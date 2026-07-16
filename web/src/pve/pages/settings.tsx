// AI Settings — configures the Cindro brain that answers in chat and drives
// the operator tools: which brain is the default (a local CLI, a locally
// running Ollama, or a cloud API), which model that brain should default to,
// and which provider API keys Cindro has on hand. This is the fix for "there
// is no UI to hand Cindro a Mistral/OpenAI/etc key, or to pick codex/claude/
// local instead" — before this page, that only lived in the desktop app's
// SettingsPage.qml.
//
// Talks directly to the co-located jarvisd over the dashboard's own
// same-origin bridge (proxmox-mcp/proxmox_mcp/dashboard_server.py):
//   GET  /_jarvis/settings  -> { settings, models }   (settings.get + model.list)
//   POST /_jarvis/settings  <- settings.set patch verbatim, e.g.
//        { api_keys: { mistral: "..." }, default_brain: "api", default_model: "..." }
// via plain fetch(credentials:"include") — deliberately NOT through
// CindroClient/proxmoxop.tool, so this page keeps working even if the
// operator chat socket is disconnected, and so a key never has to cross the
// RPC event bus. Keys are write-only: the server never echoes a raw value
// back, only booleans in settings.api_keys_set — so every provider card
// starts blank and shows "Configured"/"Not set" from that flag alone.
//
// NOTE ON "toggle local CLI brains (codex, claude, ollama)": jarvisd only has
// THREE brains (codex, claude, api — see daemon/src/ControlServer.cpp's
// brainAvailability()/modelsForBrain()); Ollama is not a fourth brain, it's a
// *model source* reached through the "api" brain (its live tags get merged
// into the api model list, and its static catalog entries are the only ones
// with a ":" in them, e.g. "qwen2.5:3b" — every cloud model id in the static
// catalog is colon-free). So "codex / claude / ollama" is presented here as
// four mutually-exclusive brain cards — Codex CLI, Claude CLI, Ollama
// (Local), Cloud API — where the last two both persist as default_brain:
// "api" and differ only in which half of that brain's model catalog (colon
// vs. no colon) they default the model field to. Self-registers per
// router.ts's PageDef contract; zero props.
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"

import type { PageDef } from "../router"

const SETTINGS_URL = "/_jarvis/settings"

// --- wire types (loose — jarvisd's settings.get carries dozens of fields
// this page doesn't touch; only what's read below is typed) -----------------

type JarvisSettingsBlob = {
  default_brain?: string
  default_model?: string
  api_keys_set?: Record<string, boolean>
  available_brains?: Record<string, boolean>
  models_by_brain?: Record<string, string[]>
  [key: string]: unknown
}

function friendlyError(e: string): string {
  if (e === "unauthorized") return "Your session has expired — reload the dashboard and sign in again."
  if (e === "jarvisd_unreachable") return "Cindro's backend isn't reachable right now — make sure it's running and try again."
  if (e === "jarvisd_error") return "Cindro's backend rejected that request."
  if (e === "bad_request") return "The dashboard sent a malformed request — this is a bug, please report it."
  return e || "something went wrong"
}

async function fetchJarvisSettings(): Promise<
  { ok: true; settings: JarvisSettingsBlob; models: string[] } | { ok: false; error: string }
> {
  try {
    const res = await fetch(SETTINGS_URL, { credentials: "include" })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) return { ok: false, error: friendlyError(json?.error ?? `load failed (${res.status})`) }
    const settings = json && typeof json.settings === "object" && json.settings ? json.settings : {}
    // The model catalog is returned SEPARATELY as model.list -> { brain, models:[...] };
    // the settings blob itself has no model list. Surface the flat id list so the
    // Default-model dropdown actually has options (was empty -> "no Mistral model").
    const models = Array.isArray(json?.models?.models) ? (json.models.models as string[]) : []
    return { ok: true, settings, models }
  } catch (e: any) {
    return { ok: false, error: e?.message ? `network error: ${e.message}` : "network error" }
  }
}

