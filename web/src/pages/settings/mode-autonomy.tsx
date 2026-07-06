// SETTINGS · MODE & AUTONOMY — permission_level (how cautious Jarvis is
// before risky actions) + the automatic-update-check toggle. Ported intent
// from desktop/qml/SettingsPage.qml's "// PERMISSIONS" segmented selector and
// the first switch of its "// UPDATES" card (auto_update_apply / the manual
// "check now" flow live in the separate Updates section, not here).
import { createSignal, For, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

type PermissionLevel = "high" | "medium" | "low"

const LEVELS: Array<{ key: PermissionLevel; name: string; sub: string }> = [
  { key: "high", name: "Cautious", sub: "Ask before HIGH + MEDIUM" },
  { key: "medium", name: "Balanced", sub: "Ask before HIGH only" },
  { key: "low", name: "Autonomous", sub: "Only confirm the worst" },
]

function ModeAutonomySection() {
  const app = useApp()
  const [level, setLevel] = createSignal<PermissionLevel>("medium")
  const [autoUpdate, setAutoUpdate] = createSignal(true)
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [error, setError] = createSignal("")

  onMount(async () => {
    try {
      const res = await app.client.call("settings.get", {}, 15000)
      const p = res.permission_level
      setLevel(p === "high" || p === "low" ? p : "medium")
      setAutoUpdate(res.auto_update === undefined ? true : res.auto_update === true)
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
      const patch = { permission_level: level(), auto_update: autoUpdate() }
      await app.client.call("settings.set", { patch }, 15000)
      setDirty(false)
      app.notify("Mode & autonomy saved.")
    } catch (e) {
      app.notify(`Save failed: ${String(e)}`, "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="sma-form">
      <style>{`
        .sma-form { display: flex; flex-direction: column; gap: 18px; max-width: 520px; animation: sma-in var(--dur-slow) ease-out; }
        @keyframes sma-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .sma-title { color: var(--accent); font-size: 11px; }
        .sma-desc { color: var(--text); font-size: 13px; margin: 6px 0 0; line-height: 1.5; }
        .sma-sub { color: var(--text-faint); font-size: 11px; margin: 4px 0 0; line-height: 1.5; }
        .sma-segments { display: flex; gap: 8px; margin-top: 12px; }
        .sma-seg {
          all: unset;
          box-sizing: border-box;
          flex: 1;
          cursor: pointer;
          text-align: center;
          padding: 10px 6px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--hairline-soft);
          background: var(--surface);
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, transform var(--dur-fast) ease;
        }
        .sma-seg:hover { border-color: var(--accent-dim); background: var(--surface-strong); }
        .sma-seg.active {
          background: var(--accent-dim);
          border-color: var(--accent);
          box-shadow: 0 0 14px -4px var(--accent-glow);
        }
        .sma-seg-name {
          display: block;
          font-family: var(--font-display);
          font-size: 12px;
          font-weight: 600;
          letter-spacing: var(--track-mid);
          color: var(--text);
        }
        .sma-seg.active .sma-seg-name { color: var(--accent-bright); }
        .sma-seg-sub { display: block; margin-top: 2px; font-size: 10px; color: var(--text-muted); }
        .sma-footnote { color: var(--text-faint); font-size: 10px; margin-top: 4px; line-height: 1.5; }
        .sma-divider { height: 1px; background: var(--hairline-soft); margin: 4px 0; }
        .sma-toggle-row { display: flex; align-items: center; gap: 14px; }
        .sma-toggle-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        .sma-toggle-title { color: var(--text); font-size: 13px; }
        .sma-toggle-sub { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
        .sma-switch {
          appearance: none;
          -webkit-appearance: none;
          width: 40px;
          height: 22px;
          flex: 0 0 40px;
          border-radius: 999px;
          background: var(--surface-input);
          border: 1px solid var(--hairline-soft);
          position: relative;
          cursor: pointer;
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
        }
        .sma-switch::after {
          content: "";
          position: absolute;
          top: 2px; left: 2px;
          width: 16px; height: 16px;
          border-radius: 50%;
          background: var(--text-muted);
          transition: transform var(--dur-fast) ease, background var(--dur-fast) ease;
        }
        .sma-switch:checked { background: var(--accent-dim); border-color: var(--accent); }
        .sma-switch:checked::after { transform: translateX(18px); background: var(--accent-bright); }
        .sma-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
        .sma-save {
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
        .sma-save:hover:not(:disabled) { background: var(--accent-faint); }
        .sma-save:disabled { opacity: 0.4; cursor: default; }
        .sma-loading { color: var(--text-faint); font-size: 12px; }
      `}</style>

      <div class="sma-head">
        <div class="hud-label sma-title">Mode &amp; Autonomy</div>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="sma-loading">Loading…</div>}>
        <div>
          <p class="sma-desc">How cautious Jarvis is before risky actions</p>
          <p class="sma-sub">
            Tools are auto-ranked by risk. HIGH = irreversible / touches your real world (delete files, destructive
            shell, your real screen, ssh, installs, sending things out). MEDIUM = reversible / scoped to the agent
            (edit files, agent desktop, memory). LOW = read-only (read, list, search, render).
          </p>
          <div class="sma-segments">
            <For each={LEVELS}>
              {(seg) => (
                <button
                  type="button"
                  class="sma-seg"
                  classList={{ active: level() === seg.key }}
                  onClick={() => {
                    setLevel(seg.key)
                    setDirty(true)
                  }}
                >
                  <span class="sma-seg-name">{seg.name.toUpperCase()}</span>
                  <span class="sma-seg-sub">{seg.sub}</span>
                </button>
              )}
            </For>
          </div>
          <p class="sma-footnote">
            Jarvis calls ask_user (tap to approve on your phone or here) before any action above your chosen line.
            This is a policy, not the sandbox — capability limits still apply.
          </p>
        </div>

        <div class="sma-divider" />

        <div class="sma-toggle-row">
          <div class="sma-toggle-text">
            <span class="sma-toggle-title">Automatic updates</span>
            <span class="sma-toggle-sub">Check for new releases periodically and notify you when an update is ready.</span>
          </div>
          <input
            type="checkbox"
            class="sma-switch"
            checked={autoUpdate()}
            onChange={(e) => {
              setAutoUpdate(e.currentTarget.checked)
              setDirty(true)
            }}
          />
        </div>

        <div class="sma-actions">
          <button type="button" class="sma-save" disabled={!dirty() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = {
  key: "mode-autonomy",
  label: "Mode & Autonomy",
  component: ModeAutonomySection,
}
export default section
