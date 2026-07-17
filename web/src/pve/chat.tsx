// Cindro operator chat: one persistent session bound to the "proxmox-operator"
// agent, routed at the full-power operator MCP (target_ref
// "proxmox-op-<host>", via env.ts's operatorTargetRef()). Renders the
// Contract B stream (thinking / message / tool_call+tool_result / approval /
// error / final) as an animated HUD transcript in the desktop app's visual
// language (see desktop/qml/ChatDelegate.qml: role-edged message bubbles,
// unified tool cards with a spinning ArcReactor while running, a pulsing-edge
// approval card). Shared by the full Chat page and the docked side-rail.
//
// The dashboard proxy only forwards a small allow-listed method set —
// session.create/send/subscribe, approval.respond, proxmoxop.*, ping (see
// dashboard_server.py's _ALLOWED_METHODS) — notably NOT session.cancel, so
// there is deliberately no "Stop" control here: a call to it would always
// come back method_not_allowed. The composer instead just blocks new sends
// until the in-flight turn's `final` event lands.

import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { createStore, produce } from "solid-js/store"

import { ArcReactor } from "../components/ArcReactor"
import type { CindroClient } from "./cindro-client"
import { operatorTargetRef } from "./env"

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type ChatItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; live: boolean }
  | {
      id: number
      kind: "thinking"
      text: string
      startedAt: number
      endedAt: number | null
      expanded: boolean
    }
  | {
      id: number
      kind: "tool"
      callId: string
      name: string
      args: string
      output: string
      state: "running" | "ok" | "failed"
      expanded: boolean
    }
  | {
      id: number
      kind: "approval"
      approvalId: string
      summary: string
      risk: "low" | "medium" | "high"
      resolved: "" | "allow" | "always" | "deny"
    }
  | { id: number; kind: "error"; text: string }

let nextId = 1
const mkId = () => nextId++

const TOOL_OUTPUT_CAP = 4000
const THINKING_CAP = 4000

// --- persistence -----------------------------------------------------------
// The operator transcript + chosen model survive a page reload AND navigation
// between pages via localStorage, so Cindro's Proxmox chat "keeps history" like
// every other Cindro surface. This is DISPLAY continuity: the daemon session
// itself can't be resumed across a browser reload (the dashboard proxy scopes
// session.send/subscribe to sessions the CURRENT socket created — see
// dashboard_server.py's allowed_sessions), so on reload the transcript is
// restored for reading and the next message opens a fresh session. Switching
// model does the same (the model is fixed at session.create), keeping history.
const CHAT_STORE_KEY = "cindro.pve.chat.transcript.v1"
const MODEL_STORE_KEY = "cindro.pve.chat.model.v1"
const MAX_PERSISTED_ITEMS = 150
const PERSIST_FIELD_CAP = 8000
// The recommended CLI-less default when nothing operator-capable is configured;
// single-sourced so the picker label and the session it opens never disagree.
const DEFAULT_OPERATOR_MODEL = "mistral-large-latest"

// The transcript can carry sensitive infra details (tool args/outputs, approval
// summaries), so it MUST NOT bleed across Proxmox accounts on a shared admin
// browser. Namespace every persisted key by the authenticated operator's userid,
// read straight from the PVEAuthCookie ("PVE:<userid>:<ts>::<sig>") — the same
// identity pveproxy signs and dashboard_server.py trusts — so a different admin
// signing in reads their own (empty) key, never the previous operator's.
function currentOperatorId(): string {
  try {
    const m = typeof document !== "undefined" ? document.cookie.match(/(?:^|;\s*)PVEAuthCookie=([^;]+)/) : null
    if (!m) return ""
    const parts = decodeURIComponent(m[1]).split(":")
    return parts.length > 1 ? parts[1] : ""
  } catch {
    return ""
  }
}

function chatStoreKey(): string {
  const id = currentOperatorId()
  return id ? `${CHAT_STORE_KEY}:${id}` : CHAT_STORE_KEY
}

function modelStoreKey(): string {
  const id = currentOperatorId()
  return id ? `${MODEL_STORE_KEY}:${id}` : MODEL_STORE_KEY
}

function capStr(s: string): string {
  return s.length > PERSIST_FIELD_CAP ? `${s.slice(0, PERSIST_FIELD_CAP)}…` : s
}

/** Freeze a live item into a stable, replay-safe form for storage: no active
 * typewriter/thinking timers, collapsed folds, capped strings, and no tool card
 * left "running" (a turn cut off by the page close reads back as failed rather
 * than spinning forever). */