async function postJarvisSettings(patch: Record<string, unknown>): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const res = await fetch(SETTINGS_URL, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) return { ok: false, error: friendlyError(json?.error ?? `save failed (${res.status})`) }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ? `network error: ${e.message}` : "network error" }
  }
}

// --- provider catalog ---------------------------------------------------

type ProviderMeta = { id: string; label: string; glyph: string; hint: string }

const PROVIDERS: ProviderMeta[] = [
  { id: "mistral", label: "Mistral", glyph: "◆", hint: "The recommended default for a CLI-less setup — mistral-large / mistral-small." },
  { id: "anthropic", label: "Anthropic", glyph: "✦", hint: "Claude models via a direct API key (separate from the Claude CLI login below)." },
  { id: "openai", label: "OpenAI", glyph: "◎", hint: "GPT models, reached through the Cloud API brain." },
  { id: "xai", label: "xAI", glyph: "✕", hint: "Grok models." },
  { id: "deepseek", label: "DeepSeek", glyph: "▲", hint: "DeepSeek chat models." },
  { id: "gemini", label: "Google Gemini", glyph: "◈", hint: "Gemini models — also powers video-understanding." },
]

const CLOUD_KEY_PROVIDERS = PROVIDERS.map((p) => p.id)

// --- brain catalog ---------------------------------------------------------

type BrainChoice = "codex" | "claude" | "api-ollama" | "api-cloud"

const BRAIN_CARDS: Array<{ id: BrainChoice; label: string; sub: string; glyph: string }> = [
  { id: "codex", label: "Codex CLI", sub: "OpenAI's Codex CLI, run locally on this machine.", glyph: "⌘" },
  { id: "claude", label: "Claude CLI", sub: "The Claude Code CLI, run locally on this machine.", glyph: "✳" },
  { id: "api-ollama", label: "Ollama (Local)", sub: "Local models served by a locally running Ollama instance — no key needed.", glyph: "◉" },
  { id: "api-cloud", label: "Cloud API", sub: "Direct calls to a provider below using a pasted API key.", glyph: "☁" },
]

function effectiveBrain(choice: BrainChoice): string {
  return choice === "codex" || choice === "claude" ? choice : "api"
}

function isOllamaModel(model: string): boolean {
  return model.includes(":")
}

function optionsForChoice(choice: BrainChoice, modelsByBrain: Record<string, string[]>): string[] {
  if (choice === "codex") return modelsByBrain.codex ?? []
  if (choice === "claude") return modelsByBrain.claude ?? []
  const apiModels = modelsByBrain.api ?? []
  return choice === "api-ollama" ? apiModels.filter(isOllamaModel) : apiModels.filter((m) => !isOllamaModel(m))
}

// --- small presentational pieces -------------------------------------------

type AvailState = "ok" | "warn" | "neutral"

const BrainCard: Component<{
  def: (typeof BRAIN_CARDS)[number]
  selected: boolean
  state: AvailState
  stateLabel: string
  index: number
  onSelect: () => void
}> = (props) => (
  <div
    role="button"
    tabIndex={0}
    class="cx-brain-card cx-fade-in"
    classList={{ selected: props.selected }}
    style={{ "animation-delay": `${props.index * 60}ms` }}
    onClick={props.onSelect}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        props.onSelect()
      }
    }}
  >
    <div class="cx-brain-card-head">
      <span class="cx-brain-glyph">{props.def.glyph}</span>
      <span class="cx-brain-label">{props.def.label}</span>
      <span class="cx-brain-toggle" classList={{ on: props.selected }} aria-hidden="true">
        <span class="cx-brain-toggle-thumb" />
      </span>
    </div>
    <div class="cx-brain-sub">{props.def.sub}</div>
    <div class="cx-brain-avail" data-state={props.state}>
      <span class="cx-brain-avail-dot" />
      {props.stateLabel}
    </div>
  </div>
)

