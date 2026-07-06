// SETTINGS · SECURITY — auth-related settings.get/set toggles: the
// phone+fingerprint auth lock gate and the local desktop unlock PIN. Ported
// intent from desktop/qml/SettingsPage.qml's "// SECURITY" cards (same two
// controls, same copy). NOTE: the "ask before risky action" permission_level
// dial and the auto_update toggle live in the Mode & Autonomy section, not
// here — this section is strictly the auth/lock surface (auth_lock_enabled +
// has_desktop_pin/desktop_pin). Per-tool/per-app enforcement rules are the
// separate Trust Policies section (policy.* verbs), not settings.get/set.
import { createSignal, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

const PIN_RE = /^\d{4,8}$/

function SecuritySection() {
  const app = useApp()
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")

  const [authLockEnabled, setAuthLockEnabled] = createSignal(true)
  const [hasDesktopPin, setHasDesktopPin] = createSignal(false)
  const [pinInput, setPinInput] = createSignal("")
  const [clearPin, setClearPin] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)

  onMount(async () => {
    try {
      const res = await app.client.call("settings.get", {}, 15000)
      setAuthLockEnabled(res.auth_lock_enabled === true)
      setHasDesktopPin(res.has_desktop_pin === true)
      setError("")
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  })

  const pin = () => pinInput().trim()
  const pinValid = () => pin().length === 0 || PIN_RE.test(pin())

  const save = async () => {
    if (!pinValid() || saving()) return
    setSaving(true)
    try {
      const patch: Record<string, unknown> = { auth_lock_enabled: authLockEnabled() }
      if (clearPin()) patch.desktop_pin = ""
      else if (pin().length > 0) patch.desktop_pin = pin()
      await app.client.call("settings.set", { patch }, 15000)
      if (clearPin()) setHasDesktopPin(false)
      else if (pin().length > 0) setHasDesktopPin(true)
      setPinInput("")
      setClearPin(false)
      setDirty(false)
      app.notify("Security settings saved.")
    } catch (e) {
      app.notify(`Save failed: ${String(e)}`, "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="ssec-form">
      <style>{`
        .ssec-form { display: flex; flex-direction: column; gap: 18px; max-width: 560px; animation: ssec-in var(--dur-slow) ease-out; }
        @keyframes ssec-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .ssec-title { color: var(--accent); font-size: 11px; }
        .ssec-loading { color: var(--text-faint); font-size: 12px; }
        .ssec-block {
          display: flex; flex-direction: column; gap: 10px;
          background: var(--surface-strong); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-sm); padding: 14px;
        }
        .ssec-row { display: flex; align-items: center; gap: 14px; }
        .ssec-row-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .ssec-row-title { color: var(--text); font-size: 13px; display: flex; align-items: center; gap: 8px; }
        .ssec-row-sub { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
        .ssec-pin-badge {
          font-family: var(--font-mono); font-size: 10px; color: var(--success);
          border: 1px solid var(--success); border-radius: 999px; padding: 1px 7px;
        }
        .ssec-switch {
          appearance: none; -webkit-appearance: none;
          width: 40px; height: 22px; flex: 0 0 40px; border-radius: 999px;
          background: var(--surface-input); border: 1px solid var(--hairline-soft);
          position: relative; cursor: pointer;
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
        }
        .ssec-switch::after {
          content: ""; position: absolute; top: 2px; left: 2px;
          width: 16px; height: 16px; border-radius: 50%; background: var(--text-muted);
          transition: transform var(--dur-fast) ease, background var(--dur-fast) ease;
        }
        .ssec-switch:checked { background: var(--accent-dim); border-color: var(--accent); }
        .ssec-switch:checked::after { transform: translateX(18px); background: var(--accent-bright); }
        .ssec-pin-fields { display: flex; gap: 8px; }
        .ssec-input {
          flex: 1; min-width: 0; box-sizing: border-box;
          background: var(--surface-input); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-xs); color: var(--text); padding: 9px 11px;
          font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px;
          transition: border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease;
        }
        .ssec-input:focus { outline: none; border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-faint); }
        .ssec-input.invalid { border-color: var(--danger-dim); }
        .ssec-input::placeholder { color: var(--text-faint); letter-spacing: normal; }
        .ssec-clear-btn {
          all: unset; cursor: pointer; box-sizing: border-box; white-space: nowrap;
          padding: 9px 14px; border-radius: var(--radius-xs);
          border: 1px solid var(--danger-dim); color: var(--danger);
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .ssec-clear-btn:hover:not(:disabled) { background: var(--danger-dim); }
        .ssec-clear-btn.active { background: var(--danger-dim); }
        .ssec-clear-btn:disabled { opacity: 0.4; cursor: default; }
        .ssec-pin-err { color: var(--danger); font-size: 11px; }
        .ssec-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
        .ssec-save {
          all: unset; cursor: pointer; padding: 8px 20px; border-radius: var(--radius-xs);
          background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim);
          font-family: var(--font-display); letter-spacing: var(--track-mid); font-size: 12px;
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .ssec-save:hover:not(:disabled) { background: var(--accent-faint); }
        .ssec-save:disabled { opacity: 0.4; cursor: default; }
      `}</style>

      <div class="ssec-head">
        <div class="hud-label ssec-title">Security</div>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="ssec-loading">Loading…</div>}>
        <div class="ssec-block">
          <div class="ssec-row">
            <div class="ssec-row-text">
              <span class="ssec-row-title">Require phone + fingerprint to open Jarvis</span>
              <span class="ssec-row-sub">
                Two factors: a tap on your paired phone AND its fingerprint unlock. Fails open when no
                phone is paired.
              </span>
            </div>
            <input
              type="checkbox"
              class="ssec-switch"
              checked={authLockEnabled()}
              onChange={(e) => {
                setAuthLockEnabled(e.currentTarget.checked)
                setDirty(true)
              }}
            />
          </div>
        </div>

        <div class="ssec-block">
          <div class="ssec-row-text">
            <span class="ssec-row-title">
              Unlock PIN
              <Show when={hasDesktopPin() && !clearPin()}>
                <span class="ssec-pin-badge">SET</span>
              </Show>
            </span>
            <span class="ssec-row-sub">
              A local PIN to unlock the desktop when your phone can't approve (or isn't paired). Leave
              blank to keep the current one.
            </span>
          </div>
          <div class="ssec-pin-fields">
            <input
              class="ssec-input"
              classList={{ invalid: !pinValid() }}
              type="password"
              inputmode="numeric"
              disabled={clearPin()}
              placeholder={hasDesktopPin() ? "New PIN (4–8 digits)" : "Set a PIN (4–8 digits)"}
              value={pinInput()}
              onInput={(e) => {
                setPinInput(e.currentTarget.value)
                setDirty(true)
              }}
            />
            <button
              type="button"
              class="ssec-clear-btn"
              classList={{ active: clearPin() }}
              disabled={!hasDesktopPin()}
              onClick={() => {
                setClearPin((v) => !v)
                setPinInput("")
                setDirty(true)
              }}
            >
              {clearPin() ? "Clearing…" : "Clear"}
            </button>
          </div>
          <Show when={!pinValid()}>
            <span class="ssec-pin-err">PIN must be 4–8 digits.</span>
          </Show>
        </div>

        <div class="ssec-actions">
          <button type="button" class="ssec-save" disabled={!dirty() || !pinValid() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "security", label: "Security", component: SecuritySection }
export default section
