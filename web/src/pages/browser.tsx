// BROWSER — drive the co-work session's controlled Chrome tab through the
// per-session engine's REST surface (ported from tui/src/pages/Browser.tsx —
// the only actually-SHIPPED reference; desktop/qml/BrowserPage.qml exists but
// is never wired into AppShell.qml, dead Qt code). Bridge.cpp:2339-2408 is
// the exact contract both that QML page and the TUI target:
//   POST <engine>/browser/status|navigate|back|forward|reload|snapshot|click|screenshot
// A terminal can't show a screenshot, so the TUI only ever renders the text
// DOM snapshot — but a real browser tab CAN, so this page renders a live
// preview image (Bridge.cpp already expects /browser/screenshot to answer
// {image_b64|screenshot}) alongside the clickable element list, which is
// strictly more than either existing frontend does.
//
// SESSION-DISCOVERY GAP: the TUI shares one `coworkSessionId` signal between
// its Computer and Browser pages because both panes live in one process
// (tui/src/engine.ts). Here core/router.ts's PageDef takes no such prop, and
// core/* is frozen, so there is no cross-page channel to reach into. This
// page instead polls session.list itself and treats the most-recently-
// updated profile:"coworker" session as "the" co-work session — same result
// (find the live one), just reached through the daemon instead of an
// in-process pane query. Every engine call still re-resolves
// agent_desktop.info FRESH right before firing (the stale-session guard
// browser_pane.py encodes) so a session that ended/rotated mid-view can
// never route a call at a dead engine.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import { ControlError, type ControlClient } from "../core/control-client"
import { theme } from "../core/theme"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"

const SESSION_POLL_MS = 4000
const LIVE_POLL_MS = 6000
const SNAPSHOT_CAP = 100

interface SessionRow {
  id: string
  profile?: string
  updated?: number
}

interface SnapNode {
  ref: string
  role: string
  name: string
}

interface EngineEndpoint {
  base: string
  bearer: string
}

async function resolveEngineEndpoint(client: ControlClient, sessionId: string): Promise<EngineEndpoint> {
  const res = await client.call("agent_desktop.info", { session_id: sessionId }, 10000)
  const port = String(res.port ?? "8810")
  return { base: `http://127.0.0.1:${port}`, bearer: String(res.bearer ?? "") }
}

/** POST one engine REST call. Every failure mode throws a readable Error —
 * no caller ever has to decode a bare TypeError or a silent 404. */
async function engineFetch(
  base: string,
  path: string,
  body: Record<string, unknown>,
  bearer: string,
  timeoutMs = 6000,
): Promise<Record<string, unknown>> {
  const url = base.replace(/\/+$/, "") + path
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let resp: Response
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal })
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`engine ${path} timed out after ${timeoutMs}ms`)
    throw new Error(`engine unreachable at ${url}: ${String(e)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`engine ${path} failed: HTTP ${resp.status}${text ? ` — ${text.slice(0, 200)}` : ""}`)
  }
  try {
    return (await resp.json()) as Record<string, unknown>
  } catch (e) {
    throw new Error(`engine ${path} returned non-JSON: ${String(e)}`)
  }
}

// -- small hand-drawn toolbar glyphs (NavIcon.tsx's pattern, own glyph set —
// back/forward/reload/go don't exist in that frozen file's map) ------------
const TOOL_GLYPHS: Record<string, (ctx: CanvasRenderingContext2D) => void> = {
  back: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(11.5, 4); ctx.lineTo(5.5, 9); ctx.lineTo(11.5, 14)
    ctx.stroke()
  },
  forward: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(6.5, 4); ctx.lineTo(12.5, 9); ctx.lineTo(6.5, 14)
    ctx.stroke()
  },
  reload: (ctx) => {
    ctx.beginPath()
    ctx.arc(9, 9.5, 5.2, 0.35 * Math.PI, 1.85 * Math.PI)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(13.8, 5.6); ctx.lineTo(14.6, 9.2); ctx.lineTo(10.9, 8.2); ctx.closePath()
    ctx.fill()
  },
  go: (ctx) => {
    ctx.beginPath()
    ctx.moveTo(5.5, 4); ctx.lineTo(14, 9); ctx.lineTo(5.5, 14); ctx.closePath()
    ctx.fill()
  },
  refresh: (ctx) => {
    ctx.beginPath()
    ctx.arc(9, 9, 6, 0.2 * Math.PI, 1.9 * Math.PI)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(14.6, 4.6); ctx.lineTo(15.2, 9); ctx.lineTo(11, 7.7); ctx.closePath()
    ctx.fill()
  },
}

function ToolIcon(props: { glyph: keyof typeof TOOL_GLYPHS; color: string }) {
  let canvas: HTMLCanvasElement | undefined
  const paint = () => {
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = 18 * dpr
    canvas.height = 18 * dpr
    canvas.style.width = "18px"
    canvas.style.height = "18px"
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, 18, 18)
    ctx.strokeStyle = props.color
    ctx.fillStyle = props.color
    ctx.lineWidth = 1.6
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ;(TOOL_GLYPHS[props.glyph] ?? TOOL_GLYPHS.go)(ctx)
  }
  onMount(paint)
  createEffect(paint) // repaint on color change (enabled/disabled states)
  return (
    <canvas
      ref={(r) => {
        canvas = r
        queueMicrotask(paint)
      }}
      style={{ width: "18px", height: "18px", "flex-shrink": 0 }}
    />
  )
}

const PAGE_CSS = `
.jv-browser { display: flex; flex-direction: column; gap: 14px; max-width: 1180px; }
.jv-browser-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.jv-browser-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px; font-size: 10px;
  font-family: var(--font-display); letter-spacing: var(--track-mid);
  border: 1px solid var(--hairline-soft); color: var(--text-faint);
}
.jv-browser-badge.live { color: var(--success); border-color: rgba(57,230,160,0.35); }
.jv-browser-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.jv-browser-badge.live .dot { animation: jv-b-pulse 1.1s ease-in-out infinite; }
@keyframes jv-b-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.jv-browser-spin {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--hairline-soft); border-top-color: var(--accent);
  animation: jv-b-spin 0.7s linear infinite;
}
@keyframes jv-b-spin { to { transform: rotate(360deg); } }

