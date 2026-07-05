// SETTINGS tab — PhoneSettingsTab.qml parity: diagnostics + call-history
// sub-screens, Twilio status card with screening toggle, user phone number,
// SMS agent enable + picker, screening transport (twilio|relay — the
// server's enum, routes/http.ts:456; "relay" is the Bluetooth M507 puck),
// inbound/unknown-caller agent pickers, carrier forwarding codes with the
// REAL configured Twilio number substituted (the QML hardcodes
// +15551234567 — bug, not copied), PSTN allowlist add/remove, the
// enroll-new-agent form, and the war-room Red Alert card.

import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"

import { useApp } from "../../app-context"
import { Picker } from "../../chat/Picker"
import type { Row } from "../api"
import { asList, httpFailure, phoneHttp, phoneMcp, str, usePhonePoll } from "../api"
import type { PromptSpec } from "../ui"
import { Hint, PromptBar, StatusLine } from "../ui"
import type { TabProps } from "./CallsTab"
import { SettingsCards } from "./SettingsCards"
import { DiagnosticsPanel, HistoryPanel } from "./SettingsPanels"

interface AgentOpt {
  ext: string
  name: string
}

interface PickState {
  title: string
  onPick: (ext: string) => void
}

export function SettingsTab(props: TabProps) {
  const app = useApp()
  const [twilioConfigured, setTwilioConfigured] = createSignal(false)
  const [fromNumber, setFromNumber] = createSignal("")
  const [userNumber, setUserNumber] = createSignal("")
  const [screeningOn, setScreeningOn] = createSignal(false)
  const [voiceProfile, setVoiceProfile] = createSignal("(default)")
  const [smsEnabled, setSmsEnabled] = createSignal(false)
  const [smsAgentExt, setSmsAgentExt] = createSignal("")
  const [transport, setTransport] = createSignal("twilio")
  const [inboundExt, setInboundExt] = createSignal("")
  const [screeningExt, setScreeningExt] = createSignal("")
  const [allowlist, setAllowlist] = createSignal<Array<{ num: string; lbl: string }>>([])
  const [alSelected, setAlSelected] = createSignal(0)
  const [agents, setAgents] = createSignal<AgentOpt[]>([])
  const [status, setStatus] = createSignal("")
  const [sub, setSub] = createSignal<"" | "diag" | "history">("")
  const [subSeq, setSubSeq] = createSignal(0)
  const [prompt, setPrompt] = createSignal<PromptSpec | null>(null)
  const [picker, setPicker] = createSignal<PickState | null>(null)
  const [confirmAlert, setConfirmAlert] = createSignal<string | null>(null)

  createEffect(() =>
    props.onModalChange?.(prompt() !== null || picker() !== null || confirmAlert() !== null),
  )
  onCleanup(() => props.onModalChange?.(false))

  const note = (msg: string) => setStatus(msg)

  const refresh = async () => {
    const tw = await phoneMcp(app.client, "twilio_status")
    if (tw.error) note(`twilio_status: ${tw.error.message}`)
    else {
      const d = (tw.data ?? {}) as Row
      setTwilioConfigured(d.configured === true)
      setFromNumber(str(d.from_number))
      setUserNumber(str(d.default_user_number))
      setScreeningOn(d.screening_enabled === true)
    }
    const al = await phoneMcp(app.client, "twilio_allowlist_list")
    if (al.error) note(`allowlist: ${al.error.message}`)
    else {
      setAllowlist(
        asList(al.data, "numbers").map((n) =>
          typeof n === "string"
            ? { num: n, lbl: "" }
            : { num: str((n as Row).phone_number), lbl: str((n as Row).label) },
        ),
      )
      setAlSelected((i) => Math.min(i, Math.max(0, allowlist().length - 1)))
    }
    const vp = await phoneMcp(app.client, "get_voice_profile", { extension: "100" })
    if (vp.error) note(`voice profile: ${vp.error.message}`)
    else {
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
      setAgents(
        asList(ex.data).map((a: Row) => ({
          ext: str(a.extension) || str(a.ext),
          name: str(a.name, "Agent"),
        })),
      )
    }
  }
  usePhonePoll(app.client, props.active, 20000, refresh)

  const toggleScreening = async () => {
    const enable = !screeningOn()
    const res = await phoneMcp(
      app.client,
      enable ? "twilio_screening_enable" : "twilio_screening_disable",
    )
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
    } else note(`Transport: ${t}`)
  }

  const postScreening = async (patch: Record<string, unknown>, label: string) => {
    const res = await phoneHttp(app.client, "POST", "/api/screening", patch)
    const fail = httpFailure(res)
    note(fail ? `${label}: ${fail}` : `${label} saved`)
    if (!fail) void refresh()
  }

  const postSms = async (patch: Record<string, unknown>, label: string) => {
    const res = await phoneHttp(app.client, "POST", "/api/sms-agent", patch)
    const fail = httpFailure(res)
    note(fail ? `${label}: ${fail}` : `${label} saved`)
    if (!fail) void refresh()
  }

  const enroll = (ext: string, name: string, token: string) => {
    // QML sends {name, requested_extension, adapter_type} — the server
    // schema (enrollmentService.ts:9-13) reads `extension`; both are sent so
    // either build accepts it. Token rides along only when provided.
    const body: Record<string, unknown> = {
      name,
      extension: ext,
      requested_extension: ext,
      adapter_type: "claude",
    }
    if (token) body.token = token
    void phoneHttp(app.client, "POST", "/api/agents/enroll", body).then((res) => {
      const fail = httpFailure(res)
      if (fail) {
        note(`enroll: ${fail}`)
        return
      }
      const d = (res.data ?? {}) as Row
      note(`Agent enrolled — ext ${ext}${d.token ? ` · token ${str(d.token)}` : ""}`)
      void refresh()
    })
  }

  const agentPicker = (title: string, onPick: (ext: string) => void) => {
    if (agents().length === 0) {
      note("No agents registered — cannot pick.")
      return
    }
    setPicker({ title, onPick })
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || picker() || confirmAlert()) return
      if (prompt()) {
        if (key.name === "escape") {
          key.preventDefault()
          setPrompt(null)
        }
        return
      }
      if (sub()) {
        if (key.name === "escape") {
          key.preventDefault()
          setSub("")
        } else if (key.name === "d" && sub() === "diag") setSubSeq((n) => n + 1)
        else if (key.name === "h" && sub() === "history") setSubSeq((n) => n + 1)
        return
      }
      switch (key.name) {
        case "d":
          setSub("diag")
          setSubSeq((n) => n + 1)
          break
        case "h":
          setSub("history")
          setSubSeq((n) => n + 1)
          break
        case "s":
          void toggleScreening()
          break
        case "t":
          void setTransportTo(transport() === "twilio" ? "relay" : "twilio")
          break
        case "u":
          setPrompt({
            label: "User phone number +1XXXXXXXXXX",
            onSubmit: (num) => {
              setPrompt(null)
              const n = num.trim()
              if (!n) return
              void phoneMcp(app.client, "twilio_set_user_number", { phone_number: n }).then(
                (res) => {
                  note(res.error ? `set number: ${res.error.message}` : `User number set: ${n}`)
                  if (!res.error) void refresh()
                },
              )
            },
          })
          break
        case "e":
          void postSms({ enabled: !smsEnabled() }, "SMS agent")
          break
        case "m":
          agentPicker("WHO ANSWERS YOUR TEXTS", (ext) => void postSms({ extension: ext }, "SMS agent"))
          break
        case "i":
          agentPicker("WHO ANSWERS WHEN YOU CALL IN", (ext) =>
            void postScreening({ inbound_extension: ext }, "Inbound agent"),
          )
          break
        case "k":
          agentPicker("WHO SCREENS UNKNOWN CALLERS", (ext) =>
            void postScreening({ screening_extension: ext }, "Screening agent"),
          )
          break
        case "a":
          setPrompt({
            label: "Allowlist +1XXXXXXXXXX (optional label)",
            onSubmit: (text) => {
              setPrompt(null)
              const parts = text.trim().split(/\s+/)
              if (!parts[0]) return
              void phoneMcp(app.client, "twilio_allowlist_add", {
                phone_number: parts[0],
                label: parts.slice(1).join(" "),
              }).then((res) => {
                note(res.error ? `allowlist add: ${res.error.message}` : `Added ${parts[0]}`)
                void refresh()
              })
            },
          })
          break
        case "x": {
          const row = allowlist()[alSelected()]
          if (!row) break
          void phoneMcp(app.client, "twilio_allowlist_remove", { phone_number: row.num }).then(
            (res) => {
              note(res.error ? `allowlist remove: ${res.error.message}` : `Removed ${row.num}`)
              void refresh()
            },
          )
          break
        }
        case "up":
          setAlSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setAlSelected((i) => Math.min(Math.max(0, allowlist().length - 1), i + 1))
          break
        case "n":
          setPrompt({
            label: "New agent extension (e.g. 106)",
            onSubmit: (ext) => {
              const e = ext.trim()
              if (!e) {
                setPrompt(null)
                return
              }
              setPrompt({
                label: "Agent name",
                onSubmit: (name) => {
                  const nm = name.trim()
                  if (!nm) {
                    setPrompt(null)
                    return
                  }
                  setPrompt({
                    label: "Token (blank = auto-generate)",
                    onSubmit: (token) => {
                      setPrompt(null)
                      enroll(e, nm, token.trim())
                    },
                  })
                },
              })
            },
          })
          break
        case "w":
          setPrompt({
            label: "RED ALERT message",
            onSubmit: (msg) => {
              setPrompt(null)
              if (msg.trim()) setConfirmAlert(msg.trim())
            },
          })
          break
        case "r":
          void refresh()
          break
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show when={sub() === "diag"}>
        <DiagnosticsPanel seq={subSeq()} />
      </Show>
      <Show when={sub() === "history"}>
        <HistoryPanel seq={subSeq()} />
      </Show>

      <Show when={sub() === ""}>
        <Hint text="d diagnostics · h history · s screening · t transport · u user number · e sms · m sms agent · i inbound · k screener" />
        <Hint text="a allowlist add · x remove · ↑↓ pick · n enroll agent · w red alert · r refresh" />
        <Show when={status()}>
          <StatusLine text={status()} />
        </Show>
        <SettingsCards
          twilioConfigured={twilioConfigured}
          fromNumber={fromNumber}
          userNumber={userNumber}
          screeningOn={screeningOn}
          voiceProfile={voiceProfile}
          smsEnabled={smsEnabled}
          smsAgentExt={smsAgentExt}
          transport={transport}
          inboundExt={inboundExt}
          screeningExt={screeningExt}
          allowlist={allowlist}
          alSelected={alSelected}
          onAlSelect={setAlSelected}
        />
      </Show>

      <Show when={picker()}>
        {(p) => (
          <Picker
            title={p().title}
            options={agents().map((a) => ({ label: a.name, description: `ext ${a.ext}`, value: a.ext }))}
            onPick={(ext) => {
              const pick = p().onPick
              setPicker(null)
              pick(ext)
            }}
            onCancel={() => setPicker(null)}
          />
        )}
      </Show>

      <Show when={confirmAlert()}>
        {(msg) => (
          <Picker
            title="CONFIRM RED ALERT?"
            options={[
              { label: `Yes — broadcast "${msg()}"`, value: "yes" },
              { label: "Cancel", value: "no" },
            ]}
            onPick={(v) => {
              const message = confirmAlert()
              setConfirmAlert(null)
              if (v === "yes" && message)
                void phoneMcp(app.client, "red_alert", { message }).then((res) =>
                  note(res.error ? `red_alert: ${res.error.message}` : "Alert broadcast"),
                )
            }}
            onCancel={() => setConfirmAlert(null)}
          />
        )}
      </Show>

      <Show when={prompt()} keyed>
        {(p) => <PromptBar prompt={p} />}
      </Show>
    </box>
  )
}
