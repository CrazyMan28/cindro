// CHAT — the primary Jarvis conversation surface. Ported from
// tui/src/chat/session.ts (the Contract-A call sequence: session.create,
// client.subscribe(id), streamed session.event kinds, session.send/cancel)
// and tui/src/chat/{Composer,Transcript,DiffReview,SubagentView}.tsx for the
// UI shape, redrawn as HTML/CSS cards to match home.tsx's visual bar instead
// of OpenTUI's terminal widgets.
//
// Gaps vs. the TUI (documented, not silently dropped):
//  - The TUI's "question" ChatItem kind comes from a LOCAL FILESYSTEM watch
//    on <dataDir>/questions/*.json (the ask_user file bus) — a browser tab
//    has no filesystem access, so that bus can never be observed here. There
//    is no session.event kind for it either (applyEvent in session.ts never
//    emits "question"), so this is a hard platform gap, not a shortcut. Every
//    OTHER item kind session.ts's applyEvent can produce over the wire
//    (message/tool_call/tool_result/diff/approval/error/final, plus the
//    todo_write and subagent-dispatch tool_call special-cases) IS implemented
//    below with real data.
//  - Assistant text renders as plain word-wrapped text (no markdown parser
//    here, unlike the TUI's <markdown> renderable) — a deliberate
//    simplification; Solid's text interpolation escapes it, so it's safe.
//  - diff.stage/commit/revert/open_pr and approval.respond were verified
//    against daemon/src/ControlServer.cpp (handleDiffStage/Revert/Commit/
//    OpenPr, handleApprovalRespond) before wiring them up for real — these
//    are live actions, not stubs.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore, produce } from "solid-js/store"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import type { ControlClient } from "../core/control-client"
import { ArcReactor } from "../components/ArcReactor"
import { NavIcon } from "../components/NavIcon"
import { WidgetTree, type WidgetAction } from "../components/WidgetRenderer"

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string
  title?: string
  agent?: string
  state?: string
  updated_at?: number
}

type ChatItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; live: boolean }
  | {
      id: number
      kind: "tool"
      name: string
      args: string
      state: "running" | "ok" | "failed"
      output: string
      expanded: boolean
    }
  | { id: number; kind: "diff"; files: Array<{ path: string; patch: string }> }
  | {
      id: number
      kind: "approval"
      approvalId: string
      summary: string
      risk: string
      resolved?: "allow" | "always" | "deny"
    }
  | { id: number; kind: "widget"; title: string; spec: Record<string, unknown> }
  | {
      id: number
      kind: "todo"
      items: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>
    }
  | { id: number; kind: "subagent"; sessionId: string; name: string; task: string; status: string }
  | { id: number; kind: "error"; message: string }
  | { id: number; kind: "divider" }
  | { id: number; kind: "notice"; text: string; style?: "info" | "warn" | "error" | "success" }

let nextId = 1
const mkId = () => nextId++

const MAX_DIFF_LINES = 30
const TOOL_PREVIEW_CHARS = 160

const SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "new", description: "start a fresh session" },
  { name: "goal", description: "set this session's goal" },
  { name: "cancel", description: "cancel the current turn" },
]

// ---------------------------------------------------------------------------
// event-shape helpers (ported 1:1 from tui/src/chat/session.ts)
// ---------------------------------------------------------------------------

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw === "string") {
    try {
      const o: unknown = JSON.parse(raw)
      return o && typeof o === "object" ? (o as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

function extractTodos(
  args: Record<string, unknown>,
): Array<{ text: string; status: "pending" | "in_progress" | "completed" }> {
  const raw = (args.items ?? args.todos ?? args.tasks ?? []) as unknown[]
  const norm = (s: unknown): "pending" | "in_progress" | "completed" => {
    const v = String(s ?? "pending").toLowerCase()
    if (v.startsWith("in") || v === "active" || v === "doing") return "in_progress"
    if (v === "completed" || v === "done" || v === "complete") return "completed"
    return "pending"
  }
  return (Array.isArray(raw) ? raw : [])
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      return {
        text: String(o.text ?? o.content ?? o.title ?? o.task ?? ""),
        status: norm(o.status ?? o.state),
      }
    })
    .filter((t) => t.text)
}

function extractDiffFiles(ev: Record<string, unknown>): Array<{ path: string; patch: string }> {
  const out: Array<{ path: string; patch: string }> = []
  const files = ev.files
  if (Array.isArray(files)) {
    for (const raw of files) {
      const f = raw as Record<string, unknown>
      const path = String(f.path ?? f.file ?? "")
      const patch = String(f.patch ?? f.diff ?? "")
      if (path || patch) out.push({ path, patch })
    }
    return out
  }
  const path = String(ev.path ?? ev.file ?? "")
  const patch = String(ev.patch ?? ev.diff ?? "")
  if (path || patch) out.push({ path, patch })
  return out
}

function diffStats(patch: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++
    else if (line.startsWith("-") && !line.startsWith("---")) del++
  }
  return { add, del }
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "chat-diff-line chat-diff-line-hunk"
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))
    return "chat-diff-line chat-diff-line-faint"
  if (line.startsWith("+")) return "chat-diff-line chat-diff-line-add"
  if (line.startsWith("-")) return "chat-diff-line chat-diff-line-del"
  return "chat-diff-line"
}

