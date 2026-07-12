// CANVAS — the LIVE ephemeral widget feed, ported from desktop/qml/CanvasPage.qml
// and tui/src/widgets/store.ts's CanvasStore + tui/src/pages/Canvas.tsx. The model
// calls the engine's render_widget MCP tool; the daemon fans that out as
// widget.render/widget.remove/widget.clear broadcasts. We subscribe once
// (widget.subscribe, best-effort — some daemon builds broadcast to everyone
// regardless) then listen with the multi-subscriber bus (client.on("widget.", …)),
// newest-on-top, update-by-id, capped at 20 — exact CanvasStore semantics.
//
// The live-feed signal lives at MODULE scope (outside the page component) so it
// keeps accumulating in the background once wired, independent of whether the
// user is currently looking at this tab — this app's router keeps every visited
// page mounted (just display:none) rather than tearing it down, so once Canvas
// has been opened once this session the subscription and its backlog survive
// nav away/back exactly like the QML version's bridge-held ListModel does.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { theme } from "../core/theme"
import { NavIcon } from "../components/NavIcon"
import { WidgetTree, type WidgetAction } from "../components/WidgetRenderer"
import { saveWidgetToLibrary } from "./widgets"

export interface CanvasItem {
  id: string
  title: string
  spec: Record<string, unknown>
  at: number
}

const CANVAS_CAP = 20
let anonSeq = 0
let wired = false

const [canvasItems, setCanvasItems] = createSignal<CanvasItem[]>([])

function parseSpec(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
}

function onWidgetEvent(event: string, data: Record<string, unknown>): void {
  if (event === "widget.clear") {
    setCanvasItems([])
    return
  }
  const id = String(data.id ?? "")
  if (event === "widget.remove") {
    if (!id) return
    setCanvasItems((items) => items.filter((i) => i.id !== id))
    return
  }
  if (event !== "widget.render") return
  const item: CanvasItem = {
    id: id || `anon-${++anonSeq}`,
    title: String(data.title ?? "") || "Widget",
    spec: parseSpec(data.spec ?? data.widget),
    at: Date.now(),
  }
  setCanvasItems((items) => {
    const rest = items.filter((i) => i.id !== item.id)
    return [item, ...rest].slice(0, CANVAS_CAP) // newest on top, capped
  })
}

