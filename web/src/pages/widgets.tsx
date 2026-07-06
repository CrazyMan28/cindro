// WIDGETS — the PERSISTENT saved-widget library, ported from
// desktop/qml/WidgetsPage.qml's intent.
//
// GAP (documented per this build's shared context): there is NO daemon RPC
// for this library. The desktop GUI and TUI both read/write
// ~/.local/share/jarvis/saved_widgets.json directly via native filesystem
// access (tui/src/widgets/store.ts's loadLibrary/saveLibrary; Bridge.cpp's
// saveWidget/refreshSavedWidgets) — a browser tab has no filesystem access
// and Contract A's verb list has nothing analogous (only widget.subscribe +
// the widget.render/remove/clear BROADCASTS, which are canvas.tsx's live
// feed, not a library). So THIS PAGE KEEPS ITS OWN STORE in the browser's
// localStorage under "jarvis.web.savedWidgets" — a browser-local library,
// NOT synced with the GUI/TUI's shared saved_widgets.json file. It also has
// no way to write into home.tsx's rendered layout (a different page/owner),
// so "pin to Home" only sets a local `pinned` flag and reorders this list —
// it does not (yet) cause anything to appear on the Home page.
import { createSignal, For, Show } from "solid-js"

import type { PageDef } from "../core/router"
import { theme } from "../core/theme"
import { NavIcon } from "../components/NavIcon"
import { WidgetTree } from "../components/WidgetRenderer"

const STORAGE_KEY = "jarvis.web.savedWidgets"

export interface SavedWidget {
  id: string
  name: string
  spec: Record<string, unknown>
  pinned: boolean
  savedAt: number
}

function readStore(): SavedWidget[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (w): w is SavedWidget => Boolean(w) && typeof w === "object" && typeof (w as SavedWidget).id === "string",
    )
  } catch {
    return []
  }
}

function writeStore(list: SavedWidget[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // best-effort — private-browsing / quota-exceeded writes just mean this
    // save silently doesn't persist; nothing here is fatal to the page.
  }
}

// Module-level signal (same rationale as canvas.tsx's live-feed store): lets
// canvas.tsx's ★ button update this page's list live even before the user
// has ever opened the Widgets page this session.
const [savedWidgets, setSavedWidgets] = createSignal<SavedWidget[]>(readStore())

/** The one cross-file coupling in this unit: canvas.tsx's ★ "save to
 * library" button calls this directly to persist a live widget here. */
export function saveWidgetToLibrary(entry: { id?: string; name: string; spec: Record<string, unknown> }): string {
  const id = entry.id && entry.id.trim() ? entry.id : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  setSavedWidgets((list) => {
    const existing = list.find((w) => w.id === id)
    const next: SavedWidget = {
      id,
      name: entry.name || "Widget",
      spec: entry.spec,
      pinned: existing?.pinned ?? false,
      savedAt: Date.now(),
    }
    const merged = [next, ...list.filter((w) => w.id !== id)]
    writeStore(merged)
    return merged
  })
  return id
}

function removeSavedWidget(id: string): void {
  setSavedWidgets((list) => {
    const next = list.filter((w) => w.id !== id)
    writeStore(next)
    return next
  })
}

function togglePinned(id: string): void {
  setSavedWidgets((list) => {
    const next = list.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w))
    writeStore(next)
    return next
  })
}