const ProviderCard: Component<{
  meta: ProviderMeta
  configured: boolean
  index: number
  onSaved: () => void
}> = (props) => {
  const [value, setValue] = createSignal("")
  const [reveal, setReveal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [flash, setFlash] = createSignal<"ok" | "err" | "">("")
  const [err, setErr] = createSignal("")

  let flashTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(flashTimer))

  const commit = async (next: string) => {
    if (busy()) return
    setBusy(true)
    setErr("")
    const r = await postJarvisSettings({ api_keys: { [props.meta.id]: next } })
    setBusy(false)
    clearTimeout(flashTimer)
    if (!r.ok) {
      setErr(r.error)
      setFlash("err")
      flashTimer = setTimeout(() => setFlash(""), 3200)
      return
    }
    setValue("")
    setReveal(false)
    setFlash("ok")
    flashTimer = setTimeout(() => setFlash(""), 2200)
    props.onSaved()
  }

  const save = () => {
    const v = value().trim()
    if (!v) return
    void commit(v)
  }

  return (
    <div
      class="cx-provider-card cx-fade-in"
      classList={{ configured: props.configured }}
      style={{ "animation-delay": `${props.index * 55}ms` }}
    >
      <div class="cx-provider-head">
        <span class="cx-provider-glyph">{props.meta.glyph}</span>
        <div class="cx-provider-headtext">
          <div class="cx-provider-label">{props.meta.label}</div>
          <div class="cx-provider-hint">{props.meta.hint}</div>
        </div>
        <span class="cx-pill" classList={{ "cx-pill-ok": props.configured }}>
          <Show when={props.configured}>
            <span class="cx-pill-dot" />
          </Show>
          {props.configured ? "Configured" : "Not set"}
        </span>
      </div>

      <div class="cx-provider-row">
        <div class="cx-provider-input-wrap">
          <input
            class="cx-input"
            type={reveal() ? "text" : "password"}
            autocomplete="off"
            spellcheck={false}
            placeholder={props.configured ? "•••••••••••• (paste to replace)" : "Paste API key…"}
            value={value()}
            disabled={busy()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save()
            }}
          />
          <button
            type="button"
            class="cx-provider-eye"
            tabIndex={-1}
            disabled={!value()}
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal() ? "Hide key" : "Show key"}
          >
            {reveal() ? "◎" : "◉"}
          </button>
        </div>
        <button type="button" class="cx-btn cx-btn-primary cx-btn-sm" disabled={busy() || !value().trim()} onClick={save}>
          <Show when={busy()} fallback="Save">
            <span class="cx-spinner" />
          </Show>
        </button>
        <Show when={props.configured}>
          <button
            type="button"
            class="cx-btn cx-btn-ghost cx-btn-sm cx-btn-danger"
            disabled={busy()}
            onClick={() => void commit("")}
          >
            Clear
          </button>
        </Show>
      </div>

      <Show when={flash() === "ok"}>
        <div class="cx-provider-flash ok">✓ Saved — key stored, never sent back to the browser.</div>
      </Show>
      <Show when={flash() === "err"}>
        <div class="cx-provider-flash err">{err() || "Save failed"}</div>
      </Show>
    </div>
  )
}

// --- page --------------------------------------------------------------------

