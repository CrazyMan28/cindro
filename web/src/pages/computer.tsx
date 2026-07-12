// COMPUTER — ported from desktop/qml/ComputerPage.qml's intent (live preview
// of Jarvis driving a desktop, take-over-my-screen consent) and
// tui/src/pages/Computer.tsx's Contract A usage, scoped to what a browser tab
// can actually do:
//
//   - agent_desktop.info DISCOVERY: is any session, anywhere, currently
//     driving a nested (or real) desktop right now? This ALSO gates the
//     NavRail entry itself (see `gated` on the exported PageDef below),
//     mirroring NavRail.qml's `computerAvailable` (bridge.hasAgentDesktop ||
//     coworkerSessionId.length>0 || currentIndex===computerIndex). Discovery
//     runs at MODULE scope (starting the instant this file is imported —
//     App.tsx eager-globs every page at boot) with its own ControlClient, so
//     the nav item can appear the moment ANY session (a plain chat OR an
//     explicit co-worker) starts driving a desktop, without the user ever
//     having opened this page first. This is a second, dedicated websocket to
//     jarvisd (distinct from the page's own app-context client) — the cost of
//     making gating actually live app-wide instead of only after a first visit.
//
//   - the LIVE VIDEO VIEW: poll-JPEG-via-authenticated-fetch into an <img> via
//     URL.createObjectURL — a raw <img src=".../video/frame"> can't carry the
//     per-engine bearer header the nested engine requires.
//
//   - a take_over.request/cancel CONSENT FLOW: approval-gated. The approval
//     card and the resulting driving-state flip both arrive as normal
//     session.event frames on the discovered session's own queue, so we
//     `client.subscribe()` it and pump that queue like a tiny chat.
//
// SCOPE NOTE: unlike ComputerPage.qml / tui's Computer.tsx, this page does not
// itself start co-worker sessions (no session.create / brain+model pickers —
// that's Chat's job). The assigned unit is discovery + live view + take-over
// only; the empty state below points the user at Chat instead.
//
// GAP: `approval.respond` is not in this repo's published Contract-A verb
// list, but it IS a real, registered daemon verb (confirmed by reading
// daemon/src/ControlServer.cpp — dispatched alongside take_over.request, and
// it's the ONLY way to answer the approval card take_over.request produces).
// Both the desktop Bridge (Bridge::respondApproval) and tui's ComputerPage
// call it the same way, so this mirrors established, working usage rather
// than inventing a verb.
//
// GAP: the agent's live pointer position (QML's "GLOW CURSOR" overlay) is
// read from a desktop-local file/IPC bus (Bridge::startPointerTail), not
// exposed over Contract A at all — there is nothing for a browser tab to
// poll, so that overlay is intentionally not reproduced here.
import { createEffect, createSignal, onCleanup, Show } from "solid-js"

import { controlToken } from "../core/config"
import { ControlClient } from "../core/control-client"
import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { ArcReactor } from "../components/ArcReactor"

interface LiveDesktop {
  sessionId: string
  videoFrame: string
  videoMjpeg: string
  bearer: string
  width: number
  height: number
}

interface PendingApproval {
  approvalId: string
  summary: string
  risk: string
  sessionId: string
}

interface SessionListRow {
  id?: string
  state?: string
  updated?: number
}

// ---- module-scope discovery -----------------------------------------------
const [liveDesktop, setLiveDesktop] = createSignal<LiveDesktop | null>(null)
const [viewingComputer, setViewingComputer] = createSignal(false)
const [discoveryError, setDiscoveryError] = createSignal("")

// A dedicated connection so discovery keeps running whether or not this
// page's own component is ever mounted (see header note above).
const discoveryClient = new ControlClient()

function sameLiveDesktop(a: LiveDesktop | null, b: LiveDesktop | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.sessionId === b.sessionId &&
    a.videoFrame === b.videoFrame &&
    a.bearer === b.bearer &&
    a.width === b.width &&
    a.height === b.height
  )
}

