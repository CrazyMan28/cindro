// REPLAY — Mission Control Replay, ported from desktop/qml/ReplayPage.qml:
// load ANY session's full stored event timeline (session.history) and scrub
// through it like a video — the transcript rebuilds up to the scrub index on
// every seek so tool calls, thinking, diffs, approvals and messages replay
// exactly as they happened. Read-only: no sending, no approvals.
//
// Event folding (foldEvents below) is a straight port of ReplayPage.qml's
// appendEvent() — same kinds, same tool_call/tool_result merge-by-call_id
// logic — reimplemented locally here (rather than importing chat.tsx, which
// is still a stub owned by a different page unit) so this page has its own
// simple, self-contained "message-kind" renderer matching the QML source of
// truth. Kind/field names come straight from NormalizedBrainEvent in
// core/include/jarvis/Protocol.h, not guessed.
//
// Cross-page handoff: sessions.tsx writes the chosen session id to
// sessionStorage["jarvis.web.replayTarget"] before navigating here (the
// router only carries a page id, no params — see sessions.tsx's file header
// for the full rationale). This page also works standalone: with no handoff
// present it opens its own session picker (session.list).
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { ArcReactor } from "../components/ArcReactor"

type Ev = Record<string, unknown>

type Item =
  | { kind: "message"; role: string; text: string }
  | { kind: "thinking"; text: string; startedAt: number | null; endedAt: number | null }
  | {
      kind: "tool"
      callId: string
      toolName: string
      input: string
      output: string
      done: boolean
      ok: boolean
      server: string
    }
  | { kind: "diff"; path: string; patch: string }
  | { kind: "approval"; text: string; approvalId: string; risk: string }
  | { kind: "error"; text: string }

interface PickerRow {
  id: string
  title: string
  state: string
  updated: number
}

const BASE_TICK_MS = 700 // auto-advance base; interval = max(120, base/speed)

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}
function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return ""
  }
}

/** Port of ReplayPage.qml's appendEvent(), folding raw events[0..n) into
 * renderable transcript items (tool_call+tool_result merge into one card). */
function foldEvents(events: Ev[], n: number): Item[] {
  const items: Item[] = []
  const toolIndexByCallId = new Map<string, number>()
  // Index of the in-progress "thinking" item in `items`, or -1 when no
  // thinking block is currently accumulating — mirrors toolIndexByCallId's
  // role of tracking "which item do the next matching events merge into",
  // but keyed by position instead of call_id since consecutive thinking
  // events aren't correlated by an id on the wire. Reset (frozen) the moment
  // any other event kind is folded, same fold point as chat.tsx's
  // freezeThinking() — see that file's applyEvent for the canonical rule.
  let thinkingIdx = -1
  for (let i = 0; i < n; i++) {
    const ev = events[i]
    if (!ev) continue
    const kind = str(ev.kind)
    if (kind !== "thinking") thinkingIdx = -1
    switch (kind) {
      case "thinking": {
        const chunk = str(ev.text)
        if (!chunk.trim()) break // empty chunk: no-op, matches chat.tsx's applyEvent
        // Real recorded ms-since-epoch timestamps ARE available here — the
        // daemon's session.history wraps every event as {seq, ts, ev} (see
        // ControlServer::handleSessionHistory), and load() above folds that
        // outer ts back onto the unwrapped event under the same key. When
        // absent (e.g. malformed/older data), fall back to no timing rather
        // than fabricating a fake duration.
        const ts = num(ev.ts, 0) || null
        if (thinkingIdx === -1) {
          thinkingIdx = items.length
          items.push({ kind: "thinking", text: chunk, startedAt: ts, endedAt: ts })
        } else {
          const existing = items[thinkingIdx]
          if (existing && existing.kind === "thinking") {
            existing.text += chunk
            if (ts !== null) existing.endedAt = ts
          }
        }
        break
      }
      case "message": {
        items.push({ kind: "message", role: str(ev.role, "assistant"), text: str(ev.text) })
        break
      }
      case "tool_call": {
        const callId = str(ev.call_id)
        const idx = items.length
        items.push({
          kind: "tool",
          callId,
          toolName: str(ev.name, "tool"),
          input: prettyArgs(ev.args),
          output: "",
          done: false,
          ok: true,
          server: str(ev.server),
        })
        if (callId) toolIndexByCallId.set(callId, idx)
        break
      }
      case "tool_result": {
        const callId = str(ev.call_id)
        const output = str(ev.output)
        const ok = ev.ok !== false
        const idx = callId ? toolIndexByCallId.get(callId) : undefined
        const existing = idx !== undefined ? items[idx] : undefined
        if (existing && existing.kind === "tool") {
          existing.output = output
          existing.done = true
          existing.ok = ok
          if (!existing.input && ev.args !== undefined) existing.input = prettyArgs(ev.args)
          if (!existing.server && ev.server) existing.server = str(ev.server)
          const nm = str(ev.name)
          if (nm && (existing.toolName === "" || existing.toolName === "tool")) existing.toolName = nm
        } else {
          items.push({
            kind: "tool",
            callId,
            toolName: str(ev.name) || "result",
            input: prettyArgs(ev.args),
            output,
            done: true,
            ok,
            server: str(ev.server),
          })
        }
        break
      }
      case "approval": {
        items.push({
          kind: "approval",
          text: str(ev.summary, "Approval requested"),
          approvalId: str(ev.approval_id),
          risk: str(ev.risk),
        })
        break
      }
      case "diff": {
        items.push({ kind: "diff", path: str(ev.path, "diff"), patch: str(ev.patch) })
        break
      }
      case "error": {
        items.push({ kind: "error", text: str(ev.message, "error") })
        break
      }
      default:
        break // thread_started/turn_started/final/usage/driving_state — ignored, QML parity
    }
  }
  return items
}

