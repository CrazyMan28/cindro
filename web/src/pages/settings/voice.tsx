// SETTINGS / VOICE — STT/TTS provider + default voice, plus full CRUD over
// the named voice-clone library (record/upload, preview, rename, set-default,
// delete). Ported from desktop/qml/SettingsPage.qml's "// VOICE" SectionCard.
// Data: settings.get/settings.set (stt_provider, tts_provider, tts_voice) for
// the picker + persisted default; voice.list_voices for the picker's actual
// entries (stock + the user's named clones, scoped to the active tts
// provider); voice.create_clone/delete_clone/rename_clone/set_default for the
// library rows (each of those calls the daemon directly and is NOT part of
// the settings.set patch — they persist immediately, no Save button needed).
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

interface ProviderOpt {
  id: string
  label: string
  available: boolean
}

interface VoiceOpt {
  id: string
  label: string
  custom: boolean
  source?: string
  raw?: boolean
  is_default?: boolean
}

// Feature-detected recorder mime — same candidate order as pages/voice.tsx's
// push-to-talk capture (that file's helpers are module-private, so this is a
// deliberate small duplication rather than an import across page boundaries).
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
const MAX_RECORD_MS = 20000

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
}

const MIC_UNSUPPORTED =
  typeof navigator === "undefined" ||
  !navigator.mediaDevices ||
  typeof navigator.mediaDevices.getUserMedia !== "function" ||
  typeof MediaRecorder === "undefined"

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("failed to read audio"))
    reader.onloadend = () => {
      const result = String(reader.result ?? "")
      const idx = result.indexOf(",")
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime || "audio/wav" })
}

function extFromMime(mime: string): string {
  const sub = mime.split(";")[0].trim().toLowerCase().split("/")[1] ?? ""
  if (sub === "mpeg") return "mp3"
  if (sub === "x-wav" || sub === "wave") return "wav"
  return sub || "webm"
}

function extFromFilename(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}

function providerLabel(opts: ProviderOpt[], id: string): string {
  const o = opts.find((p) => p.id === id)
  return o ? o.label : id
}

