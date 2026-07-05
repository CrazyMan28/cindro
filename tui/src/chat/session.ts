// SessionController — chat-session state + the event pump, framework-side of
// the Contract-A chat flow (port of ChatPane's session logic in
// cli/jarvis_cli/tui/chat.py, same verbs and event kinds):
//   session.create {profile:"coworker"} → subscribe IMMEDIATELY → pump the
//   per-session AsyncQueue into a solid store of transcript items.
// Also folds session-scoped widget.render broadcasts into the transcript
// (the GUI's ChatDelegate "widget" kind) and watches the file-based
// ask_user question bus (<dataDir>/questions/<id>.json ⇄ <id>.answer —
// the same contract Bridge::answerQuestion uses).

import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import type { FSWatcher } from "node:fs"
import { join } from "node:path"

import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"

import { dataDir } from "../config"
import type { ControlClient } from "../control/client"

export type ChatItem =
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
  | {
      id: number
      kind: "question"
      questionId: string
      question: string
      options: string[]
      answered?: string
    }
  | { id: number; kind: "widget"; title: string; spec: Record<string, unknown> }
  | { id: number; kind: "error"; message: string }
  | { id: number; kind: "divider" }
  | {
      id: number
      kind: "notice"
      text: string
      style?: "info" | "warn" | "error" | "success"
    }

let nextId = 1
const mkId = () => nextId++

export function questionsDir(): string {
  // Must match the engine's ask_bus.py / DataPaths.h EXACTLY on every OS.
  return join(dataDir(), "questions")
}

export class SessionController {
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
  readonly pendingQuestion: () => { questionId: string; question: string; options: string[] } | null
  private setPendingQuestion: (
    v: { questionId: string; question: string; options: string[] } | null,
  ) => void

  private pumpGen = 0
  private offWidget?: () => void
  private questionWatcher?: FSWatcher
  private answeredQuestions = new Set<string>()

  constructor(private client: ControlClient) {
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
    const [pendingQuestion, setPendingQuestion] = createSignal<
      { questionId: string; question: string; options: string[] } | null
    >(null)
    this.pendingQuestion = pendingQuestion
    this.setPendingQuestion = setPendingQuestion

    // Session-scoped widget.render broadcasts fold into the transcript, the
    // GUI ChatDelegate "widget" kind. Multi-subscriber bus: Canvas can
    // listen too without clobbering us (the old single-slot landmine).
    this.offWidget = client.on("widget.render", (_ev, data) => {
      const sid = String(data.session_id ?? "")
      if (!sid || sid !== this.sessionId()) return
      const spec = (data.spec ?? data.widget ?? {}) as Record<string, unknown>
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
    this.questionWatcher?.close()
  }

  private push(item: ChatItem): void {
    this.setItems((items) => {
      items.push(item)
    })
  }

  notice(text: string, style?: "info" | "warn" | "error" | "success"): void {
    this.push({ id: mkId(), kind: "notice", text, style })
  }

  // -- lifecycle --------------------------------------------------------------
  async ensureSession(): Promise<string> {
    if (this.sessionId()) return this.sessionId()
    const res = await this.client.call("session.create", { profile: "coworker" }, 20000)
    const sid = String(res.session_id ?? "")
    if (!sid) throw new Error("session.create returned no session_id")
    this.setSessionId(sid)
    await this.client.subscribe(sid)
    this.startPump(sid)
    this.watchQuestions()
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
    await this.client.subscribe(sessionId)
    this.startPump(sessionId)
    this.watchQuestions()
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

  // -- actions ----------------------------------------------------------------
  async send(text: string): Promise<void> {
    const sid = await this.ensureSession()
    this.push({ id: mkId(), kind: "user", text })
    this.setBusy(true)
    this.setStatus("thinking…")
    await this.client.call("session.send", { session_id: sid, text }, 30000)
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
    if (!pending || !this.sessionId()) {
      this.setStatus("no approval pending")
      return
    }
    await this.client.call("approval.respond", {
      session_id: this.sessionId(),
      approval_id: pending.approvalId,
      decision,
    })
    this.setItems((items) => {
      for (const item of items) {
        if (item.kind === "approval" && item.approvalId === pending.approvalId)
          item.resolved = decision
      }
    })
    this.setPendingApproval(null)
    this.setStatus("")
  }

  answerQuestion(questionId: string, answer: string): void {
    const dir = questionsDir()
    writeFileSync(join(dir, `${questionId}.answer`), JSON.stringify({ answer }))
    this.answeredQuestions.add(questionId)
    this.setItems((items) => {
      for (const item of items) {
        if (item.kind === "question" && item.questionId === questionId)
          item.answered = answer
      }
    })
    this.setPendingQuestion(null)
  }

  // -- ask_user file bus --------------------------------------------------------
  private watchQuestions(): void {
    if (this.questionWatcher) return
    const dir = questionsDir()
    try {
      mkdirSync(dir, { recursive: true })
      this.scanQuestions()
      this.questionWatcher = watch(dir, () => this.scanQuestions())
    } catch {
      // question bus unavailable (odd permissions) — chat still works
    }
  }

  scanQuestions(): void {
    const dir = questionsDir()
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const id = name.slice(0, -5)
      if (this.answeredQuestions.has(id)) continue
      if (existsSync(join(dir, `${id}.answer`))) {
        this.answeredQuestions.add(id)
        continue
      }
      if (this.items.some((i) => i.kind === "question" && i.questionId === id)) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
          string,
          unknown
        >
        const question = String(parsed.question ?? "")
        if (!question) continue
        const options = ((parsed.options ?? []) as unknown[]).map(String)
        this.push({ id: mkId(), kind: "question", questionId: id, question, options })
        this.setPendingQuestion({ questionId: id, question, options })
      } catch {
        // half-written file — the next directoryChanged rescan picks it up
      }
    }
  }

  // -- event folding --------------------------------------------------------------
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
        const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? "")
        const name = String(ev.name ?? "tool")
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
              item.expanded = !ok // failures auto-expand (GUI parity)
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
        if (!replay) this.setStatus("approval pending — y / a / n")
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
        return // unknown kinds are silently skipped, same as the legacy TUI
    }
  }

  toggleTool(itemId: number): void {
    this.setItems((items) => {
      for (const item of items) {
        if (item.kind === "tool" && item.id === itemId) item.expanded = !item.expanded
      }
    })
  }
}

/**
 * Normalize a diff event's file list (port of diff_render.extract_diff_files):
 * accepts single-file {path,patch} or multi-file {files:[…]}, tolerating
 * file/diff key aliases.
 */
export function extractDiffFiles(
  ev: Record<string, unknown>,
): Array<{ path: string; patch: string }> {
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
