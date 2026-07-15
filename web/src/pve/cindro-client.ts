// CindroClient — compact Contract A WebSocket client for the host-served
// Proxmox dashboard. Same wire protocol as web/src/core/control-client.ts
// ({v:1,id,method,params} requests, {id,ok,result|error} replies, {event,data}
// broadcasts) but pointed at the dashboard's same-origin proxy (see
// env.ts's controlWsUrl(): the dashboard server reverse-proxies this socket to
// the co-located jarvisd's LOOPBACK control socket, injecting its token
// server-side — the browser never sees it, and the proxy only forwards a
// small allow-listed method set: session.create/send/subscribe,
// approval.respond, proxmoxop.*, ping — see dashboard_server.py's
// _ALLOWED_METHODS). Deliberately compact vs. the desktop client: this SPA
// only ever needs RPC + one broadcast bus + session subscription, not a full
// per-session AsyncQueue registry.
//
// Contract:
//   call(method, params?, timeoutMs?) -> Promise<result>
//   on(match, fn) -> unsubscribe        match: exact event name
//                                        ("session.event"), a dotted prefix
//                                        ("proxmoxop." hears every
//                                        proxmoxop.* broadcast), "*" for
//                                        everything, or the synthetic
//                                        "__status" event this client fires
//                                        locally on connect/disconnect
//                                        ({connected: boolean}) — so a link
//                                        indicator never needs its own poll.
//   subscribe(sessionId)                re-sends the FULL tracked session
//                                        set (the daemon treats each
//                                        session.subscribe as authoritative).
//
// Auto-reconnects with capped exponential backoff (500ms -> 15s) and
// re-subscribes the full session set on every reconnect. An outbox queues
// call() frames sent while the socket is still CONNECTING (or between
// reconnect attempts) and flushes them in order on open — but SKIPS any
// frame whose call already timed out (its `pending` entry is gone by then),
// so a stale mutating request can never replay after the UI already reported
// failure to the user.

import { controlWsUrl } from "./env"

export class CindroError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = "CindroError"
  }
}

export type BroadcastHandler = (data: Record<string, unknown>, event: string) => void

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CindroClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers: Array<{ match: string; fn: BroadcastHandler }> = []
  private subs = new Set<string>()
  private outbox: Array<{ id: number; frame: string }> = []
  private backoff = 500
  private readonly maxBackoff = 15000
  private connecting = false
  private closed = false
  private connectedFlag = false

  get connected(): boolean {
    return this.connectedFlag
  }

  /** Open (or re-open) the socket. Idempotent — a live or in-flight
   * connection is left alone, so callers never need to guard this. call()
   * invokes it automatically. */
  connect(): void {
    if (this.closed || this.connecting || this.ws) return
    this.connecting = true
    let url: string
    try {
      url = controlWsUrl()
    } catch {
      this.connecting = false
      return
    }

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.connecting = false
      this.backoff = 500
      this.connectedFlag = true
      this.emit("__status", { connected: true })
      if (this.subs.size) this.sendSubscribe()
      // Flush anything queued while CONNECTING/reconnecting, in order. Skip
      // frames whose call already timed out (pending entry gone) — replaying
      // a stale mutating request after the UI reported failure would be worse
      // than dropping it.
      const queued = this.outbox
      this.outbox = []
      for (const q of queued) {
        if (!this.pending.has(q.id)) continue
        try {
          ws.send(q.frame)
        } catch {
          // socket died mid-flush; the call's own timer will time it out
        }
      }
    }
    ws.onclose = () => this.teardown()
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        // already closing — onclose still fires and drives the reconnect
      }
    }
    ws.onmessage = (e) => {
      try {
        this.onFrame(JSON.parse(String(e.data)) as Record<string, unknown>)
      } catch {
        // malformed frame — never let a bad payload throw out of a socket handler
      }
    }
  }

  private teardown(): void {
    const wasConnected = this.connectedFlag
    this.ws = null
    this.connecting = false
    this.connectedFlag = false
    if (wasConnected) this.emit("__status", { connected: false })
    if (this.closed) return
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff)
    setTimeout(() => this.connect(), wait)
  }

  /** Stop reconnecting and close the socket for good (page/controller teardown). */
  close(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
    this.ws = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error("client closed"))
    }
    this.pending.clear()
  }

  private onFrame(f: Record<string, unknown>): void {
    if (typeof f.id === "number" && f.ok !== undefined) {
      const p = this.pending.get(f.id)
      if (!p) return // already timed out, or a frame we never sent (ignore)
      this.pending.delete(f.id)
      clearTimeout(p.timer)
      if (f.ok) {
        p.resolve((f.result ?? {}) as Record<string, unknown>)
      } else {
        const err = (f.error ?? {}) as Record<string, unknown>
        p.reject(new CindroError(String(err.code ?? "error"), String(err.message ?? "unknown error")))
      }
      return
    }
    if (typeof f.event === "string") {
      this.emit(f.event, (f.data ?? {}) as Record<string, unknown>)
    }
  }

  private emit(event: string, data: Record<string, unknown>): void {
    for (const h of [...this.handlers]) {
      const hit = h.match === "*" || h.match === event || (h.match.endsWith(".") && event.startsWith(h.match))
      if (!hit) continue
      try {
        h.fn(data, event)
      } catch {
        // one bad subscriber must never break the bus for the others
      }
    }
  }

  /** Subscribe to broadcast frames. Returns an unsubscribe function. Any
   * number of subscribers may coexist (session chat + a permissions page
   * both watching "proxmoxop." broadcasts, say). */
  on(match: string, fn: BroadcastHandler): () => void {
    const entry = { match, fn }
    this.handlers.push(entry)
    return () => {
      const i = this.handlers.indexOf(entry)
      if (i >= 0) this.handlers.splice(i, 1)
    }
  }

  call<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<T> {
    this.connect()
    const id = this.nextId++
    const frame = JSON.stringify({ v: 1, id, method, params })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject, timer })

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(frame)
        } catch (e) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      } else {
        // CONNECTING, or between reconnect attempts — queue for the next open.
        this.outbox.push({ id, frame })
      }
    })
  }

  /** Track a session's events. Re-sends the FULL tracked set (the daemon
   * treats each session.subscribe as authoritative) — call this IMMEDIATELY
   * after session.create so nothing the operator agent emits can slip by
   * unobserved. Safe to call more than once for the same id. */
  subscribe(sessionId: string): void {
    if (!sessionId || this.subs.has(sessionId)) return
    this.subs.add(sessionId)
    this.sendSubscribe()
  }

  private sendSubscribe(): void {
    this.call("session.subscribe", { session_ids: [...this.subs] }).catch(() => {
      // best-effort — a reconnect resends the full set anyway
    })
  }
}