const CSS = `
.setv-page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
.setv-section-title {
  font-size: 11px; letter-spacing: var(--track-mid); color: var(--accent);
  margin-bottom: 4px;
}
.setv-subtitle { color: var(--text-faint); font-size: 12px; line-height: 1.4; margin-bottom: 8px; }
.setv-card {
  background: var(--surface-strong); border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm); padding: 14px; display: flex; flex-direction: column; gap: 12px;
}
.setv-row { display: flex; gap: 14px; flex-wrap: wrap; }
.setv-field { flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 5px; }
.setv-field-label { color: var(--text-muted); font-size: 12px; }
.setv-select, .setv-input {
  background: var(--surface-input); border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
  color: var(--text); font-family: var(--font-sans); font-size: 13px; padding: 8px 10px;
  transition: border-color var(--dur-fast) ease;
}
.setv-select:focus, .setv-input:focus { outline: none; border-color: var(--accent-dim); }
.setv-select:disabled, .setv-input:disabled { opacity: 0.5; }
.setv-select option:disabled { color: var(--text-faint); }

.setv-btn {
  all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
  padding: 8px 16px; border-radius: var(--radius-xs);
  font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
  border: 1px solid var(--hairline-soft); color: var(--text-muted);
  background: var(--surface); transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, opacity var(--dur-fast) ease;
  white-space: nowrap;
}
.setv-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
.setv-btn:disabled { opacity: 0.4; cursor: default; }
.setv-btn.primary { border-color: var(--accent-dim); color: var(--accent-bright); background: var(--accent-faint); }
.setv-btn.primary:hover:not(:disabled) { background: var(--accent-dim); }
.setv-btn.danger { border-color: var(--danger-dim); color: var(--danger); }
.setv-btn.danger:hover:not(:disabled) { background: rgba(255,107,107,0.10); }

.setv-save-row { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
.setv-dirty-note { color: var(--amber); font-size: 11px; margin-right: auto; }
.setv-error { color: var(--danger); font-size: 12px; }

.setv-voice-row {
  display: flex; align-items: center; gap: 10px; padding: 9px 10px;
  border: 1px solid var(--hairline-faint); border-radius: var(--radius-xs); background: var(--surface);
}
.setv-voice-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.setv-voice-dot.on { background: var(--success); box-shadow: 0 0 6px var(--success); }
.setv-voice-name { flex: 1; min-width: 0; color: var(--text); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.setv-voice-name.default::after { content: " · default"; color: var(--text-faint); font-weight: 400; }
.setv-voice-source { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; flex-shrink: 0; }
.setv-rename-input {
  flex: 1; min-width: 0; background: var(--surface-input); border: 1px solid var(--accent-dim);
  border-radius: var(--radius-xs); color: var(--text); font-size: 13px; padding: 5px 8px;
}
.setv-empty { color: var(--text-faint); font-size: 12px; }

.setv-add-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.setv-clean-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
.setv-toggle {
  all: unset; cursor: pointer; width: 32px; height: 18px; border-radius: 999px;
  background: var(--hairline); border: 1px solid var(--hairline-soft); position: relative; flex-shrink: 0;
  transition: background var(--dur-fast) ease;
}
.setv-toggle.on { background: var(--accent-dim); border-color: var(--accent); }
.setv-toggle-thumb {
  position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--text-muted); transition: transform var(--dur-fast) ease, background var(--dur-fast) ease;
}
.setv-toggle.on .setv-toggle-thumb { transform: translateX(14px); background: var(--accent-bright); }

.setv-clip-info { color: var(--text-muted); font-size: 12px; flex: 1; min-width: 160px; }
.setv-rec-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); display: inline-block; margin-right: 6px; animation: setv-blink 1000ms ease-in-out infinite; }
@keyframes setv-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.setv-footnote { color: var(--text-faint); font-size: 11px; line-height: 1.4; }
`