const SettingsPage: Component = () => {
  const [loading, setLoading] = createSignal(true)
  const [loadErr, setLoadErr] = createSignal("")
  const [modelsByBrain, setModelsByBrain] = createSignal<Record<string, string[]>>({})
  const [availableBrains, setAvailableBrains] = createSignal<Record<string, boolean>>({})
  const [apiKeysSet, setApiKeysSet] = createSignal<Record<string, boolean>>({})

  const [brainChoice, setBrainChoice] = createSignal<BrainChoice>("api-cloud")
  const [defaultModel, setDefaultModel] = createSignal("")
  const [brainSaving, setBrainSaving] = createSignal(false)
  const [brainSaved, setBrainSaved] = createSignal(false)
  const [brainErr, setBrainErr] = createSignal("")
  let brainSavedTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(brainSavedTimer))

  const load = async () => {
    setLoading(true)
    setLoadErr("")
    const r = await fetchJarvisSettings()
    if (!r.ok) {
      setLoadErr(r.error)
      setLoading(false)
      return
    }
    const s = r.settings
    // Feed the model.list catalog into the api brain's option list (the flat ids
    // are all api-brain models; optionsForChoice splits cloud vs ollama by the
    // ":" in the id). Falls back to any models_by_brain the daemon might send.
    const merged: Record<string, string[]> = { ...(s.models_by_brain ?? {}) }
    if (r.models.length) merged.api = r.models
    setModelsByBrain(merged)
    setAvailableBrains(s.available_brains ?? {})
    setApiKeysSet(s.api_keys_set ?? {})

    const db = String(s.default_brain ?? "api")
    const dm = String(s.default_model ?? "")
    setDefaultModel(dm)
    if (db === "codex" || db === "claude") setBrainChoice(db)
    else setBrainChoice(isOllamaModel(dm) ? "api-ollama" : "api-cloud")

    setLoading(false)
  }

  onMount(load)

  const refreshApiKeysOnly = async () => {
    const r = await fetchJarvisSettings()
    if (r.ok) setApiKeysSet(r.settings.api_keys_set ?? {})
  }

  const anyCloudKeySet = createMemo(() => CLOUD_KEY_PROVIDERS.some((p) => apiKeysSet()[p] === true))

  const modelOptions = createMemo(() => optionsForChoice(brainChoice(), modelsByBrain()))

  const pickBrain = (choice: BrainChoice) => {
    if (choice === brainChoice()) return
    setBrainChoice(choice)
    setBrainSaved(false)
    setBrainErr("")
    const opts = optionsForChoice(choice, modelsByBrain())
    if (!opts.includes(defaultModel())) setDefaultModel(opts[0] ?? "")
  }

  const brainState = (id: BrainChoice): AvailState => {
    if (id === "codex") return availableBrains().codex ? "ok" : "warn"
    if (id === "claude") return availableBrains().claude ? "ok" : "warn"
    if (id === "api-cloud") return anyCloudKeySet() ? "ok" : "warn"
    return "neutral"
  }
  const brainStateLabel = (id: BrainChoice): string => {
    if (id === "codex") return availableBrains().codex ? "codex CLI found on PATH" : "codex CLI not found on PATH"
    if (id === "claude") return availableBrains().claude ? "claude CLI found on PATH" : "claude CLI not found on PATH"
    if (id === "api-cloud") return anyCloudKeySet() ? "a provider key is set below" : "add a provider key below to use this"
    return "requires ollama serve running on this host"
  }

  const modelHint = createMemo(() => {
    const bc = brainChoice()
    if (bc === "codex" || bc === "claude") return "Leave blank to let the CLI resolve its own default model."
    if (bc === "api-ollama") return "Type the exact tag shown by `ollama list` on the host, e.g. llama3.2:3b."
    return "Any model your saved keys below can serve — Mistral, GPT, Claude, Gemini, Grok, DeepSeek."
  })

  const saveBrain = async () => {
    setBrainSaving(true)
    setBrainErr("")
    setBrainSaved(false)
    const r = await postJarvisSettings({
      default_brain: effectiveBrain(brainChoice()),
      default_model: defaultModel().trim(),
    })
    setBrainSaving(false)
    if (!r.ok) {
      setBrainErr(r.error)
      return
    }
    setBrainSaved(true)
    clearTimeout(brainSavedTimer)
    brainSavedTimer = setTimeout(() => setBrainSaved(false), 2400)
  }

  const noAiConfigured = createMemo(
    () => !loading() && !availableBrains().codex && !availableBrains().claude && !anyCloudKeySet(),
  )

  return (
    <div class="cx-page cx-settings-page cx-fade-in">
      <div class="cx-page-head">
        <div>
          <h1 class="cx-page-title">AI Settings</h1>
          <p class="cx-page-sub">
            Choose which brain Cindro thinks with — a local CLI, a locally running Ollama, or a
            cloud API — and paste the provider keys it should have on hand.
          </p>
        </div>
        <button type="button" class="cx-btn cx-btn-ghost cx-btn-sm" disabled={loading()} onClick={() => void load()}>
          <span class="cx-refresh-glyph" classList={{ spinning: loading() }}>⟳</span>
          Reload
        </button>
      </div>

      <Show when={loadErr()}>
        <div class="cx-error-card cx-fade-in">{loadErr()}</div>
      </Show>

      <Show
        when={!loading()}
        fallback={
          <div class="cx-settings-skel">
            <div class="cx-skel cx-skel-block" style={{ height: "168px" }} />
            <div class="cx-skel cx-skel-block" style={{ height: "64px" }} />
            <div class="cx-skel cx-skel-block" style={{ height: "260px" }} />
          </div>
        }
      >
        <Show when={noAiConfigured()}>
          <div class="cx-settings-hint cx-fade-in">
            <span class="cx-settings-hint-icon">◆</span>
            <div>
              <strong>Nothing's configured yet.</strong> Cindro has no CLI on this host and no API
              key on file — pick a brain below and, if you chose Cloud API, paste at least one
              provider key so it has something to talk to.
            </div>
          </div>
        </Show>

        <section class="cx-settings-section cx-fade-in">
          <div class="cx-section-head">
            <span class="cx-section-label">Default brain</span>
          </div>
          <div class="cx-brain-grid">
            <For each={BRAIN_CARDS}>
              {(b, i) => (
                <BrainCard
                  def={b}
                  selected={brainChoice() === b.id}
                  state={brainState(b.id)}
                  stateLabel={brainStateLabel(b.id)}
                  index={i()}
                  onSelect={() => pickBrain(b.id)}
                />
              )}
            </For>
          </div>

          <div class="cx-settings-modelrow">
            <div class="cx-field cx-settings-model-field">
              <label class="cx-field-label" for="cx-settings-model-input">Default model</label>
              <input
                id="cx-settings-model-input"
                class="cx-input"
                list="cx-settings-model-options"
                autocomplete="off"
                spellcheck={false}
                placeholder={brainChoice() === "api-ollama" ? "e.g. llama3.2:3b" : "model id"}
                value={defaultModel()}
                onInput={(e) => {
                  setDefaultModel(e.currentTarget.value)
                  setBrainSaved(false)
                }}
              />
              <datalist id="cx-settings-model-options">
                <For each={modelOptions()}>{(m) => <option value={m} />}</For>
              </datalist>
              <div class="cx-settings-model-hint">{modelHint()}</div>
            </div>
            <button
              type="button"
              class="cx-btn cx-btn-primary cx-settings-savebtn"
              classList={{ saved: brainSaved() }}
              disabled={brainSaving()}
              onClick={saveBrain}
            >
              <Show when={brainSaving()} fallback={brainSaved() ? "✓ Saved" : "Save"}>
                <span class="cx-spinner" />
              </Show>
            </button>
          </div>
          <Show when={brainErr()}>
            <div class="cx-error-card cx-fade-in">{brainErr()}</div>
          </Show>
        </section>

        <section class="cx-settings-section cx-fade-in">
          <div class="cx-section-head">
            <span class="cx-section-label">API keys</span>
            <span class="cx-settings-section-hint">
              Write-only — Cindro stores each key on disk (OS-protected) and never sends it back to
              the browser.
            </span>
          </div>
          <div class="cx-provider-grid">
            <For each={PROVIDERS}>
              {(p, i) => (
                <ProviderCard
                  meta={p}
                  configured={apiKeysSet()[p.id] === true}
                  index={i()}
                  onSaved={refreshApiKeysOnly}
                />
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  )
}

export default {
  id: "settings",
  label: "AI Settings",
  icon: "⚙",
  section: "CINDRO",
  order: 30,
  component: SettingsPage,
} satisfies PageDef
