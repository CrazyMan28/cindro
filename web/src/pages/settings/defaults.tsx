// SETTINGS · DEFAULTS — default brain + default model. Ported intent from
// desktop/qml/SettingsPage.qml's "// DEFAULTS" card: brain options come from
// settings.get's available_brains (codex/claude only offered when actually
// installed, "api" always offered), model options from models_by_brain[brain]
// with a free-text fallback when the daemon has no list for that brain.
import { createEffect, createSignal, For, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

function DefaultsSection() {
  const app = useApp()
  const [brainOptions, setBrainOptions] = createSignal<string[]>([])
  const [modelsByBrain, setModelsByBrain] = createSignal<Record<string, string[]>>({})
  const [canDrive, setCanDrive] = createSignal<Record<string, boolean>>({})
  const [brain, setBrain] = createSignal("")
  const [model, setModel] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [error, setError] = createSignal("")

  onMount(async () => {
    try {
      const res = await app.client.call("settings.get", {}, 15000)
      const avail = (res.available_brains ?? {}) as Record<string, boolean>
      const opts: string[] = []
      if (avail.codex === true) opts.push("codex")
      if (avail.claude === true) opts.push("claude")
      opts.push("api")
      setBrainOptions(opts)
      setModelsByBrain((res.models_by_brain ?? {}) as Record<string, string[]>)
      setCanDrive((res.can_drive ?? {}) as Record<string, boolean>)

      const savedBrain = typeof res.default_brain === "string" ? res.default_brain : ""
      setBrain(opts.includes(savedBrain) ? savedBrain : opts[0] ?? "")
      setModel(typeof res.default_model === "string" ? res.default_model : "")
      setError("")
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  })

  // Whether the daemon actually provided a model list for the current brain
  // — drives the select-vs-free-text-input choice below. Deliberately NOT
  // based on currentModels().length: that also counts the free-text fallback
  // (which echoes back whatever the user just typed), so using it as the
  // toggle condition would flip the input to a <select> the instant the user
  // types a first character, unmounting the input mid-edit and dropping
  // every keystroke after it.
  const hasModelList = () => {
    const list = modelsByBrain()[brain()]
    return Boolean(list && list.length)
  }

  // Options for the currently chosen brain; falls back to the saved model
  // itself so a value the daemon doesn't have a list for still shows up.
  const currentModels = () => {
    const list = modelsByBrain()[brain()]
    if (list && list.length) return list
    const m = model().trim()
    return m.length ? [m] : []
  }

  createEffect(() => {
    // Keep the model selector honest when the brain changes — if the saved
    // model isn't in this brain's list, fall back to the first offered one.
    const list = currentModels()
    if (list.length && !list.includes(model())) setModel(list[0])
  })

  const driveHint = () => {
    const b = brain()
    if (!b) return null
    if (canDrive()[b] === true) return { ok: true, text: `✓ ${b} can drive the computer-use desktop` }
    if (b === "api") return { ok: false, text: "⚠ api can't drive without an OpenAI/Mistral key — pick codex or claude, or set a key in API Keys" }
    return { ok: false, text: `⚠ ${b} can't drive the computer-use desktop headless` }
  }

  const save = async () => {
    setSaving(true)
    try {
      const patch = { default_brain: brain(), default_model: model() }
      await app.client.call("settings.set", { patch }, 15000)
      setDirty(false)
      app.notify("Defaults saved.")
    } catch (e) {
      app.notify(`Save failed: ${String(e)}`, "error")
    } finally {
      setSaving(false)
    }
  }

  const hint = () => driveHint()

  return (
    <div class="sdf-form">
      <style>{`
        .sdf-form { display: flex; flex-direction: column; gap: 16px; max-width: 480px; animation: sdf-in var(--dur-slow) ease-out; }
        @keyframes sdf-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .sdf-title { color: var(--accent); font-size: 11px; }
        .sdf-desc { color: var(--text-faint); font-size: 12px; margin: 6px 0 0; line-height: 1.5; }
        .sdf-row { display: flex; gap: 14px; }
        .sdf-field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
        .sdf-field label { color: var(--text-muted); font-size: 12px; }
        .sdf-select, .sdf-input {
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
        .sdf-select:focus, .sdf-input:focus { outline: none; border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-faint); }
        .sdf-select option { background: var(--surface-strong); color: var(--text); }
        .sdf-hint { font-size: 11px; line-height: 1.5; }
        .sdf-hint.ok { color: var(--success); }
        .sdf-hint.warn { color: var(--amber); }
        .sdf-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
        .sdf-save {
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
        .sdf-save:hover:not(:disabled) { background: var(--accent-faint); }
        .sdf-save:disabled { opacity: 0.4; cursor: default; }
        .sdf-loading { color: var(--text-faint); font-size: 12px; }
      `}</style>

      <div class="sdf-head">
        <div class="hud-label sdf-title">Defaults</div>
        <p class="sdf-desc">Which brain and model new sessions start with.</p>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="sdf-loading">Loading…</div>}>
        <div class="sdf-row">
          <div class="sdf-field">
            <label for="sdf-brain">Default brain</label>
            <select
              id="sdf-brain"
              class="sdf-select"
              value={brain()}
              onChange={(e) => {
                setBrain(e.currentTarget.value)
                setDirty(true)
              }}
            >
              <For each={brainOptions()}>{(b) => <option value={b}>{b}</option>}</For>
            </select>
          </div>
          <div class="sdf-field">
            <label for="sdf-model">Default model</label>
            <Show
              when={hasModelList()}
              fallback={
                <input
                  id="sdf-model"
                  class="sdf-input"
                  type="text"
                  placeholder="model id"
                  value={model()}
                  onInput={(e) => {
                    setModel(e.currentTarget.value)
                    setDirty(true)
                  }}
                />
              }
            >
              <select
                id="sdf-model"
                class="sdf-select"
                value={model()}
                onChange={(e) => {
                  setModel(e.currentTarget.value)
                  setDirty(true)
                }}
              >
                <For each={currentModels()}>{(m) => <option value={m}>{m}</option>}</For>
              </select>
            </Show>
          </div>
        </div>

        <Show when={hint()}>{(h) => <div class={`sdf-hint ${h().ok ? "ok" : "warn"}`}>{h().text}</div>}</Show>

        <div class="sdf-actions">
          <button type="button" class="sdf-save" disabled={!dirty() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "defaults", label: "Defaults", component: DefaultsSection }
export default section