function sanitizeForStore(it: ChatItem): ChatItem {
  switch (it.kind) {
    case "assistant":
      return { ...it, live: false, text: capStr(it.text) }
    case "thinking":
      return { ...it, expanded: false, endedAt: it.endedAt ?? it.startedAt, text: capStr(it.text) }
    case "tool":
      return it.state === "running"
        ? {
            ...it,
            expanded: false,
            state: "failed",
            args: capStr(it.args),
            output: it.output ? capStr(it.output) : "(interrupted — the page was closed mid-call)",
          }
        : { ...it, expanded: false, args: capStr(it.args), output: capStr(it.output) }
    case "approval":
      // A reloaded page can't resume the daemon session, so a still-pending
      // approval could never be answered. Persist it fail-closed (not
      // authorized) rather than as a live button that silently does nothing.
      return it.resolved ? it : { ...it, resolved: "deny" }
    case "user":
    case "error":
      // Cap these too: an operator pasting a large log into the composer would
      // otherwise store an uncapped `user` item, and a few of those can blow the
      // localStorage quota — every later write then throws (silently), wedging
      // persistence so reloads restore a stale transcript.
      return { ...it, text: capStr(it.text) }
    default:
      return it
  }
}

function isStoredItem(x: unknown): x is ChatItem {
  return !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "number" && typeof (x as { kind?: unknown }).kind === "string"
}

function readStoredTranscript(): ChatItem[] {
  try {
    const raw = localStorage.getItem(chatStoreKey())
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(isStoredItem) : []
  } catch {
    return []
  }
}

function readStoredModel(): string {
  try {
    return localStorage.getItem(modelStoreKey()) || ""
  } catch {
    return ""
  }
}

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

function formatArgs(raw: unknown): string {
  const obj = parseArgs(raw)
  if (Object.keys(obj).length === 0 && typeof raw === "string") return raw
  try {
    return JSON.stringify(obj)
  } catch {
    return ""
  }
}

function normalizeRisk(v: unknown): "low" | "medium" | "high" {
  const s = String(v ?? "medium").toLowerCase()
  return s === "high" || s === "low" ? s : "medium"
}

// The operator's MCP routing (makeBrain's "proxmox-op-" branch) ONLY wires the
// full-power operator tool endpoint for an OpenAI-compatible `api` brain — a CLI
// brain (codex/claude) or Anthropic can't drive it and would start a chat with
// NO Proxmox tools (or fail outright, e.g. "codex not found on PATH"). So a
// model is only "operator-capable" if it's a non-Anthropic api-brain model;
// this gate applies to both the session default AND the in-chat picker list.
function isOperatorCapableModel(model: string): boolean {
  return !!model && !/^(claude|anthropic)/i.test(model)
}

// The api model catalog is a static cross-provider floor (every provider's ids
// appear regardless of which keys exist), so listing it verbatim lets an
// operator pick e.g. gpt-5.5 on a Mistral-only host — makeBrain then can't find
// the OpenAI key and the whole operator conversation fails. Map an id to its
// provider (mirrors settings.tsx's PROVIDERS) so the picker can hide models
// whose key isn't set. Unknown prefixes are kept (better to show a maybe-usable
// model than to hide a valid one); Ollama tags (contain ":") are local, no key.
function providerOfModel(model: string): string {
  const m = model.toLowerCase()
  if (m.includes(":")) return "ollama"
  if (/^(gpt|o1|o3|o4|chatgpt|text-|davinci)/.test(m)) return "openai"
  if (/^(mistral|codestral|magistral|ministral|pixtral|devstral|open-mistral|open-mixtral)/.test(m)) return "mistral"
  if (/^grok/.test(m)) return "xai"
  if (/^gemini/.test(m)) return "gemini"
  if (/^deepseek/.test(m)) return "deepseek"
  return ""
}

function isModelUsable(model: string, apiKeysSet: Record<string, boolean>): boolean {
  const p = providerOfModel(model)
  if (!p || p === "ollama") return true // local, or provider we can't attribute — keep
  return apiKeysSet[p] === true
}

