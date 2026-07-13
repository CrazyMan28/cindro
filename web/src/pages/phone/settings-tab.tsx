// SETTINGS tab body — ported from desktop/qml/PhoneSettingsTab.qml (and
// cross-checked against tui/src/phone/tabs/SettingsTab.tsx + SettingsCards.tsx
// + SettingsPanels.tsx for the exact phone.mcp/phone.http call shapes).
// Twilio status + screening toggle, user phone number, SMS-agent card,
// call-screening card (transport, auto-screen, inbound/screener agent
// pickers, carrier-forwarding codes), PSTN allowlist, add-new-agent enroll
// form, war-room Red Alert, and the diagnostics/call-history sub-screens.
//
// NOTE on carrier-forwarding codes: the QML hardcodes the target number as
// +15551234567 in every code string (a bug — the real target must be the
// deployment's configured Twilio "from" number, where the screening agent
// answers). Here the REAL configured number (twilio_status.from_number) is
// substituted, and a placeholder warning is shown only when none is
// configured yet. Also: the QML's onClicked opens a `tel:` URL (which does
// nothing useful on a desktop browser); here tapping a code COPIES it to the
// clipboard instead, matching the tab's own on-screen instruction ("tap a
// code to copy it, then dial manually").
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { ControlClient } from "../../core/control-client"
import { NavIcon } from "../../components/NavIcon"
import { PhoneTabPanel, usePhoneTab } from "./index"

// -- shared phone.mcp / phone.http wire helpers (see tui/src/phone/api.ts for
// the reference implementation this mirrors) -------------------------------
interface PhoneErr {
  code: string
  message: string
}
interface McpRes {
  tool?: string
  data?: unknown
  text?: string
  error?: PhoneErr
}
interface HttpRes {
  status?: number
  data?: unknown
  error?: PhoneErr
}
type Row = Record<string, unknown>

async function phoneMcp(client: ControlClient, name: string, args: Row = {}): Promise<McpRes> {
  try {
    return (await client.call("phone.mcp", { name, arguments: args }, 30000)) as McpRes
  } catch (e) {
    return { tool: name, error: { code: "transport_error", message: String(e) } }
  }
}

async function phoneHttp(client: ControlClient, method: string, path: string, body: Row = {}): Promise<HttpRes> {
  try {
    return (await client.call("phone.http", { method, path, body }, 30000)) as HttpRes
  } catch (e) {
    return { status: 0, error: { code: "transport_error", message: String(e) } }
  }
}

function httpFailure(res: HttpRes): string | null {
  if (res.error) return res.error.message
  const status = res.status ?? 0
  if (status >= 400 || status === 0) {
    const data = (res.data ?? {}) as Row
    return String(data.error ?? data.message ?? `HTTP ${status}`)
  }
  return null
}

function asList(data: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(data)) return data as Row[]
  if (typeof data === "object" && data !== null) {
    for (const k of keys) {
      const v = (data as Row)[k]
      if (Array.isArray(v)) return v as Row[]
    }
  }
  return []
}

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

// -- carrier-forwarding codes (PhoneSettingsTab.qml:787-860) ----------------
const PLACEHOLDER_NUMBER = "+15551234567"
interface ForwardCode {
  lbl: string
  code: string
}
function forwardingCodes(twilioNumber: string): { placeholder: boolean; gsm: ForwardCode[]; vz: ForwardCode[] } {
  const placeholder = !twilioNumber
  const n = twilioNumber || PLACEHOLDER_NUMBER
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

interface AgentOpt {
  ext: string
  name: string
}

// -- small local building blocks --------------------------------------------
function Toggle(props: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      class="phset-toggle"
      classList={{ on: props.on }}
      disabled={props.disabled}
      aria-pressed={props.on}
      onClick={props.onToggle}
    >
      <span class="phset-toggle-knob" />
    </button>
  )
}

function Chip(props: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" class="phset-chip" classList={{ selected: props.selected }} onClick={props.onClick}>
      {props.label}
    </button>
  )
}

function SectionLabel(props: { children: string }) {
  return <div class="hud-label phset-section-title">{props.children}</div>
}

function AgentPicker(props: { agents: AgentOpt[]; selected: string; onSelect: (ext: string) => void }) {
  return (
    <Show when={props.agents.length > 0} fallback={<div class="phset-hint">No agents registered yet.</div>}>
      <div class="phset-flow">
        <For each={props.agents}>
          {(a) => <Chip label={a.name} selected={props.selected === a.ext} onClick={() => props.onSelect(a.ext)} />}
        </For>
      </div>
    </Show>
  )
}

// -- Diagnostics sub-screen ---------------------------------------------------
interface DiagCheck {
  label: string
  detail: string
  ok: boolean | null
}

