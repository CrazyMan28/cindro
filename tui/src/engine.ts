// Per-session computer-use engine access — the TS port of
// cli/jarvis_cli/tui/engine_endpoint.py (itself the same agent_desktop.info
// round-trip Bridge.cpp:3748-3757 uses), plus the thin REST helper both the
// Computer and Browser pages share. The daemon replies with the engine's
// loopback port and its per-session bearer (ControlServer.cpp:4057-4077 —
// the bearer is added there on purpose; AgentDesktopInfo::toJson omits it),
// or fails with code "no_agent_desktop" when no nested desktop is up.

import { createSignal } from "solid-js"

import type { ControlClient } from "./control/client"

export interface EngineEndpoint {
  /** http://127.0.0.1:<port> — the engine binds loopback only. */
  base: string
  port: string
  bearer: string
}

/**
 * Resolve session_id's per-session engine (port + bearer). Callers MUST
 * resolve fresh before every REST call — a co-work session can end and a new
 * one start (different id, different engine) while a page sits open, and a
 * cached endpoint from a prior session is invalid against the new engine
 * (the browser_pane.py stale-session rule).
 */
export async function resolveEngineEndpoint(
  client: ControlClient,
  sessionId: string,
): Promise<EngineEndpoint> {
  if (!sessionId)
    throw new Error("no session id — cannot resolve a computer-use engine endpoint")
  const res = await client.call("agent_desktop.info", { session_id: sessionId }, 10000)
  const port = String(res.port ?? "8810")
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    bearer: String(res.bearer ?? ""),
  }
}

export interface EngineFetchOptions {
  bearer?: string
  timeoutMs?: number
}

/**
 * POST one engine REST call (all /browser/<op> routes are POSTs — the exact
 * surface Bridge.cpp:2339-2408 targets: navigate/back/forward/reload/
 * status/snapshot/click). 5s timeout, and every failure mode throws a
 * readable Error — no caller ever has to decode a bare TypeError.
 */
export async function engineFetch(
  base: string,
  path: string,
  body: Record<string, unknown> = {},
  opts: EngineFetchOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const url = base.replace(/\/+$/, "") + path
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  let resp: Response
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (ctrl.signal.aborted)
      throw new Error(`engine ${path} timed out after ${timeoutMs}ms (${url})`)
    throw new Error(`engine unreachable at ${url}: ${String(e)}`)
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(
      `engine ${path} failed: HTTP ${resp.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    )
  }
  try {
    return (await resp.json()) as Record<string, unknown>
  } catch (e) {
    throw new Error(`engine ${path} returned non-JSON: ${String(e)}`)
  }
}

// -- shared co-work session id -------------------------------------------------
// The Browser page needs the Computer page's live co-work session id — the
// legacy TUI reached across panes with app.query_one("#computer").session_id
// (browser_pane.py:41-44). Here it's one reactive module-level signal both
// pages share; Browser re-reads it FRESH before every engine call so a
// session swap mid-view can never route a call at a dead engine.
const [coworkSessionId, setCoworkSessionId] = createSignal("")
export { coworkSessionId, setCoworkSessionId }