// The operator session's brain/model come from the admin's AI Settings
// (settings.get default_brain / default_model), surfaced by the dashboard's
// /_jarvis/settings bridge, so a host configured for OpenAI / Ollama / etc.
// isn't forced onto Mistral. Also returns the operator-capable model catalog so
// the in-chat model picker has something to list. Falls back to the api brain +
// mistral-large-latest (the recommended CLI-less default) when nothing usable
// is configured.
async function resolveOperatorConfig(): Promise<{ brain: string; model: string; models: string[] }> {
  const fallback = { brain: "api", model: DEFAULT_OPERATOR_MODEL, models: [] as string[] }
  try {
    const r = await fetch("/_jarvis/settings", { credentials: "include" })
    if (!r.ok) return fallback
    const j = (await r.json()) as Record<string, unknown>
    const s = ((j?.settings as Record<string, unknown>) ?? {}) as Record<string, unknown>
    const apiKeysSet = (s.api_keys_set as Record<string, boolean>) ?? {}
    const rawModels = (j?.models as { models?: unknown })?.models
    const models = (Array.isArray(rawModels) ? (rawModels as unknown[]) : []).filter(
      (m): m is string => typeof m === "string" && isOperatorCapableModel(m) && isModelUsable(m, apiKeysSet),
    )
    let model = fallback.model
    if (s.default_brain === "api" && typeof s.default_model === "string" && isOperatorCapableModel(s.default_model)) {
      model = s.default_model
    }
    return { brain: "api", model, models }
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// ChatController — one session, the Contract B event pump, and reactive state
// ---------------------------------------------------------------------------

export class ChatController {
  readonly items: ChatItem[]
  private setItems: (fn: (items: ChatItem[]) => void) => void

  readonly busy: () => boolean
  private setBusy: (v: boolean) => void
  readonly connected: () => boolean

  private sid = createSignal("")
  private unbindEvents: (() => void) | null = null
  private unbindStatus: (() => void) | null = null
  private currentThinkingId: number | null = null
  private creating: Promise<string> | null = null

  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private modelOverride = createSignal<string>(readStoredModel())
  private hostDefaultModel = createSignal<string>("")
  private modelList = createSignal<string[]>([])
  private modelsLoaded = false

  constructor(private client: CindroClient) {
    const [items, setItems] = createStore<ChatItem[]>([])
    this.items = items
    // Every mutation schedules a debounced localStorage write so the transcript
    // is durable without persisting on every streamed token.
    this.setItems = (fn) => {
      setItems(produce(fn))
      this.schedulePersist()
    }

    // Rehydrate any prior transcript BEFORE the event pump can push new items,
    // and advance the id counter past the restored ids so new items never
    // collide with (and clobber) a restored row of the same id.
    const restored = readStoredTranscript()
    if (restored.length) {
      let maxId = 0
      for (const it of restored) if (it.id > maxId) maxId = it.id
      if (nextId <= maxId) nextId = maxId + 1
      setItems(
        produce((list) => {
          for (const it of restored) list.push(it)
        }),
      )
    }

    const [busy, setBusy] = createSignal(false)
    this.busy = busy
    this.setBusy = setBusy

    const [connected, setConnected] = createSignal(client.connected)
    this.connected = connected
    this.unbindStatus = client.on("__status", (data) => {
      const c = Boolean(data.connected)
      setConnected(c)
      // If the socket drops mid-turn, the `final` frame may be lost; don't leave
      // the composer disabled forever — free it so the user can retry.
      if (!c) this.setBusy(false)
    })
  }

  sessionId(): string {
    return this.sid[0]()
  }

  /** Wire the Contract B event pump. Idempotent — safe to call from every
   * mount site that shares this controller (the full Chat page AND the
   * docked side-rail render the same conversation). */
  bind(): void {
    if (this.unbindEvents) return
    this.unbindEvents = this.client.on("session.event", (data) => {
      const sessionId = String(data.session_id ?? "")
      if (!sessionId || sessionId !== this.sid[0]()) return
      this.applyEvent((data.ev ?? {}) as Record<string, unknown>)
    })
  }

  dispose(): void {
    this.unbindEvents?.()
    this.unbindEvents = null
    this.unbindStatus?.()
    this.unbindStatus = null
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
  }

  // --- model picker + history controls -------------------------------------

  /** The operator-capable model catalog for the in-chat picker. */
  models(): string[] {
    return this.modelList[0]()
  }

  /** The model the next session will use: the operator's explicit pick, else the
   * host default from AI Settings, else Mistral. */
  selectedModel(): string {
    return this.modelOverride[0]() || this.hostDefaultModel[0]() || DEFAULT_OPERATOR_MODEL
  }

  /** Fetch the operator-capable model catalog + host default for the picker.
   * Idempotent — the first caller wins, later calls are no-ops. */
  async loadModels(): Promise<void> {
    if (this.modelsLoaded) return
    this.modelsLoaded = true
    const cfg = await resolveOperatorConfig()
    this.hostDefaultModel[1](cfg.model)
    // Drop a persisted override whose provider key has since been removed — the
    // usable catalog loaded but no longer lists it — so we don't open a session
    // on a model with no key (the turn would just fail); fall back to the host
    // default. Guard on a NON-EMPTY catalog so a transient settings-fetch failure
    // (empty list) doesn't wipe a still-valid pick.
    const override = this.modelOverride[0]()
    if (override && cfg.models.length > 0 && !cfg.models.includes(override)) {
      this.modelOverride[1]("")
      try {
        localStorage.removeItem(modelStoreKey())
      } catch {
        /* best-effort */
      }
    }
    // Keep the (now-validated) current selection listed even if the catalog
    // didn't return it — e.g. the host default the admin set, or an offline
    // provider — so the header never shows a model that's missing from its menu.
    const list = [...cfg.models]
    const sel = this.modelOverride[0]() || cfg.model
    if (sel && !list.includes(sel)) list.unshift(sel)
    this.modelList[1](list)
  }

  /** Switch the model for subsequent turns. The model is fixed at
   * session.create, so this abandons the current daemon session (a fresh one
   * opens on the next send) while KEEPING the visible transcript. */
  setModel(model: string): void {
    // Refuse mid-turn: resetSession would blank the sid an in-flight
    // ensureSession/turn still depends on (a race that strands the switch and
    // leaves a running tool card spinning). The picker button is disabled while
    // busy; this guards the already-open-menu case.
    if (!model || this.busy() || model === this.selectedModel()) return
    this.modelOverride[1](model)
    try {
      localStorage.setItem(modelStoreKey(), model)
    } catch {
      /* best-effort */
    }
    this.resetSession()
  }

  /** Wipe the transcript and start a brand-new conversation. */
  newConversation(): void {
    if (this.busy()) return // never clear out from under an in-flight turn
    this.clearTranscript()
  }

  /** Purge persisted + in-memory history unconditionally — call at the auth
   * boundary (logout / account switch) so a shared admin browser doesn't carry
   * one operator's transcript, tool outputs, or approval summaries into the
   * next operator's session. */
  forgetHistory(): void {
    this.clearTranscript()
    try {
      localStorage.removeItem(modelStoreKey())
    } catch {
      /* best-effort */
    }
    this.modelOverride[1]("")
  }

  private clearTranscript(): void {
    this.setItems((items) => {
      items.splice(0, items.length)
    })
    this.resetSession()
    // The splice above scheduled a debounced write; cancel it so removeItem
    // actually clears the key instead of being overwritten with "[]" 400ms later.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    try {
      localStorage.removeItem(chatStoreKey())
    } catch {
      /* best-effort */
    }
  }

  private resetSession(): void {
    this.sid[1]("")
    this.creating = null
    this.currentThinkingId = null
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      try {
        const slice = this.items.slice(-MAX_PERSISTED_ITEMS).map(sanitizeForStore)
        localStorage.setItem(chatStoreKey(), JSON.stringify(slice))
      } catch {
        /* quota exceeded / storage unavailable — history is best-effort */
      }
    }, 400)
  }

  private push(item: ChatItem): void {
    this.setItems((items) => {
      items.push(item)
    })
  }

  private async ensureSession(): Promise<string> {
    const existing = this.sid[0]()
    if (existing) return existing
    if (this.creating) return this.creating
    this.creating = (async () => {
      // Resolve the catalog first (idempotent, single fetch): this populates the
      // host default AND drops a persisted override whose provider key was
      // removed, so we never open a session on a model with no usable key.
      await this.loadModels()
      // Then honor the operator's (validated) pick, else the admin's default,
      // else Mistral — a host with only an OpenAI key or a local Ollama model
      // shouldn't be forced onto a hard-coded mistral.
      const brain = "api"
      const model = this.selectedModel()
      const res = await this.client.call(
        "session.create",
        {
          agent: "proxmox-operator",
          brain,
          model,
          target_ref: operatorTargetRef(),
          title: "Cindro operator",
        },
        20000,
      )
      const id = String(res.session_id ?? "")
      if (!id) throw new Error("session.create returned no session_id")
      this.sid[1](id)
      this.client.subscribe(id) // BEFORE anything else can race an event in
      return id
    })()
    try {
      return await this.creating
    } finally {
      this.creating = null
    }
  }

  async send(text: string): Promise<void> {
    const t = text.trim()
    if (!t || this.busy()) return
    this.push({ id: mkId(), kind: "user", text: t })
    this.setBusy(true)
    try {
      const sid = await this.ensureSession()
      await this.client.call("session.send", { session_id: sid, text: t }, 30000)
    } catch (e) {
      this.setBusy(false)
      this.push({ id: mkId(), kind: "error", text: e instanceof Error ? e.message : String(e) })
    }
  }

  async respond(approvalId: string, decision: "allow" | "always" | "deny"): Promise<void> {
    const sid = this.sid[0]()
    if (!sid) return
    try {
      await this.client.call("approval.respond", { session_id: sid, approval_id: approvalId, decision }, 15000)
    } catch (e) {
      this.push({ id: mkId(), kind: "error", text: `approval failed: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    this.setItems((items) => {
      for (const it of items) if (it.kind === "approval" && it.approvalId === approvalId) it.resolved = decision
    })
  }

  toggleTool(id: number): void {
    this.setItems((items) => {
      for (const it of items) if (it.kind === "tool" && it.id === id) it.expanded = !it.expanded
    })
  }

  toggleThinking(id: number): void {
    this.setItems((items) => {
      for (const it of items) if (it.kind === "thinking" && it.id === id) it.expanded = !it.expanded
    })
  }

  private freezeThinking(): void {
    if (this.currentThinkingId === null) return
    const id = this.currentThinkingId
    this.currentThinkingId = null
    this.setItems((items) => {
      for (const it of items) if (it.kind === "thinking" && it.id === id) it.endedAt = Date.now()
    })
  }

  private applyEvent(ev: Record<string, unknown>): void {
    switch (String(ev.kind ?? "")) {
      case "thinking": {
        const chunk = String(ev.text ?? "")
        if (!chunk) return
        if (this.currentThinkingId === null) {
          const id = mkId()
          this.currentThinkingId = id
          this.push({ id, kind: "thinking", text: chunk, startedAt: Date.now(), endedAt: null, expanded: false })
        } else {
          const id = this.currentThinkingId
          this.setItems((items) => {
            for (const it of items) if (it.kind === "thinking" && it.id === id) it.text += chunk
          })
        }
        return
      }
      case "message": {
        // Only the assistant's own turn is rendered from the wire — the
        // user's own message is already echoed locally the instant send()
        // is called, so a role:"user" replay of the same text would double it.
        if (String(ev.role ?? "") !== "assistant") return
        this.freezeThinking()
        // NB: do NOT clear busy here — an api model streams a text preamble as a
        // `message` BEFORE its tool_calls/final, so clearing on message would
        // re-enable the composer mid-turn (queuing a follow-up into a still-
        // running/awaiting-approval turn). busy is cleared on final/error, and
        // the __status handler clears it if the socket actually drops.
        this.push({ id: mkId(), kind: "assistant", text: String(ev.text ?? ""), live: true })
        return
      }
      case "tool_call": {
        this.freezeThinking()
        this.push({
          id: mkId(),
          kind: "tool",
          callId: String(ev.call_id ?? ""),
          name: String(ev.name ?? "tool"),
          args: formatArgs(ev.args),
          output: "",
          state: "running",
          expanded: false,
        })
        return
      }
      case "tool_result": {
        const callId = String(ev.call_id ?? "")
        const output = String(ev.output ?? "").trim()
        const ok = ev.ok === undefined ? true : Boolean(ev.ok)
        this.setItems((items) => {
          // Prefer an exact call_id match; Contract B doesn't guarantee
          // tool_result carries one, so fall back to the most recent
          // still-running tool card (the normal call/result pairing order).
          let target: Extract<ChatItem, { kind: "tool" }> | null = null
          if (callId) {
            for (const it of items) {
              if (it.kind === "tool" && it.callId === callId && it.state === "running") {
                target = it
                break
              }
            }
          }
          if (!target) {
            for (let i = items.length - 1; i >= 0; i--) {
              const it = items[i]
              if (it.kind === "tool" && it.state === "running") {
                target = it
                break
              }
            }
          }
          if (target) {
            target.output = output
            target.state = ok ? "ok" : "failed"
            target.expanded = !ok
          }
        })
        return
      }
      case "approval": {
        this.freezeThinking()
        this.push({
          id: mkId(),
          kind: "approval",
          approvalId: String(ev.approval_id ?? ""),
          summary: String(ev.summary ?? ev.tool ?? "an action"),
          risk: normalizeRisk(ev.risk),
          resolved: "",
        })
        return
      }
      case "error": {
        this.freezeThinking()
        this.setBusy(false)
        this.push({ id: mkId(), kind: "error", text: String(ev.message ?? "error") })
        return
      }
      case "final": {
        this.freezeThinking()
        this.setBusy(false)
        return
      }
      default:
        return
    }
  }
}

// ---------------------------------------------------------------------------
// presentational pieces
// ---------------------------------------------------------------------------

/** Assistant text reveals word-by-word once, like the desktop's typewriter —
 * a per-instance local timer (never in the shared store, so recycled rows
 * never replay). */
const AssistantBubble: Component<{ text: string; live: boolean }> = (props) => {
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
    }, 40)
    onCleanup(() => clearInterval(timer))
  })

  const done = createMemo(() => shown() >= tokens().length)
  const displayText = createMemo(() => (done() ? props.text : tokens().slice(0, shown()).join("")))

  return (
    <div class="cx-msg-row assistant cx-item">
      <div class="cx-msg-role assistant">
        <span class="cx-msg-dot" />
        CINDRO
      </div>
      <div class="cx-bubble assistant">
        {displayText()}
        <Show when={!done()}>
          <span class="cx-caret" />
        </Show>
      </div>
    </div>
  )
}

const UserBubble: Component<{ text: string }> = (props) => (
  <div class="cx-msg-row user cx-item">
    <div class="cx-msg-role user">
      OPERATOR
      <span class="cx-msg-dot" />
    </div>
    <div class="cx-bubble user">{props.text}</div>
  </div>
)

const ThinkingCard: Component<{ item: Extract<ChatItem, { kind: "thinking" }>; onToggle: () => void }> = (
  props,
) => {
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    if (props.item.endedAt !== null) return
    // Stop ticking once the block freezes — transcript rows never unmount, so
    // relying on onCleanup alone would leak a 1s timer per completed thinking
    // block for the lifetime of the page.
    const timer = setInterval(() => {
      if (props.item.endedAt !== null) {
        clearInterval(timer)
        return
      }
      setNow(Date.now())
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })
  const active = () => props.item.endedAt === null
  const elapsed = createMemo(() => Math.max(0, Math.round(((props.item.endedAt ?? now()) - props.item.startedAt) / 1000)))
  const clamped = createMemo(() =>
    props.item.text.length > THINKING_CAP
      ? `${props.item.text.slice(0, THINKING_CAP)}\n… (${props.item.text.length} chars, truncated)`
      : props.item.text,
  )
  return (
    <div class={`cx-thinking-card cx-item ${active() ? "active" : ""}`} onClick={props.onToggle}>
      <div class="cx-thinking-head">
        <Show when={active()} fallback={<span class="cx-thinking-glyph">◆</span>}>
          <ArcReactor size={14} />
        </Show>
        <span class={`cx-thinking-label ${active() ? "active" : "done"}`}>
          {active() ? `Thinking… ${elapsed()}s` : `Thought for ${elapsed()}s`}
        </span>
        <Show when={props.item.text}>
          <span class="cx-thinking-fold">{props.item.expanded ? "▴" : "▾"}</span>
        </Show>
      </div>
      <Show when={props.item.expanded && props.item.text}>
        <div class="cx-thinking-body">{clamped()}</div>
      </Show>
    </div>
  )
}

const ToolCard: Component<{ item: Extract<ChatItem, { kind: "tool" }>; onToggle: () => void }> = (props) => {
  const preview = createMemo(() => (props.item.output || props.item.args).replaceAll("\n", " ⏎ ").slice(0, 160))
  const clampedOutput = createMemo(() =>
    props.item.output.length > TOOL_OUTPUT_CAP
      ? `${props.item.output.slice(0, TOOL_OUTPUT_CAP)}\n… (${props.item.output.length} chars, truncated)`
      : props.item.output,
  )
  return (
    <div class={`cx-tool-card cx-item ${props.item.state}`} onClick={props.onToggle}>
      <div class="cx-tool-head">
        <Show
          when={props.item.state === "running"}
          fallback={<span class={`cx-tool-glyph ${props.item.state}`}>{props.item.state === "ok" ? "✓" : "✕"}</span>}
        >
          <ArcReactor size={14} />
        </Show>
        <span class="cx-tool-name">{props.item.name}</span>
        <span class={`cx-tool-state ${props.item.state}`}>
          {props.item.state === "running" ? "running…" : props.item.state === "ok" ? "done" : "failed"}
        </span>
        <span class="cx-tool-fold">{props.item.expanded ? "▴" : "▾"}</span>
      </div>
      <Show when={!props.item.expanded && preview()}>
        <div class="cx-tool-preview">{preview()}</div>
      </Show>
      <Show when={props.item.expanded}>
        <div class="cx-tool-body">
          <Show when={props.item.args}>
            <div class="cx-tool-section-label">INPUT</div>
            <pre class="cx-tool-pre">{props.item.args}</pre>
          </Show>
          <Show when={props.item.output}>
            <div class={`cx-tool-section-label ${props.item.state === "failed" ? "fault" : ""}`}>
              {props.item.state === "failed" ? "FAULT" : "OUTPUT"}
            </div>
            <pre class="cx-tool-pre">{clampedOutput()}</pre>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export const ApprovalCard: Component<{
  item: Extract<ChatItem, { kind: "approval" }>
  onRespond: (decision: "allow" | "always" | "deny") => void
}> = (props) => (
  <div class={`cx-approval-card cx-item risk-${props.item.risk}`}>
    <div class="cx-approval-head">
      ⚠ AUTHORIZE REQUIRED
      <span class="cx-approval-risk">{props.item.risk}</span>
    </div>
    <div class="cx-approval-body">{props.item.summary}</div>
    <Show
      when={!props.item.resolved}
      fallback={
        <div class={`cx-approval-resolved ${props.item.resolved === "deny" ? "deny" : "ok"}`}>
          ✓ {props.item.resolved}
        </div>
      }
    >
      <div class="cx-approval-actions">
        <button type="button" class="cx-approval-btn allow" onClick={() => props.onRespond("allow")}>
          Authorize
        </button>
        <button type="button" class="cx-approval-btn" onClick={() => props.onRespond("always")}>
          Always
        </button>
        <button type="button" class="cx-approval-btn deny" onClick={() => props.onRespond("deny")}>
          Deny
        </button>
      </div>
    </Show>
  </div>
)

const ErrorCard: Component<{ text: string }> = (props) => (
  <div class="cx-error-card cx-item">
    <span>!</span>
    <span>{props.text}</span>
  </div>
)

/** Compact, self-closing dropdown to switch the operator's model on the fly.
 * Custom (not a native <select>) so it stays in the HUD's dark palette in every
 * browser and fits the narrow docked rail. Lists the operator-capable catalog
 * from AI Settings (see ChatController.loadModels / resolveOperatorConfig). */
const ModelPicker: Component<{ controller: ChatController }> = (props) => {
  const [open, setOpen] = createSignal(false)
  let wrapRef: HTMLDivElement | undefined
  onMount(() => {
    void props.controller.loadModels()
    const onDocPointer = (e: PointerEvent) => {
      if (wrapRef && !wrapRef.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onDocPointer)
    onCleanup(() => document.removeEventListener("pointerdown", onDocPointer))
  })
  const selected = createMemo(() => props.controller.selectedModel())
  return (
    <div class="cx-model-picker" ref={wrapRef}>
      <button
        type="button"
        class="cx-model-btn"
        classList={{ open: open() }}
        disabled={props.controller.busy()}
        title={
          props.controller.busy()
            ? `Model: ${selected()} — finish the current turn to switch`
            : `Model: ${selected()} — click to switch`
        }
        onClick={() => {
          if (props.controller.busy()) return
          void props.controller.loadModels()
          setOpen((v) => !v)
        }}
      >
        <span class="cx-model-btn-label">{selected()}</span>
        <span class="cx-model-btn-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="cx-model-menu">
          <For
            each={props.controller.models()}
            fallback={<div class="cx-model-empty">No models available — add a provider key in AI Settings.</div>}
          >
            {(m) => (
              <button
                type="button"
                class="cx-model-item"
                classList={{ active: m === selected() }}
                onClick={() => {
                  props.controller.setModel(m)
                  setOpen(false)
                }}
              >
                {m}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const TranscriptRow: Component<{
  item: ChatItem
  onToggleTool: (id: number) => void
  onToggleThinking: (id: number) => void
  onRespondApproval: (approvalId: string, decision: "allow" | "always" | "deny") => void
}> = (props) => {
  const item = props.item
  if (item.kind === "user") return <UserBubble text={item.text} />
  if (item.kind === "assistant") return <AssistantBubble text={item.text} live={item.live} />
  if (item.kind === "thinking") return <ThinkingCard item={item} onToggle={() => props.onToggleThinking(item.id)} />
  if (item.kind === "tool") return <ToolCard item={item} onToggle={() => props.onToggleTool(item.id)} />
  if (item.kind === "approval")
    return <ApprovalCard item={item} onRespond={(d) => props.onRespondApproval(item.approvalId, d)} />
  if (item.kind === "error") return <ErrorCard text={item.text} />
  return null
}

// ---------------------------------------------------------------------------
// ChatPanel — the full transcript + composer, gorgeous & animated
// ---------------------------------------------------------------------------

export const ChatPanel: Component<{ controller: ChatController; compact?: boolean }> = (props) => {
  const [draft, setDraft] = createSignal("")
  let scrollRef: HTMLDivElement | undefined
  let inputRef: HTMLTextAreaElement | undefined
  let stickBottom = true

  onMount(() => {
    props.controller.bind()
    if (!props.compact) inputRef?.focus()
  })

  const onScroll = () => {
    const el = scrollRef
    if (!el) return
    stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72
  }

  // Autoscroll while the transcript grows, unless the operator has scrolled
  // up to read history.
  onMount(() => {
    const el = scrollRef
    if (!el) return
    const observer = new MutationObserver(() => {
      if (stickBottom) queueMicrotask(() => (el.scrollTop = el.scrollHeight))
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    onCleanup(() => observer.disconnect())
  })

  const submit = () => {
    const text = draft()
    if (!text.trim() || props.controller.busy()) return
    setDraft("")
    void props.controller.send(text)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // Only show the ambient "Cindro is working…" shimmer when nothing already
  // in the transcript is carrying its own live indicator (an active thinking
  // card or a still-running tool card) — otherwise it's a redundant second
  // spinner right above one that's already spinning.
  const showBusyRow = createMemo(() => {
    if (!props.controller.busy()) return false
    const items = props.controller.items
    const last = items[items.length - 1]
    if (!last) return true
    if (last.kind === "thinking" && last.endedAt === null) return false
    if (last.kind === "tool" && last.state === "running") return false
    return true
  })

  return (
    <div class={`cx-chat ${props.compact ? "cx-chat-compact" : ""}`}>
      <div class="cx-chat-head">
        <span class="cx-chat-wordmark">CINDRO</span>
        <div class="cx-chat-head-tools">
          <ModelPicker controller={props.controller} />
          <button
            type="button"
            class="cx-chat-new"
            title="New conversation"
            aria-label="New conversation"
            disabled={props.controller.busy()}
            onClick={() => props.controller.newConversation()}
          >
            ⟲
          </button>
          <span class={`cx-chat-link ${props.controller.connected() ? "live" : ""}`} />
        </div>
      </div>
      <div class="cx-chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <Show when={props.controller.items.length > 0} fallback={<EmptyState compact={props.compact} />}>
          <For each={props.controller.items}>
            {(item) => (
              <TranscriptRow
                item={item}
                onToggleTool={(id) => props.controller.toggleTool(id)}
                onToggleThinking={(id) => props.controller.toggleThinking(id)}
                onRespondApproval={(id, d) => void props.controller.respond(id, d)}
              />
            )}
          </For>
        </Show>
        <Show when={showBusyRow()}>
          <div class="cx-busy-row cx-item">
            <ArcReactor size={14} />
            <span class="cx-busy-label">Cindro is working…</span>
          </div>
        </Show>
      </div>
      <div class="cx-composer">
        <textarea
          ref={(r) => {
            inputRef = r
          }}
          class="cx-composer-input"
          placeholder="Ask Cindro to manage Proxmox…"
          rows={1}
          value={draft()}
          disabled={props.controller.busy()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          class="cx-send-btn"
          disabled={!draft().trim() || props.controller.busy()}
          onClick={submit}
          aria-label="Send"
        >
          ➤
        </button>
      </div>
    </div>
  )
}

const EmptyState: Component<{ compact?: boolean }> = (props) => (
  <div class="cx-empty">
    <ArcReactor size={props.compact ? 26 : 34} />
    <span>Ask Cindro to manage Proxmox…</span>
  </div>
)
