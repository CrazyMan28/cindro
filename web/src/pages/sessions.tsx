// SESSIONS — ported from desktop/qml/SessionsPage.qml: the full list of
// stored top-level sessions (parent_session_id empty; subagent children are
// grouped into a live "✦ n" badge on their parent, same as the QML original),
// searchable + filterable by state, with an open-in-Chat action, a two-step
// (arm + confirm) delete via session.delete, and a "▶ REPLAY" action that
// opens Mission Control Replay (./replay.tsx) on that session.
//
// Field names below are the daemon's real wire shape — SessionRow::toJson()
// in core/src/SessionStore.cpp (id/title/brain/model/state/
// parent_session_id/agent/updated, updated in unix ms) — not guessed.
//
// Cross-page handoff: core/router.ts's AppApi.navigate(id) carries no
// params, so "open in Chat" / "open in Replay" hand the target session id to
// the destination page via sessionStorage under well-known jarvis.web.* keys
// (the same kind of documented workaround the widget-library gap uses
// localStorage for). replay.tsx reads + clears "jarvis.web.replayTarget" on
// mount; chat.tsx (once built) should do the same for
// "jarvis.web.openSessionId" to resume that thread directly instead of
// starting a new one.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"

interface SessionRow {
  id: string
  title: string
  brain: string
  model: string
  state: string
  agent: string
  updated: number
}