function timeAgo(ts?: number): string {
  if (!ts) return ""
  const ms = ts > 1e12 ? ts : ts * 1000
  const diff = Date.now() - ms
  if (diff < 0 || !Number.isFinite(diff)) return ""
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ---------------------------------------------------------------------------
// ChatController — per-session state + event pump (port of SessionController)
// ---------------------------------------------------------------------------

class ChatController {
  readonly items: ChatItem[]
  private setItems: (fn: (items: ChatItem[]) => void) => void

  readonly sessionId: () => string
  private setSessionId: (v: string) => void
  readonly busy: () => boolean
  private setBusy: (v: boolean) => void
  readonly status: () => string
  private setStatus: (v: string) => void
  readonly pendingApproval: () => { approvalId: string; summary: string; risk: string } | null
  private setPendingApproval: (
    v: { approvalId: string; summary: string; risk: string } | null,
  ) => void

  private pumpGen = 0
  private offWidget?: () => void

  constructor(
    private client: ControlClient,
    private onError: (message: string) => void,
  ) {
    const [items, setItems] = createStore<ChatItem[]>([])
    this.items = items
    this.setItems = (fn) => setItems(produce(fn))

    const [sessionId, setSessionId] = createSignal("")
    this.sessionId = sessionId
    this.setSessionId = setSessionId
    const [busy, setBusy] = createSignal(false)
    this.busy = busy
    this.setBusy = setBusy
    const [status, setStatus] = createSignal("")
    this.status = status
    this.setStatus = setStatus
    const [pendingApproval, setPendingApproval] = createSignal<
      { approvalId: string; summary: string; risk: string } | null
    >(null)
    this.pendingApproval = pendingApproval
    this.setPendingApproval = setPendingApproval

    // Session-scoped widget.render broadcasts fold into the transcript (the
    // GUI ChatDelegate "widget" kind) — ONLY when session_id explicitly
    // matches this controller's session. A page can have more than one
    // ChatController alive at once (the main chat plus a SubagentModal's
    // controller bound to a child session), so a session-id-less broadcast
    // can never be safely attributed to "the" active session — falling back
    // to "render it here if I have any session open" would duplicate it into
    // every concurrently-open controller. Sessionless widget pushes remain
    // visible via the Canvas page's unscoped live feed instead.
    this.offWidget = client.on("widget.render", (_ev, data) => {
      const sid = String(data.session_id ?? "")
      if (!sid || sid !== this.sessionId()) return
      let spec = (data.spec ?? data.widget ?? {}) as Record<string, unknown>
      if (typeof spec === "string") {
        try {
          spec = JSON.parse(spec) as Record<string, unknown>
        } catch {
          spec = {}
        }
      }
      this.push({
        id: mkId(),
        kind: "widget",
        title: String(data.title ?? spec.title ?? "widget"),
        spec,
      })
    })
  }

  dispose(): void {
    this.pumpGen++
    this.offWidget?.()
  }

  private push(item: ChatItem): void {
    this.setItems((items) => {
      items.push(item)
    })
  }

  notice(text: string, style?: "info" | "warn" | "error" | "success"): void {
    this.push({ id: mkId(), kind: "notice", text, style })
  }

  async ensureSession(): Promise<string> {
    if (this.sessionId()) return this.sessionId()
    const res = await this.client.call("session.create", { profile: "coworker" }, 20000)
    const sid = String(res.session_id ?? "")
    if (!sid) throw new Error("session.create returned no session_id")
    this.setSessionId(sid)
    await this.client.subscribe(sid)
    this.startPump(sid)
    return sid
  }

  async openSession(sessionId: string, title = ""): Promise<void> {
    this.pumpGen++ // kill any pump parked on the old session's queue
    this.setSessionId(sessionId)
    this.setPendingApproval(null)
    this.setBusy(false)
    this.setItems((items) => {
      items.length = 0
    })
    this.notice(`— session ${title || sessionId} —`, "info")
    // Subscribe BEFORE fetching history (mirrors ensureSession()'s ordering
    // and the ControlClient docstring: "Call IMMEDIATELY after session.create
    // so no other chat's events can leak in"/be missed). subscribe() creates
    // the AsyncQueue and starts buffering events right away, so anything the
    // daemon emits while session.history is still in flight (e.g. a subagent
    // actively running) queues up instead of being silently dropped.
    await this.client.subscribe(sessionId)
    try {
      const hist = await this.client.call(
        "session.history",
        { session_id: sessionId, limit: 40 },
        20000,
      )
      for (const raw of (hist.events ?? []) as Array<Record<string, unknown>>) {
        this.applyEvent((raw.ev ?? raw) as Record<string, unknown>, true)
      }
    } catch (e) {
      this.notice(`history unavailable: ${String(e)}`, "warn")
    }
    this.startPump(sessionId)
  }

  async newSession(): Promise<void> {
    this.pumpGen++
    this.setSessionId("")
    this.setPendingApproval(null)
    this.setBusy(false)
    this.setStatus("")
    this.setItems((items) => {
      items.length = 0
    })
    await this.ensureSession()
    this.notice("— new session —", "info")
  }

  private startPump(sessionId: string): void {
    const gen = ++this.pumpGen
    const loop = async () => {
      while (gen === this.pumpGen && this.sessionId() === sessionId) {
        const q = this.client.queueFor(sessionId)
        if (!q) return
        const ev = await q.shift(500) // bounded so a session switch is seen
        if (gen !== this.pumpGen || this.sessionId() !== sessionId) return
        if (ev) this.applyEvent(ev)
      }
    }
    void loop()
  }

  async send(text: string): Promise<void> {
    const sid = await this.ensureSession()
    this.push({ id: mkId(), kind: "user", text })
    this.setBusy(true)
    this.setStatus("thinking…")
    try {
      await this.client.call("session.send", { session_id: sid, text }, 30000)
    } catch (e) {
      this.setBusy(false)
      this.setStatus("")
      this.push({ id: mkId(), kind: "error", message: String(e) })
      throw e
    }
  }

  async stop(): Promise<void> {
    if (!this.sessionId()) return
    await this.client.call("session.cancel", { session_id: this.sessionId() })
    this.setBusy(false)
    this.setStatus("")
    this.notice("■ turn cancelled", "warn")
  }

  async setGoal(goal: string): Promise<void> {
    const sid = await this.ensureSession()
    await this.client.call("session.set_goals", { session_id: sid, goals: goal })
    this.notice(goal ? `◎ goal set: ${goal}` : "◎ goal cleared", "info")
  }

  async respondApproval(decision: "allow" | "always" | "deny"): Promise<void> {
    const pending = this.pendingApproval()
    if (!pending || !this.sessionId()) return
    try {
      await this.client.call("approval.respond", {
        session_id: this.sessionId(),
        approval_id: pending.approvalId,
        decision,
      })
    } catch (e) {
      this.onError(String(e))
      return
    }
    this.setItems((items) => {
      for (const item of items) {
        if (item.kind === "approval" && item.approvalId === pending.approvalId)
          item.resolved = decision
      }
    })
    this.setPendingApproval(null)
    this.setStatus("")
  }

  applyEvent(ev: Record<string, unknown>, replay = false): void {
    const kind = String(ev.kind ?? "")
    switch (kind) {
      case "thinking": {
        const text = String(ev.text ?? "").trim()
        if (text && !replay) {
          const lastLine = text.split("\n").at(-1) ?? ""
          this.setStatus(`· ${lastLine.slice(0, 120)}`)
        }
        return
      }
      case "message": {
        const role = String(ev.role ?? "")
        const text = String(ev.text ?? "")
        if (role === "assistant") {
          this.push({ id: mkId(), kind: "assistant", text, live: !replay })
          if (!replay) {
            this.setBusy(false)
            this.setStatus("")
          }
        } else if (role === "user") {
          this.push({ id: mkId(), kind: "user", text })
        }
        return
      }
      case "tool_call": {
        const rawArgs = ev.args
        const name = String(ev.name ?? "tool")
        const argsObj = parseArgs(rawArgs)

        if (/^todo[_ ]?write$/i.test(name) || name === "TodoWrite") {
          const todos = extractTodos(argsObj)
          if (todos.length) {
            this.upsertTodo(todos)
            if (!replay) this.setStatus("")
            return
          }
        }

        if (/^(task|dispatch_agent|agents?\.dispatch|dispatch)$/i.test(name)) {
          this.push({
            id: mkId(),
            kind: "subagent",
            sessionId: String(argsObj.session_id ?? argsObj.child_session_id ?? ""),
            name: String(argsObj.agent ?? argsObj.name ?? argsObj.subagent_type ?? "subagent"),
            task: String(argsObj.task ?? argsObj.description ?? argsObj.prompt ?? "").slice(0, 200),
            status: "running",
          })
          if (!replay) this.setStatus(`dispatched ${String(argsObj.agent ?? "subagent")}…`)
          return
        }

        const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? "")
        this.push({
          id: mkId(),
          kind: "tool",
          name,
          args,
          state: "running",
          output: "",
          expanded: false,
        })
        if (!replay) this.setStatus(`running ${name}…`)
        return
      }
      case "tool_result": {
        const output = String(ev.output ?? "").trim()
        const ok = ev.ok === undefined ? true : Boolean(ev.ok)
        this.setItems((items) => {
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i]
            if (item.kind === "tool" && item.state === "running") {
              item.output = output
              item.state = ok ? "ok" : "failed"
              item.expanded = !ok
              return
            }
          }
        })
        return
      }
      case "diff": {
        this.push({ id: mkId(), kind: "diff", files: extractDiffFiles(ev) })
        return
      }
      case "approval": {
        const approvalId = String(ev.approval_id ?? "")
        const summary = String(ev.summary ?? ev.tool ?? "an action")
        const risk = String(ev.risk ?? "medium")
        this.setPendingApproval({ approvalId, summary, risk })
        this.push({ id: mkId(), kind: "approval", approvalId, summary, risk })
        if (!replay) this.setStatus("approval pending")
        return
      }
      case "error": {
        this.push({ id: mkId(), kind: "error", message: String(ev.message ?? "error") })
        if (!replay) {
          this.setBusy(false)
          this.setStatus("")
        }
        return
      }
      case "final": {
        this.push({ id: mkId(), kind: "divider" })
        if (!replay) {
          this.setBusy(false)
          this.setStatus("")
        }
        return
      }
      default:
        return
    }
  }

  toggleTool(itemId: number): void {
    this.setItems((items) => {
      for (const item of items) {
        if (item.kind === "tool" && item.id === itemId) item.expanded = !item.expanded
      }
    })
  }

  private upsertTodo(
    todos: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>,
  ): void {
    let updated = false
    this.setItems((items) => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === "todo") {
          ;(items[i] as Extract<ChatItem, { kind: "todo" }>).items = todos
          updated = true
          return
        }
      }
    })
    if (!updated) this.push({ id: mkId(), kind: "todo", items: todos })
  }
}

