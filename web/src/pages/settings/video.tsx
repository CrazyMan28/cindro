// SETTINGS / VIDEO — video-understanding knobs (yt-dlp/ffmpeg/whisper pipeline
// prefs the daemon stores, the Python engine reads). Field names + allowed
// values below are read straight off core/src/SettingsStore.cpp's
// videoKeyOrder()/videoDefaults()/normalizeVideoValue() — NOT guessed — and
// settings.get's response (flat video_* keys + a video_backends availability
// array), matching desktop/qml/SettingsPage.qml's "// VIDEO UNDERSTANDING"
// SectionCard plus the newer knobs that section hasn't caught up to yet
// (describer model/timeout, session/downloads retention, audio chunking,
// gemini model/tokens — all real settings.set-able keys).
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

interface BackendOpt {
  id: string
  label: string
  available: boolean
}

interface VideoForm {
  video_backend: string
  video_whisper_engine: string
  video_whisper_model: string
  video_whisper_device: string
  video_frame_mode: string
  video_frame_format: string
  video_frame_resolution: number
  video_default_fps: string
  video_max_frames: number
  video_frame_describer_model: string
  video_frame_describer_timeout_sec: number
  video_enable_index: boolean
  video_session_max_age_days: number
  video_downloads_max_age_days: number
  video_audio_chunk_trigger_seconds: number
  video_audio_chunk_size_seconds: number
  video_audio_chunk_overlap_seconds: number
  video_gemini_model: string
  video_gemini_max_output_tokens: number
}

const DEFAULTS: VideoForm = {
  video_backend: "local",
  video_whisper_engine: "faster-whisper",
  video_whisper_model: "large-v3",
  video_whisper_device: "auto",
  video_frame_mode: "images",
  video_frame_format: "jpeg",
  video_frame_resolution: 512,
  video_default_fps: "auto",
  video_max_frames: 100,
  video_frame_describer_model: "",
  video_frame_describer_timeout_sec: 180,
  video_enable_index: false,
  video_session_max_age_days: 7,
  video_downloads_max_age_days: 7,
  video_audio_chunk_trigger_seconds: 1200,
  video_audio_chunk_size_seconds: 600,
  video_audio_chunk_overlap_seconds: 0,
  video_gemini_model: "gemini-3-flash-preview",
  video_gemini_max_output_tokens: 65536,
}

const RESOLUTION_PICKS = [256, 512, 768, 1024]
const MAX_FRAMES_PICKS = [50, 100, 200]
const FPS_PICKS = ["auto", "0.2", "0.5", "1", "2"]

