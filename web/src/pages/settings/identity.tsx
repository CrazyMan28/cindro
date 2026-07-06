// SETTINGS · IDENTITY — assistant name + user name. Straight settings.get
// read / settings.set({patch}) partial-write round-trip. Ported intent from
// desktop/qml/SettingsPage.qml's "// IDENTITY" card (same two fields, same
// copy) — this is the browser-side twin of that form.
import { createSignal, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

function IdentitySection() {
  const app = useApp()
  const [assistantName, setAssistantName] = createSignal("")
  const [userName, setUserName] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [error, setError] = createSignal("")

  onMount(async () => {
    try {
      const res = await app.client.call("settings.get", {}, 15000)
      const rawAssistant = res.assistant_name
      const name = typeof rawAssistant === "string" && rawAssistant.trim().length ? rawAssistant : "Jarvis"
      setAssistantName(name)
      setUserName(typeof res.user_name === "string" ? res.user_name : "")
      setError("")
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  })

  const save = async () => {
    setSaving(true)
    try {
      const patch = {
        assistant_name: assistantName().trim().length ? assistantName().trim() : "Jarvis",
        user_name: userName().trim(),
      }
      await app.client.call("settings.set", { patch }, 15000)
      setAssistantName(patch.assistant_name)
      setUserName(patch.user_name)
      setDirty(false)
      app.notify("Identity saved.")
    } catch (e) {
      app.notify(`Save failed: ${String(e)}`, "error")
    } finally {
      setSaving(false)
    }
  }

  const displayName = () => (assistantName().trim().length ? assistantName().trim() : "Jarvis")

  return (
    <div class="sid-form">
      <style>{`
        .sid-form { display: flex; flex-direction: column; gap: 16px; max-width: 480px; animation: sid-in var(--dur-slow) ease-out; }
        @keyframes sid-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .sid-title { color: var(--accent); font-size: 11px; }
        .sid-desc { color: var(--text-faint); font-size: 12px; margin: 6px 0 0; line-height: 1.5; }
        .sid-field { display: flex; flex-direction: column; gap: 5px; }
        .sid-field label { color: var(--text-muted); font-size: 12px; }
        .sid-input {
          width: 100%;
          box-sizing: border-box;
          background: var(--surface-input);
          border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-xs);
          color: var(--text);
          padding: 9px 11px;
          font-family: var(--font-sans);
          font-size: 13px;
          transition: border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease;
        }
        .sid-input:focus { outline: none; border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-faint); }
        .sid-hint { color: var(--text-faint); font-size: 11px; line-height: 1.5; }
        .sid-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
        .sid-save {
          all: unset;
          cursor: pointer;
          padding: 8px 20px;
          border-radius: var(--radius-xs);
          background: var(--accent-dim);
          color: var(--accent-bright);
          border: 1px solid var(--accent-dim);
          font-family: var(--font-display);
          letter-spacing: var(--track-mid);
          font-size: 12px;
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .sid-save:hover:not(:disabled) { background: var(--accent-faint); }
        .sid-save:disabled { opacity: 0.4; cursor: default; }
        .sid-loading { color: var(--text-faint); font-size: 12px; }
      `}</style>

      <div class="sid-head">
        <div class="hud-label sid-title">Identity</div>
        <p class="sid-desc">
          What the assistant calls itself, in chat and voice, and who you are so it can address you by name.
        </p>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="sid-loading">Loading…</div>}>
        <div class="sid-field">
          <label for="sid-assistant-name">Assistant name</label>
          <input
            id="sid-assistant-name"
            class="sid-input"
            type="text"
            placeholder="Jarvis"
            value={assistantName()}
            onInput={(e) => {
              setAssistantName(e.currentTarget.value)
              setDirty(true)
            }}
          />
        </div>

        <div class="sid-field">
          <label for="sid-user-name">Your name</label>
          <input
            id="sid-user-name"
            class="sid-input"
            type="text"
            placeholder="Your name (optional)"
            value={userName()}
            onInput={(e) => {
              setUserName(e.currentTarget.value)
              setDirty(true)
            }}
          />
        </div>

        <div class="sid-hint">Saved as a memory so {displayName()} can address you by name.</div>

        <div class="sid-actions">
          <button type="button" class="sid-save" disabled={!dirty() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "identity", label: "Identity", component: IdentitySection }
export default section
