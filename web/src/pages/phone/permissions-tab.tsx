// PERMISSIONS tab body — "what Cindro may do over the phone" (PhonePolicyStore).
// Mirrors desktop/qml/PhonePermissionsTab.qml. One card per capability; choices
// render as selectable chips with an honest ENFORCED vs GUIDANCE badge (outbound
// tool actions + answer-policy are hard-enforced; the inbound-agent capabilities
// are guidance only, since the vendored phone server has no daemon choke point).
// Wired to Contract A phone.policy.list/set/reset (device-exposed).
import { createEffect, createSignal, For, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import { PhoneTabPanel, usePhoneTab } from "./index"

interface ChoiceLabel {
  value: string
  label: string
}
interface PhoneCap {
  id: string
  label: string
  value: string
  enforcement: string // "hard" | "config" | "soft"
  note: string
  choices: string[]
  choiceLabels: ChoiceLabel[]
}
interface PolicyRes {
  capabilities?: PhoneCap[]
}

export function PhonePermissionsTab() {
  const app = useApp()
  const shell = usePhoneTab()
  const active = () => shell.tab() === "permissions"

  const [caps, setCaps] = createSignal<PhoneCap[]>([])
  const [loading, setLoading] = createSignal(false)
  const [status, setStatus] = createSignal("")

  const apply = (res: PolicyRes) => setCaps(res.capabilities ?? [])

  async function load() {
    if (!app.client.connected) return
    setLoading(true)
    setStatus("")
    try {
      apply((await app.client.call("phone.policy.list", {}, 15000)) as PolicyRes)
    } catch (e) {
      setStatus("Error: " + String(e))
    } finally {
      setLoading(false)
    }
  }
  async function setCap(id: string, value: string) {
    setStatus("Saving…")
    try {
      apply((await app.client.call("phone.policy.set", { id, value }, 15000)) as PolicyRes)
      setStatus("")
    } catch (e) {
      setStatus("Error: " + String(e))
    }
  }
  async function resetAll() {
    setStatus("Resetting…")
    try {
      apply((await app.client.call("phone.policy.reset", {}, 15000)) as PolicyRes)
      setStatus("")
    } catch (e) {
      setStatus("Error: " + String(e))
    }
  }

  createEffect(() => {
    shell.refreshNonce()
    if (active()) void load()
  })

  const labelFor = (cap: PhoneCap, value: string) =>
    cap.choiceLabels.find((c) => c.value === value)?.label ?? value
  const isHard = (cap: PhoneCap) => cap.enforcement === "hard" || cap.enforcement === "config"

  return (
    <PhoneTabPanel>
      <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: 1 }}>
          <div class="hud-label" style={{ "font-size": "10px", color: "var(--text-faint)" }}>
            WHAT CINDRO MAY DO OVER THE PHONE
          </div>
          <div style={{ color: "var(--text-muted)", "font-size": "11px" }}>
            Deny blocks the action; Ask requires your approval first.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void resetAll()}
          style={{
            all: "unset",
            cursor: "pointer",
            height: "28px",
            padding: "0 12px",
            "border-radius": "var(--radius-xs)",
            border: "1px solid var(--hairline-soft)",
            color: "var(--text-muted)",
            "font-size": "10px",
          }}
        >
          RESET
        </button>
      </div>

      <Show when={status()}>
        <div style={{ color: status().startsWith("Error") ? "var(--danger)" : "var(--accent)", "font-size": "11px", "font-family": "monospace" }}>
          {status()}
        </div>
      </Show>

      <Show when={loading() && caps().length === 0}>
        <div style={{ color: "var(--text-faint)", "font-size": "12px" }}>Loading permissions…</div>
      </Show>

      <For each={caps()}>
        {(cap) => (
          <div class="card" style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <div style={{ color: "var(--text)", "font-size": "13px", "font-weight": 500, flex: 1 }}>{cap.label}</div>
              <span
                class="hud-label"
                style={{
                  "font-size": "8px",
                  padding: "2px 6px",
                  "border-radius": "8px",
                  color: isHard(cap) ? "var(--success)" : "var(--amber)",
                  background: isHard(cap) ? "var(--success-faint, rgba(56,230,160,0.16))" : "rgba(255,180,84,0.16)",
                }}
              >
                {isHard(cap) ? "ENFORCED" : "GUIDANCE"}
              </span>
            </div>
            <Show when={cap.note}>
              <div style={{ color: "var(--text-muted)", "font-size": "10px", "line-height": "1.4" }}>{cap.note}</div>
            </Show>
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
              <For each={cap.choices}>
                {(choice) => {
                  const sel = () => cap.value === choice
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        if (!sel()) void setCap(cap.id, choice)
                      }}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        height: "28px",
                        padding: "0 12px",
                        "border-radius": "var(--radius-xs)",
                        border: `1px solid ${sel() ? "var(--accent)" : "var(--hairline-soft)"}`,
                        background: sel() ? "var(--accent-dim)" : "var(--surface-strong, transparent)",
                        color: sel() ? "var(--accent)" : "var(--text-muted)",
                        "font-size": "11px",
                      }}
                    >
                      {labelFor(cap, choice)}
                    </button>
                  )
                }}
              </For>
            </div>
          </div>
        )}
      </For>
    </PhoneTabPanel>
  )
}