.jv-browser-toolbar {
  display: flex; align-items: center; gap: 6px;
  background: var(--surface); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius); padding: 8px 10px;
  transition: border-color var(--dur-fast) ease;
}
.jv-browser-toolbar:focus-within { border-color: var(--accent-dim); }
.jv-browser-tbtn {
  all: unset; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: var(--radius-xs); cursor: pointer;
  transition: background var(--dur-fast) ease;
}
.jv-browser-tbtn:hover:not(:disabled) { background: var(--accent-faint); }
.jv-browser-tbtn:disabled { cursor: default; opacity: 0.35; }
.jv-browser-urlwrap {
  flex: 1; min-width: 140px; display: flex; align-items: center; gap: 8px;
  background: var(--surface-input); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm); padding: 0 10px; height: 32px;
}
.jv-browser-urlwrap:focus-within { border-color: var(--accent-dim); }
.jv-browser-urlwrap input {
  all: unset; flex: 1; color: var(--text); font-family: var(--font-mono); font-size: 12.5px;
}
.jv-browser-urlwrap input::placeholder { color: var(--text-faint); }
.jv-browser-go {
  all: unset; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: var(--radius-xs); cursor: pointer;
  background: var(--accent-dim); transition: background var(--dur-fast) ease;
}
.jv-browser-go:hover:not(:disabled) { background: var(--accent-faint); }
.jv-browser-go:disabled { cursor: default; opacity: 0.4; }