function relTime(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function WidgetsPage() {
  const sorted = () =>
    [...savedWidgets()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.savedAt - a.savedAt)

  return (
    <div class="jw-page">
      <style>{CSS}</style>
      <div class="jw-header">
        <div class="hud-label jw-title">WIDGETS</div>
        <div class="jw-subtitle">
          Your reusable widget library, saved locally in this browser. Save a live widget from Canvas (★) to keep it
          here, then pin it or delete it.
        </div>
      </div>

      <Show
        when={sorted().length > 0}
        fallback={
          <div class="jw-empty">
            <div class="jw-empty-icon">
              <NavIcon glyph="widgets" color={theme.amber} glow />
            </div>
            <div class="jw-empty-title">No saved widgets yet</div>
            <div class="jw-empty-sub">On the Canvas page, tap ★ on a live widget to save it here.</div>
          </div>
        }
      >
        <div class="jw-list">
          <For each={sorted()}>
            {(w, i) => (
              <div
                class="jw-card card"
                classList={{ "jw-card-pinned": w.pinned }}
                style={{ "animation-delay": `${Math.min(i() * 40, 320)}ms` }}
              >
                <div class="jw-card-accent" />
                <div class="jw-card-head">
                  <span class="jw-card-title">
                    {w.pinned ? "📌 " : "★ "}
                    {w.name}
                  </span>
                  <span class="jw-card-time">{relTime(w.savedAt)}</span>
                  <button
                    type="button"
                    class="jw-pill"
                    classList={{ active: w.pinned }}
                    onClick={() => togglePinned(w.id)}
                  >
                    {w.pinned ? "Unpin" : "📌 Pin to Home"}
                  </button>
                  <button
                    type="button"
                    class="jw-icon-btn jw-icon-danger"
                    title="Delete"
                    onClick={() => removeSavedWidget(w.id)}
                  >
                    ✕
                  </button>
                </div>
                <div class="jw-card-body">
                  <WidgetTree spec={w.spec} />
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
.jw-page { display: flex; flex-direction: column; gap: 18px; max-width: 980px; }
.jw-header { display: flex; flex-direction: column; gap: 4px; }
.jw-title { color: var(--amber); font-size: 20px; }
.jw-subtitle { color: var(--text-muted); font-size: 13px; }

.jw-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 72px 20px;
  text-align: center;
}
.jw-empty-icon {
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: scale(2.6);
  opacity: 0.7;
  animation: jw-icon-pulse var(--pulse) ease-in-out infinite;
}
@keyframes jw-icon-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.9; } }
.jw-empty-title {
  font-family: var(--font-display);
  letter-spacing: var(--track-mid);
  color: var(--text-muted);
  font-size: 13px;
  text-transform: uppercase;
}
.jw-empty-sub { color: var(--text-faint); font-size: 12px; max-width: 360px; }

.jw-list { display: flex; flex-direction: column; gap: 12px; }
.jw-card {
  position: relative;
  padding-left: 26px;
  animation: jw-card-in var(--dur-slow) ease-out backwards;
  transition: transform var(--dur-fast) ease, box-shadow var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
.jw-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -8px rgba(255, 180, 84, 0.35);
  border-color: var(--amber-dim);
}
.jw-card.jw-card-pinned { border-color: var(--amber-dim); box-shadow: inset 0 0 0 1px var(--amber-dim); }
@keyframes jw-card-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.jw-card-accent {
  position: absolute;
  left: 10px;
  top: 14px;
  bottom: 14px;
  width: 3px;
  border-radius: 1.5px;
  background: var(--amber);
  opacity: 0.7;
}
.jw-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.jw-card-title {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  font-size: 13px;
  color: var(--text);
}
.jw-card-time { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; margin-left: auto; }
.jw-pill {
  all: unset;
  cursor: pointer;
  padding: 5px 12px;
  border-radius: 999px;
  font-family: var(--font-display);
  font-size: 10px;
  letter-spacing: var(--track-mid);
  border: 1px solid var(--hairline-soft);
  color: var(--text-muted);
  transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease, background var(--dur-fast) ease;
}
.jw-pill:hover { border-color: var(--amber-dim); color: var(--amber); }
.jw-pill.active { background: var(--amber-dim); border-color: var(--amber); color: var(--amber); }
.jw-icon-btn {
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
.jw-icon-btn:hover { background: var(--surface-strong); border-color: var(--hairline); color: var(--amber); }
.jw-icon-btn.jw-icon-danger:hover { background: var(--danger-dim); border-color: var(--danger); color: var(--danger); }
`

const page: PageDef = { id: "widgets", label: "WIDGETS", section: "WORKSPACE", order: 5, component: WidgetsPage }
export default page