function relTime(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function CanvasPage() {
  const app = useApp()
  const [status, setStatus] = createSignal("")
  const [connected, setConnected] = createSignal(app.client.connected)

  onMount(() => {
    const trySubscribe = () => {
      // Some daemon builds gate widget.* to widget.subscribe'd sockets; older
      // ones broadcast to everyone. Best-effort either way — never invented,
      // widget.subscribe is the confirmed Contract A verb for this feed.
      void app.client.call("widget.subscribe", {}, 15000).catch(() => {})
    }
    if (!wired) {
      wired = true
      trySubscribe()
    }
    let lastConnected = app.client.connected
    const poll = setInterval(() => {
      const now = app.client.connected
      setConnected(now)
      if (now && !lastConnected) trySubscribe() // re-arm after a reconnect
      lastConnected = now
    }, 1500)
    const off = app.client.on("widget.", onWidgetEvent)
    onCleanup(() => {
      clearInterval(poll)
      off()
    })
  })

  const sendAsChat = async (text: string) => {
    try {
      const created = await app.client.call("session.create", { profile: "coworker" }, 20000)
      const sid = String(created.session_id ?? "")
      if (!sid) throw new Error("session.create returned no session_id")
      await app.client.call("session.send", { session_id: sid, text }, 30000)
      app.notify("Sent — opening Chat.", "info")
      app.navigate("chat")
    } catch (e) {
      app.notify(`Couldn't send: ${String(e)}`, "error")
    }
  }

  const invokeSkill = async (name: string, args: string) => {
    try {
      const params: Record<string, unknown> = { name }
      if (args.trim()) params.args = args.trim()
      const res = await app.client.call("skills.invoke", params, 30000)
      app.notify(String(res.message ?? `Invoked "${name}".`), "info")
    } catch (e) {
      app.notify(`Skill failed: ${String(e)}`, "error")
    }
  }

  const handleAction = (action: WidgetAction) => {
    if (action.send) void sendAsChat(action.send)
    else if (action.skill) void invokeSkill(action.skill, action.args ?? "")
  }

  const save = (item: CanvasItem) => {
    saveWidgetToLibrary({ id: item.id, name: item.title, spec: item.spec })
    setStatus(`★ saved "${item.title}" to the widget library`)
    setTimeout(() => setStatus(""), 2600)
  }

  // Canvas-local removal only — there is no Contract A verb to delete a
  // widget on the daemon side (widget.render/remove/clear are broadcasts WE
  // receive; there's no "widget.delete" call in the confirmed RPC surface),
  // so this just drops it from this tab's live view, same as CanvasStore's
  // own remove() in tui/src/widgets/store.ts.
  const remove = (id: string) => {
    setCanvasItems((items) => items.filter((i) => i.id !== id))
  }

  return (
    <div class="jc-page">
      <style>{CSS}</style>
      <div class="jc-header">
        <div class="hud-label jc-title">CANVAS</div>
        <div class="jc-subtitle">
          Widgets Cindro renders for you. Ask it to draw or show something visual.
          <Show when={!connected()}> · connecting to the daemon…</Show>
        </div>
      </div>

      <Show when={status()}>
        <div class="jc-toast">{status()}</div>
      </Show>

      <Show
        when={canvasItems().length > 0}
        fallback={
          <div class="jc-empty">
            <div class="jc-empty-icon">
              <NavIcon glyph="canvas" color={theme.accent} glow />
            </div>
            <div class="jc-empty-title">No widgets yet</div>
            <div class="jc-empty-sub">Cindro-rendered widgets appear here live. Try: "show me a duck".</div>
          </div>
        }
      >
        <div class="jc-list">
          <For each={canvasItems()}>
            {(item, i) => (
              <div class="jc-card card" style={{ "animation-delay": `${Math.min(i() * 40, 320)}ms` }}>
                <div class="jc-card-accent" />
                <div class="jc-card-head">
                  <span class="jc-card-title">{item.title}</span>
                  <span class="jc-card-time">{relTime(item.at)}</span>
                  <button type="button" class="jc-icon-btn" title="Save to library" onClick={() => save(item)}>
                    ★
                  </button>
                  <button
                    type="button"
                    class="jc-icon-btn jc-icon-danger"
                    title="Remove"
                    onClick={() => remove(item.id)}
                  >
                    ✕
                  </button>
                </div>
                <div class="jc-card-body">
                  <WidgetTree spec={item.spec} onAction={handleAction} />
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const CSS = `
.jc-page { display: flex; flex-direction: column; gap: 18px; max-width: 980px; }
.jc-header { display: flex; flex-direction: column; gap: 4px; }
.jc-title { color: var(--accent-bright); font-size: 20px; }
.jc-subtitle { color: var(--text-muted); font-size: 13px; }
.jc-toast {
  align-self: flex-start;
  padding: 6px 14px;
  border-radius: var(--radius-xs);
  background: var(--accent-faint);
  border: 1px solid var(--accent-dim);
  color: var(--accent-bright);
  font-size: 12px;
  animation: jc-toast-in var(--dur-mid) ease-out;
}
@keyframes jc-toast-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

.jc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 72px 20px;
  text-align: center;
}
.jc-empty-icon {
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: scale(2.6);
  opacity: 0.7;
  animation: jc-icon-pulse var(--pulse) ease-in-out infinite;
}
@keyframes jc-icon-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.9; } }
.jc-empty-title {
  font-family: var(--font-display);
  letter-spacing: var(--track-mid);
  color: var(--text-muted);
  font-size: 13px;
  text-transform: uppercase;
}
.jc-empty-sub { color: var(--text-faint); font-size: 12px; max-width: 360px; }

.jc-list { display: flex; flex-direction: column; gap: 12px; }
.jc-card {
  position: relative;
  padding-left: 26px;
  animation: jc-card-in var(--dur-slow) ease-out backwards;
  transition: transform var(--dur-fast) ease, box-shadow var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
.jc-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -8px var(--accent-glow);
  border-color: var(--accent-dim);
}
@keyframes jc-card-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.jc-card-accent {
  position: absolute;
  left: 10px;
  top: 14px;
  bottom: 14px;
  width: 3px;
  border-radius: 1.5px;
  background: var(--accent);
  opacity: 0.7;
}
.jc-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.jc-card-title {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  font-size: 13px;
  color: var(--text);
}
.jc-card-time { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; margin-left: auto; }
.jc-icon-btn {
  all: unset;
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  border: 1px solid transparent;
  font-size: 13px;
  flex-shrink: 0;
  transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease;
}
.jc-icon-btn:hover { background: var(--surface-strong); border-color: var(--hairline); color: var(--amber); }
.jc-icon-btn.jc-icon-danger:hover { background: var(--danger-dim); border-color: var(--danger); color: var(--danger); }
`

const page: PageDef = { id: "canvas", label: "CANVAS", section: "WORKSPACE", order: 4, component: CanvasPage }
export default page
