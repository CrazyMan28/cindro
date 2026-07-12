// ControlClient — the jarvisd control-websocket client (Contract A), ported
// from tui/src/control/client.ts (itself a port of cli/jarvis_cli/control.py's
// battle-tested shape). ONE reader resolves per-id reply promises and fans
// `session.event` frames into per-session AsyncQueues; reconnects with
// 0.5s→15s backoff and re-sends the full subscription set (the daemon treats
// each session.subscribe as authoritative).
//
// MULTI-SUBSCRIBER bus (`on(match, fn)` returning an unsubscribe) — needed
// here even more than in the TUI since Chat, Canvas, Widgets, Computer, and
// Home may all want live events concurrently in the same page/tab.
//
// Only change from the TUI source: config comes from browser localStorage
// (./config.ts) instead of env vars / files, since a browser tab has no
// filesystem access.

import { controlHost, controlPort, controlWsUrl } from "./config"

export class ControlError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = "ControlError"
  }
}

/** Unbounded push queue with promise-based consumption. */
export class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(v: T) => void> = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  /** Next item, or `undefined` after timeoutMs (omit to wait forever). */
  async shift(timeoutMs?: number): Promise<T | undefined> {
    const head = this.items.shift()
    if (head !== undefined) return head
    return new Promise<T | undefined>((resolve) => {
      let settled = false
      const waiter = (v: T) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(v)
      }
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (settled) return
              settled = true
              const i = this.waiters.indexOf(waiter)
              if (i >= 0) this.waiters.splice(i, 1)
              resolve(undefined)
            }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  get size(): number {
    return this.items.length
  }
}

export type BroadcastHandler = (event: string, data: Record<string, unknown>) => void

interface Pending {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class ControlClient {
  private ws: WebSocket | null = null
  private nextId = 0
  private pending = new Map<number, Pending>()
  private queues = new Map<string, AsyncQueue<Record<string, unknown>>>()
  private subscribed = new Set<string>()
  private handlers: Array<{ match: string; fn: BroadcastHandler }> = []

  private connectedFlag = false
  private connectWaiters: Array<() => void> = []
  private supervising = false
  private closing = false

  constructor(
    private urlFactory: () => string = controlWsUrl,
    private maxBackoffMs = 15000,
  ) {}

  get connected(): boolean {
    return this.connectedFlag
  }

  // -- event bus ------------------------------------------------------------
  /**
   * Subscribe to broadcast frames. `match` is an exact event name
   * ("session.opened"), a prefix ending in "." ("widget." hears
   * widget.render/remove/clear), or "*" for everything. Returns an
   * unsubscribe function. Any number of subscribers may coexist.
   */
  on(match: string, fn: BroadcastHandler): () => void {
    const entry = { match, fn }
    this.handlers.push(entry)
    return () => {
      const i = this.handlers.indexOf(entry)
      if (i >= 0) this.handlers.splice(i, 1)
    }
  }

  // -- lifecycle ------------------------------------------------------------
  start(): void {
    if (!this.supervising) {
      this.closing = false
      void this.supervise()
    }
  }

  async close(): Promise<void> {
    this.closing = true
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
    this.ws = null
    this.setConnected(false)
    this.failPending(new Error("control client closed"))
  }

  private setConnected(v: boolean): void {
    this.connectedFlag = v
    if (v) for (const w of this.connectWaiters.splice(0)) w()
  }