function DiagnosticsPanel(props: { onBack: () => void }) {
  const app = useApp()
  const [checks, setChecks] = createSignal<DiagCheck[]>([
    { label: "Server alive", detail: "GET /health", ok: null },
    { label: "Twilio configured", detail: "twilio_status", ok: null },
    { label: "Tailscale / WS", detail: "control websocket", ok: null },
    { label: "Ext-100 online", detail: "…", ok: null },
    { label: "Mistral voice key", detail: "GET /api/mistral-health", ok: null },
    { label: "Mistral chat key", detail: "GET /api/mistral-health", ok: null },
  ])
  const [running, setRunning] = createSignal(true)
  const [lastError, setLastError] = createSignal("")
  const [ts, setTs] = createSignal("")

  const setCheck = (i: number, ok: boolean, detail?: string) =>
    setChecks((cs) => cs.map((c, j) => (j === i ? { ...c, ok, ...(detail ? { detail } : {}) } : c)))

  const run = async () => {
    setRunning(true)
    setLastError("")
    setCheck(2, app.client.connected)
    const health = await phoneHttp(app.client, "GET", "/health")
    const hd = (health.data ?? {}) as Row
    setCheck(0, !httpFailure(health) && hd.ok === true)
    const tw = await phoneMcp(app.client, "twilio_status")
    const twd = (tw.data ?? {}) as Row
    setCheck(1, !tw.error && twd.configured === true)
    if (tw.error) setLastError(tw.error.message || "Twilio error")
    const ex = await phoneMcp(app.client, "list_extensions")
    let extCount = 0
    let ext100 = false
    if (!ex.error && Array.isArray(ex.data)) {
      const arr = asList(ex.data)
      extCount = arr.length
      const e100 = arr.find((e) => (str(e.extension) || str(e.ext)) === "100")
      ext100 = Boolean(e100 && (e100.status === "online" || e100.online === true || e100.connected === true))
    } else if (ex.error) setLastError(ex.error.message)
    const ag = await phoneMcp(app.client, "list_agents")
    const agentCount = !ag.error && Array.isArray(ag.data) ? asList(ag.data).length : 0
    setCheck(3, ext100, `${extCount} ext · ${agentCount} agents`)
    const mh = await phoneHttp(app.client, "GET", "/api/mistral-health")
    const md = (mh.data ?? {}) as Row
    const mFail = httpFailure(mh)
    if (mFail) setLastError(mFail)
    setCheck(4, !mFail && Boolean((md.voice_key as Row | undefined)?.ok === true))
    setCheck(5, !mFail && Boolean((md.chat_key as Row | undefined)?.ok === true))
    setRunning(false)
    setTs(new Date().toISOString().slice(0, 16).replace("T", " "))
  }

  onMount(() => void run())

  return (
    <div class="phset-sub">
      <div class="phset-sub-header">
        <button type="button" class="phset-back" onClick={props.onBack}>←</button>
        <div class="hud-label phset-sub-title">DIAGNOSTICS</div>
        <div style={{ flex: 1 }} />
        <button type="button" class="phset-btn small" disabled={running()} onClick={() => void run()}>
          {running() ? "RUNNING…" : "RE-RUN"}
        </button>
      </div>
      <div class="phset-diag-list">
        <For each={checks()}>
          {(c) => (
            <div class="card phset-diag-row">
              <div class="phset-diag-icon" classList={{ ok: c.ok === true, fail: c.ok === false }}>
                {c.ok === true ? "✓" : c.ok === false ? "✗" : "?"}
              </div>
              <div class="phset-diag-text">
                <div class="phset-diag-label">{c.label}</div>
                <div class="phset-diag-detail">{c.detail}</div>
              </div>
              <div class="phset-diag-state" classList={{ ok: c.ok === true, fail: c.ok === false }}>
                {c.ok === true ? "OK" : c.ok === false ? "FAIL" : "—"}
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={lastError()}>
        <div class="phset-error-card">
          <div class="hud-label" style={{ color: "var(--danger)", "font-size": "10px" }}>LAST ERROR</div>
          <div class="phset-error-text">{lastError()}</div>
        </div>
      </Show>
      <Show when={ts()}>
        <div class="phset-hint">Run: {ts()}</div>
      </Show>
    </div>
  )
}

// -- Call-history sub-screen ---------------------------------------------------
function HistoryPanel(props: { onBack: () => void }) {
  const app = useApp()
  const [rows, setRows] = createSignal<Row[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const load = async () => {
    setLoading(true)
    setError("")
    const res = await phoneHttp(app.client, "GET", "/api/calls")
    setLoading(false)
    const fail = httpFailure(res)
    if (fail) {
      setError(fail)
      return
    }
    setRows(
      asList(res.data, "calls").map((c) => ({
        from: str(c.from_extension) || str(c.from) || "—",
        to: str(c.to_extension) || str(c.to) || "—",
        state: str(c.state),
        reason: str(c.reason),
        ts: str(c.created_at) || str(c.timestamp),
        missed: c.missed === true,
      })),
    )
  }

  onMount(() => void load())

  const shortTime = (t: string) => (t.length > 5 ? t.slice(-8).slice(0, 5) : t)

  return (
    <div class="phset-sub">
      <div class="phset-sub-header">
        <button type="button" class="phset-back" onClick={props.onBack}>←</button>
        <div class="hud-label phset-sub-title">CALL HISTORY</div>
        <div style={{ flex: 1 }} />
        <button type="button" class="phset-btn small" disabled={loading()} onClick={() => void load()}>
          ↺
        </button>
      </div>
      <Show when={loading()}>
        <div class="phset-hint">Loading…</div>
      </Show>
      <Show when={error()}>
        <div class="phset-error-card"><div class="phset-error-text">{error()}</div></div>
      </Show>
      <Show when={!loading() && !error() && rows().length === 0}>
        <div class="phset-hint">No call history yet.</div>
      </Show>
      <div class="phset-history-list">
        <For each={rows()}>
          {(r) => (
            <div class="card phset-history-row">
              <div class="phset-history-main">
                <div class="phset-mono">{str(r.from)} → {str(r.to)}</div>
                <div class="phset-history-sub">{[str(r.state), str(r.reason)].filter((s) => s.length > 0).join(" · ")}</div>
              </div>
              <div class="phset-mono" classList={{ danger: r.missed === true, success: r.missed !== true }}>
                {shortTime(str(r.ts))}
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

// -- main SETTINGS body -------------------------------------------------------
export function PhoneSettingsTab() {
  const app = useApp()
  const shell = usePhoneTab()
  const active = () => shell.tab() === "settings"

  const [sub, setSub] = createSignal<"" | "diagnostics" | "history">("")

  const [twilioConfigured, setTwilioConfigured] = createSignal(false)
  const [fromNumber, setFromNumber] = createSignal("")
  const [userNumber, setUserNumber] = createSignal("")
  const [userNumberInput, setUserNumberInput] = createSignal("")
  const [screeningOn, setScreeningOn] = createSignal(false)
  const [voiceProfile, setVoiceProfile] = createSignal("(default)")
  const [smsEnabled, setSmsEnabled] = createSignal(false)
  const [smsAgentExt, setSmsAgentExt] = createSignal("")
  const [transport, setTransport] = createSignal("twilio")
  const [inboundExt, setInboundExt] = createSignal("")
  const [screeningExt, setScreeningExt] = createSignal("")
  const [allowlist, setAllowlist] = createSignal<Array<{ num: string; lbl: string }>>([])
  const [agents, setAgents] = createSignal<AgentOpt[]>([])
  const [status, setStatus] = createSignal("")
  const [copiedCode, setCopiedCode] = createSignal("")

  const [newAllowNum, setNewAllowNum] = createSignal("")
  const [newAllowLbl, setNewAllowLbl] = createSignal("")
  // Twilio Verified Caller IDs (trial-account outbound gate; control-only RPCs)
  const [callerIds, setCallerIds] = createSignal<Array<{ num: string; name: string }>>([])
  const [verifyNum, setVerifyNum] = createSignal("")
  const [verifyLabel, setVerifyLabel] = createSignal("")
  const [verifyCode, setVerifyCode] = createSignal("")
  const [verifyStatus, setVerifyStatus] = createSignal("")
  const [enrollExt, setEnrollExt] = createSignal("")
  const [enrollName, setEnrollName] = createSignal("")
  const [enrollToken, setEnrollToken] = createSignal("")
  const [alertMsg, setAlertMsg] = createSignal("")

  const note = (msg: string) => setStatus(msg)

  const refresh = async () => {
    void loadCallerIds()
    const tw = await phoneMcp(app.client, "twilio_status")
    if (tw.error) note(`twilio_status: ${tw.error.message}`)
    else {
      const d = (tw.data ?? {}) as Row
      setTwilioConfigured(d.configured === true)
      setFromNumber(str(d.from_number))
      setScreeningOn(d.screening_enabled === true)
    }
    const al = await phoneMcp(app.client, "twilio_allowlist_list")
    if (al.error) note(`allowlist: ${al.error.message}`)
    else {
      setAllowlist(
        asList(al.data, "numbers").map((n) =>
          typeof n === "string" ? { num: n, lbl: "" } : { num: str((n as Row).phone_number), lbl: str((n as Row).label) },
        ),
      )
    }
    const vp = await phoneMcp(app.client, "get_voice_profile", { extension: "100" })
    if (!vp.error) {
      const d = (vp.data ?? {}) as Row
      const v = (d.voice ?? d) as Row
      setVoiceProfile(str(v.voice_id) || str(v.voice_name) || str(v.name) || "(default)")
    }
    const sc = await phoneHttp(app.client, "GET", "/api/screening")
    const scFail = httpFailure(sc)
    if (scFail) note(`screening config: ${scFail}`)
    else if (sc.data) {
      const d = (sc.data ?? {}) as Row
      setScreeningOn(d.enabled === true)
      setTransport(str(d.transport, "twilio"))
      setInboundExt(str(d.inbound_extension))
      setScreeningExt(str(d.screening_extension))
    }
    const sm = await phoneHttp(app.client, "GET", "/api/sms-agent")
    const smFail = httpFailure(sm)
    if (smFail) note(`sms agent: ${smFail}`)
    else if (sm.data) {
      const d = (sm.data ?? {}) as Row
      setSmsEnabled(d.enabled === true)
      setSmsAgentExt(str(d.extension))
    }
    const ex = await phoneMcp(app.client, "list_extensions")
    if (ex.error) note(`list_extensions: ${ex.error.message}`)
    else {
      setAgents(asList(ex.data).map((a) => ({ ext: str(a.extension) || str(a.ext), name: str(a.name, "Agent") })))
    }
    // twilio_status doesn't carry a default user number on every build; keep
    // whatever the user last set locally if the field is absent server-side.
    const d2 = (tw.data ?? {}) as Row
    if (typeof d2.default_user_number === "string") setUserNumber(d2.default_user_number)
  }

  createEffect(() => {
    shell.refreshNonce()
    if (active()) void refresh()
  })

  onMount(() => {
    const t = setInterval(() => {
      if (active()) void refresh()
    }, 20000)
    onCleanup(() => clearInterval(t))
  })

  const toggleScreening = async () => {
    const enable = !screeningOn()
    const res = await phoneMcp(app.client, enable ? "twilio_screening_enable" : "twilio_screening_disable")
    if (res.error) note(`screening: ${res.error.message}`)
    else {
      setScreeningOn(enable)
      note(`Screening ${enable ? "enabled" : "disabled"}`)
    }
  }

  const setTransportTo = async (t: string) => {
    const prev = transport()
    setTransport(t)
    const res = await phoneHttp(app.client, "POST", "/api/screening", { transport: t })
    const fail = httpFailure(res)
    if (fail) {
      setTransport(prev)
      note(`transport: ${fail}`)
    } else note(`Transport set: ${t}`)
  }

  const postScreening = async (patch: Row, label: string) => {
    const res = await phoneHttp(app.client, "POST", "/api/screening", patch)
    const fail = httpFailure(res)
    note(fail ? `${label}: ${fail}` : `${label} saved`)
    if (!fail) void refresh()
  }

  const postSms = async (patch: Row, label: string) => {
    const res = await phoneHttp(app.client, "POST", "/api/sms-agent", patch)
    const fail = httpFailure(res)
    note(fail ? `${label}: ${fail}` : `${label} saved`)
    if (!fail) void refresh()
  }

  const setUserNumberAction = async () => {
    const n = userNumberInput().trim()
    if (!n) return
    const res = await phoneMcp(app.client, "twilio_set_user_number", { phone_number: n })
    if (res.error) note(`set number: ${res.error.message}`)
    else {
      note(`User number set: ${n}`)
      setUserNumber(n)
      setUserNumberInput("")
    }
  }

  // Twilio Verified Caller IDs — control-only phone.twilio_verify_* RPCs.
  const loadCallerIds = async () => {
    try {
      const res = (await app.client.call("phone.twilio_caller_ids_list", {}, 30000)) as {
        caller_ids?: Array<{ phone_number?: string; friendly_name?: string }>
      }
      setCallerIds((res.caller_ids ?? []).map((c) => ({ num: str(c.phone_number), name: str(c.friendly_name) })))
    } catch {
      /* twilio_not_configured / transport — leave the list empty */
    }
  }
  const verifyNumber = async () => {
    const num = verifyNum().trim()
    if (!num) return
    setVerifyStatus("Requesting verification…")
    setVerifyCode("")
    try {
      const res = (await app.client.call(
        "phone.twilio_verify_start",
        { phone_number: num, friendly_name: verifyLabel().trim() },
        30000,
      )) as { validation_code?: string; note?: string }
      setVerifyCode(str(res.validation_code))
      setVerifyStatus(str(res.note, `Twilio is calling ${num} — enter the code when prompted.`))
      void loadCallerIds()
    } catch (e) {
      setVerifyStatus("Error: " + String(e))
    }
  }

  const addAllowNumber = async () => {
    const num = newAllowNum().trim()
    if (!num) return
    const res = await phoneMcp(app.client, "twilio_allowlist_add", { phone_number: num, label: newAllowLbl().trim() })
    if (res.error) note(`allowlist add: ${res.error.message}`)
    else {
      note(`Added ${num}`)
      setNewAllowNum("")
      setNewAllowLbl("")
      void refresh()
    }
  }

  const removeAllowNumber = async (num: string) => {
    const res = await phoneMcp(app.client, "twilio_allowlist_remove", { phone_number: num })
    if (res.error) note(`allowlist remove: ${res.error.message}`)
    else {
      note(`Removed ${num}`)
      void refresh()
    }
  }

  const enroll = async () => {
    const ext = enrollExt().trim()
    const name = enrollName().trim()
    if (!ext || !name) return
    const body: Row = { name, extension: ext, requested_extension: ext, adapter_type: "claude" }
    const token = enrollToken().trim()
    if (token) body.token = token
    const res = await phoneHttp(app.client, "POST", "/api/agents/enroll", body)
    const fail = httpFailure(res)
    if (fail) note(`enroll: ${fail}`)
    else {
      const d = (res.data ?? {}) as Row
      note(`Agent enrolled — ext ${ext}${d.token ? ` · token ${str(d.token)}` : ""}`)
      setEnrollExt("")
      setEnrollName("")
      setEnrollToken("")
      void refresh()
    }
  }

  const redAlert = async () => {
    const msg = alertMsg().trim()
    if (!msg) return
    if (!globalThis.confirm(`Broadcast RED ALERT to every agent?\n\n"${msg}"`)) return
    const res = await phoneMcp(app.client, "red_alert", { message: msg })
    note(res.error ? `red_alert: ${res.error.message}` : "Alert broadcast")
    if (!res.error) setAlertMsg("")
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode((c) => (c === code ? "" : c)), 1600)
    } catch {
      note(`Could not copy — dial manually: ${code}`)
    }
  }

  const codes = () => forwardingCodes(fromNumber())

  return (
    <PhoneTabPanel>
      <style>{`
        .phset-actions { display: flex; gap: 10px; flex-wrap: wrap; }
        .phset-action-tile {
          all: unset; cursor: pointer; box-sizing: border-box;
          flex: 1 1 220px; display: flex; align-items: center; gap: 12px;
          padding: 12px; border-radius: var(--radius-sm);
          background: var(--surface); border: 1px solid var(--hairline-soft);
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, transform var(--dur-fast) ease;
        }
        .phset-action-tile:hover { background: var(--surface-strong); border-color: var(--accent-dim); transform: translateY(-1px); }
        .phset-action-icon {
          width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
          background: var(--accent-dim); font-size: 15px;
        }
        .phset-action-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .phset-action-label { font-size: 13px; color: var(--text); font-weight: 500; }
        .phset-action-desc { font-size: 10px; color: var(--text-muted); }
        .phset-action-chev { margin-left: auto; color: var(--text-faint); font-size: 16px; }

        .phset-section-title { font-size: 9px; color: var(--text-faint); letter-spacing: var(--track-wide); margin: 4px 0 -4px; }

        .phset-status { font-size: 11px; color: var(--accent-bright); font-family: var(--font-mono); }

        .phset-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .phset-mono { font-family: var(--font-mono); font-size: 11px; color: var(--text); }
        .phset-mono.danger { color: var(--danger); }
        .phset-mono.success { color: var(--success); }
        .phset-label-muted { color: var(--text-muted); font-size: 11px; }

        .phset-toggle {
          all: unset; cursor: pointer; box-sizing: border-box; flex-shrink: 0;
          width: 42px; height: 22px; border-radius: 11px; position: relative;
          background: var(--surface-strong); border: 1px solid var(--hairline-soft);
          transition: background var(--dur-mid) ease, border-color var(--dur-mid) ease;
        }
        .phset-toggle.on { background: var(--accent); border-color: var(--accent-glow); box-shadow: 0 0 10px -2px var(--accent-glow); }
        .phset-toggle:disabled { opacity: 0.5; cursor: default; }
        .phset-toggle-knob {
          position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
          background: var(--text); transition: transform var(--dur-mid) cubic-bezier(.2,.8,.2,1);
        }
        .phset-toggle.on .phset-toggle-knob { transform: translateX(20px); }

        .phset-desc-row { display: flex; align-items: flex-start; gap: 10px; justify-content: space-between; }
        .phset-desc-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
        .phset-desc-title { font-size: 12px; color: var(--text); font-weight: 500; }
        .phset-desc-sub { font-size: 10px; color: var(--text-muted); line-height: 1.5; }

        .phset-field-row { display: flex; gap: 8px; }
        .phset-input {
          flex: 1; min-width: 0; background: var(--surface-input);
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
          color: var(--text); padding: 8px 10px; font-family: var(--font-mono);
          font-size: 12px; transition: border-color var(--dur-fast) ease;
        }
        .phset-input:focus { outline: none; border-color: var(--accent-dim); }
        .phset-input::placeholder { color: var(--text-faint); }

        .phset-btn {
          all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
          padding: 8px 16px; border-radius: var(--radius-xs); white-space: nowrap;
          font-family: var(--font-display); font-size: 10px; letter-spacing: var(--track-mid);
          border: 1px solid var(--accent-dim); color: var(--ink-on-accent);
          background: var(--accent-dim); transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .phset-btn:hover:not(:disabled) { background: var(--accent); }
        .phset-btn:disabled { opacity: 0.4; cursor: default; }
        .phset-btn.small { padding: 5px 10px; font-size: 9px; }
        .phset-btn.danger { border-color: var(--danger-dim); background: var(--danger-dim); color: var(--text); }
        .phset-btn.danger:hover:not(:disabled) { background: var(--danger); }

        .phset-flow { display: flex; flex-wrap: wrap; gap: 8px; }
        .phset-chip {
          all: unset; cursor: pointer; box-sizing: border-box;
          height: 28px; padding: 0 12px; border-radius: var(--radius-xs);
          display: inline-flex; align-items: center; font-size: 11px; color: var(--text-muted);
          background: transparent; border: 1px solid var(--hairline-soft);
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease;
        }
        .phset-chip:hover { background: rgba(255,255,255,0.06); }
        .phset-chip.selected { background: var(--accent-dim); border-color: var(--accent); color: var(--accent-bright); }

        .phset-hint { font-size: 11px; color: var(--text-faint); }

        .phset-forward-note { font-size: 10px; color: var(--text-faint); line-height: 1.5; }
        .phset-forward-warn { font-size: 10px; color: var(--amber); line-height: 1.5; }
        .phset-code-row { display: flex; flex-wrap: wrap; gap: 8px; }
        .phset-code-chip {
          all: unset; cursor: pointer; box-sizing: border-box; position: relative;
          display: flex; flex-direction: column; gap: 1px; padding: 6px 10px;
          border-radius: var(--radius-xs); border: 1px solid var(--accent-dim); background: transparent;
          transition: background var(--dur-fast) ease;
        }
        .phset-code-chip:hover { background: var(--accent-faint); }
        .phset-code-chip.copied { border-color: var(--success); }
        .phset-code-chip-lbl { font-family: var(--font-display); font-size: 9px; letter-spacing: 0.6px; color: var(--accent); }
        .phset-code-chip-code { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }
        .phset-code-chip.copied .phset-code-chip-lbl { color: var(--success); }
        .phset-relay-note {
          border: 1px solid var(--amber); border-radius: var(--radius-xs); padding: 8px 10px;
          color: var(--amber); font-size: 10px;
        }

        .phset-allow-list { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; }
        .phset-allow-row { display: flex; align-items: center; gap: 8px; }
        .phset-allow-num { flex: 1; min-width: 0; }
        .phset-allow-remove {
          all: unset; cursor: pointer; width: 24px; height: 22px; border-radius: 4px;
          display: flex; align-items: center; justify-content: center;
          color: var(--danger); border: 1px solid var(--danger-dim); font-size: 10px;
          transition: background var(--dur-fast) ease;
        }
        .phset-allow-remove:hover { background: var(--danger-dim); }

        .phset-warroom { border-color: var(--danger); }

        .phset-sub { display: flex; flex-direction: column; gap: 10px; }
        .phset-sub-header { display: flex; align-items: center; gap: 10px; }
        .phset-sub-title { font-size: 13px; color: var(--text); }
        .phset-back {
          all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs);
          display: flex; align-items: center; justify-content: center;
          color: var(--text-muted); border: 1px solid var(--hairline-soft);
          transition: background var(--dur-fast) ease;
        }
        .phset-back:hover { background: rgba(255,255,255,0.06); }

        .phset-diag-list { display: flex; flex-direction: column; gap: 8px; }
        .phset-diag-row { display: flex; align-items: center; gap: 10px; }
        .phset-diag-icon {
          width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center; font-size: 13px;
          color: var(--text-muted); background: rgba(92,113,133,0.14);
        }
        .phset-diag-icon.ok { color: var(--success); background: rgba(57,230,160,0.16); }
        .phset-diag-icon.fail { color: var(--danger); background: rgba(255,107,107,0.15); }
        .phset-diag-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
        .phset-diag-label { font-size: 12px; color: var(--text); }
        .phset-diag-detail { font-size: 9px; color: var(--text-faint); font-family: var(--font-mono); }
        .phset-diag-state { font-family: var(--font-display); font-size: 10px; font-weight: 600; color: var(--text-faint); }
        .phset-diag-state.ok { color: var(--success); }
        .phset-diag-state.fail { color: var(--danger); }

        .phset-error-card {
          border: 1px solid var(--danger); border-radius: var(--radius-sm); padding: 10px 12px;
          display: flex; flex-direction: column; gap: 4px; background: var(--surface);
        }
        .phset-error-text { font-family: var(--font-mono); font-size: 10px; color: var(--text); word-break: break-word; }

        .phset-history-list { display: flex; flex-direction: column; gap: 6px; }
        .phset-history-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
        .phset-history-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .phset-history-sub { font-size: 10px; color: var(--text-muted); }
      `}</style>

      <Show when={sub() === ""}>
        <div class="phset-actions">
          <button type="button" class="phset-action-tile" onClick={() => setSub("diagnostics")}>
            <div class="phset-action-icon">⚡</div>
            <div class="phset-action-text">
              <div class="phset-action-label">Diagnostics</div>
              <div class="phset-action-desc">Inspect connection, auth, and service health.</div>
            </div>
            <div class="phset-action-chev">›</div>
          </button>
          <button type="button" class="phset-action-tile" onClick={() => setSub("history")}>
            <div class="phset-action-icon">📋</div>
            <div class="phset-action-text">
              <div class="phset-action-label">Call history</div>
              <div class="phset-action-desc">Recent calls and missed calls.</div>
            </div>
            <div class="phset-action-chev">›</div>
          </button>
        </div>

        <Show when={status()}>
          <div class="phset-status">{status()}</div>
        </Show>

        <SectionLabel>TWILIO STATUS</SectionLabel>
        <div class="card">
          <div class="phset-row">
            <span class="phset-label-muted">Status:</span>
            <span class="phset-mono" classList={{ success: twilioConfigured(), danger: !twilioConfigured() }}>
              {twilioConfigured() ? "Configured" : "Not configured"}
            </span>
          </div>
          <div class="phset-row" style={{ "margin-top": "6px" }}>
            <span class="phset-label-muted">Number:</span>
            <span class="phset-mono">{fromNumber() || "—"}</span>
          </div>
          <div class="phset-row" style={{ "margin-top": "6px" }}>
            <span class="phset-label-muted">Voice:</span>
            <span class="phset-mono" style={{ color: "var(--violet)" }}>{voiceProfile()}</span>
          </div>
          <div class="phset-row" style={{ "margin-top": "10px" }}>
            <span class="phset-label-muted">Screening:</span>
            <Toggle on={screeningOn()} onToggle={() => void toggleScreening()} />
            <span class="hud-label" style={{ "font-size": "9px", color: screeningOn() ? "var(--accent)" : "var(--text-faint)" }}>
              {screeningOn() ? "ON" : "OFF"}
            </span>
          </div>
        </div>

        <SectionLabel>USER PHONE NUMBER</SectionLabel>
        <div class="phset-field-row">
          <input
            class="phset-input"
            placeholder="+1XXXXXXXXXX"
            value={userNumberInput()}
            onInput={(e) => setUserNumberInput(e.currentTarget.value)}
          />
          <button type="button" class="phset-btn" disabled={!userNumberInput().trim()} onClick={() => void setUserNumberAction()}>
            SET
          </button>
        </div>
        <Show when={userNumber()}>
          <div class="phset-hint">Current: {userNumber()}</div>
        </Show>

        <SectionLabel>TEXT YOUR AGENT (SMS)</SectionLabel>
        <div class="card">
          <div class="phset-desc-row">
            <div class="phset-desc-text">
              <div class="phset-desc-title">Text your agent (SMS)</div>
              <div class="phset-desc-sub">
                {smsEnabled()
                  ? "ON — texting your number reaches the agent, which texts you back."
                  : "OFF — inbound texts just land in your inbox."}
              </div>
            </div>
            <Toggle on={smsEnabled()} onToggle={() => void postSms({ enabled: !smsEnabled() }, "SMS agent")} />
          </div>
          <div style={{ "margin-top": "10px" }}>
            <div class="phset-label-muted" style={{ "margin-bottom": "6px" }}>Who answers your texts</div>
            <AgentPicker agents={agents()} selected={smsAgentExt()} onSelect={(ext) => void postSms({ extension: ext }, "SMS agent")} />
          </div>
          <div class="phset-hint" style={{ "margin-top": "8px" }}>Your number must be on the Twilio allowlist.</div>
        </div>

        <SectionLabel>CALL SCREENING</SectionLabel>
        <div class="card">
          <div class="phset-label-muted" style={{ "margin-bottom": "4px" }}>Transport</div>
          <div class="phset-hint" style={{ "margin-bottom": "8px" }}>How a screened call reaches your agent.</div>
          <div class="phset-row">
            <Chip label="Twilio (anywhere)" selected={transport() === "twilio"} onClick={() => void setTransportTo("twilio")} />
            <Chip label="Bluetooth relay (M507)" selected={transport() === "relay"} onClick={() => void setTransportTo("relay")} />
          </div>

          <div class="phset-desc-row" style={{ "margin-top": "14px" }}>
            <div class="phset-desc-text">
              <div class="phset-desc-title">Auto-screen calls</div>
              <div class="phset-desc-sub">
                {screeningOn()
                  ? "ON — agent answers calls you decline or don't pick up."
                  : "OFF — calls are not screened."}
              </div>
            </div>
            <Toggle on={screeningOn()} onToggle={() => void toggleScreening()} />
          </div>

          <div style={{ "margin-top": "14px" }}>
            <div class="phset-label-muted" style={{ "margin-bottom": "4px" }}>Who answers when YOU call in</div>
            <div class="phset-hint" style={{ "margin-bottom": "6px" }}>When you dial your own number, this agent picks up.</div>
            <AgentPicker agents={agents()} selected={inboundExt()} onSelect={(ext) => void postScreening({ inbound_extension: ext }, "Inbound agent")} />
          </div>

          <div style={{ "margin-top": "14px" }}>
            <div class="phset-label-muted" style={{ "margin-bottom": "4px" }}>Who screens unknown callers</div>
            <div class="phset-hint" style={{ "margin-bottom": "6px" }}>A fast, tool-free brain for screening.</div>
            <AgentPicker agents={agents()} selected={screeningExt()} onSelect={(ext) => void postScreening({ screening_extension: ext }, "Screening agent")} />
          </div>

          <Show when={transport() === "twilio"}>
            <div style={{ "margin-top": "14px" }}>
              <div class="phset-label-muted" style={{ "margin-bottom": "4px" }}>Carrier forwarding (one-time setup)</div>
              <div class="phset-forward-note">
                Sends declined/missed calls to the agent instead of voicemail. Tap a code to copy it, then dial manually
                on your phone. Undo with ##002#.
              </div>
              <Show when={codes().placeholder}>
                <div class="phset-forward-warn" style={{ "margin-top": "6px" }}>
                  ⚠ No Twilio number configured yet — codes below show the +15551234567 PLACEHOLDER, do not dial them as-is.
                </div>
              </Show>
              <div class="phset-code-row" style={{ "margin-top": "8px" }}>
                <For each={codes().gsm}>
                  {(c) => (
                    <button type="button" class="phset-code-chip" classList={{ copied: copiedCode() === c.code }} onClick={() => void copyCode(c.code)}>
                      <span class="phset-code-chip-lbl">{copiedCode() === c.code ? "COPIED" : c.lbl.toUpperCase()}</span>
                      <span class="phset-code-chip-code">{c.code}</span>
                    </button>
                  )}
                </For>
              </div>
              <div class="phset-forward-note" style={{ "margin-top": "8px" }}>
                Verizon: try "Busy/no-answer" first (rings you, rolls to agent if you decline/miss).
              </div>
              <div class="phset-code-row" style={{ "margin-top": "8px" }}>
                <For each={codes().vz}>
                  {(c) => (
                    <button type="button" class="phset-code-chip" classList={{ copied: copiedCode() === c.code }} onClick={() => void copyCode(c.code)}>
                      <span class="phset-code-chip-lbl">{copiedCode() === c.code ? "COPIED" : c.lbl.toUpperCase()}</span>
                      <span class="phset-code-chip-code">{c.code}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <Show when={transport() === "relay"}>
            <div class="phset-relay-note" style={{ "margin-top": "14px" }}>
              Carry the M507 relay puck (paired over Bluetooth). When you let your agent answer, the call is
              auto-answered and its audio is routed to the puck — no carrier forwarding needed.
            </div>
          </Show>
        </div>

        <SectionLabel>PSTN ALLOWLIST</SectionLabel>
        <div class="card">
          <Show when={allowlist().length > 0} fallback={<div class="phset-hint">No numbers allowlisted.</div>}>
            <div class="phset-allow-list">
              <For each={allowlist()}>
                {(row) => (
                  <div class="phset-allow-row">
                    <span class="phset-mono phset-allow-num">{row.num}{row.lbl ? `  ${row.lbl}` : ""}</span>
                    <button type="button" class="phset-allow-remove" onClick={() => void removeAllowNumber(row.num)}>✕</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="phset-field-row" style={{ "margin-top": "10px" }}>
            <input
              class="phset-input"
              placeholder="+1XXXXXXXXXX"
              value={newAllowNum()}
              onInput={(e) => setNewAllowNum(e.currentTarget.value)}
            />
            <input
              class="phset-input"
              style={{ flex: "0 0 140px" }}
              placeholder="label (optional)"
              value={newAllowLbl()}
              onInput={(e) => setNewAllowLbl(e.currentTarget.value)}
            />
            <button type="button" class="phset-btn" disabled={!newAllowNum().trim()} onClick={() => void addAllowNumber()}>
              ADD
            </button>
          </div>
        </div>

        <SectionLabel>VERIFIED CALLER IDs (TWILIO)</SectionLabel>
        <div class="card">
          <div class="phset-hint" style={{ "margin-bottom": "10px" }}>
            On a Twilio trial, Cindro can only call/text VERIFIED numbers. Verify one — Twilio calls it with a code; the number is also added to the allowlist.
          </div>
          <div class="phset-field-row">
            <input class="phset-input" placeholder="+1XXXXXXXXXX" value={verifyNum()} onInput={(e) => setVerifyNum(e.currentTarget.value)} />
            <input
              class="phset-input"
              style={{ flex: "0 0 140px" }}
              placeholder="label (optional)"
              value={verifyLabel()}
              onInput={(e) => setVerifyLabel(e.currentTarget.value)}
            />
            <button type="button" class="phset-btn" disabled={!verifyNum().trim()} onClick={() => void verifyNumber()}>
              VERIFY
            </button>
          </div>
          <Show when={verifyCode()}>
            <div
              class="card"
              style={{
                "margin-top": "10px",
                display: "flex",
                "align-items": "center",
                gap: "10px",
                border: "1px solid var(--accent)",
                background: "var(--accent-dim)",
              }}
            >
              <span style={{ color: "var(--text-muted)", "font-size": "11px" }}>Enter code on the call:</span>
              <span class="phset-mono" style={{ color: "var(--accent-bright)", "font-size": "20px", "font-weight": 700 }}>{verifyCode()}</span>
            </div>
          </Show>
          <Show when={verifyStatus() && !verifyCode()}>
            <div class="phset-hint" style={{ "margin-top": "8px", color: verifyStatus().startsWith("Error") ? "var(--danger)" : "var(--accent)" }}>
              {verifyStatus()}
            </div>
          </Show>
          <Show when={callerIds().length > 0} fallback={<div class="phset-hint" style={{ "margin-top": "10px" }}>No verified caller IDs yet (or Twilio not configured).</div>}>
            <div class="phset-allow-list" style={{ "margin-top": "10px" }}>
              <For each={callerIds()}>
                {(row) => (
                  <div class="phset-allow-row">
                    <span class="phset-mono phset-allow-num">✓ {row.num}{row.name ? `  ${row.name}` : ""}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <SectionLabel>ADD NEW AGENT</SectionLabel>
        <div class="card">
          <div class="phset-hint" style={{ "margin-bottom": "10px" }}>Mint an extension + token and register an inbound agent.</div>
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <input class="phset-input" placeholder="Extension (e.g. 106)" value={enrollExt()} onInput={(e) => setEnrollExt(e.currentTarget.value)} />
            <input class="phset-input" placeholder="Agent name" value={enrollName()} onInput={(e) => setEnrollName(e.currentTarget.value)} />
            <input
              class="phset-input"
              type="password"
              placeholder="Token (leave blank to auto-generate)"
              value={enrollToken()}
              onInput={(e) => setEnrollToken(e.currentTarget.value)}
            />
            <button
              type="button"
              class="phset-btn"
              style={{ "align-self": "flex-start" }}
              disabled={!enrollExt().trim() || !enrollName().trim()}
              onClick={() => void enroll()}
            >
              REGISTER AGENT
            </button>
          </div>
        </div>

        <SectionLabel>WAR ROOM</SectionLabel>
        <div class="card phset-warroom">
          <div class="phset-row" style={{ "margin-bottom": "10px" }}>
            <NavIcon glyph="agents" color="var(--danger)" glow />
            <span class="phset-desc-sub">RED ALERT broadcasts to every agent and opens a war-room thread.</span>
          </div>
          <div class="phset-field-row">
            <input class="phset-input" placeholder="Alert message…" value={alertMsg()} onInput={(e) => setAlertMsg(e.currentTarget.value)} />
            <button type="button" class="phset-btn danger" disabled={!alertMsg().trim()} onClick={() => void redAlert()}>
              RED ALERT
            </button>
          </div>
        </div>
      </Show>

      <Show when={sub() === "diagnostics"}>
        <DiagnosticsPanel onBack={() => setSub("")} />
      </Show>
      <Show when={sub() === "history"}>
        <HistoryPanel onBack={() => setSub("")} />
      </Show>
    </PhoneTabPanel>
  )
}
