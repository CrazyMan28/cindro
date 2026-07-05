// MockDaemon — a tiny in-process jarvisd stand-in for bun tests (the TS
// counterpart of cli/tests/harness.py's MockDaemon): speaks Contract A
// frames over a real websocket, records every call, lets tests override
// per-verb handlers and inject broadcast/session events.

import type { ServerWebSocket } from "bun"

type Handler = (params: Record<string, unknown>) =>
  | Record<string, unknown>
  | { __error: { code: string; message: string } }
  | undefined

export class MockDaemon {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  handlers: Record<string, Handler> = {}

  private sockets = new Set<ServerWebSocket<unknown>>()
  private server: ReturnType<typeof Bun.serve>

  constructor(port = 0) {
    this.server = Bun.serve({
      port,
      fetch: (req, server) => {
        if (server.upgrade(req, { data: null })) return undefined
        return new Response("websocket only", { status: 400 })
      },
      websocket: {
        open: (ws) => {
          this.sockets.add(ws)
        },
        close: (ws) => {
          this.sockets.delete(ws)
        },
        message: (ws, raw) => this.onMessage(ws, raw),
      },
    })
  }

  get port(): number {
    return this.server.port ?? 0
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/control/ws`
  }

  get clientCount(): number {
    return this.sockets.size
  }

  private onMessage(ws: ServerWebSocket<unknown>, raw: string | Buffer): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    const method = msg.method as string
    const params = (msg.params ?? {}) as Record<string, unknown>
    const id = msg.id as number
    this.calls.push({ method, params })

    const handler = this.handlers[method]
    let result: ReturnType<Handler> = {}
    if (handler) result = handler(params)
    else if (method === "ping") result = { pong: true, ts: Date.now() }

    if (result === undefined) return // handler chose not to reply (timeout tests)
    if (typeof result === "object" && "__error" in result) {
      const err = result.__error
      ws.send(JSON.stringify({ v: 1, id, ok: false, error: err }))
      return
    }
    ws.send(JSON.stringify({ v: 1, id, ok: true, result }))
  }

  /** Push a broadcast frame ({"event":..., "data":...}) to every client. */
  broadcast(event: string, data: Record<string, unknown> = {}): void {
    const frame = JSON.stringify({ v: 1, event, data })
    for (const ws of this.sockets) ws.send(frame)
  }

  /** Push one normalized session event to every client. */
  sessionEvent(sessionId: string, ev: Record<string, unknown>): void {
    this.broadcast("session.event", { session_id: sessionId, ev })
  }

  callsFor(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === method).map((c) => c.params)
  }

  stop(): void {
    this.server.stop(true)
    this.sockets.clear()
  }
}