function ReplayPage() {
  const app = useApp()
  const [sessionId, setSessionId] = createSignal("")
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [events, setEvents] = createSignal<Ev[]>([])
  const [cursor, setCursor] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [speed, setSpeed] = createSignal(1)
  const [error, setError] = createSignal("")
  const [items, setItems] = createSignal<Item[]>([])
  const [expandedTools, setExpandedTools] = createSignal<Set<string>>(new Set())
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [pickerLoading, setPickerLoading] = createSignal(false)
  const [pickerRows, setPickerRows] = createSignal<PickerRow[]>([])

  const total = () => events().length

  const seek = (n: number) => {
    const clamped = Math.max(0, Math.min(n, events().length))
    setCursor(clamped)
    setItems(foldEvents(events(), clamped))
  }

  const stepBy = (d: number) => {
    setPlaying(false)
    seek(cursor() + d)
  }

  const togglePlay = () => {
    if (!total()) return
    if (!playing() && cursor() >= total()) seek(0) // replay from start
    setPlaying((p) => !p)
  }

  const cycleSpeed = () => setSpeed((s) => (s >= 4 ? 0.5 : s < 1 ? 1 : s * 2))

  // ---- playback clock: interval retimes whenever speed changes -------------
  createEffect(() => {
    if (!playing()) return
    const interval = Math.max(120, BASE_TICK_MS / speed())
    const timer = setInterval(() => {
      if (cursor() >= total()) {
        setPlaying(false)
        return
      }
      seek(cursor() + 1)
    }, interval)
    onCleanup(() => clearInterval(timer))
  })

  const evLabel = (i: number): string => {
    const ev = events()[i]
    if (!ev) return ""
    const k = str(ev.kind, "?")
    if (k === "tool_call" || k === "tool_result") return str(ev.name, "tool")
    if (k === "message") return `${str(ev.role, "msg")} message`
    return k
  }
  const readout = () =>
    `${cursor()} / ${total()}` + (cursor() > 0 && cursor() <= total() ? `   ·   ${evLabel(cursor() - 1)}` : "")

  const load = async (sid: string, title: string) => {
    setError("")
    setPlaying(false)
    setPickerOpen(false)
    try {
      const res = await app.client.call("session.history", { session_id: sid }, 20000)
      // session.history wraps each event as {seq, ts, ev}; unwrap to the bare
      // event but fold the outer ts back in under the same key (no NormalizedBrainEvent
      // kind uses "ts" in its own fields — see core/include/jarvis/Protocol.h — so this
      // can't collide) so foldEvents can stamp real thinking-block start/end times.
      const evs = ((res.events ?? []) as Ev[]).map((e) => {
        const inner = { ...((e.ev ?? e) as Ev) }
        if (e.ts !== undefined) inner.ts = e.ts
        return inner
      })
      const meta = (res.session ?? {}) as Ev
      setSessionId(sid)
      setSessionTitle(title || str(meta.title) || sid)
      setEvents(evs)
      setExpandedTools(new Set<string>())
      seek(evs.length) // start fully played-out; scrub back to rewind (QML parity)
    } catch (e) {
      setError(`history unavailable: ${String(e)}`)
    }
  }

  const openPicker = async () => {
    setError("")
    setPickerLoading(true)
    setPickerOpen(true)
    try {
      const res = await app.client.call("session.list", {}, 15000)
      const rows = ((res.sessions ?? []) as Record<string, unknown>[])
        .filter((s) => !str(s.parent_session_id))
        .map(
          (s): PickerRow => ({
            id: str(s.id),
            title: str(s.title) || "Untitled session",
            state: str(s.state) || "idle",
            updated: num(s.updated),
          }),
        )
        .sort((a, b) => b.updated - a.updated)
      setPickerRows(rows)
    } catch (e) {
      setError(`session.list failed: ${String(e)}`)
    } finally {
      setPickerLoading(false)
    }
  }

  onMount(() => {
    const raw = sessionStorage.getItem("jarvis.web.replayTarget")
    if (raw) {
      sessionStorage.removeItem("jarvis.web.replayTarget")
      try {
        const parsed = JSON.parse(raw) as { id?: string; title?: string }
        if (parsed.id) {
          void load(parsed.id, parsed.title ?? "")
          return
        }
      } catch {
        // malformed handoff — fall through to the picker
      }
    }
    void openPicker()
  })

  const toggleTool = (key: string) => {
    if (!key) return
    setExpandedTools((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div class="rep-page">
      <style>{replayCss}</style>

      <div class="rep-header">
        <div class="hud-label rep-title">MISSION CONTROL // REPLAY</div>
        <div class="rep-subtitle">
          {sessionId() ? `${sessionTitle()}  ·  ${total()} events` : "Pick a session to replay"}
        </div>
        <button type="button" class="rep-change-btn" onClick={() => void openPicker()}>
          {sessionId() ? "Change session" : "Pick session"}
        </button>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <div class="rep-transcript card">
        <Show
          when={items().length > 0}
          fallback={
            <div class="rep-empty">
              <ArcReactor size={64} tint="var(--accent)" />
              <div class="hud-label rep-empty-label">
                {sessionId() ? "REWOUND TO START" : "NO SESSION LOADED"}
              </div>
            </div>
          }
        >
          <div class="rep-items">
            <For each={items()}>
              {(it, i) => <ReplayItem item={it} index={i()} expanded={expandedTools()} onToggle={toggleTool} />}
            </For>
          </div>
        </Show>
      </div>

      <div class="rep-transport" classList={{ disabled: total() === 0 }}>
        <div class="rep-transport-buttons">
          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              seek(0)
            }}
          >
            ⏮
          </button>
          <button type="button" onClick={() => stepBy(-1)}>
            ◀ Step
          </button>
          <button type="button" class="rep-play" onClick={togglePlay}>
            {playing() ? "⏸ Pause" : "▶ Play"}
          </button>
          <button type="button" onClick={() => stepBy(1)}>
            Step ▶
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              seek(total())
            }}
          >
            ⏭
          </button>
        </div>

        <div class="rep-scrub-wrap">
          <input
            type="range"
            min="0"
            max={Math.max(1, total())}
            value={cursor()}
            class="rep-scrub"
            style={{ "--pct": `${(cursor() / Math.max(1, total())) * 100}%` }}
            onInput={(e) => {
              setPlaying(false)
              seek(Number(e.currentTarget.value))
            }}
          />
          <div class="rep-readout">{readout()}</div>
        </div>

        <button type="button" class="rep-speed" onClick={cycleSpeed}>
          {speed()}×
        </button>
      </div>

      <Show when={pickerOpen()}>
        <div
          class="rep-picker-backdrop"
          onClick={() => {
            if (sessionId()) setPickerOpen(false)
          }}
        >
          <div class="rep-picker card" onClick={(e) => e.stopPropagation()}>
            <div class="hud-label rep-picker-title">PICK A SESSION</div>
            <Show when={pickerLoading()}>
              <div class="rep-picker-loading">Loading…</div>
            </Show>
            <Show when={!pickerLoading() && pickerRows().length === 0}>
              <div class="rep-picker-loading">No sessions to replay yet.</div>
            </Show>
            <div class="rep-picker-list">
              <For each={pickerRows()}>
                {(r) => (
                  <button type="button" class="rep-picker-row" onClick={() => void load(r.id, r.title)}>
                    <span class="rep-picker-row-title">{r.title}</span>
                    <span class="rep-picker-row-state">{r.state}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={sessionId()}>
              <button type="button" class="rep-picker-cancel" onClick={() => setPickerOpen(false)}>
                Cancel
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ReplayItem(props: {
  item: Item
  index: number
  expanded: Set<string>
  onToggle: (key: string) => void
}) {
  const item = props.item
  if (item.kind === "message") {
    return (
      <div class="rep-msg" classList={{ [`rep-msg-${item.role}`]: true }}>
        <div class="rep-msg-role hud-label">{item.role}</div>
        <div class="rep-msg-text">{item.text}</div>
      </div>
    )
  }
  if (item.kind === "thinking") {
    // Synthetic key extends the tool cards' expandedTools Set to also cover
    // thinking blocks (per-position, since a thinking item has no call_id).
    const key = `thinking-${props.index}`
    const isOpen = () => props.expanded.has(key)
    // Duration only renders when real recorded timestamps were available on
    // both ends (see foldEvents) — replay is a static scrub through history,
    // not a live stream, so there's no "now" to tick against like the live
    // chat view's ThinkingCard; we either know the real duration or we don't.
    const seconds = () =>
      item.startedAt !== null && item.endedAt !== null && item.endedAt > item.startedAt
        ? Math.max(1, Math.round((item.endedAt - item.startedAt) / 1000))
        : null
    return (
      <div class="rep-msg rep-msg-thinking">
        <button type="button" class="rep-msg-thinking-head" onClick={() => props.onToggle(key)}>
          <span class="rep-msg-role hud-label">thinking</span>
          <span class="rep-msg-thinking-dur">{seconds() !== null ? `Thought for ${seconds()}s` : ""}</span>
          <span class="rep-tool-toggle">{isOpen() ? "▾" : "▸"}</span>
        </button>
        <Show when={isOpen()}>
          <div class="rep-msg-text">{item.text || "(thinking…)"}</div>
        </Show>
      </div>
    )
  }
  if (item.kind === "tool") {
    const key = item.callId || `#${props.index}`
    // NOTE: read props.expanded reactively via a function called from inside
    // the returned JSX, not as a plain top-level const — a component's own
    // function body only runs once in Solid, so a bare `const open = ...`
    // here would freeze at mount time and never see later toggles.
    const isOpen = () => props.expanded.has(key) || (item.done && !item.ok)
    return (
      <div class="rep-tool" classList={{ failed: item.done && !item.ok, running: !item.done }}>
        <button type="button" class="rep-tool-head" onClick={() => props.onToggle(key)}>
          <span class="rep-tool-status">{!item.done ? "…" : item.ok ? "✓" : "✕"}</span>
          <span class="rep-tool-name">{item.toolName}</span>
          <Show when={item.server}>
            <span class="rep-tool-server">{item.server}</span>
          </Show>
          <span class="rep-tool-toggle">{isOpen() ? "▾" : "▸"}</span>
        </button>
        <Show when={isOpen()}>
          <div class="rep-tool-body">
            <Show when={item.input}>
              <pre class="rep-tool-pre">{item.input}</pre>
            </Show>
            <Show when={item.output}>
              <pre class="rep-tool-pre rep-tool-output">{item.output}</pre>
            </Show>
          </div>
        </Show>
      </div>
    )
  }
  if (item.kind === "diff") {
    return (
      <div class="rep-diff">
        <div class="rep-diff-head">{item.path}</div>
        <pre class="rep-tool-pre">{item.patch}</pre>
      </div>
    )
  }
  if (item.kind === "approval") {
    return (
      <div class="rep-approval">
        <span class="rep-approval-badge">{item.risk || "medium"}</span>
        <span>{item.text}</span>
      </div>
    )
  }
  return <div class="rep-error">⚠ {item.text}</div>
}

const replayCss = `
.rep-page { display:flex; flex-direction:column; gap:12px; height:100%; max-width:1100px; }
.rep-header { display:flex; align-items:center; gap:14px; flex-wrap:wrap; flex-shrink:0; }
.rep-title { font-size:14px; color:var(--accent-bright); }
.rep-subtitle { color:var(--text-faint); font-size:12px; flex:1; }
.rep-change-btn { all:unset; cursor:pointer; padding:7px 14px; border-radius:var(--radius-sm); border:1px solid var(--hairline-soft); background:var(--surface); color:var(--text-muted); font-family:var(--font-display); font-size:10px; letter-spacing:var(--track-mid); transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.rep-change-btn:hover { border-color:var(--accent-dim); color:var(--accent-bright); }

.rep-transcript { flex:1; min-height:0; overflow-y:auto; padding:14px; }
.rep-items { display:flex; flex-direction:column; gap:10px; }
.rep-empty { height:100%; min-height:220px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--text-muted); }
.rep-empty-label { font-size:12px; letter-spacing:var(--track-mid); }

.rep-msg { display:flex; flex-direction:column; gap:3px; padding:10px 12px; border-radius:var(--radius-sm); background:var(--surface); border:1px solid var(--hairline-faint); max-width:88%; }
.rep-msg-user { align-self:flex-end; border-color:var(--accent-dim); background:var(--accent-faint); }
.rep-msg-assistant { align-self:flex-start; }
.rep-msg-thinking { align-self:flex-start; opacity:0.75; font-style:italic; border-style:dashed; padding:0; overflow:hidden; }
.rep-msg-role { font-size:9px; color:var(--text-faint); text-transform:uppercase; }
.rep-msg-thinking .rep-msg-role { color:var(--violet); }
.rep-msg-user .rep-msg-role { color:var(--accent); }
.rep-msg-text { color:var(--text); font-size:13px; white-space:pre-wrap; word-break:break-word; }
.rep-msg-thinking-head { all:unset; box-sizing:border-box; width:100%; display:flex; align-items:center; gap:8px; padding:10px 12px; cursor:pointer; }
.rep-msg-thinking-dur { flex:1; color:var(--text-faint); font-size:11px; font-style:normal; }
.rep-msg-thinking .rep-msg-text { padding:0 12px 10px; }

.rep-tool { border-radius:var(--radius-sm); border:1px solid var(--hairline-soft); background:var(--surface); overflow:hidden; }
.rep-tool.failed { border-color:rgba(255,107,107,0.45); }
.rep-tool.running { border-color:var(--accent-dim); }
.rep-tool-head { all:unset; box-sizing:border-box; width:100%; display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; }
.rep-tool-status { font-family:var(--font-mono); color:var(--success); width:14px; text-align:center; }
.rep-tool.failed .rep-tool-status { color:var(--danger); }
.rep-tool.running .rep-tool-status { color:var(--amber); }
.rep-tool-name { color:var(--text); font-family:var(--font-mono); font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rep-tool-server { color:var(--text-faint); font-size:10px; font-family:var(--font-mono); }
.rep-tool-toggle { color:var(--text-faint); font-size:10px; }
.rep-tool-body { padding:0 12px 12px; display:flex; flex-direction:column; gap:8px; }
.rep-tool-pre { margin:0; padding:8px 10px; background:var(--surface-deep); border-radius:var(--radius-xs); color:var(--text-muted); font-family:var(--font-mono); font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow-y:auto; }
.rep-tool-output { color:var(--text); }

.rep-diff { border-radius:var(--radius-sm); border:1px solid var(--hairline-soft); background:var(--surface); padding:10px 12px; display:flex; flex-direction:column; gap:6px; }
.rep-diff-head { color:var(--amber); font-family:var(--font-mono); font-size:11px; }

.rep-approval { display:flex; align-items:center; gap:8px; padding:9px 12px; border-radius:var(--radius-sm); border:1px solid var(--amber-dim); background:rgba(255,180,84,0.06); color:var(--text); font-size:12px; }
.rep-approval-badge { font-family:var(--font-display); font-size:9px; letter-spacing:var(--track-tight); color:var(--amber); border:1px solid var(--amber-dim); border-radius:6px; padding:2px 8px; text-transform:uppercase; }

.rep-error { padding:9px 12px; border-radius:var(--radius-sm); border:1px solid var(--danger-dim); background:rgba(255,107,107,0.06); color:var(--danger); font-size:12px; }

.rep-transport { display:flex; align-items:center; gap:12px; padding:0 14px; height:64px; border-radius:var(--radius); background:var(--surface); border:1px solid var(--accent-dim); flex-shrink:0; }
.rep-transport.disabled { opacity:0.5; pointer-events:none; }
.rep-transport-buttons { display:flex; gap:8px; }
.rep-transport-buttons button, .rep-play { all:unset; cursor:pointer; padding:7px 12px; border-radius:var(--radius-sm); border:1px solid var(--hairline-soft); color:var(--text-muted); font-family:var(--font-display); font-size:11px; white-space:nowrap; transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease, background var(--dur-fast) ease; }
.rep-transport-buttons button:hover { border-color:var(--accent-dim); color:var(--text); }
.rep-play { color:var(--accent-bright); border-color:var(--accent-dim); background:var(--accent-dim); }
.rep-play:hover { background:var(--accent-faint); border-color:var(--accent); }

.rep-scrub-wrap { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.rep-scrub { -webkit-appearance:none; appearance:none; width:100%; height:4px; border-radius:2px; background:linear-gradient(to right, var(--accent) 0%, var(--accent) var(--pct,0%), var(--hairline) var(--pct,0%), var(--hairline) 100%); outline:none; cursor:pointer; }
.rep-scrub::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:var(--accent-bright); border:1px solid var(--accent); cursor:pointer; margin-top:-5px; }
.rep-scrub::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background:var(--accent-bright); border:1px solid var(--accent); cursor:pointer; }
.rep-scrub::-moz-range-track { height:4px; border-radius:2px; background:var(--hairline); }
.rep-readout { color:var(--text-muted); font-family:var(--font-mono); font-size:10px; }
.rep-speed { all:unset; cursor:pointer; padding:7px 12px; border-radius:var(--radius-sm); border:1px solid var(--hairline-soft); color:var(--amber); font-family:var(--font-display); font-size:11px; transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease; }
.rep-speed:hover { border-color:var(--amber-dim); background:var(--amber-dim); }

.rep-picker-backdrop { position:fixed; inset:0; z-index:150; background:rgba(4,7,12,0.6); display:flex; align-items:center; justify-content:center; }
.rep-picker { width:440px; max-width:calc(100vw - 32px); max-height:70vh; display:flex; flex-direction:column; gap:10px; }
.rep-picker-title { font-size:12px; color:var(--accent-bright); }
.rep-picker-loading { color:var(--text-faint); font-size:12px; }
.rep-picker-list { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px; }
.rep-picker-row { all:unset; cursor:pointer; box-sizing:border-box; width:100%; display:flex; justify-content:space-between; gap:10px; padding:9px 12px; border-radius:var(--radius-sm); background:var(--surface); border:1px solid var(--hairline-faint); color:var(--text); font-size:12px; transition: border-color var(--dur-fast) ease; }
.rep-picker-row:hover { border-color:var(--accent-dim); }
.rep-picker-row-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rep-picker-row-state { color:var(--text-faint); font-family:var(--font-mono); font-size:11px; text-transform:uppercase; flex-shrink:0; }
.rep-picker-cancel { all:unset; cursor:pointer; align-self:flex-end; padding:6px 14px; border-radius:var(--radius-xs); border:1px solid var(--hairline-soft); color:var(--text-muted); font-size:12px; }
.rep-picker-cancel:hover { background:var(--surface-strong); }
`

const page: PageDef = { id: "replay", label: "REPLAY", section: "MIND", order: 6, component: ReplayPage }
export default page