// Sets the signal only when something actually changed, so effects that
// depend on liveDesktop() (the frame poller, the approval pump) don't tear
// down and restart every discovery tick just because a fresh-but-identical
// object was probed.
function applyLiveDesktop(next: LiveDesktop | null): void {
  setLiveDesktop((prev) => (sameLiveDesktop(prev, next) ? prev : next))
}

function toLiveDesktop(sessionId: string, res: Record<string, unknown>): LiveDesktop | null {
  if (!res.up) return null
  return {
    sessionId,
    videoFrame: String(res.video_frame ?? ""),
    videoMjpeg: String(res.video_mjpeg ?? ""),
    bearer: String(res.bearer ?? ""),
    width: Number(res.width ?? 0),
    height: Number(res.height ?? 0),
  }
}

async function probe(sessionId: string): Promise<LiveDesktop | null> {
  try {
    const res = await discoveryClient.call("agent_desktop.info", { session_id: sessionId }, 6000)
    return toLiveDesktop(sessionId, res)
  } catch {
    return null // no_agent_desktop, unknown session, or a transient disconnect
  }
}

async function discoverOnce(): Promise<void> {
  if (!controlToken()) return // not paired yet — nothing to poll

  // Fast path: re-verify the session we already found before scanning again.
  const cur = liveDesktop()
  if (cur) {
    const still = await probe(cur.sessionId)
    if (still) {
      applyLiveDesktop(still)
      setDiscoveryError("")
      return
    }
  }

  try {
    const res = await discoveryClient.call("session.list", {}, 8000)
    const rows = (res.sessions ?? []) as SessionListRow[]
    const candidates = rows
      .filter((r) => typeof r.id === "string" && r.state !== "done" && r.state !== "error")
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, 6)
    const probed = await Promise.all(candidates.map((c) => probe(String(c.id))))
    const found = probed.find((r): r is LiveDesktop => r !== null) ?? null
    applyLiveDesktop(found)
    setDiscoveryError("")
  } catch (e) {
    // Daemon unreachable this tick — keep the last known state rather than
    // flapping the NavRail item off on a transient hiccup (home.tsx's
    // session-list poll does the same: surface the error, keep stale data).
    setDiscoveryError(String(e))
  }
}

let discoveryStarted = false
function ensureDiscoveryLoop(): void {
  if (discoveryStarted) return
  discoveryStarted = true
  void discoverOnce()
  setInterval(() => void discoverOnce(), 3500)
}
ensureDiscoveryLoop()