  private waitConnected(timeoutMs: number): Promise<void> {
    if (this.connectedFlag) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.connectWaiters.indexOf(waiter)
        if (i >= 0) this.connectWaiters.splice(i, 1)
        reject(
          new Error(
            `jarvisd is not reachable at ${controlHost()}:${controlPort()} — ` +
              `is the daemon running? (try: cindro start / cindro doctor)`,
          ),
        )
      }, timeoutMs)
      const waiter = () => {
        clearTimeout(timer)
        resolve()
      }
      this.connectWaiters.push(waiter)
    })
  }

  private open(url: string, timeoutMs: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error("connect timeout"))
      }, timeoutMs)
      // Attach the frame reader BEFORE open resolves so nothing can slip
      // through in the gap between onopen and the supervisor's wiring.
      ws.onmessage = (ev) => this.onFrame(ev.data)
      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ws)
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error("connect failed"))
      }
      ws.onclose = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error("connection closed during open"))
      }
    })
  }

  private async supervise(): Promise<void> {
    this.supervising = true
    let backoff = 500
    try {
      while (!this.closing) {
        let ws: WebSocket
        try {
          ws = await this.open(this.urlFactory(), 6000)
        } catch {
          this.setConnected(false)
          await sleep(backoff)
          backoff = Math.min(backoff * 2, this.maxBackoffMs)
          continue
        }

        backoff = 500
        this.ws = ws
        this.setConnected(true)
        if (this.subscribed.size) {
          this.sendSubscribe().catch(() => {
            // re-subscribe after reconnect failed — next reconnect retries
          })
        }

        await new Promise<void>((resolve) => {
          ws.onclose = () => resolve()
          ws.onerror = () => {
            // the close event follows; nothing to do here
          }
        })

        this.setConnected(false)
        this.ws = null
        this.failPending(new Error("control connection lost"))
        if (this.closing) break
        await sleep(backoff)
        backoff = Math.min(backoff * 2, this.maxBackoffMs)
      }
    } finally {
      this.supervising = false
    }
  }

  // -- frame handling ---------------------------------------------------------
  private onFrame(raw: unknown): void {
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(String(raw))
      if (typeof parsed !== "object" || parsed === null) return
      msg = parsed as Record<string, unknown>
    } catch {
      return
    }

    const event = msg.event as string | undefined
    if (event === "session.event") {
      const data = (msg.data ?? {}) as Record<string, unknown>
      const sid = (data.session_id as string) ?? ""
      const q = this.queues.get(sid)
      // Session-scoping defense: only tracked sessions get events.
      if (q) q.push((data.ev ?? {}) as Record<string, unknown>)
      return
    }
    if (event) {
      const data = (msg.data ?? {}) as Record<string, unknown>
      for (const h of [...this.handlers]) {
        const hit =
          h.match === "*" ||
          h.match === event ||
          (h.match.endsWith(".") && event.startsWith(h.match))
        if (!hit) continue
        try {
          h.fn(event, data)
        } catch {
          // one bad subscriber must never break the bus for the others
        }
      }
      return
    }

    const pend = this.pending.get(msg.id as number)
    if (!pend) return
    this.pending.delete(msg.id as number)
    if (msg.ok) {
      pend.resolve((msg.result ?? {}) as Record<string, unknown>)
    } else {
      const err = (msg.error ?? {}) as Record<string, unknown>
      pend.reject(
        new ControlError(
          (err.code as string) ?? "error",
          (err.message as string) ?? "unknown error",
        ),
      )
    }
  }

  private failPending(err: Error): void {
    const pending = this.pending
    this.pending = new Map()
    for (const p of pending.values()) p.reject(err)
  }

  // -- requests ---------------------------------------------------------------
  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60000,
  ): Promise<Record<string, unknown>> {
    this.start()
    await this.waitConnected(Math.min(timeoutMs, 8000))

    const ws = this.ws
    if (!ws) throw new Error("jarvisd control connection lost")
    const id = ++this.nextId

    let resolveFn!: Pending["resolve"]
    let rejectFn!: Pending["reject"]
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    this.pending.set(id, { resolve: resolveFn, reject: rejectFn })

    try {
      ws.send(JSON.stringify({ v: 1, id, method, params }))
    } catch (e) {
      this.pending.delete(id)
      throw new Error(`control send failed for '${method}': ${String(e)}`)
    }

    const timer = setTimeout(() => {
      if (this.pending.delete(id))
        rejectFn(new Error(`control call '${method}' timed out`))
    }, timeoutMs)
    try {
      return await promise
    } finally {
      clearTimeout(timer)
    }
  }

  // -- subscriptions ------------------------------------------------------------
  /**
   * Track a session's events. Re-sends the FULL set (the daemon treats each
   * session.subscribe as authoritative). Call IMMEDIATELY after
   * session.create so no other chat's events can leak in.
   */
  async subscribe(sessionId: string): Promise<AsyncQueue<Record<string, unknown>>> {
    let q = this.queues.get(sessionId)
    if (!q) {
      q = new AsyncQueue()
      this.queues.set(sessionId, q)
    }
    this.subscribed.add(sessionId)
    await this.sendSubscribe()
    return q
  }

  private sendSubscribe(): Promise<Record<string, unknown>> {
    return this.call(
      "session.subscribe",
      { session_ids: [...this.subscribed].sort() },
      20000,
    )
  }

  queueFor(sessionId: string): AsyncQueue<Record<string, unknown>> | undefined {
    return this.queues.get(sessionId)
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.queues.delete(sessionId)
    this.subscribed.delete(sessionId)
    try {
      await this.sendSubscribe()
    } catch {
      // best-effort — the daemon drops dead subscriptions on disconnect anyway
    }
  }
}