// ---------------------------------------------------------------------------
// presentational pieces
// ---------------------------------------------------------------------------

function AssistantMessage(props: { text: string; live: boolean }) {
  const tokens = createMemo(() => props.text.match(/\S+\s*/g) ?? [])
  const [shown, setShown] = createSignal(props.live ? 0 : tokens().length)

  onMount(() => {
    if (!props.live) return
    const timer = setInterval(() => {
      setShown((n) => {
        const next = n + 3
        if (next >= tokens().length) clearInterval(timer)
        return Math.min(next, tokens().length)
      })
    }, 45)
    onCleanup(() => clearInterval(timer))
  })

  const done = createMemo(() => shown() >= tokens().length)
  const displayText = createMemo(() => (done() ? props.text : tokens().slice(0, shown()).join("")))

  return (
    <div class="chat-msg">
      <div class="chat-msg-header">
        <Show when={!done()} fallback={<span class="chat-msg-dot" />}>
          <ArcReactor size={16} />
        </Show>
        <span class="chat-msg-name">J.A.R.V.I.S</span>
      </div>
      <div class="chat-msg-text">{displayText()}</div>
    </div>
  )
}

function ToolCard(props: { item: Extract<ChatItem, { kind: "tool" }>; onToggle: () => void }) {
  const glyph = () => (props.item.state === "running" ? "…" : props.item.state === "ok" ? "✓" : "✕")
  const cls = () =>
    props.item.state === "running"
      ? "chat-tool-glyph running"
      : props.item.state === "ok"
        ? "chat-tool-glyph ok"
        : "chat-tool-glyph failed"
  return (
    <div class="chat-tool-card" onClick={props.onToggle}>
      <div class="chat-tool-header">
        <span class={cls()}>⚙ {glyph()}</span>
        <span class="chat-tool-name">{props.item.name}</span>
        <span class="chat-tool-args">{props.item.args.slice(0, TOOL_PREVIEW_CHARS)}</span>
        <span class="chat-tool-fold">{props.item.expanded ? "▾" : "▸"}</span>
      </div>
      <Show when={props.item.expanded && props.item.output}>
        <div class={props.item.state === "failed" ? "chat-tool-output failed" : "chat-tool-output"}>
          {props.item.output.slice(0, 4000)}
        </div>
      </Show>
      <Show when={!props.item.expanded && props.item.output}>
        <div class="chat-tool-preview">
          {props.item.output.slice(0, 200).replaceAll("\n", " ⏎ ")}
        </div>
      </Show>
    </div>
  )
}

