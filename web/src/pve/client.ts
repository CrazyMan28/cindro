// Compact Contract A WebSocket client for the host-served Proxmox dashboard.
// Same wire protocol as web/src/core/control-client.ts, trimmed to what this
// SPA needs (RPC + event bus + session subscribe) and pointed at the same-
// origin proxy (see env.controlWsUrl).

import { controlWsUrl } from "./env"

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
type Listener = { match: string; fn: (data: unknown) => void }

export class Client {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners: Listener[] = []
  private subs = new Set<string>()
  private outbox: string[] = [] // frames queued while the socket isn't OPEN yet
  connected = false
  onStatus: ((c: boolean) => void) | null = null

  connect(): void {
    let url: string
    try {
      url = controlWsUrl()
    } catch {
      return
    }
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.onStatus?.(true)
      if (this.subs.size) this.sendSub()
      // Flush anything enqueued while CONNECTING (the normal login/load path:
      // App.boot() connects and pages onMount(refresh) immediately).
      const queued = this.outbox
      this.outbox = []
      for (const f of queued) {
        try {
          ws.send(f)
        } catch {
          /* dropped; its call() will time out */
        }
      }
    }
    ws.onclose = () => {
      this.connected = false
      this.onStatus?.(false)
      setTimeout(() => this.connect(), 1200)
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    ws.onmessage = (e) => {
      try {
        this.onFrame(JSON.parse(String(e.data)))
      } catch {
        /* ignore malformed */
      }
    }
  }

  private onFrame(f: any): void {
    if (typeof f?.id === "number" && f.ok !== undefined) {
      const p = this.pending.get(f.id)
      if (p) {
        this.pending.delete(f.id)
        clearTimeout(p.timer)
        f.ok ? p.resolve(f.result ?? {}) : p.reject(new Error(f.error?.message || "error"))
      }
      return
    }
    if (typeof f?.event === "string") {
      for (const l of this.listeners) {
        if (
          l.match === "*" ||
          l.match === f.event ||
          (l.match.endsWith(".") && String(f.event).startsWith(l.match))
        )
          l.fn(f.data)
      }
    }
  }

  call<T = any>(method: string, params: unknown = {}, timeoutMs = 60000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      const frame = JSON.stringify({ v: 1, id, method, params })
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(frame)
        } catch (e) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(e)
        }
      } else {
        // Socket still CONNECTING (or reconnecting) — queue and flush on open,
        // instead of throwing/no-op'ing and leaving the RPC to time out.
        this.outbox.push(frame)
      }
    })
  }

  on(match: string, fn: (data: unknown) => void): () => void {
    const l: Listener = { match, fn }
    this.listeners.push(l)
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l)
    }
  }

  subscribe(sessionId: string): void {
    this.subs.add(sessionId)
    this.sendSub()
  }

  private sendSub(): void {
    this.call("session.subscribe", { session_ids: [...this.subs] }).catch(() => {})
  }
}
