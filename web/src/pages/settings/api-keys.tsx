// SETTINGS / API KEYS — masked credential inputs for every provider
// core/src/SettingsStore.cpp's providerKeys() recognizes (codex/claude/
// openai/anthropic/mistral/ollama/gemini/xai/deepseek). settings.get returns
// only booleans (api_keys_set — never the raw value); settings.set's patch is
// WRITE-ONLY (patch.api_keys: {provider: newValue}) and only ever sent for
// providers the user actually typed into, so an untouched field can never
// clobber a saved key. An emptied field IS a deliberate clear (setApiKey
// removes the key when value is empty) — mirrors desktop/qml/
// SettingsPage.qml's "// API KEYS" Repeater 1:1 (same provider list/hints).
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

interface ProviderMeta {
  id: string
  label: string
  hint: string
}

// Same order/copy as SettingsPage.qml's `property var providers`.
const PROVIDERS: ProviderMeta[] = [
  { id: "codex", label: "Codex CLI", hint: "OpenAI key used by the Codex brain" },
  { id: "claude", label: "Claude CLI", hint: "Anthropic key used by the Claude brain" },
  { id: "openai", label: "OpenAI API", hint: "Direct OpenAI API (api brain)" },
  { id: "anthropic", label: "Anthropic API", hint: "Direct Anthropic API (api brain)" },
  { id: "mistral", label: "Mistral API", hint: "Direct Mistral API (api brain) — mistral-large/small-latest" },
  { id: "ollama", label: "Ollama", hint: "Local Ollama endpoint / token (optional)" },
  {
    id: "gemini",
    label: "Google Gemini",
    hint: "Gemini API key (api brain, gemini-* models). Several keys? comma-separate them — Cindro rotates on rate limits",
  },
  { id: "xai", label: "xAI Grok", hint: "xAI API key (api brain, grok-* models)" },
  { id: "deepseek", label: "DeepSeek", hint: "DeepSeek API key (api brain, deepseek-* models)" },
]

const CSS = `
.setk-page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
.setk-section-title { font-size: 11px; letter-spacing: var(--track-mid); color: var(--accent); margin-bottom: 4px; }
.setk-subtitle { color: var(--text-faint); font-size: 12px; line-height: 1.4; margin-bottom: 8px; }
.setk-empty { color: var(--text-faint); font-size: 12px; }
.setk-error { color: var(--danger); font-size: 12px; }

.setk-row {
  background: var(--surface-strong); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
.setk-row-head { display: flex; align-items: center; gap: 10px; }
.setk-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.setk-row-label { color: var(--text); font-size: 14px; font-weight: 600; }
.setk-row-hint { color: var(--text-faint); font-size: 12px; }
.setk-badge {
  flex-shrink: 0; border-radius: 7px; padding: 3px 10px; font-size: 11px; letter-spacing: 0.4px;
  border: 1px solid var(--hairline);
  color: var(--text-faint);
}
.setk-badge.set { border-color: var(--success); color: var(--success); }

.setk-input-row { display: flex; gap: 8px; }
.setk-input {
  flex: 1; min-width: 0; background: var(--surface-input); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-xs); color: var(--text); font-family: var(--font-mono); font-size: 13px;
  padding: 8px 10px; transition: border-color var(--dur-fast) ease;
}
.setk-input:focus { outline: none; border-color: var(--accent-dim); }
.setk-input.pending { border-color: var(--amber); }
.setk-clear-btn {
  all: unset; cursor: pointer; padding: 6px 12px; border-radius: var(--radius-xs);
  font-family: var(--font-display); font-size: 10px; letter-spacing: var(--track-mid);
  color: var(--text-faint); border: 1px solid var(--hairline-soft); background: var(--surface); white-space: nowrap;
}
.setk-clear-btn:hover { color: var(--danger); border-color: var(--danger-dim); }
.setk-pending-note { color: var(--amber); font-size: 11px; }

.setk-save-row {
  position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; justify-content: flex-end;
  padding-top: 8px; background: linear-gradient(180deg, transparent 0%, var(--surface) 40%);
}
.setk-dirty-note { color: var(--amber); font-size: 11px; margin-right: auto; }
.setk-btn {
  all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
  padding: 9px 18px; border-radius: var(--radius-xs);
  font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
  border: 1px solid var(--accent-dim); color: var(--accent-bright);
  background: var(--accent-faint); transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
}
.setk-btn:hover:not(:disabled) { background: var(--accent-dim); }
.setk-btn:disabled { opacity: 0.4; cursor: default; }
`