const CSS = `
.setvid-page { display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
.setvid-section-title { font-size: 11px; letter-spacing: var(--track-mid); color: var(--accent); margin-bottom: 4px; }
.setvid-subtitle { color: var(--text-faint); font-size: 12px; line-height: 1.4; margin-bottom: 8px; }
.setvid-card {
  background: var(--surface-strong); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm); padding: 14px; display: flex; flex-direction: column; gap: 12px;
}
.setvid-card-title { color: var(--text-muted); font-size: 11px; letter-spacing: var(--track-mid); text-transform: uppercase; }
.setvid-row { display: flex; gap: 14px; flex-wrap: wrap; }
.setvid-field { flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 5px; }
.setvid-field-label { color: var(--text-muted); font-size: 12px; }
.setvid-select, .setvid-input {
  background: var(--surface-input); border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
  color: var(--text); font-family: var(--font-sans); font-size: 13px; padding: 8px 10px;
  transition: border-color var(--dur-fast) ease;
}
.setvid-select:focus, .setvid-input:focus { outline: none; border-color: var(--accent-dim); }
.setvid-select:disabled, .setvid-input:disabled { opacity: 0.45; }
.setvid-num-row { display: flex; gap: 8px; align-items: center; }
.setvid-num-row .setvid-input { width: 100px; flex: none; }
.setvid-pick-btn {
  all: unset; cursor: pointer; padding: 6px 10px; border-radius: var(--radius-xs);
  font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);
  border: 1px solid var(--hairline-soft); background: var(--surface);
}
.setvid-pick-btn:hover { border-color: var(--accent-dim); color: var(--text); }
.setvid-pick-btn.active { border-color: var(--accent); color: var(--accent-bright); background: var(--accent-faint); }

.setvid-toggle-row { display: flex; align-items: center; gap: 10px; }
.setvid-toggle {
  all: unset; cursor: pointer; width: 34px; height: 19px; border-radius: 999px;
  background: var(--hairline); border: 1px solid var(--hairline-soft); position: relative; flex-shrink: 0;
  transition: background var(--dur-fast) ease;
}
.setvid-toggle.on { background: var(--accent-dim); border-color: var(--accent); }
.setvid-toggle-thumb {
  position: absolute; top: 1px; left: 1px; width: 15px; height: 15px; border-radius: 50%;
  background: var(--text-muted); transition: transform var(--dur-fast) ease, background var(--dur-fast) ease;
}
.setvid-toggle.on .setvid-toggle-thumb { transform: translateX(15px); background: var(--accent-bright); }
.setvid-toggle-label { color: var(--text-muted); font-size: 12px; }

.setvid-details summary {
  cursor: pointer; color: var(--accent); font-size: 11px; letter-spacing: var(--track-mid);
  list-style: none; user-select: none;
}
.setvid-details summary::-webkit-details-marker { display: none; }
.setvid-details summary::before { content: "▸ "; }
.setvid-details[open] summary::before { content: "▾ "; }
.setvid-details[open] { display: flex; flex-direction: column; gap: 12px; }

.setvid-save-row { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
.setvid-dirty-note { color: var(--amber); font-size: 11px; margin-right: auto; }
.setvid-btn {
  all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
  padding: 9px 18px; border-radius: var(--radius-xs);
  font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
  border: 1px solid var(--accent-dim); color: var(--accent-bright);
  background: var(--accent-faint); transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
}
.setvid-btn:hover:not(:disabled) { background: var(--accent-dim); }
.setvid-btn:disabled { opacity: 0.4; cursor: default; }
.setvid-error { color: var(--danger); font-size: 12px; }
.setvid-empty { color: var(--text-faint); font-size: 12px; }
.setvid-footnote { color: var(--text-faint); font-size: 11px; line-height: 1.4; }
`

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function VideoSettings() {
  const app = useApp()
  let alive = true
  onCleanup(() => {
    alive = false
  })

  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal("")
  const [saveError, setSaveError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [backends, setBackends] = createSignal<BackendOpt[]>([])

  const [form, setForm] = createSignal<VideoForm>({ ...DEFAULTS })
  const [saved, setSaved] = createSignal<VideoForm>({ ...DEFAULTS })
  const [fpsCustom, setFpsCustom] = createSignal(false)

  const dirty = createMemo(() => JSON.stringify(form()) !== JSON.stringify(saved()))

  const set = <K extends keyof VideoForm>(key: K, value: VideoForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const load = async () => {
    setLoading(true)
    setLoadError("")
    try {
      const s = await app.client.call("settings.get", {}, 15000)
      if (!alive) return
      const next: VideoForm = {
        video_backend: String(s.video_backend ?? DEFAULTS.video_backend),
        video_whisper_engine: String(s.video_whisper_engine ?? DEFAULTS.video_whisper_engine),
        video_whisper_model: String(s.video_whisper_model ?? DEFAULTS.video_whisper_model),
        video_whisper_device: String(s.video_whisper_device ?? DEFAULTS.video_whisper_device),
        video_frame_mode: String(s.video_frame_mode ?? DEFAULTS.video_frame_mode),
        video_frame_format: String(s.video_frame_format ?? DEFAULTS.video_frame_format),
        video_frame_resolution: num(s.video_frame_resolution, DEFAULTS.video_frame_resolution),
        video_default_fps: String(s.video_default_fps ?? DEFAULTS.video_default_fps),
        video_max_frames: num(s.video_max_frames, DEFAULTS.video_max_frames),
        video_frame_describer_model: String(s.video_frame_describer_model ?? ""),
        video_frame_describer_timeout_sec: num(s.video_frame_describer_timeout_sec, DEFAULTS.video_frame_describer_timeout_sec),
        video_enable_index: Boolean(s.video_enable_index),
        video_session_max_age_days: num(s.video_session_max_age_days, DEFAULTS.video_session_max_age_days),
        video_downloads_max_age_days: num(s.video_downloads_max_age_days, DEFAULTS.video_downloads_max_age_days),
        video_audio_chunk_trigger_seconds: num(s.video_audio_chunk_trigger_seconds, DEFAULTS.video_audio_chunk_trigger_seconds),
        video_audio_chunk_size_seconds: num(s.video_audio_chunk_size_seconds, DEFAULTS.video_audio_chunk_size_seconds),
        video_audio_chunk_overlap_seconds: num(s.video_audio_chunk_overlap_seconds, DEFAULTS.video_audio_chunk_overlap_seconds),
        video_gemini_model: String(s.video_gemini_model ?? DEFAULTS.video_gemini_model),
        video_gemini_max_output_tokens: num(s.video_gemini_max_output_tokens, DEFAULTS.video_gemini_max_output_tokens),
      }
      setForm(next)
      setSaved(next)
      setFpsCustom(!FPS_PICKS.includes(next.video_default_fps))
      setBackends((s.video_backends ?? []) as BackendOpt[])
    } catch (e) {
      if (alive) setLoadError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void load()
  })

  const save = async () => {
    if (saving() || !dirty()) return
    setSaving(true)
    setSaveError("")
    try {
      // Send the full video_* set every time (cheap; the daemon normalizes
      // and no-ops unchanged keys back to defaults) rather than diffing.
      await app.client.call("settings.set", { patch: { ...form() } }, 20000)
      if (!alive) return
      setSaved(form())
      app.notify("Video settings saved.", "info")
    } catch (e) {
      if (alive) setSaveError(String(e))
      app.notify(`Failed to save video settings: ${String(e)}`, "error")
    } finally {
      if (alive) setSaving(false)
    }
  }

  const isLocal = () => form().video_backend === "local"
  const isFasterWhisper = () => form().video_whisper_engine === "faster-whisper"
  const isGemini = () => form().video_backend === "gemini-api"
  const isDescriptions = () => form().video_frame_mode === "descriptions"

  return (
    <div class="setvid-page">
      <style>{CSS}</style>

      <div>
        <div class="hud-label setvid-section-title">// VIDEO UNDERSTANDING</div>
        <div class="setvid-subtitle">
          How Orin watches videos — frames become images it sees, audio becomes a timestamped transcript it
          reads. Paste a YouTube URL or a video path into chat and ask it to watch.
        </div>
      </div>

      <Show when={loadError()}>
        <div class="setvid-error">⚠ {loadError()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="setvid-empty">Loading video settings…</div>}>
        <div class="setvid-card">
          <div class="setvid-card-title">Backend</div>
          <div class="setvid-row">
            <label class="setvid-field">
              <span class="setvid-field-label">Audio/analysis backend</span>
              <select class="setvid-select" value={form().video_backend} onChange={(e) => set("video_backend", e.currentTarget.value)}>
                <For each={backends().length ? backends() : [{ id: "local", label: "Local whisper (offline)", available: true }]}>
                  {(b) => (
                    <option value={b.id} disabled={!b.available}>
                      {b.label}
                      {b.available ? "" : " (needs API key)"}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="setvid-field">
              <span class="setvid-field-label">Local engine</span>
              <select
                class="setvid-select"
                disabled={!isLocal()}
                value={form().video_whisper_engine}
                onChange={(e) => set("video_whisper_engine", e.currentTarget.value)}
              >
                <option value="faster-whisper">faster-whisper (recommended)</option>
                <option value="whisper-cpp">whisper.cpp</option>
                <option value="openai-whisper">openai-whisper</option>
              </select>
            </label>
          </div>
          <div class="setvid-row">
            <label class="setvid-field">
              <span class="setvid-field-label">Whisper model</span>
              <select
                class="setvid-select"
                disabled={!isLocal()}
                value={form().video_whisper_model}
                onChange={(e) => set("video_whisper_model", e.currentTarget.value)}
              >
                <option value="auto">auto (pick by RAM)</option>
                <option value="tiny">tiny (fastest)</option>
                <option value="base">base</option>
                <option value="small">small</option>
                <option value="medium">medium</option>
                <option value="large-v3-turbo">large-v3-turbo</option>
                <option value="large-v3">large-v3 (best)</option>
              </select>
            </label>
            <label class="setvid-field">
              <span class="setvid-field-label">Device</span>
              <select
                class="setvid-select"
                disabled={!isLocal() || !isFasterWhisper()}
                value={form().video_whisper_device}
                onChange={(e) => set("video_whisper_device", e.currentTarget.value)}
              >
                <option value="auto">auto (GPU when present)</option>
                <option value="cpu">CPU</option>
                <option value="cuda">CUDA (NVIDIA GPU)</option>
              </select>
            </label>
          </div>
        </div>

        <div class="setvid-card">
          <div class="setvid-card-title">Frames</div>
          <div class="setvid-row">
            <label class="setvid-field">
              <span class="setvid-field-label">Frame mode</span>
              <select class="setvid-select" value={form().video_frame_mode} onChange={(e) => set("video_frame_mode", e.currentTarget.value)}>
                <option value="images">Images (Orin sees frames)</option>
                <option value="descriptions">Descriptions (token-saving)</option>
              </select>
            </label>
            <label class="setvid-field">
              <span class="setvid-field-label">Frame format</span>
              <select class="setvid-select" value={form().video_frame_format} onChange={(e) => set("video_frame_format", e.currentTarget.value)}>
                <option value="jpeg">jpeg (default)</option>
                <option value="png">png (screen recordings)</option>
                <option value="webp">webp</option>
              </select>
            </label>
          </div>
          <div class="setvid-field">
            <span class="setvid-field-label">Frame resolution (128–2048 px)</span>
            <div class="setvid-num-row">
              <input
                type="number"
                class="setvid-input"
                min="128"
                max="2048"
                value={form().video_frame_resolution}
                onInput={(e) => set("video_frame_resolution", num(e.currentTarget.value, DEFAULTS.video_frame_resolution))}
              />
              <For each={RESOLUTION_PICKS}>
                {(r) => (
                  <button
                    type="button"
                    class="setvid-pick-btn"
                    classList={{ active: form().video_frame_resolution === r }}
                    onClick={() => set("video_frame_resolution", r)}
                  >
                    {r}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="setvid-row">
            <div class="setvid-field">
              <span class="setvid-field-label">Default fps</span>
              <div class="setvid-num-row">
                <select
                  class="setvid-select"
                  style={{ flex: "1" }}
                  value={fpsCustom() ? "custom" : form().video_default_fps}
                  onChange={(e) => {
                    if (e.currentTarget.value === "custom") {
                      setFpsCustom(true)
                      return
                    }
                    setFpsCustom(false)
                    set("video_default_fps", e.currentTarget.value)
                  }}
                >
                  <For each={FPS_PICKS}>
                    {(f) => <option value={f}>{f === "auto" ? "auto (by duration)" : `${f} fps`}</option>}
                  </For>
                  <option value="custom">custom…</option>
                </select>
                <Show when={fpsCustom()}>
                  <input
                    type="text"
                    class="setvid-input"
                    style={{ width: "80px" }}
                    placeholder="e.g. 0.75"
                    value={FPS_PICKS.includes(form().video_default_fps) ? "" : form().video_default_fps}
                    onInput={(e) => set("video_default_fps", e.currentTarget.value)}
                  />
                </Show>
              </div>
            </div>
            <div class="setvid-field">
              <span class="setvid-field-label">Max frames per call (1–1000)</span>
              <div class="setvid-num-row">
                <input
                  type="number"
                  class="setvid-input"
                  min="1"
                  max="1000"
                  value={form().video_max_frames}
                  onInput={(e) => set("video_max_frames", num(e.currentTarget.value, DEFAULTS.video_max_frames))}
                />
                <For each={MAX_FRAMES_PICKS}>
                  {(m) => (
                    <button
                      type="button"
                      class="setvid-pick-btn"
                      classList={{ active: form().video_max_frames === m }}
                      onClick={() => set("video_max_frames", m)}
                    >
                      {m}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>

          <Show when={isDescriptions()}>
            <div class="setvid-row">
              <label class="setvid-field">
                <span class="setvid-field-label">Describer model (free text)</span>
                <input
                  type="text"
                  class="setvid-input"
                  placeholder="e.g. a vision-capable model id"
                  value={form().video_frame_describer_model}
                  onInput={(e) => set("video_frame_describer_model", e.currentTarget.value)}
                />
              </label>
              <label class="setvid-field">
                <span class="setvid-field-label">Describer timeout (10–3600s)</span>
                <input
                  type="number"
                  class="setvid-input"
                  min="10"
                  max="3600"
                  value={form().video_frame_describer_timeout_sec}
                  onInput={(e) =>
                    set("video_frame_describer_timeout_sec", num(e.currentTarget.value, DEFAULTS.video_frame_describer_timeout_sec))
                  }
                />
              </label>
            </div>
          </Show>

          <div class="setvid-toggle-row">
            <button
              type="button"
              class="setvid-toggle"
              classList={{ on: form().video_enable_index }}
              onClick={() => set("video_enable_index", !form().video_enable_index)}
            >
              <span class="setvid-toggle-thumb" />
            </button>
            <span class="setvid-toggle-label">Cache extracted frames on disk (faster follow-up questions on the same video)</span>
          </div>
        </div>

        <Show when={isGemini()}>
          <div class="setvid-card">
            <div class="setvid-card-title">Gemini cloud backend</div>
            <div class="setvid-row">
              <label class="setvid-field">
                <span class="setvid-field-label">Gemini model</span>
                <input
                  type="text"
                  class="setvid-input"
                  value={form().video_gemini_model}
                  onInput={(e) => set("video_gemini_model", e.currentTarget.value)}
                />
              </label>
              <label class="setvid-field">
                <span class="setvid-field-label">Max output tokens (1024–1,000,000)</span>
                <input
                  type="number"
                  class="setvid-input"
                  min="1024"
                  max="1000000"
                  value={form().video_gemini_max_output_tokens}
                  onInput={(e) => set("video_gemini_max_output_tokens", num(e.currentTarget.value, DEFAULTS.video_gemini_max_output_tokens))}
                />
              </label>
            </div>
          </div>
        </Show>

        <details class="setvid-details">
          <summary class="hud-label">ADVANCED — RETENTION &amp; AUDIO CHUNKING</summary>
          <div class="setvid-card">
            <div class="setvid-row">
              <label class="setvid-field">
                <span class="setvid-field-label">Cached session max age (1–365 days)</span>
                <input
                  type="number"
                  class="setvid-input"
                  min="1"
                  max="365"
                  value={form().video_session_max_age_days}
                  onInput={(e) => set("video_session_max_age_days", num(e.currentTarget.value, DEFAULTS.video_session_max_age_days))}
                />
              </label>
              <label class="setvid-field">
                <span class="setvid-field-label">Downloaded video max age (1–365 days)</span>
                <input
                  type="number"
                  class="setvid-input"
                  min="1"
                  max="365"
                  value={form().video_downloads_max_age_days}
                  onInput={(e) => set("video_downloads_max_age_days", num(e.currentTarget.value, DEFAULTS.video_downloads_max_age_days))}
                />
              </label>
            </div>
            <div class="setvid-row">
              <label class="setvid-field">
                <span class="setvid-field-label">Audio chunk trigger (60–86400s)</span>
                <input
                  type="number"
                  class="setvid-input"
                  min="60"
                  max="86400"
                  value={form().video_audio_chunk_trigger_seconds}
                  onInput={(e) =>
                    set("video_audio_chunk_trigger_seconds", num(e.currentTarget.value, DEFAULTS.video_audio_chunk_trigger_seconds))
                  }
                />
              </label>
              <label class="setvid-field">
                <span class="setvid-field-label">Audio chunk size (60–86400s)</span>
                <input
                  type="number"
                  class="setvid-input"
                  min="60"
                  max="86400"
                  value={form().video_audio_chunk_size_seconds}
                  onInput={(e) => set("video_audio_chunk_size_seconds", num(e.currentTarget.value, DEFAULTS.video_audio_chunk_size_seconds))}
                />
              </label>
              <label class="setvid-field">
                <span class="setvid-field-label">Audio chunk overlap (0–60s)</span>
                <input
                  type="number"
                  class="setvid-input"
                  min="0"
                  max="60"
                  value={form().video_audio_chunk_overlap_seconds}
                  onInput={(e) =>
                    set("video_audio_chunk_overlap_seconds", num(e.currentTarget.value, DEFAULTS.video_audio_chunk_overlap_seconds))
                  }
                />
              </label>
            </div>
          </div>
        </details>

        <Show when={saveError()}>
          <div class="setvid-error">⚠ {saveError()}</div>
        </Show>

        <div class="setvid-save-row">
          <Show when={dirty()}>
            <span class="setvid-dirty-note">unsaved changes</span>
          </Show>
          <button type="button" class="setvid-btn" disabled={!dirty() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>

        <div class="setvid-footnote">
          Local whisper runs fully offline — nothing leaves this machine. Cloud backends need their API key
          under API KEYS. Say "run video_setup" in chat for a live dependency + model check.
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "video", label: "Video", component: VideoSettings }
export default section