/** Open, call once, close — for one-shot round-trips outside a page's lifetime. */
export async function oneCall(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const c = new ControlClient()
  try {
    return await c.call(method, params, timeoutMs)
  } finally {
    await c.close()
  }
}

// -- phone.config helpers -----------------------------------------------------
// Typed wrappers around the control(loopback)-only phone.config verb (see
// daemon/src/ControlServer.cpp's handlePhoneConfig) — mirrors the plain
// `call()` helper above, just with request/response shapes spelled out so
// callers (settings page, setup wizard) don't hand-roll the wire shape.
// Secrets are NEVER returned by "get" (only has_* booleans); "set" only ever
// writes the patch keys actually present, so a masked secret the user never
// touched can't be clobbered by a save.
export interface PhoneConfigTwilio {
  has_account_sid: boolean
  has_auth_token: boolean
  from_number: string
  public_base_url: string
  inbound_extension: string
  screening_extension: string
  configured: boolean
}

export interface PhoneConfig {
  configured: boolean
  server_port: string
  server_url: string
  has_admin_token: boolean
  has_device_token: boolean
  has_agent_token: boolean
  twilio: PhoneConfigTwilio
}

/** All keys optional — only keys actually present get written; an empty
 * string clears that key. Never include a secret key unless the user typed a
 * NEW value (see file header). */
export interface PhoneConfigPatch {
  server_port?: string
  admin_token?: string
  device_token?: string
  agent_token?: string
  twilio_account_sid?: string
  twilio_auth_token?: string
  twilio_from_number?: string
  twilio_public_base_url?: string
  twilio_inbound_extension?: string
  twilio_screening_extension?: string
  public_base_url?: string
}

export interface PhoneConfigSetResult {
  ok: boolean
  restarted: boolean
  note: string
}

export interface PhoneConfigTestResult {
  reachable: boolean
  twilio_configured: boolean
}

export async function phoneConfigGet(client: ControlClient): Promise<PhoneConfig> {
  return (await client.call("phone.config", { action: "get" }, 15000)) as unknown as PhoneConfig
}

export async function phoneConfigSet(
  client: ControlClient,
  patch: PhoneConfigPatch,
): Promise<PhoneConfigSetResult> {
  return (await client.call(
    "phone.config",
    { action: "set", patch: patch as Record<string, unknown> },
    20000,
  )) as unknown as PhoneConfigSetResult
}

/** Real connectivity probe (the daemon calls the phone server) — use for a
 * Test button instead of a fake always-success. */
export async function phoneConfigTest(client: ControlClient): Promise<PhoneConfigTestResult> {
  return (await client.call("phone.config", { action: "test" }, 20000)) as unknown as PhoneConfigTestResult
}