function ComputerPage() {
  const app = useApp()

  // Reflects "the user is currently looking at this page" into the module
  // signal above — the `currentIndex===computerIndex` half of NavRail.qml's
  // computerAvailable. App.tsx keeps every visited page mounted with
  // display:none rather than unmounting it, so onMount/onCleanup can't tell
  // us this; app.page() is the live signal for "which page is showing".
  createEffect(() => setViewingComputer(app.page() === "computer"))
  onCleanup(() => setViewingComputer(false))

  const [frameUrl, setFrameUrl] = createSignal<string | null>(null)
  const [frameError, setFrameError] = createSignal(false)
  const [takeOverConfirmOpen, setTakeOverConfirmOpen] = createSignal(false)
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null)
  const [driving, setDriving] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  // Plain (non-reactive) guard for the subscription effect below — it must
  // NOT be a signal: the effect both reads and writes it, and a signal
  // read-then-write inside its own effect makes Solid immediately re-trigger
  // that same effect, which fires the pump's onCleanup (cancelled = true)
  // before the subscribe()'d queue is ever read. Confirmed live: with this as
  // a signal, take_over.request/approval.respond round-tripped fine but the
  // approval card never appeared because the pump was torn down instantly.
  let subscribedSessionId = ""

  let objectUrl: string | null = null
  const swapFrame = (blob: Blob) => {
    const next = URL.createObjectURL(blob)
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = next
    setFrameUrl(next)
  }
  onCleanup(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  })

  // ---- live JPEG poll: authenticated fetch -> blob -> object URL ----------
  // Only runs while BOTH a live desktop is known AND the user is actually
  // looking at this page (QML's `wantMirror = pageVisible && hasLiveDesktop`).
  createEffect(() => {
    const info = liveDesktop()
    const watching = viewingComputer()
    if (!info || !watching) {
      setFrameError(false)
      return
    }
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      if (cancelled) return
      try {
        const res = await fetch(info.videoFrame, {
          headers: info.bearer ? { Authorization: `Bearer ${info.bearer}` } : {},
          cache: "no-store",
        })
        if (cancelled) return
        if (res.ok) {
          swapFrame(await res.blob())
          setFrameError(false)
        } else {
          setFrameError(true)
        }
      } catch {
        if (!cancelled) setFrameError(true)
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), 250) // ~4fps
    }
    void tick()

    onCleanup(() => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    })
  })

  // ---- session.event pump: watch for the approval + driving.state that
  // take_over.request/cancel produce (approval.respond answers the former;
  // ControlServer::setTakeOverActive broadcasts the latter as a normal
  // session-scoped event). ----------------------------------------------------
  createEffect(() => {
    const info = liveDesktop()
    if (!info) {
      setPendingApproval(null)
      setDriving(false)
      subscribedSessionId = ""
      return
    }
    if (subscribedSessionId === info.sessionId) return
    subscribedSessionId = info.sessionId
    setPendingApproval(null)
    setDriving(false)

    let cancelled = false
    void app.client.subscribe(info.sessionId).then(async (queue) => {
      while (!cancelled) {
        const ev = await queue.shift(2000) // periodic wake so `cancelled` is re-checked
        if (cancelled || !ev) continue
        const kind = String(ev.kind ?? "")
        if (kind === "approval" && String(ev.approval_id ?? "").startsWith("takeover-")) {
          setPendingApproval({
            approvalId: String(ev.approval_id ?? ""),
            summary: String(ev.summary ?? "Allow Cindro to drive your real screen?"),
            risk: String(ev.risk ?? "high"),
            sessionId: info.sessionId,
          })
        } else if (kind === "driving.state") {
          setDriving(Boolean(ev.active))
          if (ev.active) setPendingApproval(null)
        }
      }
    })

    onCleanup(() => {
      cancelled = true
      void app.client.unsubscribe(info.sessionId)
    })
  })

  const requestTakeOver = async () => {
    const info = liveDesktop()
    if (!info) return
    setBusy(true)
    try {
      const res = await app.client.call("take_over.request", { session_id: info.sessionId }, 15000)
      app.notify(
        res.pending_approval ? "Take-over requested — waiting for approval…" : "Take-over requested.",
        "warn",
      )
    } catch (e) {
      app.notify(`Take-over request failed: ${String(e)}`, "error")
    } finally {
      setBusy(false)
    }
  }

  const cancelTakeOver = async () => {
    const info = liveDesktop()
    setBusy(true)
    try {
      await app.client.call("take_over.cancel", info ? { session_id: info.sessionId } : {}, 15000)
      setDriving(false)
      setPendingApproval(null)
      app.notify("Take-over released.", "info")
    } catch (e) {
      app.notify(`Release failed: ${String(e)}`, "error")
    } finally {
      setBusy(false)
    }
  }

  const respond = async (decision: "allow" | "always" | "deny") => {
    const a = pendingApproval()
    if (!a) return
    setBusy(true)
    try {
      await app.client.call(
        "approval.respond",
        { session_id: a.sessionId, approval_id: a.approvalId, decision },
        15000,
      )
      setPendingApproval(null)
      if (decision === "deny") app.notify("Take-over denied.", "warn")
    } catch (e) {
      app.notify(`Approval response failed: ${String(e)}`, "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="computer-page page-enter">
      <style>{COMPUTER_CSS}</style>

      <div class="computer-header">
        <div>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>
            COMPUTER
          </div>
          <div class="computer-subtitle">Watch Cindro drive a desktop, or hand it your real screen.</div>
        </div>
        <Show when={driving()}>
          <div class="computer-driving-badge">
            <span class="computer-driving-dot" />
            DRIVING REAL SCREEN
          </div>
        </Show>
      </div>

      <Show
        when={liveDesktop()}
        fallback={
          <div class="computer-empty card">
            <ArcReactor size={72} />
            <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "13px" }}>
              NO ACTIVE SESSION
            </div>
            <p class="computer-empty-text">
              Open a chat and have Cindro use its computer, and this page will start watching it live.
            </p>
            <button type="button" class="computer-btn primary" onClick={() => app.navigate("chat")}>
              Open Chat
            </button>
            <Show when={discoveryError()}>
              <div class="setup-error">⚠ {discoveryError()}</div>
            </Show>
          </div>
        }
      >
        {(info) => (
          <div class="computer-layout">
            <div class="computer-preview card">
              <div class="computer-preview-head">
                <span class="hud-label computer-preview-label">NESTED AGENT DESKTOP</span>
                <span class="computer-session-id" title={info().sessionId}>
                  {info().sessionId}
                </span>
              </div>
              <div class="computer-frame">
                <Show
                  when={frameUrl() && !frameError()}
                  fallback={
                    <div class="computer-frame-empty">
                      <ArcReactor size={64} />
                      <span class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "12px" }}>
                        {frameError() ? "PREVIEW UNAVAILABLE" : "CONNECTING TO AGENT DESKTOP…"}
                      </span>
                    </div>
                  }
                >
                  <img class="computer-frame-img" src={frameUrl() ?? undefined} alt="Live agent desktop" />
                  <div class="computer-live-banner">⚡ Cindro is using this desktop</div>
                </Show>
              </div>
            </div>

            <div class="computer-side card">
              <span class="hud-label computer-preview-label">TAKE OVER</span>
              <p class="computer-side-text">
                Cindro will drive your ACTUAL desktop with a distinct cursor and a "CINDRO IS DRIVING"
                overlay. This requires approval, and you can release control at any time.
              </p>

              <Show when={pendingApproval()}>
                {(a) => (
                  <div class="computer-approval">
                    <div class="computer-approval-summary">✋ {a().summary}</div>
                    <div class="computer-approval-actions">
                      <button
                        type="button"
                        class="computer-btn"
                        disabled={busy()}
                        onClick={() => void respond("allow")}
                      >
                        Allow
                      </button>
                      <button
                        type="button"
                        class="computer-btn"
                        disabled={busy()}
                        onClick={() => void respond("always")}
                      >
                        Always
                      </button>
                      <button
                        type="button"
                        class="computer-btn danger"
                        disabled={busy()}
                        onClick={() => void respond("deny")}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                )}
              </Show>

              <Show
                when={!driving()}
                fallback={
                  <button
                    type="button"
                    class="computer-btn danger"
                    disabled={busy()}
                    onClick={() => void cancelTakeOver()}
                  >
                    Release screen
                  </button>
                }
              >
                <button
                  type="button"
                  class="computer-btn amber"
                  disabled={busy() || Boolean(pendingApproval())}
                  onClick={() => setTakeOverConfirmOpen(true)}
                >
                  Take over my screen
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={takeOverConfirmOpen()}>
        <div class="computer-modal-backdrop" onClick={() => setTakeOverConfirmOpen(false)}>
          <div class="computer-modal" onClick={(e) => e.stopPropagation()}>
            <div class="computer-modal-title">
              <span>⚠</span> TAKE OVER MY SCREEN
            </div>
            <p class="computer-side-text">
              Cindro will drive your ACTUAL desktop with a distinct cursor and a "CINDRO IS DRIVING"
              overlay. This requires approval, and you can release control at any time.
            </p>
            <div class="computer-modal-actions">
              <button type="button" class="computer-btn" onClick={() => setTakeOverConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                class="computer-btn amber"
                onClick={() => {
                  setTakeOverConfirmOpen(false)
                  void requestTakeOver()
                }}
              >
                Request take-over
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

const COMPUTER_CSS = `
.computer-page { display: flex; flex-direction: column; gap: 16px; max-width: 1180px; }
.computer-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.computer-subtitle { color: var(--text-muted); font-size: 12px; margin-top: 4px; }

.computer-driving-badge {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 14px; border-radius: var(--radius-xs);
  background: var(--danger-dim); border: 1px solid var(--danger);
  color: var(--danger); font-family: var(--font-display); font-size: 9px;
  letter-spacing: var(--track-mid); font-weight: 600;
}
.computer-driving-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--danger);
  animation: computer-blink 900ms ease-in-out infinite;
}
@keyframes computer-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

.computer-empty {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 48px 24px; text-align: center;
  background: linear-gradient(135deg, var(--surface) 0%, var(--surface-strong) 100%);
  border-color: var(--accent-dim);
}
.computer-empty-text { color: var(--text-faint); font-size: 12px; max-width: 380px; line-height: 1.5; margin: 0; }

.computer-layout { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(240px, 1fr); gap: 16px; align-items: start; }
@media (max-width: 860px) { .computer-layout { grid-template-columns: 1fr; } }

.computer-preview, .computer-side { display: flex; flex-direction: column; gap: 12px; }
.computer-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.computer-preview-label { color: var(--accent); opacity: 0.85; font-size: 10px; }
.computer-session-id {
  color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.computer-frame {
  position: relative;
  min-height: 340px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--hairline-soft);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.computer-frame-img { display: block; width: 100%; height: 100%; object-fit: contain; }
.computer-frame-empty { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.computer-live-banner {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  padding: 7px 16px; border-radius: 999px;
  background: rgba(10, 14, 22, 0.92); border: 1px solid var(--accent);
  color: var(--text); font-size: 12px; font-weight: 500;
  box-shadow: 0 0 16px -4px var(--accent-glow);
}

.computer-side-text { color: var(--text-muted); font-size: 12px; line-height: 1.5; margin: 0; }

.computer-approval {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px; border-radius: var(--radius-sm);
  background: var(--danger-dim); border: 1px solid var(--danger);
}
.computer-approval-summary { color: var(--text); font-size: 12.5px; font-weight: 500; }
.computer-approval-actions { display: flex; gap: 8px; }

.computer-btn {
  all: unset; cursor: pointer; padding: 9px 16px; border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft); background: var(--surface); color: var(--text-muted);
  font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-tight);
  text-align: center; white-space: nowrap;
  transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease,
    background var(--dur-fast) ease, transform var(--dur-fast) ease;
}
.computer-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); transform: translateY(-1px); }
.computer-btn:active:not(:disabled) { transform: translateY(0); }
.computer-btn:disabled { opacity: 0.5; cursor: default; }
.computer-btn.primary { background: var(--accent-dim); border-color: var(--accent-dim); color: var(--accent-bright); }
.computer-btn.primary:hover:not(:disabled) { background: var(--accent-faint); border-color: var(--accent); }
.computer-btn.amber { border-color: var(--amber); color: var(--amber); }
.computer-btn.amber:hover:not(:disabled) { background: var(--amber-dim); }
.computer-btn.danger { border-color: var(--danger); color: var(--danger); }
.computer-btn.danger:hover:not(:disabled) { background: var(--danger-dim); }

.computer-modal-backdrop {
  position: fixed; inset: 0; z-index: 250; background: rgba(4,7,12,0.6);
  display: flex; align-items: center; justify-content: center;
}
.computer-modal {
  width: 440px; max-width: calc(100vw - 32px);
  background: var(--surface-strong); border: 1px solid var(--amber-dim); border-radius: var(--radius);
  padding: 22px; display: flex; flex-direction: column; gap: 14px;
}
.computer-modal-title {
  display: flex; align-items: center; gap: 10px;
  color: var(--amber); font-family: var(--font-display); font-size: 15px;
  font-weight: 600; letter-spacing: var(--track-mid);
}
.computer-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
`

const page: PageDef = {
  id: "computer",
  label: "COMPUTER",
  section: "WORKSPACE",
  order: 3,
  gated: () => viewingComputer() || liveDesktop() !== null,
  component: ComputerPage,
}
export default page
