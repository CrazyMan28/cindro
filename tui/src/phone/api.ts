// Phone-hub shared contract layer — the TS mirror of phone_pane.py's
// _phone_mcp/_phone_http wrappers (cli/jarvis_cli/tui/phone_pane.py:230-251)
// and the Phone*Tab.qml constants. Both proxy verbs travel over the SAME
// Contract-A control websocket: `phone.mcp` {name, arguments} and
// `phone.http` {method, path, body} — jarvisd holds the phone bearer and
// makes the actual HTTP call (see the phone_pane.py module docstring).
// NEVER throws: transport failures fold into the same {error} shape the QML
// callbacks already check, so every failure can surface as visible text.

import { createEffect, onCleanup, onMount } from "solid-js"

import type { ControlClient } from "../control/client"
import { theme } from "../theme"

export interface PhoneErr {
  code: string
  message: string
}

export interface McpRes {
  tool?: string
  data?: unknown
  text?: string
  error?: PhoneErr
}

export interface HttpRes {
  status?: number
  data?: unknown
  error?: PhoneErr
}

export async function phoneMcp(
  client: ControlClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpRes> {
  try {
    return (await client.call("phone.mcp", { name, arguments: args }, 30000)) as McpRes
  } catch (e) {
    return { tool: name, error: { code: "transport_error", message: String(e) } }
  }
}

export async function phoneHttp(
  client: ControlClient,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<HttpRes> {
  try {
    return (await client.call("phone.http", { method, path, body }, 30000)) as HttpRes
  } catch (e) {
    return { status: 0, error: { code: "transport_error", message: String(e) } }
  }
}

/** Failure message for an http result, or null when it succeeded. Unlike the
 * QML (which only checks r.error and treats a 404 as success) a >=400 status
 * is a failure here — failures must never pass silently. */
export function httpFailure(res: HttpRes): string | null {
  if (res.error) return res.error.message
  const status = res.status ?? 0
  if (status >= 400 || status === 0) {
    const data = (res.data ?? {}) as Record<string, unknown>
    return String(data.error ?? data.message ?? `HTTP ${status}`)
  }
  return null
}

export type Row = Record<string, unknown>

/** data may be the array itself or nested under one of `keys`. */
export function asList(data: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(data)) return data as Row[]
  if (typeof data === "object" && data !== null) {
    for (const k of keys) {
      const v = (data as Row)[k]
      if (Array.isArray(v)) return v as Row[]
    }
  }
  return []
}

export function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

export function trunc(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

// -- call states (PhoneCallOverlay.qml / phone_pane.py:_RINGING_STATES) -------
export const RINGING_STATES = ["ringing", "created"]
export const ACTIVE_STATES = ["active", "accepted"]

/** Ringing/created first, else active/accepted — the overlay always surfaces
 * an unanswered incoming call over an ongoing one (PhoneCallOverlay._doPoll). */
export function pickBannerCall(calls: Row[]): Row | null {
  for (const c of calls) if (RINGING_STATES.includes(str(c.state))) return c
  for (const c of calls) if (ACTIVE_STATES.includes(str(c.state))) return c
  return null
}

/** PhoneDialerTab.qml:363-365 state dot colors. */
export function callStateColor(state: string) {
  if (state === "active") return theme.success
  if (state === "ringing") return theme.amber
  if (state === "speaking") return theme.accent
  return theme.textFaint
}

// -- transcript merging (phone_pane.py:_load_call_transcript) -----------------
export interface TranscriptLine {
  speaker: string
  body: string
  isAgent: boolean
}

/** STT utterances (`transcripts`) first, then agent call messages
 * (`messages`) — identical merge order to PhoneCallOverlay._refreshTranscript. */
export function mergeTranscript(data: unknown): TranscriptLine[] {
  const d = (data ?? {}) as Row
  const lines: TranscriptLine[] = []
  for (const t of asList(d.transcripts)) {
    lines.push({
      speaker: t.from_extension !== undefined ? `ext ${str(t.from_extension)}` : "caller",
      body: str(t.text),
      isAgent: false,
    })
  }
  for (const m of asList(d.messages)) {
    lines.push({
      speaker: m.from_extension !== undefined ? `ext ${str(m.from_extension)}` : "agent",
      body: str(m.content) || str(m.text),
      isAgent: true,
    })
  }
  return lines
}

export function fmtElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`
}

/** QML thread-list timestamp shortener (PhoneInboxTab.qml:273). */
export function shortTime(ts: string): string {
  return ts.length > 5 ? ts.slice(-8).slice(0, 5) : ts
}

// -- dialer constants (PhoneDialerTab.qml) ------------------------------------
export const EXTENSION_RE = /^\d{1,6}$/
export const QUICK_DIAL = ["101", "102", "103", "104", "105", "900"]

// -- agent-config constants (PhoneAgentsTab.qml) -------------------------------
export interface VoiceEntry {
  vid: string
  vname: string
  speaker: string
  emotion: string
}

/** Built-in fallback voice set when GET /api/voices is empty — verbatim from
 * PhoneAgentsTab.qml:121-138 (matches the agent-phone Android app). */
export const DEFAULT_VOICES: VoiceEntry[] = [
  { vid: "", vname: "Default", speaker: "Default", emotion: "Default" },
  { vid: "jarvis-od", vname: "Cindro (on-device)", speaker: "Cindro", emotion: "Cindro" },
  { vid: "paul-cheerful", vname: "Paul - Cheerful", speaker: "Paul", emotion: "Cheerful" },
  { vid: "paul-sad", vname: "Paul - Sad", speaker: "Paul", emotion: "Sad" },
  { vid: "paul-angry", vname: "Paul - Angry", speaker: "Paul", emotion: "Angry" },
  { vid: "paul-terrified", vname: "Paul - Terrified", speaker: "Paul", emotion: "Terrified" },
  { vid: "paul-shouting", vname: "Paul - Shouting", speaker: "Paul", emotion: "Shouting" },
  { vid: "oliver-cheerful", vname: "Oliver - Cheerful", speaker: "Oliver", emotion: "Cheerful" },
  { vid: "oliver-sad", vname: "Oliver - Sad", speaker: "Oliver", emotion: "Sad" },
  { vid: "oliver-friendly", vname: "Oliver - Friendly", speaker: "Oliver", emotion: "Friendly" },
  { vid: "jane-cheerful", vname: "Jane - Cheerful", speaker: "Jane", emotion: "Cheerful" },
  { vid: "jane-sad", vname: "Jane - Sad", speaker: "Jane", emotion: "Sad" },
  { vid: "jane-friendly", vname: "Jane - Friendly", speaker: "Jane", emotion: "Friendly" },
  { vid: "marie-cheerful", vname: "Marie - Cheerful", speaker: "Marie", emotion: "Cheerful" },
  { vid: "marie-sad", vname: "Marie - Sad", speaker: "Marie", emotion: "Sad" },
  { vid: "marie-friendly", vname: "Marie - Friendly", speaker: "Marie", emotion: "Friendly" },
]

/** Speaker/emotion split for server voices (PhoneAgentsTab.qml:114-117). */
export function parseVoice(v: Row, index: number): VoiceEntry {
  const nm = str(v.label) || str(v.name) || `Voice ${index}`
  const dash = nm.includes(" - ")
  const speaker = str(v.speaker) || (dash ? nm.split(" - ")[0].trim() : nm.replace(/ *\(.*\)/, "").trim())
  const emotion = str(v.emotion) || (dash ? nm.split(" - ")[1].trim() : "Default")
  return { vid: str(v.id), vname: nm, speaker, emotion }
}

// Which daemon brain (if any) an agent's model picker should query via
// model.list — codex/claude only; other extensions (Copilot, Echo, Hermes,
// Mistral Screener, ...) have no selectable Jarvis-brain model. Mirrors
// android AgentConfigScreen.kt's brainFor() and extension/sidepanel.js's
// equivalent — keep all three in sync if the naming convention changes.
export function brainForAgent(name: string): string | null {
  const n = name.toLowerCase()
  if (n.includes("claude")) return "claude"
  if (n.includes("codex")) return "codex"
  return null
}
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"]
export const SPEED_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

// -- inbox constants (PhoneInboxTab.qml) ---------------------------------------
export const PRIORITIES = ["low", "normal", "urgent", "critical"]

/** PhoneInboxTab.qml:237-239 priority colors. */
export function priorityColor(p: string) {
  if (p === "critical") return theme.danger
  if (p === "urgent") return theme.amber
  if (p === "low") return theme.textFaint
  return theme.accent
}

// -- carrier forwarding codes (PhoneSettingsTab.qml:787-860) -------------------
// The GUI hardcodes +15551234567 into these codes — a bug (the forwarding
// TARGET is the deployment's Twilio number, where the screening agent
// answers; twilio_status.from_number). Here the real configured number is
// substituted; the placeholder only appears (clearly labeled) when no number
// is configured yet.
export const PLACEHOLDER_NUMBER = "+15551234567"

export interface ForwardCode {
  lbl: string
  code: string
}

export function forwardingCodes(twilioNumber: string): {
  placeholder: boolean
  gsm: ForwardCode[]
  vz: ForwardCode[]
} {
  const placeholder = !twilioNumber
  const n = twilioNumber || PLACEHOLDER_NUMBER
  // Verizon codes take the 10-digit national number (QML: *715551234567).
  const vzN = n.startsWith("+1") ? n.slice(2) : n.replace(/^\+/, "")
  return {
    placeholder,
    gsm: [
      { lbl: "Set all", code: `**004*${n}#` },
      { lbl: "Check", code: "*#002#" },
      { lbl: "Undo", code: "##002#" },
      { lbl: "Busy", code: `**67*${n}#` },
      { lbl: "No answer", code: `**61*${n}#` },
      { lbl: "Unreachable", code: `**62*${n}#` },
    ],
    vz: [
      { lbl: "VZ busy/no-ans", code: `*71${vzN}` },
      { lbl: "VZ all (*72)", code: `*72${vzN}` },
      { lbl: "VZ off (*73)", code: "*73" },
    ],
  }
}

// -- polling -------------------------------------------------------------------
/**
 * Poll loop with the PhonePane pause convention: ticks only run while
 * `active()` (tab visible AND page visible) and the daemon is connected
 * (phone_pane.py:286 skips polls while disconnected). Also fires once as
 * soon as the client first connects, and again every time the tab
 * re-activates (refresh-on-activate).
 */
export function usePhonePoll(
  client: ControlClient,
  active: () => boolean,
  intervalMs: number,
  fn: () => void | Promise<void>,
): void {
  let fired = false
  const tick = () => {
    if (!active() || !client.connected) return
    fired = true
    void fn()
  }
  createEffect(() => {
    if (active()) queueMicrotask(tick)
  })
  onMount(() => {
    client.start() // idempotent — the page may mount before anything else dialed
    // Fast starter: the mount-time tick usually races the websocket connect,
    // so retry until the first fetch lands, then fall back to the cadence.
    const quick = setInterval(() => {
      if (fired) clearInterval(quick)
      else tick()
    }, 250)
    const timer = setInterval(tick, intervalMs)
    onCleanup(() => {
      clearInterval(quick)
      clearInterval(timer)
    })
  })
}