type FilterState = "all" | "running" | "idle" | "done" | "error"
const FILTERS: FilterState[] = ["all", "running", "idle", "done", "error"]

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}
function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function relTime(ms: number): string {
  if (!ms || ms <= 0) return "—"
  const diff = Date.now() - ms
  if (diff < 60000) return "just now"
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function stateColor(st: string): string {
  if (st === "running" || st === "starting") return "var(--accent)"
  if (st === "error") return "var(--danger)"
  if (st === "done") return "var(--success)"
  return "var(--text-faint)"
}

function SessionsPage() {
  const app = useApp()
  const [rows, setRows] = createSignal<SessionRow[]>([])
  const [liveKids, setLiveKids] = createSignal<Record<string, number>>({})
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [search, setSearch] = createSignal("")
  const [filter, setFilter] = createSignal<FilterState>("all")
  const [confirming, setConfirming] = createSignal("")
  let alive = true
  onCleanup(() => {
    alive = false
  })

  const load = async () => {
    try {
      const res = await app.client.call("session.list", {}, 15000)
      if (!alive) return
      const all = (res.sessions ?? []) as Record<string, unknown>[]

      // Subagent CHILD sessions (non-empty parent_session_id) never render as
      // top-level rows — they roll up into their parent's live "✦ n" badge
      // while running/starting, same grouping as SessionsPage.qml.
      const kids: Record<string, number> = {}
      for (const s of all) {
        const par = str(s.parent_session_id)
        const st = str(s.state)
        if (par && (st === "running" || st === "starting")) kids[par] = (kids[par] ?? 0) + 1
      }

      const top = all
        .filter((s) => !str(s.parent_session_id))
        .map(
          (s): SessionRow => ({
            id: str(s.id),
            title: str(s.title) || "Untitled session",
            brain: str(s.brain),
            model: str(s.model),
            state: str(s.state) || "idle",
            agent: str(s.agent),
            updated: num(s.updated),
          }),
        )
        .sort((a, b) => b.updated - a.updated)

      setRows(top)
      setLiveKids(kids)
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(load, 10000)
    onCleanup(() => clearInterval(timer))
  })

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase()
    const f = filter()
    return rows().filter((s) => {
      if (f !== "all") {
        const isRunning = s.state === "running" || s.state === "starting"
        if (f === "running" ? !isRunning : s.state !== f) return false
      }
      if (!q) return true
      return (
        s.title.toLowerCase().includes(q) ||
        s.brain.toLowerCase().includes(q) ||
        s.model.toLowerCase().includes(q)
      )
    })
  })

  const openInChat = (id: string) => {
    sessionStorage.setItem("jarvis.web.openSessionId", id)
    app.navigate("chat")
  }

  const newChat = () => {
    sessionStorage.removeItem("jarvis.web.openSessionId")
    app.navigate("chat")
  }

  const openReplay = (s: SessionRow) => {
    sessionStorage.setItem("jarvis.web.replayTarget", JSON.stringify({ id: s.id, title: s.title }))
    app.navigate("replay")
  }

  const doDelete = async (id: string) => {
    setConfirming("")
    setRows((r) => r.filter((s) => s.id !== id)) // optimistic
    try {
      await app.client.call("session.delete", { session_id: id }, 15000)
    } catch (e) {
      app.notify(`Delete failed: ${String(e)}`, "error")
    }
    void load()
  }

  return (
    <div class="sess-page">
      <style>{sessionsCss}</style>

      <div class="sess-header">
        <div>
          <div class="hud-label sess-title">SESSIONS</div>
          <div class="sess-subtitle">Open a past conversation to resume it in Chat, or start a new one.</div>
        </div>
        <div class="sess-header-actions">
          <button type="button" class="sess-btn sess-btn-primary" onClick={newChat}>
            + New chat
          </button>
          <button type="button" class="sess-btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      <div class="sess-toolbar">
        <input
          class="sess-search"
          type="text"
          placeholder="Search sessions…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <div class="sess-filters">
          <For each={FILTERS}>
            {(f) => (
              <button
                type="button"
                class="sess-filter-chip"
                classList={{ active: filter() === f }}
                onClick={() => setFilter(f)}
              >
                {f.toUpperCase()}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading() && !error() && filtered().length === 0}>
        <div class="sess-empty card">
          <div class="hud-label" style={{ color: "var(--text-muted)" }}>
            {rows().length === 0 ? "No sessions yet" : "No sessions match"}
          </div>
          <div class="sess-empty-sub">
            {rows().length === 0
              ? "Start a conversation on the Chat page and it will appear here."
              : "Try a different search term or filter."}
          </div>
        </div>
      </Show>

      <div class="sess-list">
        <For each={filtered()}>
          {(s, i) => (
            <div
              class="sess-row"
              classList={{ confirming: confirming() === s.id }}
              style={{ "animation-delay": `${Math.min(i(), 12) * 22}ms` }}
            >
              <div class="sess-row-node">
                <div class="sess-row-spine" />
                <div class="sess-row-dot-ring" style={{ "border-color": stateColor(s.state) }}>
                  <div
                    class="sess-row-dot"
                    classList={{ pulsing: s.state === "running" }}
                    style={{ background: stateColor(s.state) }}
                  />
                </div>
              </div>

              <button type="button" class="sess-row-body" onClick={() => openInChat(s.id)}>
                <div class="sess-row-title">{s.title}</div>
                <div class="sess-row-meta">
                  <span class="sess-row-brain">
                    {s.brain}
                    {s.model ? ` · ${s.model}` : ""}
                  </span>
                  <span class="sess-row-open">→ OPEN</span>
                </div>
              </button>

              <div class="sess-row-right">
                <Show when={(liveKids()[s.id] ?? 0) > 0}>
                  <span class="sess-badge sess-badge-live">✦ {liveKids()[s.id]}</span>
                </Show>
                <span
                  class="sess-badge"
                  style={{ color: stateColor(s.state), "border-color": stateColor(s.state) }}
                >
                  {s.state.toUpperCase()}
                </span>
                <span class="sess-row-time">{relTime(s.updated)}</span>
              </div>

              <div class="sess-row-actions">
                <Show
                  when={confirming() !== s.id}
                  fallback={
                    <div class="sess-confirm">
                      <button type="button" class="sess-confirm-delete" onClick={() => void doDelete(s.id)}>
                        DELETE
                      </button>
                      <button type="button" class="sess-confirm-cancel" onClick={() => setConfirming("")}>
                        ✕
                      </button>
                    </div>
                  }
                >
                  <button type="button" class="sess-action-btn" onClick={() => openReplay(s)}>
                    ▶ REPLAY
                  </button>
                  <button
                    type="button"
                    class="sess-action-icon"
                    title="Delete"
                    onClick={() => setConfirming(s.id)}
                  >
                    🗑
                  </button>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

const sessionsCss = `
.sess-page { display:flex; flex-direction:column; gap:16px; max-width:980px; }
.sess-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.sess-title { font-size:20px; color:var(--accent-bright); }
.sess-subtitle { color:var(--text-muted); font-size:13px; margin-top:4px; }
.sess-header-actions { display:flex; gap:8px; }
.sess-btn { all:unset; cursor:pointer; padding:8px 16px; border-radius:var(--radius-sm); border:1px solid var(--hairline-soft); background:var(--surface); color:var(--text-muted); font-family:var(--font-display); font-size:11px; letter-spacing:var(--track-mid); transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease, transform var(--dur-fast) ease; }
.sess-btn:hover { border-color:var(--accent-dim); color:var(--text); transform:translateY(-1px); }
.sess-btn-primary { background:var(--accent-dim); border-color:var(--accent-dim); color:var(--accent-bright); }
.sess-btn-primary:hover { background:var(--accent-faint); border-color:var(--accent); }

.sess-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.sess-search { all:unset; flex:1; min-width:180px; max-width:320px; box-sizing:border-box; background:var(--surface-input); border:1px solid var(--hairline-soft); border-radius:var(--radius-sm); padding:8px 12px; color:var(--text); font-size:13px; transition:border-color var(--dur-fast) ease; }
.sess-search:focus { border-color:var(--accent-dim); }
.sess-search::placeholder { color:var(--text-faint); }
.sess-filters { display:flex; gap:6px; flex-wrap:wrap; }
.sess-filter-chip { all:unset; cursor:pointer; padding:5px 12px; border-radius:999px; border:1px solid var(--hairline-soft); color:var(--text-faint); font-family:var(--font-display); font-size:9px; letter-spacing:var(--track-mid); transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease, background var(--dur-fast) ease; }
.sess-filter-chip:hover { color:var(--text); border-color:var(--accent-dim); }
.sess-filter-chip.active { color:var(--accent-bright); border-color:var(--accent); background:var(--accent-dim); }

.sess-empty { display:flex; flex-direction:column; align-items:center; gap:6px; padding:40px 16px; text-align:center; }
.sess-empty-sub { color:var(--text-faint); font-size:12px; }

.sess-list { display:flex; flex-direction:column; gap:9px; }
.sess-row {
  position:relative;
  display:flex;
  align-items:center;
  gap:14px;
  padding:0 50px 0 15px;
  min-height:70px;
  border-radius:var(--radius-sm);
  background:var(--panel-soft);
  border:1px solid var(--hairline-faint);
  transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, padding-right var(--dur-mid) ease;
  animation: sess-row-in var(--dur-slow) ease-out backwards;
}
.sess-row:hover { background:var(--surface-strong); border-color:var(--accent-dim); }
.sess-row.confirming { padding-right:160px; }
@keyframes sess-row-in { from{opacity:0; transform:translateY(6px);} to{opacity:1; transform:translateY(0);} }

.sess-row-node { position:relative; width:16px; align-self:stretch; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.sess-row-spine { position:absolute; top:0; bottom:0; width:1px; background:var(--hairline-soft); opacity:0.6; }
.sess-row-dot-ring { position:relative; width:14px; height:14px; border-radius:50%; background:var(--bg-deep); border:1.3px solid; display:flex; align-items:center; justify-content:center; box-sizing:border-box; }
.sess-row-dot { width:7px; height:7px; border-radius:50%; }
.sess-row-dot.pulsing { animation: sess-dot-pulse 700ms ease-in-out infinite alternate; }
@keyframes sess-dot-pulse { from{opacity:1;} to{opacity:0.3;} }

.sess-row-body { all:unset; flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; cursor:pointer; }
.sess-row-title { color:var(--text); font-size:14px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sess-row-meta { display:flex; align-items:center; gap:8px; }
.sess-row-brain { color:var(--text-muted); font-family:var(--font-mono); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sess-row-open { color:var(--accent); font-family:var(--font-display); font-size:9px; letter-spacing:var(--track-mid); opacity:0; transition:opacity var(--dur-fast) ease; }
.sess-row:hover .sess-row-open { opacity:0.9; }

.sess-row-right { display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0; }
.sess-badge { display:inline-flex; align-items:center; padding:2px 9px; border-radius:6px; border:1px solid var(--hairline-soft); font-family:var(--font-display); font-size:9px; letter-spacing:var(--track-tight); }
.sess-badge-live { color:var(--violet); border-color:rgba(178,139,255,0.45); background:rgba(178,139,255,0.10); }
.sess-row-time { color:var(--text-faint); font-size:11px; }

.sess-row-actions { position:absolute; right:12px; top:50%; transform:translateY(-50%); display:flex; gap:6px; opacity:0; transition:opacity var(--dur-fast) ease; }
.sess-row:hover .sess-row-actions { opacity:1; }
.sess-row.confirming .sess-row-actions { opacity:1; }
.sess-action-btn { all:unset; cursor:pointer; display:flex; align-items:center; gap:4px; padding:5px 10px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); color:var(--text-muted); font-family:var(--font-display); font-size:9px; letter-spacing:var(--track-mid); white-space:nowrap; transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease, background var(--dur-fast) ease; }
.sess-action-btn:hover { color:var(--accent-bright); border-color:var(--accent); background:var(--accent-dim); }
.sess-action-icon { all:unset; cursor:pointer; width:26px; height:26px; display:flex; align-items:center; justify-content:center; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); color:var(--text-muted); transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease, background var(--dur-fast) ease; }
.sess-action-icon:hover { color:var(--danger); border-color:rgba(255,107,107,0.45); background:var(--danger-dim); }

.sess-confirm { display:flex; gap:6px; align-items:center; }
.sess-confirm-delete { all:unset; cursor:pointer; padding:6px 14px; border-radius:var(--radius-xs); background:var(--danger-dim); border:1px solid rgba(255,107,107,0.55); color:var(--danger); font-family:var(--font-display); font-size:9px; font-weight:600; letter-spacing:var(--track-mid); white-space:nowrap; transition: background var(--dur-fast) ease, color var(--dur-fast) ease; }
.sess-confirm-delete:hover { background:var(--danger); color:var(--ink-on-accent); }
.sess-confirm-cancel { all:unset; cursor:pointer; width:26px; height:26px; display:flex; align-items:center; justify-content:center; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); color:var(--text-muted); }
.sess-confirm-cancel:hover { background:var(--surface-strong); }
`

const page: PageDef = { id: "sessions", label: "SESSIONS", section: "WORKSPACE", order: 6, component: SessionsPage }
export default page