function ApiKeysSettings() {
  const app = useApp()
  let alive = true
  onCleanup(() => {
    alive = false
  })

  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal("")
  const [saveError, setSaveError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [keysSet, setKeysSet] = createSignal<Record<string, boolean>>({})
  // Only providers the user actually edited land in here — untouched ones
  // are never sent, so they can never be accidentally cleared.
  const [pending, setPending] = createSignal<Record<string, string>>({})

  const dirty = createMemo(() => Object.keys(pending()).length > 0)

  const load = async () => {
    setLoading(true)
    setLoadError("")
    try {
      const s = await app.client.call("settings.get", {}, 15000)
      if (!alive) return
      setKeysSet((s.api_keys_set ?? {}) as Record<string, boolean>)
      setPending({})
    } catch (e) {
      if (alive) setLoadError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void load()
  })

  const onInput = (id: string, value: string) => {
    setPending((p) => ({ ...p, [id]: value }))
  }

  const onClear = (id: string) => {
    setPending((p) => ({ ...p, [id]: "" }))
  }

  const undo = (id: string) => {
    setPending((p) => {
      const next = { ...p }
      delete next[id]
      return next
    })
  }

  const save = async () => {
    const patchKeys = pending()
    if (saving() || Object.keys(patchKeys).length === 0) return
    setSaving(true)
    setSaveError("")
    try {
      await app.client.call("settings.set", { patch: { api_keys: patchKeys } }, 20000)
      if (!alive) return
      // Re-derive keysSet locally rather than a full reload: cleared (empty)
      // -> false, non-empty -> true. A follow-up settings.get would also work
      // but this is instant and avoids a network round-trip on every save.
      setKeysSet((prev) => {
        const next = { ...prev }
        for (const id of Object.keys(patchKeys)) next[id] = patchKeys[id].trim().length > 0
        return next
      })
      setPending({})
      app.notify("API keys saved.", "info")
    } catch (e) {
      if (alive) setSaveError(String(e))
      app.notify(`Failed to save API keys: ${String(e)}`, "error")
    } finally {
      if (alive) setSaving(false)
    }
  }

  return (
    <div class="setk-page">
      <style>{CSS}</style>

      <div>
        <div class="hud-label setk-section-title">// API KEYS</div>
        <div class="setk-subtitle">
          Keys are write-only — the daemon never sends a saved value back, only whether one is set. Leave a
          field untouched to keep the saved key; type in it to replace it; clear it and save to remove it.
        </div>
      </div>

      <Show when={loadError()}>
        <div class="setk-error">⚠ {loadError()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="setk-empty">Loading API keys…</div>}>
        <For each={PROVIDERS}>
          {(p) => {
            const isSet = () => keysSet()[p.id] === true
            const isPending = () => Object.prototype.hasOwnProperty.call(pending(), p.id)
            const willClear = () => isPending() && pending()[p.id].trim().length === 0
            return (
              <div class="setk-row">
                <div class="setk-row-head">
                  <div class="setk-row-text">
                    <span class="setk-row-label">{p.label}</span>
                    <span class="setk-row-hint">{p.hint}</span>
                  </div>
                  <span class="setk-badge" classList={{ set: isSet() }}>
                    {isSet() ? "saved" : "empty"}
                  </span>
                </div>
                <div class="setk-input-row">
                  <input
                    type="password"
                    autocomplete="off"
                    class="setk-input"
                    classList={{ pending: isPending() }}
                    placeholder={isSet() ? "•••••••••• (set — type to replace)" : "Paste API key…"}
                    value={pending()[p.id] ?? ""}
                    onInput={(e) => onInput(p.id, e.currentTarget.value)}
                  />
                  <Show when={isPending()} fallback={<button type="button" class="setk-clear-btn" disabled={!isSet()} onClick={() => onClear(p.id)}>Clear</button>}>
                    <button type="button" class="setk-clear-btn" onClick={() => undo(p.id)}>
                      Undo
                    </button>
                  </Show>
                </div>
                <Show when={willClear()}>
                  <div class="setk-pending-note">will clear this key on Save</div>
                </Show>
              </div>
            )
          }}
        </For>

        <Show when={saveError()}>
          <div class="setk-error">⚠ {saveError()}</div>
        </Show>

        <div class="setk-save-row">
          <Show when={dirty()}>
            <span class="setk-dirty-note">{Object.keys(pending()).length} key(s) changed</span>
          </Show>
          <button type="button" class="setk-btn" disabled={!dirty() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "api-keys", label: "API Keys", component: ApiKeysSettings }
export default section
