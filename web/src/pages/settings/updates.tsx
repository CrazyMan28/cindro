// SETTINGS · UPDATES — running version (status.get) + the manual
// update.check/apply flow, plus the two auto-updater knobs NOT already owned
// by Mode & Autonomy (which has the base "Automatic updates" on/off switch):
// auto_update_apply (silent install) and auto_update_interval_hours (check
// cadence). Ported status-line semantics 1:1 from desktop/qml/SettingsPage.qml's
// onUpdateChecked/onUpdateApplied handlers so "Up to date" / "Update available
// (x.y.z)" / "Updated to x.y.z — restarting…" read the same on both frontends.
import { createSignal, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

function shortSha(sha: string): string {
  return sha && sha !== "unknown" ? sha.slice(0, 9) : sha
}

function UpdatesSection() {
  const app = useApp()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const [version, setVersion] = createSignal("")
  const [gitSha, setGitSha] = createSignal("")

  const [autoUpdateApply, setAutoUpdateApply] = createSignal(false)
  const [intervalHours, setIntervalHours] = createSignal(6)
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  const [checking, setChecking] = createSignal(false)
  const [applying, setApplying] = createSignal(false)
  const [updateBehind, setUpdateBehind] = createSignal(false)
  const [statusLine, setStatusLine] = createSignal("")
  const [statusKind, setStatusKind] = createSignal<"neutral" | "ok" | "amber">("neutral")

  const load = async () => {
    try {
      const [st, s] = await Promise.all([
        app.client.call("status.get", {}, 15000),
        app.client.call("settings.get", {}, 15000),
      ])
      setVersion(String(st.version ?? s.version ?? "unknown"))
      setGitSha(String(st.git_sha ?? s.git_sha ?? "unknown"))
      setAutoUpdateApply(s.auto_update_apply === true)
      const ih = Number(s.auto_update_interval_hours)
      setIntervalHours(Number.isFinite(ih) && ih >= 1 ? Math.round(ih) : 6)
      setError("")
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const savePrefs = async () => {
    setSaving(true)
    try {
      const patch = {
        auto_update_apply: autoUpdateApply(),
        auto_update_interval_hours: Math.max(1, Math.round(intervalHours())),
      }
      await app.client.call("settings.set", { patch }, 15000)
      setDirty(false)
      app.notify("Update preferences saved.")
    } catch (e) {
      app.notify(`Save failed: ${String(e)}`, "error")
    } finally {
      setSaving(false)
    }
  }

  const checkNow = async () => {
    if (checking()) return
    setChecking(true)
    setStatusLine("Checking for updates…")
    setStatusKind("neutral")
    try {
      const res = await app.client.call("update.check", {}, 45000)
      const behind = res.behind === true
      const latest = typeof res.latest === "string" ? res.latest : ""
      const reason = typeof res.reason === "string" ? res.reason : ""
      const v = typeof res.version === "string" ? res.version : ""
      if (v) setVersion(v)
      setUpdateBehind(behind)
      if (behind) {
        setStatusLine(`Update available (${latest.length ? latest : "newer"})`)
        setStatusKind("amber")
      } else if (reason) {
        setStatusLine(reason)
        setStatusKind("neutral")
      } else {
        setStatusLine("Up to date")
        setStatusKind("ok")
      }
    } catch (e) {
      setStatusLine(String(e))
      setStatusKind("neutral")
    } finally {
      setChecking(false)
    }
  }

  const applyNow = async () => {
    if (applying()) return
    setApplying(true)
    setStatusLine("Downloading + installing the update…")
    setStatusKind("neutral")
    try {
      const res = await app.client.call("update.apply", {}, 600000)
      const updated = res.updated === true
      const to = typeof res.to === "string" ? res.to : ""
      const reason = typeof res.reason === "string" ? res.reason : ""
      if (updated) {
        setUpdateBehind(false)
        setStatusLine(`Updated to ${to.length ? to : "latest"} — Orin is restarting…`)
        setStatusKind("ok")
        app.notify("Update applied — Orin is restarting.")
      } else {
        setStatusLine(reason.length ? reason : "No update applied")
        setStatusKind("neutral")
        app.notify(`Update not applied: ${reason || "unknown reason"}`, "warn")
      }
    } catch (e) {
      setStatusLine(String(e))
      setStatusKind("neutral")
      app.notify(`Update failed: ${String(e)}`, "error")
    } finally {
      setApplying(false)
    }
  }

  return (
    <div class="supd-page">
      <style>{`
        .supd-page { display: flex; flex-direction: column; gap: 18px; max-width: 560px; animation: supd-in var(--dur-slow) ease-out; }
        @keyframes supd-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .supd-title { color: var(--accent); font-size: 11px; }
        .supd-loading { color: var(--text-faint); font-size: 12px; }
        .supd-block {
          display: flex; flex-direction: column; gap: 12px;
          background: var(--surface-strong); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-sm); padding: 14px;
        }
        .supd-version-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .supd-version { font-family: var(--font-mono); font-size: 13px; color: var(--text); }
        .supd-sha { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }
        .supd-status { font-size: 12px; line-height: 1.5; }
        .supd-status.neutral { color: var(--text-muted); }
        .supd-status.ok { color: var(--success); }
        .supd-status.amber { color: var(--amber); }
        .supd-btn-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .supd-btn {
          all: unset; cursor: pointer; box-sizing: border-box; text-align: center; white-space: nowrap;
          padding: 8px 18px; border-radius: var(--radius-xs);
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          border: 1px solid var(--hairline-soft); color: var(--text-muted); background: var(--surface);
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .supd-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
        .supd-btn:disabled { opacity: 0.5; cursor: default; }
        .supd-btn.primary { border-color: var(--accent-dim); color: var(--accent-bright); background: var(--accent-faint); }
        .supd-btn.primary:hover:not(:disabled) { background: var(--accent-dim); }

        .supd-row { display: flex; align-items: center; gap: 14px; }
        .supd-row-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .supd-row-title { color: var(--text); font-size: 13px; }
        .supd-row-sub { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
        .supd-switch {
          appearance: none; -webkit-appearance: none;
          width: 40px; height: 22px; flex: 0 0 40px; border-radius: 999px;
          background: var(--surface-input); border: 1px solid var(--hairline-soft);
          position: relative; cursor: pointer;
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
        }
        .supd-switch::after {
          content: ""; position: absolute; top: 2px; left: 2px;
          width: 16px; height: 16px; border-radius: 50%; background: var(--text-muted);
          transition: transform var(--dur-fast) ease, background var(--dur-fast) ease;
        }
        .supd-switch:checked { background: var(--accent-dim); border-color: var(--accent); }
        .supd-switch:checked::after { transform: translateX(18px); background: var(--accent-bright); }
        .supd-interval { display: flex; align-items: center; gap: 10px; }
        .supd-interval-input {
          width: 64px; box-sizing: border-box; background: var(--surface-input);
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
          color: var(--text); padding: 7px 9px; font-family: var(--font-mono); font-size: 13px;
          transition: border-color var(--dur-fast) ease;
        }
        .supd-interval-input:focus { outline: none; border-color: var(--accent-dim); }
        .supd-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
        .supd-save {
          all: unset; cursor: pointer; padding: 8px 20px; border-radius: var(--radius-xs);
          background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim);
          font-family: var(--font-display); letter-spacing: var(--track-mid); font-size: 12px;
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .supd-save:hover:not(:disabled) { background: var(--accent-faint); }
        .supd-save:disabled { opacity: 0.4; cursor: default; }
        .supd-note { color: var(--text-faint); font-size: 11px; line-height: 1.5; }
      `}</style>

      <div class="supd-head">
        <div class="hud-label supd-title">Updates</div>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="supd-loading">Loading…</div>}>
        <div class="supd-block">
          <div class="supd-version-row">
            <span class="supd-version">Current version: {version() || "unknown"}</span>
            <span class="supd-sha">({shortSha(gitSha())})</span>
          </div>

          <Show when={statusLine()}>
            <div
              class="supd-status"
              classList={{ neutral: statusKind() === "neutral", ok: statusKind() === "ok", amber: statusKind() === "amber" }}
            >
              {statusLine()}
            </div>
          </Show>

          <div class="supd-btn-row">
            <button type="button" class="supd-btn" disabled={!app.client.connected || checking() || applying()} onClick={() => void checkNow()}>
              {checking() ? "Checking…" : "Check for updates"}
            </button>
            <Show when={updateBehind()}>
              <button type="button" class="supd-btn primary" disabled={!app.client.connected || applying()} onClick={() => void applyNow()}>
                {applying() ? "Updating…" : "Update now"}
              </button>
            </Show>
          </div>
        </div>

        <div class="supd-block">
          <div class="supd-row">
            <div class="supd-row-text">
              <span class="supd-row-title">Install updates automatically</span>
              <span class="supd-row-sub">
                When a new release is found, download and install it without asking. Orin restarts itself
                on Windows; on Linux the update takes effect the next time you launch. Only runs when
                automatic updates (Mode &amp; Autonomy) are on.
              </span>
            </div>
            <input
              type="checkbox"
              class="supd-switch"
              checked={autoUpdateApply()}
              onChange={(e) => {
                setAutoUpdateApply(e.currentTarget.checked)
                setDirty(true)
              }}
            />
          </div>

          <div class="supd-row">
            <div class="supd-row-text">
              <span class="supd-row-title">Check cadence</span>
              <span class="supd-row-sub">How often Orin checks for a new release in the background.</span>
            </div>
            <div class="supd-interval">
              <input
                type="number"
                min="1"
                class="supd-interval-input"
                value={intervalHours()}
                onInput={(e) => {
                  const n = Number(e.currentTarget.value)
                  setIntervalHours(Number.isFinite(n) && n >= 1 ? n : 1)
                  setDirty(true)
                }}
              />
              <span class="supd-note">hours</span>
            </div>
          </div>

          <div class="supd-actions">
            <button type="button" class="supd-save" disabled={!dirty() || saving()} onClick={() => void savePrefs()}>
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "updates", label: "Updates", component: UpdatesSection }
export default section