function VoiceSettings() {
  const app = useApp()
  let alive = true
  onCleanup(() => {
    alive = false
  })

  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal("")

  const [sttProvider, setSttProvider] = createSignal("")
  const [ttsProvider, setTtsProvider] = createSignal("")
  const [sttProviders, setSttProviders] = createSignal<ProviderOpt[]>([])
  const [ttsProviders, setTtsProviders] = createSignal<ProviderOpt[]>([])
  const [savedSttProvider, setSavedSttProvider] = createSignal("")
  const [savedTtsProvider, setSavedTtsProvider] = createSignal("")

  const [defaultVoice, setDefaultVoice] = createSignal("")
  const [savedDefaultVoice, setSavedDefaultVoice] = createSignal("")
  const [voices, setVoices] = createSignal<VoiceOpt[]>([])

  const [engineDirty, setEngineDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [actionBusy, setActionBusy] = createSignal("") // voice id currently being acted on
  const [actionError, setActionError] = createSignal("")

  const libraryVoices = createMemo(() => voices().filter((v) => v.custom))

  // -- add-voice form -----------------------------------------------------------
  const [cloneName, setCloneName] = createSignal("")
  const [cleanClip, setCleanClip] = createSignal(true)
  const [recState, setRecState] = createSignal<"idle" | "recording">("idle")
  const [recSeconds, setRecSeconds] = createSignal(0)
  const [clip, setClip] = createSignal<{ blob: Blob; url: string; ext: string; source: "record" | "upload"; label: string } | null>(null)
  const [micError, setMicError] = createSignal("")
  const [cloneBusy, setCloneBusy] = createSignal(false)
  const [renameId, setRenameId] = createSignal("")
  const [renameValue, setRenameValue] = createSignal("")

  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let recTimer: ReturnType<typeof setInterval> | undefined
  let currentAudio: HTMLAudioElement | null = null

  const releaseClip = () => {
    const c = clip()
    if (c) URL.revokeObjectURL(c.url)
    setClip(null)
  }

  const releaseStream = () => {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }

  onCleanup(() => {
    releaseClip()
    releaseStream()
    if (recTimer) clearInterval(recTimer)
    currentAudio?.pause()
    currentAudio = null
  })

  const playB64 = (b64: string, mime: string) => {
    currentAudio?.pause()
    const blob = base64ToBlob(b64, mime)
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    const cleanup = () => URL.revokeObjectURL(url)
    audio.onended = cleanup
    audio.onerror = cleanup
    void audio.play().catch(cleanup)
  }

  // -- load ---------------------------------------------------------------------
  // Returns the effective default slug (mirrors the seeded clone default when
  // tts_voice is unset) so callers can decide whether to adopt it.
  const refreshVoices = async (provider: string): Promise<string> => {
    const res = await app.client.call("voice.list_voices", { tts_provider: provider }, 15000)
    if (!alive) return ""
    setVoices((res.voices ?? []) as VoiceOpt[])
    return String(res.default ?? "")
  }

  const load = async () => {
    setLoading(true)
    setLoadError("")
    try {
      const s = await app.client.call("settings.get", {}, 15000)
      if (!alive) return
      const stt = String(s.stt_provider ?? "voxtral")
      const tts = String(s.tts_provider ?? "voxtral")
      setSttProvider(stt)
      setTtsProvider(tts)
      setSavedSttProvider(stt)
      setSavedTtsProvider(tts)
      setSttProviders((s.stt_providers ?? []) as ProviderOpt[])
      setTtsProviders((s.tts_providers ?? []) as ProviderOpt[])
      const def = await refreshVoices(tts)
      if (!alive) return
      setDefaultVoice(def)
      setSavedDefaultVoice(def)
      setEngineDirty(false)
    } catch (e) {
      if (alive) setLoadError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void load()
  })

  // -- engine save ----------------------------------------------------------------
  const onSttChange = (v: string) => {
    setSttProvider(v)
    setEngineDirty(true)
  }
  const onTtsChange = (v: string) => {
    setTtsProvider(v)
    setEngineDirty(true)
    void refreshVoices(v).then(() => {
      if (!alive) return
      // If the current default voice slug isn't in the new provider's list,
      // fall back to that provider's own default so Save doesn't persist a
      // dangling slug.
      const list = voices()
      if (!list.some((o) => o.id === defaultVoice())) {
        setDefaultVoice(list[0]?.id ?? "")
      }
    })
  }
  const onVoiceChange = (v: string) => {
    setDefaultVoice(v)
    setEngineDirty(true)
  }

  const saveEngine = async () => {
    if (saving()) return
    setSaving(true)
    setActionError("")
    try {
      await app.client.call(
        "settings.set",
        { patch: { stt_provider: sttProvider(), tts_provider: ttsProvider(), tts_voice: defaultVoice() } },
        15000,
      )
      if (!alive) return
      setSavedSttProvider(sttProvider())
      setSavedTtsProvider(ttsProvider())
      setSavedDefaultVoice(defaultVoice())
      setEngineDirty(false)
      app.notify("Voice settings saved.", "info")
    } catch (e) {
      if (alive) setActionError(String(e))
      app.notify(`Failed to save voice settings: ${String(e)}`, "error")
    } finally {
      if (alive) setSaving(false)
    }
  }

  // -- library actions --------------------------------------------------------------
  const previewVoice = async (id: string) => {
    if (actionBusy()) return
    setActionBusy(id)
    setActionError("")
    try {
      const res = await app.client.call("voice.preview_clone", { voice: id }, 30000)
      if (!alive) return
      const b64 = String(res.audio_b64 ?? "")
      if (b64) playB64(b64, String(res.mime ?? "audio/wav"))
    } catch (e) {
      if (alive) setActionError(String(e))
    } finally {
      if (alive) setActionBusy("")
    }
  }

  const setLibraryDefault = async (id: string) => {
    if (actionBusy()) return
    setActionBusy(id)
    setActionError("")
    try {
      const res = await app.client.call("voice.set_default", { voice: id }, 15000)
      if (!alive) return
      setVoices((res.voices ?? []) as VoiceOpt[])
      const def = String(res.default ?? id)
      setDefaultVoice(def)
      setSavedDefaultVoice(def)
      setEngineDirty(sttProvider() !== savedSttProvider() || ttsProvider() !== savedTtsProvider())
      app.notify("Default voice updated.", "info")
    } catch (e) {
      if (alive) setActionError(String(e))
      app.notify(`Failed to set default voice: ${String(e)}`, "error")
    } finally {
      if (alive) setActionBusy("")
    }
  }

  const startRename = (v: VoiceOpt) => {
    setRenameId(v.id)
    setRenameValue(v.label)
  }
  const cancelRename = () => {
    setRenameId("")
    setRenameValue("")
  }
  const submitRename = async (id: string) => {
    const name = renameValue().trim()
    if (!name || actionBusy()) return
    setActionBusy(id)
    setActionError("")
    try {
      const res = await app.client.call("voice.rename_clone", { id, name }, 15000)
      if (!alive) return
      setVoices((res.voices ?? []) as VoiceOpt[])
      cancelRename()
      app.notify("Voice renamed.", "info")
    } catch (e) {
      if (alive) setActionError(String(e))
      app.notify(`Failed to rename voice: ${String(e)}`, "error")
    } finally {
      if (alive) setActionBusy("")
    }
  }

  const deleteClone = async (v: VoiceOpt) => {
    if (actionBusy()) return
    if (!window.confirm(`Delete the voice "${v.label}"? This cannot be undone.`)) return
    setActionBusy(v.id)
    setActionError("")
    try {
      const res = await app.client.call("voice.delete_clone", { id: v.id }, 15000)
      if (!alive) return
      setVoices((res.voices ?? []) as VoiceOpt[])
      const def = String(res.default ?? "")
      if (def) {
        setDefaultVoice(def)
        setSavedDefaultVoice(def)
      }
      app.notify("Voice deleted.", "info")
    } catch (e) {
      if (alive) setActionError(String(e))
      app.notify(`Failed to delete voice: ${String(e)}`, "error")
    } finally {
      if (alive) setActionBusy("")
    }
  }

  // -- record / upload --------------------------------------------------------------
  const startRecording = async () => {
    if (MIC_UNSUPPORTED || recState() !== "idle") return
    setMicError("")
    releaseClip()
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ""
      setMicError(
        name === "NotAllowedError"
          ? "Microphone permission denied — allow mic access for this site and try again."
          : `Microphone unavailable: ${String(e)}`,
      )
      return
    }
    const mimeType = pickMimeType()
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch (e) {
      setMicError(`Recorder unavailable: ${String(e)}`)
      releaseStream()
      return
    }
    chunks = []
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data)
    }
    recorder.start()
    setRecState("recording")
    setRecSeconds(0)
    recTimer = setInterval(() => {
      setRecSeconds((s) => {
        const next = s + 1
        if (next >= MAX_RECORD_MS / 1000) void stopRecording()
        return next
      })
    }, 1000)
  }

  const stopRecording = async () => {
    if (recState() !== "recording") return
    const r = recorder
    recorder = null
    if (recTimer) clearInterval(recTimer)
    setRecState("idle")
    if (!r) {
      releaseStream()
      return
    }
    const blob = await new Promise<Blob>((resolve) => {
      r.onstop = () => resolve(new Blob(chunks, { type: r.mimeType || "audio/webm" }))
      if (r.state === "inactive") resolve(new Blob(chunks, { type: r.mimeType || "audio/webm" }))
      else r.stop()
    })
    chunks = []
    releaseStream()
    if (!alive || blob.size === 0) return
    releaseClip()
    setClip({
      blob,
      url: URL.createObjectURL(blob),
      ext: extFromMime(blob.type),
      source: "record",
      label: `recording (${recSeconds()}s)`,
    })
  }

  const onUploadFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    releaseClip()
    setClip({
      blob: file,
      url: URL.createObjectURL(file),
      ext: extFromFilename(file.name) || extFromMime(file.type),
      source: "upload",
      label: file.name,
    })
  }

  const saveClone = async () => {
    const c = clip()
    const name = cloneName().trim()
    if (!c || !name || cloneBusy()) return
    setCloneBusy(true)
    setActionError("")
    try {
      const audio_b64 = await blobToBase64(c.blob)
      const res = await app.client.call(
        "voice.create_clone",
        { name, audio_b64, format: c.ext, clean: cleanClip(), source: c.source },
        60000,
      )
      if (!alive) return
      setVoices((res.voices ?? []) as VoiceOpt[])
      const def = String(res.default ?? "")
      if (def && !savedDefaultVoice()) {
        setDefaultVoice(def)
        setSavedDefaultVoice(def)
      }
      setCloneName("")
      releaseClip()
      app.notify(`Voice "${name}" saved.`, "info")
    } catch (e) {
      if (alive) setActionError(String(e))
      app.notify(`Failed to save voice: ${String(e)}`, "error")
    } finally {
      if (alive) setCloneBusy(false)
    }
  }

  return (
    <div class="setv-page">
      <style>{CSS}</style>

      <div>
        <div class="hud-label setv-section-title">// VOICE</div>
        <div class="setv-subtitle">
          Which engine Orin uses to hear (STT) and speak (TTS), and the default voice.
        </div>
      </div>

      <Show when={loadError()}>
        <div class="setv-error">⚠ {loadError()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="setv-empty">Loading voice settings…</div>}>
        <div class="setv-card">
          <div class="setv-row">
            <label class="setv-field">
              <span class="setv-field-label">STT provider</span>
              <select class="setv-select" value={sttProvider()} onChange={(e) => onSttChange(e.currentTarget.value)}>
                <For each={sttProviders()}>
                  {(p) => (
                    <option value={p.id} disabled={!p.available}>
                      {p.label}
                      {p.available ? "" : " (unavailable)"}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="setv-field">
              <span class="setv-field-label">TTS provider</span>
              <select class="setv-select" value={ttsProvider()} onChange={(e) => onTtsChange(e.currentTarget.value)}>
                <For each={ttsProviders()}>
                  {(p) => (
                    <option value={p.id} disabled={!p.available}>
                      {p.label}
                      {p.available ? "" : " (unavailable)"}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </div>
          <div class="setv-row">
            <label class="setv-field">
              <span class="setv-field-label">Default TTS voice</span>
              <select
                class="setv-select"
                value={defaultVoice()}
                disabled={voices().length === 0}
                onChange={(e) => onVoiceChange(e.currentTarget.value)}
              >
                <For each={voices()}>
                  {(v) => (
                    <option value={v.id}>
                      {v.custom ? `★ ${v.label}` : v.label}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </div>
          <div class="setv-save-row">
            <Show when={engineDirty()}>
              <span class="setv-dirty-note">unsaved changes</span>
            </Show>
            <button type="button" class="setv-btn primary" disabled={!engineDirty() || saving()} onClick={() => void saveEngine()}>
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <div>
          <div class="hud-label setv-section-title">SAVED VOICES — RECORD YOUR OWN OR UPLOAD A CLIP</div>
          <div class="setv-subtitle">
            The default voice is used everywhere Orin speaks — read-back, voice mode, and phone calls.
          </div>
        </div>

        <Show when={actionError()}>
          <div class="setv-error">⚠ {actionError()}</div>
        </Show>

        <div class="setv-card">
          <Show when={libraryVoices().length > 0} fallback={<div class="setv-empty">No saved voices yet — record or upload one below.</div>}>
            <For each={libraryVoices()}>
              {(v) => (
                <div class="setv-voice-row">
                  <span class="setv-voice-dot" classList={{ on: v.is_default }} />
                  <Show
                    when={renameId() === v.id}
                    fallback={
                      <span class="setv-voice-name" classList={{ default: v.is_default }}>
                        {v.label}
                      </span>
                    }
                  >
                    <input
                      class="setv-rename-input"
                      value={renameValue()}
                      onInput={(e) => setRenameValue(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRename(v.id)
                        if (e.key === "Escape") cancelRename()
                      }}
                    />
                  </Show>
                  <span class="setv-voice-source">{v.source === "record" ? "recorded" : v.raw ? "raw clip" : "clip"}</span>
                  <Show
                    when={renameId() === v.id}
                    fallback={
                      <>
                        <button type="button" class="setv-btn" disabled={actionBusy() === v.id} onClick={() => void previewVoice(v.id)}>
                          {actionBusy() === v.id ? "…" : "Preview"}
                        </button>
                        <button type="button" class="setv-btn" disabled={actionBusy() === v.id} onClick={() => startRename(v)}>
                          Rename
                        </button>
                        <button
                          type="button"
                          class="setv-btn"
                          classList={{ primary: !v.is_default }}
                          disabled={v.is_default || actionBusy() === v.id}
                          onClick={() => void setLibraryDefault(v.id)}
                        >
                          Set default
                        </button>
                        <button type="button" class="setv-btn danger" disabled={actionBusy() === v.id} onClick={() => void deleteClone(v)}>
                          Delete
                        </button>
                      </>
                    }
                  >
                    <button type="button" class="setv-btn primary" disabled={actionBusy() === v.id} onClick={() => void submitRename(v.id)}>
                      Save
                    </button>
                    <button type="button" class="setv-btn" onClick={cancelRename}>
                      Cancel
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>

          <Show when={micError()}>
            <div class="setv-error">⚠ {micError()}</div>
          </Show>
          <Show when={MIC_UNSUPPORTED}>
            <div class="setv-footnote">This browser has no microphone capture API — you can still upload a clip below.</div>
          </Show>

          <div class="setv-add-row">
            <input
              class="setv-input"
              style={{ flex: "1", "min-width": "160px" }}
              placeholder="Voice name (e.g. My Voice)"
              value={cloneName()}
              onInput={(e) => setCloneName(e.currentTarget.value)}
            />
          </div>
          <div class="setv-add-row">
            <button
              type="button"
              class="setv-btn"
              classList={{ danger: recState() === "recording" }}
              disabled={MIC_UNSUPPORTED}
              onClick={() => (recState() === "recording" ? void stopRecording() : void startRecording())}
            >
              {recState() === "recording" ? (
                <>
                  <span class="setv-rec-dot" />
                  Stop ({recSeconds()}s)
                </>
              ) : (
                "● Record"
              )}
            </button>
            <label class="setv-btn" style={{ display: "inline-block" }}>
              Upload clip
              <input type="file" accept="audio/*" style={{ display: "none" }} onChange={(e) => void onUploadFile(e)} />
            </label>
            <Show when={clip()}>
              {(c) => (
                <div class="setv-clip-info">
                  {c().label} <audio controls src={c().url} style={{ height: "26px", "vertical-align": "middle", "margin-left": "8px" }} />
                </div>
              )}
            </Show>
            <label class="setv-clean-toggle">
              <button type="button" class="setv-toggle" classList={{ on: cleanClip() }} onClick={() => setCleanClip((v) => !v)}>
                <span class="setv-toggle-thumb" />
              </button>
              Auto-clean
            </label>
            <button
              type="button"
              class="setv-btn primary"
              disabled={!clip() || cloneName().trim().length === 0 || cloneBusy()}
              onClick={() => void saveClone()}
            >
              {cloneBusy() ? "Saving…" : "Save voice"}
            </button>
          </div>
        </div>

        <div class="setv-footnote">
          Provider labels: {providerLabel(sttProviders(), savedSttProvider())} (STT) / {providerLabel(ttsProviders(), savedTtsProvider())} (TTS).
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "voice", label: "Voice", component: VoiceSettings }
export default section