.jv-browser-titlebar {
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted);
  padding: 0 2px;
}
.jv-browser-titlebar .t { color: var(--text); font-weight: 600; }
.jv-browser-titlebar .u { font-family: var(--font-mono); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.jv-browser-grid { display: grid; grid-template-columns: minmax(340px, 1.5fr) minmax(260px, 1fr); gap: 14px; align-items: start; }
@media (max-width: 760px) { .jv-browser-grid { grid-template-columns: 1fr; } }

.jv-browser-shotcard {
  background: var(--surface); border: 1px solid var(--hairline-soft); border-radius: var(--radius);
  overflow: hidden; display: flex; flex-direction: column;
  box-shadow: 0 0 0 rgba(0,0,0,0); transition: box-shadow var(--dur-mid) ease, border-color var(--dur-mid) ease;
}
.jv-browser-shotcard.live { border-color: var(--accent-dim); box-shadow: 0 4px 22px -8px var(--accent-glow); }
.jv-browser-shotcard-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--hairline-faint);
}
.jv-browser-shot-frame {
  position: relative; aspect-ratio: 16 / 10; background: var(--surface-deep);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.jv-browser-shot-frame img { width: 100%; height: 100%; object-fit: contain; display: block; animation: jv-b-fadein var(--dur-mid) ease; }
@keyframes jv-b-fadein { from { opacity: 0; } to { opacity: 1; } }
.jv-browser-shot-empty { color: var(--text-faint); font-size: 12px; text-align: center; padding: 0 20px; }

.jv-browser-list-card {
  background: var(--surface); border: 1px solid var(--hairline-soft); border-radius: var(--radius);
  display: flex; flex-direction: column; max-height: 520px;
}
.jv-browser-list-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--hairline-faint);
}
.jv-browser-list-body { overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 3px; }
.jv-browser-node {
  all: unset; cursor: pointer; display: flex; gap: 8px; align-items: baseline;
  padding: 7px 9px; border-radius: var(--radius-xs); font-size: 12px; color: var(--text);
  border: 1px solid transparent; transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
.jv-browser-node:hover { background: var(--accent-faint); border-color: var(--accent-dim); }
.jv-browser-node.pulse { animation: jv-b-clickpulse 500ms ease; }
@keyframes jv-b-clickpulse { 0% { background: var(--accent-dim); } 100% { background: transparent; } }
.jv-browser-node .ref { color: var(--accent); font-family: var(--font-mono); font-size: 10.5px; flex-shrink: 0; }
.jv-browser-node .role { color: var(--text-faint); font-size: 10.5px; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.3px; }
.jv-browser-node .name { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jv-browser-empty-row { color: var(--text-faint); font-size: 12px; padding: 14px 10px; text-align: center; }

.jv-browser-status {
  font-size: 12px; color: var(--danger); background: var(--danger-dim);
  border: 1px solid rgba(255,107,107,0.3); border-radius: var(--radius-sm); padding: 8px 12px;
}

.jv-browser-gate {
  background: var(--surface); border: 1px solid var(--hairline-soft); border-radius: var(--radius);
  padding: 28px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
}
.jv-browser-gate .go-computer {
  all: unset; cursor: pointer; margin-top: 6px; padding: 8px 18px; border-radius: var(--radius-sm);
  background: var(--accent-dim); color: var(--accent-bright); font-family: var(--font-display);
  font-size: 11px; letter-spacing: var(--track-mid); transition: background var(--dur-fast) ease;
}
.jv-browser-gate .go-computer:hover { background: var(--accent-faint); }
`

function BrowserPage() {
  const app = useApp()
  const active = createMemo(() => app.page() === "browser")

  const [sessionId, setSessionId] = createSignal("")
  const [sessionChecked, setSessionChecked] = createSignal(false)
  const [noDesktop, setNoDesktop] = createSignal(false)

  const [url, setUrl] = createSignal("")
  const [title, setTitle] = createSignal("")
  const [canBack, setCanBack] = createSignal(false)
  const [canForward, setCanForward] = createSignal(false)
  const [nodes, setNodes] = createSignal<SnapNode[]>([])
  const [shot, setShot] = createSignal("")
  const [inputValue, setInputValue] = createSignal("")
  // Separate from inputValue()'s emptiness — "" is a valid in-progress edit
  // (the user cleared the field to type a new address) and must not fall
  // back to displaying the stale url() while the user is actively editing.
  const [editingUrl, setEditingUrl] = createSignal(false)
  const [status, setStatus] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [clickedRef, setClickedRef] = createSignal("")

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const fail = (e: unknown) => alive && setStatus(`✖ ${e instanceof Error ? e.message : String(e)}`)

  // -- fresh-per-call engine access (the stale-session guard) --------------
  const enginePost = async (path: string, body: Record<string, unknown> = {}) => {
    const sid = sessionId()
    if (!sid) throw new Error("no active co-work session")
    let ep: EngineEndpoint
    try {
      ep = await resolveEngineEndpoint(app.client, sid)
    } catch (e) {
      if (e instanceof ControlError && e.code === "no_agent_desktop") setNoDesktop(true)
      throw e
    }
    if (alive) setNoDesktop(false)
    const data = await engineFetch(ep.base, path, body, ep.bearer)
    if (sessionId() !== sid) throw new Error("co-work session changed mid-call — result discarded")
    return data
  }

  const applyStatus = (data: Record<string, unknown>) => {
    if (typeof data.url === "string" && data.url) setUrl(data.url)
    if (typeof data.title === "string") setTitle(data.title)
    if (typeof data.can_back === "boolean") setCanBack(data.can_back)
    if (typeof data.can_forward === "boolean") setCanForward(data.can_forward)
  }

  const refreshSnapshot = async () => {
    const data = await enginePost("/browser/snapshot")
    const list = ((data.nodes ?? []) as Array<Record<string, unknown>>)
      .slice(0, SNAPSHOT_CAP)
      .map((n) => ({
        ref: String(n.ref ?? ""),
        role: String(n.role ?? ""),
        name: String(n.name ?? n.text ?? ""),
      }))
    if (alive) setNodes(list)
    applyStatus(data)
  }

  /** Best-effort — an engine that hasn't wired /browser/screenshot yet must
   * never block the DOM snapshot (the page's core value) from showing. */
  const refreshScreenshot = async () => {
    const data = await enginePost("/browser/screenshot")
    const raw =
      typeof data.image_b64 === "string" && data.image_b64
        ? data.image_b64
        : typeof data.screenshot === "string"
          ? data.screenshot
          : ""
    if (raw && alive) setShot(raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`)
  }

  const refreshAll = async () => {
    if (!sessionId()) return
    setBusy(true)
    try {
      const data = await enginePost("/browser/status")
      applyStatus(data)
      await refreshSnapshot()
      if (alive) setStatus("")
    } catch (e) {
      fail(e)
    } finally {
      if (alive) setBusy(false)
    }
    void refreshScreenshot().catch(() => {
      // no screenshot this round — the DOM list above still stands on its own
    })
  }

  const navCall = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    setStatus("")
    try {
      applyStatus(await enginePost(path, body))
      await refreshSnapshot()
      if (alive) setStatus("")
    } catch (e) {
      fail(e)
    } finally {
      if (alive) setBusy(false)
    }
    void refreshScreenshot().catch(() => {})
  }

  const goTo = (raw: string) => {
    let u = raw.trim()
    if (!u) return
    if (!u.includes("://") && !u.startsWith("about:")) u = `https://${u}`
    void navCall("/browser/navigate", { url: u })
  }

  const clickNode = (ref: string) => {
    setClickedRef(ref)
    void navCall("/browser/click", { ref })
  }

  // -- session discovery: find the live coworker session ourselves ---------
  const discover = async () => {
    try {
      const res = await app.client.call("session.list", {}, 10000)
      const rows = ((res.sessions ?? []) as SessionRow[])
        .filter((s) => s.profile === "coworker")
        .sort((a, b) => Number(b.updated ?? 0) - Number(a.updated ?? 0))
      if (!alive) return
      setSessionChecked(true)
      const next = rows[0]?.id ?? ""
      if (next !== sessionId()) {
        setSessionId(next)
        setNoDesktop(false)
        if (next) {
          void refreshAll()
        } else {
          setNodes([])
          setShot("")
          setUrl("")
          setTitle("")
          setStatus("")
        }
      }
    } catch (e) {
      if (!alive) return
      setSessionChecked(true)
      fail(e)
    }
  }

  onMount(() => {
    void discover()
    const sessionTimer = setInterval(() => {
      if (active()) void discover()
    }, SESSION_POLL_MS)
    const liveTimer = setInterval(() => {
      if (active() && sessionId() && !busy()) void refreshAll()
    }, LIVE_POLL_MS)
    onCleanup(() => {
      clearInterval(sessionTimer)
      clearInterval(liveTimer)
    })
  })

  const hasSession = createMemo(() => Boolean(sessionId()))

  return (
    <div class="jv-browser">
      <style>{PAGE_CSS}</style>

      <div class="jv-browser-head">
        <NavIcon glyph="browser" color={theme.accentBright} glow />
        <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "18px" }}>
          BROWSER
        </div>
        <Show
          when={hasSession()}
          fallback={
            <span class="jv-browser-badge">
              <span class="dot" /> NO SESSION
            </span>
          }
        >
          <span class="jv-browser-badge" classList={{ live: !noDesktop() }}>
            <span class="dot" /> {noDesktop() ? "SESSION STARTING…" : "LIVE"}
          </span>
        </Show>
        <Show when={busy()}>
          <span class="jv-browser-spin" />
        </Show>
      </div>

      <Show
        when={!sessionChecked()}
        fallback={
          <Show
            when={hasSession()}
            fallback={
              <div class="jv-browser-gate">
                <NavIcon glyph="browser" color={theme.textFaint} />
                <div style={{ color: "var(--text)", "font-size": "13px", "font-weight": 600 }}>
                  No live co-work session
                </div>
                <p style={{ color: "var(--text-muted)", "font-size": "12px", margin: 0, "max-width": "360px" }}>
                  Start a co-worker on the Computer page — it drives a controlled
                  Chrome tab on the agent's own desktop. Once one is running,
                  come back here to navigate it and click through its page.
                </p>
                <button type="button" class="go-computer" onClick={() => app.navigate("computer")}>
                  GO TO COMPUTER
                </button>
              </div>
            }
          >
            <div class="jv-browser-toolbar">
              <button
                type="button"
                class="jv-browser-tbtn"
                disabled={!canBack() || busy()}
                title="Back"
                onClick={() => void navCall("/browser/back")}
              >
                <ToolIcon glyph="back" color={!canBack() || busy() ? theme.textFaint : theme.text} />
              </button>
              <button
                type="button"
                class="jv-browser-tbtn"
                disabled={!canForward() || busy()}
                title="Forward"
                onClick={() => void navCall("/browser/forward")}
              >
                <ToolIcon glyph="forward" color={!canForward() || busy() ? theme.textFaint : theme.text} />
              </button>
              <button
                type="button"
                class="jv-browser-tbtn"
                disabled={busy()}
                title="Reload page"
                onClick={() => void navCall("/browser/reload")}
              >
                <ToolIcon glyph="reload" color={busy() ? theme.textFaint : theme.text} />
              </button>
              <form
                class="jv-browser-urlwrap"
                onSubmit={(e) => {
                  e.preventDefault()
                  const target = editingUrl() ? inputValue() : url()
                  setEditingUrl(false)
                  goTo(target)
                }}
              >
                <NavIcon glyph="browser" color={theme.textFaint} />
                <input
                  value={editingUrl() ? inputValue() : url()}
                  placeholder="https://…"
                  onInput={(e) => setInputValue(e.currentTarget.value)}
                  onFocus={(e) => {
                    setEditingUrl(true)
                    setInputValue(e.currentTarget.value)
                  }}
                />
                <button type="submit" class="jv-browser-go" disabled={busy()} title="Go">
                  <ToolIcon glyph="go" color={theme.accentBright} />
                </button>
              </form>
              <button
                type="button"
                class="jv-browser-tbtn"
                disabled={busy()}
                title="Refresh snapshot + view"
                onClick={() => void refreshAll()}
              >
                <ToolIcon glyph="refresh" color={busy() ? theme.textFaint : theme.text} />
              </button>
            </div>

            <div class="jv-browser-titlebar">
              <span class="t">{title() || "(no title)"}</span>
              <span class="u">— {url() || "—"}</span>
            </div>

            <div class="jv-browser-grid">
              <div class="jv-browser-shotcard" classList={{ live: Boolean(shot()) }}>
                <div class="jv-browser-shotcard-head">
                  <span class="hud-label" style={{ "font-size": "10px", color: "var(--text-faint)" }}>
                    LIVE VIEW
                  </span>
                </div>
                <div class="jv-browser-shot-frame">
                  <Show
                    when={shot()}
                    fallback={
                      <div class="jv-browser-shot-empty">
                        {noDesktop()
                          ? "waiting for the agent desktop to come up…"
                          : "no screenshot yet — press refresh"}
                      </div>
                    }
                  >
                    <img src={shot()} alt={title() || "browser preview"} />
                  </Show>
                </div>
              </div>

              <div class="jv-browser-list-card">
                <div class="jv-browser-list-head">
                  <span class="hud-label" style={{ "font-size": "10px", color: "var(--text-faint)" }}>
                    CLICKABLE ELEMENTS
                  </span>
                  <span style={{ "font-size": "10px", color: "var(--text-faint)" }}>{nodes().length}</span>
                </div>
                <div class="jv-browser-list-body">
                  <For
                    each={nodes()}
                    fallback={
                      <div class="jv-browser-empty-row">
                        no snapshot yet — press the refresh button above
                      </div>
                    }
                  >
                    {(node) => (
                      <button
                        type="button"
                        class="jv-browser-node"
                        classList={{ pulse: clickedRef() === node.ref }}
                        disabled={!node.ref || busy()}
                        onClick={() => clickNode(node.ref)}
                      >
                        <span class="ref">[{node.ref}]</span>
                        <span class="role">{node.role}</span>
                        <span class="name">{node.name}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Show>
        }
      >
        <div style={{ color: "var(--text-faint)", "font-size": "12px" }}>checking for a live session…</div>
      </Show>

      <Show when={status()}>
        <div class="jv-browser-status">{status()}</div>
      </Show>
    </div>
  )
}

const page: PageDef = { id: "browser", label: "BROWSER", section: "WORKSPACE", order: 999, component: BrowserPage }
export default page