function DiffCard(props: { item: Extract<ChatItem, { kind: "diff" }>; sessionId: () => string; readOnly?: boolean }) {
  const app = useApp()
  const [collapsed, setCollapsed] = createSignal<Record<number, boolean>>({})
  const [statuses, setStatuses] = createSignal<Record<number, { ok: boolean; text: string }>>({})
  const [commitIndex, setCommitIndex] = createSignal<number | null>(null)
  const [commitMsg, setCommitMsg] = createSignal("")
  const [confirmRevert, setConfirmRevert] = createSignal<number | null>(null)

  const run = async (
    verb: "stage" | "revert" | "commit" | "open_pr",
    index: number,
    params: Record<string, unknown>,
    label: string,
  ) => {
    const p = { ...params, session_id: props.sessionId() }
    try {
      const res = await app.client.call(`diff.${verb}`, p)
      const ok = res.ok === undefined ? true : Boolean(res.ok)
      const detail = String(res.url ?? res.message ?? "")
      setStatuses((m) => ({
        ...m,
        [index]: { ok, text: `${ok ? "✓" : "✕"} ${label}${detail ? " — " + detail : ""}` },
      }))
    } catch (e) {
      setStatuses((m) => ({ ...m, [index]: { ok: false, text: `✕ ${label}: ${String(e)}` } }))
    }
  }

  return (
    <div class="chat-diff-card">
      <For each={props.item.files} fallback={<div class="chat-diff-empty">(empty diff)</div>}>
        {(file, i) => {
          const stats = diffStats(file.patch)
          const lines = () => file.patch.split("\n")
          const isCollapsed = () => Boolean(collapsed()[i()])
          return (
            <div class="chat-diff-file">
              <div class="chat-diff-file-header" onClick={() => setCollapsed((m) => ({ ...m, [i()]: !m[i()] }))}>
                <span class="chat-diff-path">Δ {file.path || "(unnamed file)"}</span>
                <Show when={stats.add > 0}>
                  <span class="chat-diff-add">+{stats.add}</span>
                </Show>
                <Show when={stats.del > 0}>
                  <span class="chat-diff-del">-{stats.del}</span>
                </Show>
                <span class="chat-diff-fold">{isCollapsed() ? "▸" : "▾"}</span>
              </div>
              <Show when={!isCollapsed()}>
                <div class="chat-diff-lines">
                  <For each={lines().slice(0, MAX_DIFF_LINES)}>
                    {(line) => <div class={diffLineClass(line)}>{line || " "}</div>}
                  </For>
                  <Show when={lines().length > MAX_DIFF_LINES}>
                    <div class="chat-diff-more">… {lines().length - MAX_DIFF_LINES} more lines</div>
                  </Show>
                </div>
              </Show>
              <Show when={!props.readOnly}>
                <div class="chat-diff-actions">
                  <button type="button" onClick={() => void run("stage", i(), { path: file.path }, "stage")}>
                    Stage
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCommitIndex(i())
                      setCommitMsg("")
                    }}
                  >
                    Commit
                  </button>
                  <button type="button" onClick={() => void run("open_pr", i(), {}, "open PR")}>
                    Open PR
                  </button>
                  <button type="button" class="chat-diff-danger" onClick={() => setConfirmRevert(i())}>
                    Revert
                  </button>
                </div>
                <Show when={commitIndex() === i()}>
                  <div class="chat-diff-commit-row">
                    <input
                      value={commitMsg()}
                      placeholder="commit message (optional)"
                      onInput={(e) => setCommitMsg(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setCommitIndex(null)
                        if (e.key === "Enter") {
                          const msg = commitMsg().trim()
                          void run("commit", i(), msg ? { message: msg } : {}, "commit")
                          setCommitIndex(null)
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const msg = commitMsg().trim()
                        void run("commit", i(), msg ? { message: msg } : {}, "commit")
                        setCommitIndex(null)
                      }}
                    >
                      ✓
                    </button>
                  </div>
                </Show>
                <Show when={confirmRevert() === i()}>
                  <div class="chat-diff-confirm">
                    <span>Discard local changes to {file.path}?</span>
                    <button
                      type="button"
                      class="chat-diff-danger"
                      onClick={() => {
                        void run("revert", i(), { path: file.path }, "revert")
                        setConfirmRevert(null)
                      }}
                    >
                      Yes, revert
                    </button>
                    <button type="button" onClick={() => setConfirmRevert(null)}>
                      Cancel
                    </button>
                  </div>
                </Show>
              </Show>
              <Show when={statuses()[i()]}>
                {(s) => (
                  <div class={s().ok ? "chat-diff-status ok" : "chat-diff-status fail"}>{s().text}</div>
                )}
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}

function ApprovalCard(props: {
  item: Extract<ChatItem, { kind: "approval" }>
  onRespond: (decision: "allow" | "always" | "deny") => void
  readOnly?: boolean
}) {
  const riskClass = () =>
    props.item.risk === "high" ? "high" : props.item.risk === "low" ? "low" : "medium"
  return (
    <div class={`chat-approval-card risk-${riskClass()}`}>
      <div class="chat-approval-title">
        ✋ AUTHORIZE: {props.item.summary} <span class="chat-approval-risk">[{props.item.risk}]</span>
      </div>
      <Show
        when={!props.item.resolved}
        fallback={
          <div class={props.item.resolved === "deny" ? "chat-approval-resolved deny" : "chat-approval-resolved ok"}>
            ✓ {props.item.resolved}
          </div>
        }
      >
        <Show when={!props.readOnly} fallback={<div class="chat-approval-waiting">awaiting response…</div>}>
          <div class="chat-approval-actions">
            <button type="button" class="chat-approval-allow" onClick={() => props.onRespond("allow")}>
              Allow
            </button>
            <button type="button" class="chat-approval-always" onClick={() => props.onRespond("always")}>
              Always Allow
            </button>
            <button type="button" class="chat-approval-deny" onClick={() => props.onRespond("deny")}>
              Deny
            </button>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function TodoCard(props: { item: Extract<ChatItem, { kind: "todo" }> }) {
  const done = () => props.item.items.filter((t) => t.status === "completed").length
  const glyph = (s: string) => (s === "completed" ? "✔" : s === "in_progress" ? "▶" : "☐")
  return (
    <div class="chat-todo-card">
      <div class="chat-todo-header">
        <span>⏱ To-dos</span>
        <span class="chat-todo-count">
          {done()}/{props.item.items.length}
        </span>
      </div>
      <For each={props.item.items}>
        {(t) => (
          <div class={`chat-todo-item ${t.status}`}>
            <span class="chat-todo-glyph">{glyph(t.status)}</span>
            <span class="chat-todo-text">{t.text}</span>
          </div>
        )}
      </For>
    </div>
  )
}

function SubagentCard(props: { item: Extract<ChatItem, { kind: "subagent" }>; onOpen: (sid: string) => void }) {
  const running = () => props.item.status === "running" || props.item.status === "starting"
  return (
    <div
      class="chat-subagent-card"
      classList={{ clickable: Boolean(props.item.sessionId) }}
      onClick={() => props.item.sessionId && props.onOpen(props.item.sessionId)}
    >
      <div class="chat-subagent-header">
        <Show when={running()} fallback={<span class="chat-subagent-dot done" />}>
          <ArcReactor size={16} />
        </Show>
        <span class="chat-subagent-name">subagent: {props.item.name}</span>
        <span class="chat-subagent-status">{props.item.status}</span>
      </div>
      <Show when={props.item.task}>
        <div class="chat-subagent-task">{props.item.task}</div>
      </Show>
      <Show when={props.item.sessionId}>
        <div class="chat-subagent-hint">click to watch its chat</div>
      </Show>
    </div>
  )
}

function WidgetCard(props: { item: Extract<ChatItem, { kind: "widget" }>; onAction: (a: WidgetAction) => void }) {
  return (
    <div class="chat-widget-card">
      <div class="chat-widget-header">◆ {props.item.title}</div>
      <div class="chat-widget-body">
        <WidgetTree spec={props.item.spec} onAction={props.onAction} />
      </div>
    </div>
  )
}

function TranscriptItemView(props: {
  item: ChatItem
  sessionId: () => string
  onToggleTool: (id: number) => void
  onRespondApproval: (decision: "allow" | "always" | "deny") => void
  onWidgetAction: (a: WidgetAction) => void
  onOpenSubagent: (sid: string) => void
  readOnly?: boolean
}) {
  return (
    <div class="chat-item">
      <Switch>
        <Match when={props.item.kind === "user"}>
          <div class="chat-msg chat-msg-user">
            <div class="chat-msg-text">{(props.item as Extract<ChatItem, { kind: "user" }>).text}</div>
          </div>
        </Match>
        <Match when={props.item.kind === "assistant"}>
          {(() => {
            const a = props.item as Extract<ChatItem, { kind: "assistant" }>
            return <AssistantMessage text={a.text} live={a.live} />
          })()}
        </Match>
        <Match when={props.item.kind === "tool"}>
          <ToolCard
            item={props.item as Extract<ChatItem, { kind: "tool" }>}
            onToggle={() => props.onToggleTool(props.item.id)}
          />
        </Match>
        <Match when={props.item.kind === "diff"}>
          <DiffCard
            item={props.item as Extract<ChatItem, { kind: "diff" }>}
            sessionId={props.sessionId}
            readOnly={props.readOnly}
          />
        </Match>
        <Match when={props.item.kind === "approval"}>
          <ApprovalCard
            item={props.item as Extract<ChatItem, { kind: "approval" }>}
            onRespond={props.onRespondApproval}
            readOnly={props.readOnly}
          />
        </Match>
        <Match when={props.item.kind === "todo"}>
          <TodoCard item={props.item as Extract<ChatItem, { kind: "todo" }>} />
        </Match>
        <Match when={props.item.kind === "subagent"}>
          <SubagentCard
            item={props.item as Extract<ChatItem, { kind: "subagent" }>}
            onOpen={props.onOpenSubagent}
          />
        </Match>
        <Match when={props.item.kind === "widget"}>
          <WidgetCard
            item={props.item as Extract<ChatItem, { kind: "widget" }>}
            onAction={props.onWidgetAction}
          />
        </Match>
        <Match when={props.item.kind === "error"}>
          <div class="chat-error">✖ {(props.item as Extract<ChatItem, { kind: "error" }>).message}</div>
        </Match>
        <Match when={props.item.kind === "divider"}>
          <div class="chat-divider" />
        </Match>
        <Match when={props.item.kind === "notice"}>
          {(() => {
            const n = props.item as Extract<ChatItem, { kind: "notice" }>
            return <div class={`chat-notice ${n.style ?? "info"}`}>{n.text}</div>
          })()}
        </Match>
      </Switch>
    </div>
  )
}

// ---------------------------------------------------------------------------
// composer (input + inline "/" popup)
// ---------------------------------------------------------------------------

function Composer(props: { busy: () => boolean; onSubmit: (text: string) => void; onStop: () => void }) {
  const [value, setValue] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [popupClosed, setPopupClosed] = createSignal(false)
  let inputRef: HTMLInputElement | undefined

  onMount(() => inputRef?.focus())

  const matches = createMemo(() => {
    const v = value()
    if (popupClosed() || !v.startsWith("/") || v.includes(" ")) return []
    const prefix = v.slice(1).toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix))
  })
  const popupOpen = createMemo(() => matches().length > 0)

  const setInputValue = (text: string) => {
    setValue(text)
    setPopupClosed(false)
    setSelected(0)
    inputRef?.focus()
  }

  const onInput = (e: InputEvent & { currentTarget: HTMLInputElement }) => {
    const v = e.currentTarget.value
    setValue(v)
    setSelected(0)
    if (!v.startsWith("/")) setPopupClosed(false)
  }

  const submit = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    if (popupOpen()) {
      const pick = matches()[selected()]
      if (pick) {
        const rest = text.slice(1).split(/\s+/).slice(1).join(" ")
        setValue("")
        props.onSubmit(`/${pick.name} ${rest}`.trim())
        return
      }
    }
    setValue("")
    props.onSubmit(text)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (popupOpen()) {
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelected((i) => (i - 1 + matches().length) % matches().length)
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelected((i) => (i + 1) % matches().length)
        return
      }
      if (e.key === "Tab") {
        e.preventDefault()
        const pick = matches()[selected()]
        if (pick) setInputValue(`/${pick.name} `)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setPopupClosed(true)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit(value())
    }
  }

  return (
    <div class="chat-composer-wrap">
      <Show when={popupOpen()}>
        <div class="chat-slash-popup">
          <For each={matches()}>
            {(entry, i) => (
              <div
                class="chat-slash-item"
                classList={{ active: i() === selected() }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  setSelected(i())
                  submit(`/${entry.name}`)
                }}
              >
                <span class="chat-slash-name">/{entry.name}</span>
                <span class="chat-slash-desc">{entry.description}</span>
              </div>
            )}
          </For>
          <div class="chat-slash-hint">↑↓ pick · Enter run · Tab complete · Esc close</div>
        </div>
      </Show>
      <div class="chat-composer">
        <span class="chat-composer-caret">❯</span>
        <input
          ref={(r) => {
            inputRef = r
          }}
          class="chat-input"
          value={value()}
          placeholder="message · / for commands"
          onInput={onInput}
          onKeyDown={onKeyDown}
        />
        <Show when={props.busy()}>
          <button type="button" class="chat-stop-btn" onClick={props.onStop}>
            ■ Stop
          </button>
        </Show>
        <button type="button" class="chat-send-btn" onClick={() => submit(value())} disabled={!value().trim()}>
          Send ➤
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// session sidebar
// ---------------------------------------------------------------------------

function SessionSidebar(props: {
  sessions: () => SessionRow[]
  activeId: () => string
  onSelect: (row: SessionRow) => void
  onNew: () => void
}) {
  return (
    <div class="chat-sidebar">
      <div class="chat-sidebar-header">
        <NavIcon glyph="sessions" color="var(--accent)" glow />
        <span class="hud-label chat-sidebar-title">SESSIONS</span>
      </div>
      <button type="button" class="chat-new-btn" onClick={props.onNew}>
        + New Chat
      </button>
      <div class="chat-session-list">
        <For each={props.sessions()} fallback={<div class="chat-sidebar-empty">No sessions yet.</div>}>
          {(row) => (
            <button
              type="button"
              class="chat-session-row"
              classList={{ active: row.id === props.activeId() }}
              onClick={() => props.onSelect(row)}
            >
              <span class="chat-session-title">{row.title || row.id}</span>
              <span class="chat-session-meta">
                <Show when={row.state}>
                  <span class="chat-session-state">{row.state}</span>
                </Show>
                <span class="chat-session-time">{timeAgo(row.updated_at)}</span>
              </span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// subagent watch modal
// ---------------------------------------------------------------------------

function SubagentModal(props: { sessionId: string; onClose: () => void }) {
  const app = useApp()
  const controller = new ChatController(app.client, (m) => app.notify(m, "error"))
  let alive = true

  onMount(() => {
    void controller
      .openSession(props.sessionId, `subagent ${props.sessionId.slice(0, 8)}`)
      .catch((e) => {
        if (alive) controller.notice(`couldn't attach: ${String(e)}`, "error")
      })
  })
  onCleanup(() => {
    alive = false
    controller.dispose()
  })

  return (
    <div
      class="chat-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div class="chat-modal">
        <div class="chat-modal-header">
          <span>◇ subagent chat</span>
          <button type="button" class="chat-modal-close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class="chat-modal-transcript">
          <For each={controller.items}>
            {(item) => (
              <TranscriptItemView
                item={item}
                sessionId={controller.sessionId}
                onToggleTool={(id) => controller.toggleTool(id)}
                onRespondApproval={() => {}}
                onWidgetAction={() => {}}
                onOpenSubagent={() => {}}
                readOnly
              />
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// main page
// ---------------------------------------------------------------------------

function ChatPage() {
  const app = useApp()
  const controller = new ChatController(app.client, (m) => app.notify(m, "error"))
  const [sessions, setSessions] = createSignal<SessionRow[]>([])
  const [connected, setConnected] = createSignal(app.client.connected)
  const [subagentId, setSubagentId] = createSignal("")
  let alive = true
  let scrollRef: HTMLDivElement | undefined
  let stickBottom = true

  onCleanup(() => {
    alive = false
    controller.dispose()
  })

  onMount(() => {
    const poll = setInterval(() => setConnected(app.client.connected), 500)
    onCleanup(() => clearInterval(poll))
  })

  const loadSessions = async () => {
    try {
      const res = await app.client.call("session.list", {}, 15000)
      if (!alive) return
      const rows = (res.sessions ?? []) as SessionRow[]
      setSessions(rows.filter((s) => !s.agent).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)))
    } catch (e) {
      if (alive) app.notify(`session list failed: ${String(e)}`, "warn")
    }
  }

  onMount(() => {
    void loadSessions()
    const timer = setInterval(loadSessions, 12000)
    onCleanup(() => clearInterval(timer))
  })

  // sticky-bottom autoscroll: stick unless the user has scrolled up to read
  // history, matching the TUI scrollbox's stickyScroll/stickyStart="bottom".
  const onScroll = () => {
    const el = scrollRef
    if (!el) return
    stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  createEffect(() => {
    controller.items.length // eslint-disable-line @typescript-eslint/no-unused-expressions
    const el = scrollRef
    if (el && stickBottom) queueMicrotask(() => (el.scrollTop = el.scrollHeight))
  })

  const runSlash = async (name: string, args: string) => {
    switch (name.toLowerCase()) {
      case "new":
        await controller.newSession()
        void loadSessions()
        return
      case "goal":
        await controller.setGoal(args)
        return
      case "cancel":
        await controller.stop()
        return
      default:
        // Unknown slash text falls through as a normal chat message — the
        // brain itself may recognize its own conventions; we never invent
        // client-side behavior for verbs we don't know.
        await controller.send(`/${name} ${args}`.trim())
    }
  }

  const submitText = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    if (text.startsWith("/")) {
      const [name = "", ...rest] = text.slice(1).split(/\s+/)
      void runSlash(name, rest.join(" ")).then(loadSessions).catch((e) => app.notify(String(e), "error"))
      return
    }
    void controller
      .send(text)
      .then(loadSessions)
      .catch(() => {
        // controller.send() already pushed an inline error card
      })
  }

  const onWidgetAction = async (a: WidgetAction) => {
    if (a.send) {
      submitText(a.send)
      return
    }
    if (a.skill) {
      try {
        const res = await app.client.call("skills.invoke", { name: a.skill, args: a.args ?? "" })
        controller.notice(`◆ ${a.skill}: ${String(res.message ?? "done")}`, "success")
      } catch (e) {
        controller.notice(`◆ ${a.skill} failed: ${String(e)}`, "error")
      }
    }
  }

  const selectRow = (row: SessionRow) => {
    void controller.openSession(row.id, row.title || row.id).catch((e) => app.notify(String(e), "error"))
  }

  const startNew = () => {
    void controller
      .newSession()
      .then(loadSessions)
      .catch((e) => app.notify(String(e), "error"))
  }

  return (
    <div class="chat-page page-enter">
      <SessionSidebar sessions={sessions} activeId={controller.sessionId} onSelect={selectRow} onNew={startNew} />
      <div class="chat-main">
        <div class="chat-header">
          <span class={connected() ? "chat-conn-dot on" : "chat-conn-dot"} />
          <span class="chat-header-title">
            {controller.sessionId() ? controller.sessionId().slice(0, 8) : "new conversation"}
          </span>
          <Show when={controller.status()}>
            <span class="chat-header-status">{controller.status()}</span>
          </Show>
        </div>
        <div class="chat-transcript" ref={(r) => (scrollRef = r)} onScroll={onScroll}>
          <Show when={controller.items.length === 0}>
            <div class="chat-empty-state">
              <ArcReactor size={40} />
              <div class="chat-empty-title">How can I help?</div>
              <div class="chat-empty-sub">Send a message to start, or pick a session on the left.</div>
            </div>
          </Show>
          <For each={controller.items}>
            {(item) => (
              <TranscriptItemView
                item={item}
                sessionId={controller.sessionId}
                onToggleTool={(id) => controller.toggleTool(id)}
                onRespondApproval={(d) => void controller.respondApproval(d)}
                onWidgetAction={(a) => void onWidgetAction(a)}
                onOpenSubagent={(sid) => setSubagentId(sid)}
              />
            )}
          </For>
        </div>
        <Composer busy={controller.busy} onSubmit={submitText} onStop={() => void controller.stop()} />
      </div>
      <Show when={subagentId()}>
        <SubagentModal sessionId={subagentId()} onClose={() => setSubagentId("")} />
      </Show>
      <style>{CHAT_CSS}</style>
    </div>
  )
}

// ---------------------------------------------------------------------------
// styles — page-scoped (chat-* prefix); reuses theme.css tokens via var(...)
// ---------------------------------------------------------------------------

const CHAT_CSS = `
.chat-page {
  display: flex;
  height: 100%;
  gap: 12px;
}
.chat-sidebar {
  width: 220px;
  flex: 0 0 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius);
  padding: 12px;
  min-height: 0;
}
.chat-sidebar-header { display: flex; align-items: center; gap: 8px; }
.chat-sidebar-title { font-size: 11px; color: var(--text-faint); }
.chat-new-btn {
  all: unset;
  cursor: pointer;
  text-align: center;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--accent-dim);
  color: var(--accent-bright);
  border: 1px solid var(--accent-dim);
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: var(--track-mid);
  transition: background var(--dur-fast) ease;
}
.chat-new-btn:hover { background: var(--accent-faint); }
.chat-session-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.chat-sidebar-empty { color: var(--text-faint); font-size: 11px; padding: 6px 2px; }
.chat-session-row {
  all: unset;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  color: var(--text-muted);
  transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease;
}
.chat-session-row:hover { background: rgba(255,255,255,0.04); }
.chat-session-row.active {
  border-color: var(--accent-dim);
  background: var(--nav-active);
  color: var(--accent-bright);
}
.chat-session-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-session-meta { display: flex; gap: 8px; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }

.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-soft);
  background: var(--surface-deep);
  flex: 0 0 auto;
}
.chat-conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); flex-shrink: 0; }
.chat-conn-dot.on { background: var(--success); animation: chat-link-pulse 1100ms ease-in-out infinite; }
@keyframes chat-link-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.chat-header-title { font-family: var(--font-display); font-size: 12px; letter-spacing: var(--track-mid); color: var(--text); }
.chat-header-status { margin-left: auto; font-size: 11px; color: var(--accent); font-family: var(--font-mono); }

.chat-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 6px 4px 2px;
}
.chat-empty-state {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--text-faint);
  padding: 40px 0;
}
.chat-empty-title { font-family: var(--font-display); font-size: 15px; color: var(--text-muted); }
.chat-empty-sub { font-size: 12px; }

.chat-item { animation: chat-item-in var(--dur-slow) ease-out backwards; }
@keyframes chat-item-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

.chat-msg { display: flex; flex-direction: column; gap: 4px; max-width: 720px; }
.chat-msg-header { display: flex; align-items: center; gap: 6px; }
.chat-msg-name { font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid); color: var(--accent); }
.chat-msg-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-dim); border: 1px solid var(--accent-dim); flex-shrink: 0; }
.chat-msg-text { font-size: 13px; line-height: 1.5; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.chat-msg-user {
  align-self: flex-end;
  background: var(--surface-strong);
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm);
  padding: 9px 13px;
}
.chat-msg-user .chat-msg-text { color: var(--text); font-weight: 500; }

.chat-tool-card {
  cursor: pointer;
  border-left: 2px solid var(--hairline-soft);
  padding: 6px 0 6px 10px;
  max-width: 720px;
}
.chat-tool-header { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.chat-tool-glyph { font-family: var(--font-mono); }
.chat-tool-glyph.running { color: var(--amber); }
.chat-tool-glyph.ok { color: var(--success); }
.chat-tool-glyph.failed { color: var(--danger); }
.chat-tool-name { color: var(--amber); font-family: var(--font-mono); }
.chat-tool-args { color: var(--text-faint); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.chat-tool-fold { color: var(--text-faint); }
.chat-tool-output {
  margin-top: 4px;
  padding: 8px 10px;
  border-left: 1px solid var(--hairline-soft);
  background: var(--surface-deep);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.chat-tool-output.failed { color: var(--danger); border-left-color: var(--danger); }
.chat-tool-preview { font-size: 11px; color: var(--text-faint); font-family: var(--font-mono); }

.chat-diff-card { display: flex; flex-direction: column; gap: 8px; max-width: 760px; }
.chat-diff-file {
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chat-diff-file-header { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; }
.chat-diff-path { color: var(--accent); font-weight: 600; font-family: var(--font-mono); }
.chat-diff-add { color: var(--success); font-family: var(--font-mono); font-size: 11px; }
.chat-diff-del { color: var(--danger); font-family: var(--font-mono); font-size: 11px; }
.chat-diff-fold { margin-left: auto; color: var(--text-faint); }
.chat-diff-lines {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--surface-deep);
  border-radius: var(--radius-xs);
  padding: 8px;
  max-height: 340px;
  overflow-y: auto;
}
.chat-diff-line { white-space: pre-wrap; word-break: break-word; color: var(--text-muted); }
.chat-diff-line-add { color: var(--success); }
.chat-diff-line-del { color: var(--danger); }
.chat-diff-line-hunk { color: var(--violet); }
.chat-diff-line-faint { color: var(--text-faint); }
.chat-diff-more { color: var(--text-faint); }
.chat-diff-empty { color: var(--text-faint); font-size: 12px; }
.chat-diff-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.chat-diff-actions button, .chat-diff-commit-row button, .chat-diff-confirm button {
  all: unset;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft);
  background: var(--surface-strong);
  color: var(--text-muted);
  font-size: 11px;
  font-family: var(--font-display);
  letter-spacing: var(--track-tight);
}
.chat-diff-actions button:hover { border-color: var(--accent-dim); color: var(--accent-bright); }
.chat-diff-danger { color: var(--danger) !important; }
.chat-diff-danger:hover { border-color: var(--danger-dim) !important; }
.chat-diff-commit-row { display: flex; gap: 6px; align-items: center; }
.chat-diff-commit-row input {
  flex: 1;
  background: var(--surface-input);
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-xs);
  color: var(--text);
  padding: 6px 8px;
  font-size: 12px;
}
.chat-diff-confirm { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--amber); }
.chat-diff-status { font-size: 11px; }
.chat-diff-status.ok { color: var(--success); }
.chat-diff-status.fail { color: var(--danger); }

.chat-approval-card {
  border: 1px solid var(--amber-dim);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  max-width: 620px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-approval-card.risk-high { border-color: var(--danger-dim); }
.chat-approval-card.risk-low { border-color: rgba(57, 230, 160, 0.3); }
.chat-approval-title { font-size: 12px; font-weight: 600; color: var(--amber); }
.risk-high .chat-approval-title { color: var(--danger); }
.risk-low .chat-approval-title { color: var(--success); }
.chat-approval-risk { color: var(--text-faint); font-weight: 400; }
.chat-approval-actions { display: flex; gap: 8px; }
.chat-approval-actions button {
  all: unset;
  cursor: pointer;
  padding: 5px 12px;
  border-radius: var(--radius-xs);
  font-size: 11px;
  font-family: var(--font-display);
  letter-spacing: var(--track-tight);
  border: 1px solid var(--hairline-soft);
}
.chat-approval-allow { color: var(--success); }
.chat-approval-allow:hover { border-color: var(--success); }
.chat-approval-always { color: var(--accent-bright); }
.chat-approval-always:hover { border-color: var(--accent); }
.chat-approval-deny { color: var(--danger); }
.chat-approval-deny:hover { border-color: var(--danger); }
.chat-approval-resolved { font-size: 11px; }
.chat-approval-resolved.ok { color: var(--success); }
.chat-approval-resolved.deny { color: var(--danger); }
.chat-approval-waiting { font-size: 11px; color: var(--text-faint); }

.chat-todo-card {
  border-left: 2px solid var(--accent);
  padding: 6px 0 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 480px;
}
.chat-todo-header { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--accent); font-weight: 600; }
.chat-todo-count { color: var(--text-faint); font-weight: 400; font-family: var(--font-mono); }
.chat-todo-item { display: flex; gap: 8px; font-size: 12px; }
.chat-todo-item.completed .chat-todo-text { color: var(--text-faint); text-decoration: line-through; }
.chat-todo-item.in_progress .chat-todo-text { color: var(--text); font-weight: 600; }
.chat-todo-item.completed .chat-todo-glyph { color: var(--success); }
.chat-todo-item.in_progress .chat-todo-glyph { color: var(--accent-bright); }
.chat-todo-item.pending .chat-todo-glyph { color: var(--text-muted); }

.chat-subagent-card {
  border: 1px solid var(--violet);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.chat-subagent-card.clickable { cursor: pointer; }
.chat-subagent-card.clickable:hover { box-shadow: 0 0 12px -4px var(--violet); }
.chat-subagent-header { display: flex; align-items: center; gap: 8px; }
.chat-subagent-dot { width: 8px; height: 8px; border-radius: 50%; }
.chat-subagent-dot.done { background: var(--success); }
.chat-subagent-name { font-size: 12px; color: var(--violet); font-weight: 600; }
.chat-subagent-status { margin-left: auto; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.chat-subagent-task { font-size: 11px; color: var(--text-muted); }
.chat-subagent-hint { font-size: 10px; color: var(--text-faint); }

.chat-widget-card {
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  max-width: 640px;
}
.chat-widget-header { font-size: 11px; color: var(--accent); font-weight: 600; margin-bottom: 8px; }

.chat-error { color: var(--danger); font-size: 12px; font-weight: 600; max-width: 640px; }
.chat-divider { height: 1px; background: linear-gradient(90deg, transparent, var(--hairline), transparent); margin: 4px 0; }
.chat-notice { font-size: 11px; color: var(--text-muted); }
.chat-notice.warn { color: var(--amber); }
.chat-notice.error { color: var(--danger); }
.chat-notice.success { color: var(--success); }

.chat-composer-wrap { position: relative; flex: 0 0 auto; }
.chat-composer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 44px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-soft);
  background: var(--surface-input);
}
.chat-composer:focus-within { border-color: var(--accent-dim); }
.chat-composer-caret { color: var(--accent); }
.chat-input {
  all: unset;
  flex: 1;
  color: var(--text);
  font-size: 13px;
}
.chat-input::placeholder { color: var(--text-faint); }
.chat-send-btn, .chat-stop-btn {
  all: unset;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: var(--radius-xs);
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: var(--track-tight);
  flex-shrink: 0;
}
.chat-send-btn { background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim); }
.chat-send-btn:hover { background: var(--accent-faint); }
.chat-send-btn:disabled { opacity: 0.4; cursor: default; }
.chat-stop-btn { color: var(--danger); border: 1px solid var(--danger-dim); }
.chat-stop-btn:hover { background: var(--danger-dim); }

.chat-slash-popup {
  position: absolute;
  bottom: 52px;
  left: 0;
  right: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-strong);
  overflow: hidden;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,0.5);
}
.chat-slash-item { display: flex; gap: 10px; padding: 7px 12px; cursor: pointer; font-size: 12px; }
.chat-slash-item.active { background: var(--nav-active); }
.chat-slash-name { color: var(--accent-bright); font-family: var(--font-mono); }
.chat-slash-desc { color: var(--text-faint); }
.chat-slash-hint { padding: 5px 12px; font-size: 10px; color: var(--text-faint); border-top: 1px solid var(--hairline-faint); }

.chat-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 250;
  background: rgba(4,7,12,0.65);
  display: flex;
  align-items: center;
  justify-content: center;
}
.chat-modal {
  width: min(720px, calc(100vw - 48px));
  height: min(640px, calc(100vh - 80px));
  background: var(--surface);
  border: 1px solid var(--violet);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chat-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--hairline-soft);
  color: var(--violet);
  font-size: 12px;
  font-weight: 600;
}
.chat-modal-close { all: unset; cursor: pointer; color: var(--text-faint); padding: 2px 6px; }
.chat-modal-close:hover { color: var(--text); }
.chat-modal-transcript { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
`

const page: PageDef = { id: "chat", label: "CHAT", section: "WORKSPACE", order: 1, component: ChatPage }
export default page
