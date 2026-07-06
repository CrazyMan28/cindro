// VOICE — browser push-to-talk voice mode: MediaRecorder capture -> voice.stt
// -> a chat turn on a dedicated session -> voice.tts -> playback, all wrapped
// around the ArcReactor "orb" as the listening/thinking/speaking indicator.
// Ported from desktop/qml/VoiceMode.qml (the "spinny thing") and
// tui/src/pages/Voice.tsx + tui/src/voice/audio.ts, adapted to the ONE
// capture/playback API a browser tab actually has: MediaRecorder + <audio>
// (no arecord/aplay shell-out, no always-listening VAD duplex — tap-to-talk,
// the same tradeoff the TUI made for a terminal with no continuous capture).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { theme } from "../core/theme"
import { ArcReactor } from "../components/ArcReactor"

type VoiceState = "idle" | "listening" | "thinking" | "speaking"

interface VoiceOption {
  id: string
  label: string
}

// A modest set of Jarvis-flavored "thinking" phrases (in the spirit of
// VoiceMode.qml's WORK_PHRASES / tui/src/pages/Voice.tsx's THINKING_PHRASES,
// written fresh here rather than copied from either).
const THINKING_PHRASES = [
  "Charging the arc reactor", "Untangling the wiring harness", "Consulting the archives",
  "Aligning the satellite dish", "Reticulating splines", "Warming up the vacuum tubes",
  "Cross-checking the telemetry", "Rerouting auxiliary power", "Spinning up the repulsors",
  "Polishing the final answer", "Running a diagnostic sweep", "Compiling brilliance",
  "Negotiating with the firmware", "Sharpening Occam's razor", "Syncing with the mothership",
  "Distilling the signal from the noise", "Assembling the response", "Tuning the frequency",
  "Querying the knowledge base", "Bracing for a breakthrough",
]
const PHRASE_ROTATE_MS = 2600

// Feature-detected recorder mime, best quality/compat first. The daemon's
// local-whisper STT path (VoiceProvider::extForMime) understands wav/ogg/webm.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
]

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function")
    return undefined
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
}

function pickPhrase(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)] ?? "Thinking"
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  )
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("failed to read recording"))
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

const MIC_UNSUPPORTED =
  typeof navigator === "undefined" ||
  !navigator.mediaDevices ||
  typeof navigator.mediaDevices.getUserMedia !== "function" ||
  typeof MediaRecorder === "undefined"

const VOICE_CSS = `
.voice-page { display: flex; flex-direction: column; gap: 18px; max-width: 720px; margin: 0 auto; }
.voice-header { display: flex; flex-direction: column; gap: 6px; background: linear-gradient(135deg, var(--surface) 0%, var(--surface-strong) 100%); border-color: var(--accent-dim); }
.voice-title { color: var(--accent-bright); font-size: 20px; }
.voice-subtitle { color: var(--text-muted); font-size: 13px; }

.voice-controls { display: flex; justify-content: center; }
.voice-field { display: flex; align-items: center; gap: 10px; }
.voice-field-label { font-size: 10px; color: var(--text-faint); }
.voice-select {
  background: var(--surface-input);
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 12px;
  padding: 6px 10px;
  min-width: 220px;
}
.voice-select:focus { outline: none; border-color: var(--accent-dim); }
.voice-select:disabled { opacity: 0.5; }

.voice-stage { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 30px 20px; }

.voice-orb-halo { position: relative; width: 220px; height: 220px; display: flex; align-items: center; justify-content: center; margin-top: 6px; }
.voice-orb-ring { position: absolute; inset: 0; border-radius: 50%; border: 1px solid var(--accent); opacity: 0; pointer-events: none; }
.voice-orb-halo[data-state="idle"] .voice-orb-ring { animation: voice-ring-idle 3400ms ease-out infinite; }
.voice-orb-halo[data-state="listening"] .voice-orb-ring { animation: voice-ring-listening 1200ms ease-out infinite; border-color: var(--accent-bright); }
.voice-orb-halo[data-state="thinking"] .voice-orb-ring { animation: voice-ring-thinking 1000ms ease-out infinite; border-color: var(--violet); }
.voice-orb-halo[data-state="speaking"] .voice-orb-ring { animation: voice-ring-speaking 900ms ease-out infinite; border-color: var(--accent-bright); }
.voice-orb-ring:nth-child(1) { animation-delay: 0ms; }
.voice-orb-ring:nth-child(2) { animation-delay: 350ms; }
.voice-orb-ring:nth-child(3) { animation-delay: 700ms; }

@keyframes voice-ring-idle { 0% { transform: scale(0.74); opacity: 0.30; } 100% { transform: scale(1.0); opacity: 0; } }
@keyframes voice-ring-listening { 0% { transform: scale(0.55); opacity: 0.55; } 100% { transform: scale(1.08); opacity: 0; } }
@keyframes voice-ring-thinking { 0% { transform: scale(0.55) rotate(0deg); opacity: 0.5; } 100% { transform: scale(1.02) rotate(60deg); opacity: 0; } }
@keyframes voice-ring-speaking { 0% { transform: scale(0.62); opacity: 0.6; } 100% { transform: scale(1.04); opacity: 0; } }

.voice-orb-core {
  all: unset;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 50%;
  transition: transform 110ms ease-out;
  filter: drop-shadow(0 0 18px var(--accent-glow));
}
.voice-orb-core:disabled { cursor: default; filter: none; opacity: 0.55; }

.voice-state-label { font-size: 13px; letter-spacing: var(--track-mid); opacity: 0.9; text-align: center; }

.voice-mic-warning, .voice-error { color: var(--danger); font-size: 12px; text-align: center; max-width: 480px; }
.voice-heard { color: var(--text-muted); font-style: italic; font-size: 14px; text-align: center; max-width: 480px; }
.voice-reply { color: var(--text); font-size: 15px; text-align: center; max-width: 520px; }

.voice-actions { display: flex; gap: 10px; align-items: center; }
.voice-talk-btn {
  all: unset;
  cursor: pointer;
  padding: 13px 30px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--accent-glow);
  color: var(--text);
  font-family: var(--font-display);
  font-size: 13px;
  letter-spacing: var(--track-mid);
  font-weight: 600;
  transition: background 110ms ease, box-shadow 110ms ease, transform 110ms ease;
}
.voice-talk-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 18px -6px var(--accent-glow); }
.voice-talk-btn:disabled { opacity: 0.5; cursor: default; }
.voice-talk-btn--active { background: var(--accent-dim); box-shadow: 0 0 22px -4px var(--accent-glow); }

.voice-cancel-btn {
  all: unset;
  cursor: pointer;
  padding: 10px 18px;
  border-radius: 999px;
  border: 1px solid var(--hairline-soft);
  color: var(--text-muted);
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: var(--track-mid);
}
.voice-cancel-btn:hover { color: var(--text); border-color: var(--danger-dim); }

.voice-hint { color: var(--text-faint); font-size: 11px; text-align: center; }
`

function VoicePage() {
  const app = useApp()

  const [voiceState, setVoiceState] = createSignal<VoiceState>("idle")
  const [phrase, setPhrase] = createSignal(pickPhrase())
  const [level, setLevel] = createSignal(0)
  const [pulse, setPulse] = createSignal(0)
  const [heard, setHeard] = createSignal("")
  const [reply, setReply] = createSignal("")
  const [error, setError] = createSignal("")
  const [micError, setMicError] = createSignal(
    MIC_UNSUPPORTED
      ? "This browser has no microphone capture API (getUserMedia/MediaRecorder) — Voice mode needs a modern browser served over https or localhost."
      : "",
  )
  const [voices, setVoices] = createSignal<VoiceOption[]>([])
  const [selectedVoice, setSelectedVoice] = createSignal("")
  const [sessionId, setSessionId] = createSignal("")

  let alive = true
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let levelRaf = 0
  let currentAudio: HTMLAudioElement | null = null

  // -- voice picker -------------------------------------------------------------
  const loadVoices = async () => {
    try {
      const res = await app.client.call("voice.list_voices", {}, 15000)
      if (!alive) return
      const list = (res.voices ?? []) as Array<Record<string, unknown>>
      const opts = list
        .map((v) => ({ id: String(v.id ?? ""), label: String(v.label ?? v.id ?? "") }))
        .filter((v) => v.id)
      setVoices(opts)
      const def = String(res.default ?? "")
      setSelectedVoice(def && opts.some((o) => o.id === def) ? def : (opts[0]?.id ?? ""))
    } catch (e) {
      if (alive) setError(String(e))
    }
  }

  onMount(() => {
    void loadVoices()
  })

  // -- thinking-phrase rotation ---------------------------------------------------
  onMount(() => {
    const t = setInterval(() => {
      if (voiceState() === "thinking") setPhrase(pickPhrase())
    }, PHRASE_ROTATE_MS)
    onCleanup(() => clearInterval(t))
  })

  // -- gentle breathing pulse for thinking/speaking (mirrors VoiceMode.qml's
  // reactor.pulse) — small, smooth, never an abrupt size jump.
  onMount(() => {
    let dir = 1
    const t = setInterval(() => {
      const s = voiceState()
      if (s !== "thinking" && s !== "speaking") {
        setPulse(0)
        return
      }
      setPulse((p) => {
        let n = p + dir * 0.018
        if (n >= 0.09) {
          n = 0.09
          dir = -1
        }
        if (n <= 0) {
          n = 0
          dir = 1
        }
        return n
      })
    }, 40)
    onCleanup(() => clearInterval(t))
  })

  // -- mic level meter (drives the orb's reactive swell while listening) --------
  const teardownLevelMeter = () => {
    if (levelRaf) cancelAnimationFrame(levelRaf)
    levelRaf = 0
    analyser = null
    try {
      void audioCtx?.close()
    } catch {
      // already closed
    }
    audioCtx = null
    setLevel(0)
  }

  const setupLevelMeter = (s: MediaStream) => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      audioCtx = new Ctor()
      const src = audioCtx.createMediaStreamSource(s)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        if (!analyser) return
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4))
        levelRaf = requestAnimationFrame(tick)
      }
      levelRaf = requestAnimationFrame(tick)
    } catch {
      // level meter is purely cosmetic — recording still works without it
    }
  }

  // -- recording ------------------------------------------------------------------
  const releaseStream = () => {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }

  const startRecording = async () => {
    if (MIC_UNSUPPORTED || voiceState() !== "idle") return
    setError("")
    setHeard("")
    setReply("")
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ""
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setMicError(
          "Microphone permission denied — allow mic access for this site in your browser's settings, then try again.",
        )
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setMicError("No microphone found on this device.")
      } else {
        setMicError(`Microphone unavailable: ${String(e)}`)
      }
      return
    }
    // The user can navigate away while the browser's permission prompt is
    // still up — onCleanup already ran by the time getUserMedia() resolves,
    // so without this check the mic would start recording (and stay lit)
    // on an unmounted page with nothing left to ever release it.
    if (!alive) {
      releaseStream()
      return
    }
    setMicError("")
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
    setupLevelMeter(stream)
    setVoiceState("listening")
  }

  const cancelRecording = () => {
    if (voiceState() !== "listening") return
    const r = recorder
    recorder = null
    teardownLevelMeter()
    if (r && r.state !== "inactive") {
      r.ondataavailable = null
      r.onstop = null
      r.stop()
    }
    releaseStream()
    chunks = []
    setVoiceState("idle")
  }

  const stopAndSend = async () => {
    if (voiceState() !== "listening") return
    const r = recorder
    recorder = null
    teardownLevelMeter()
    setVoiceState("thinking")
    setPhrase(pickPhrase()) // don't leave a stale LISTENING label up
    if (!r) {
      releaseStream()
      setVoiceState("idle")
      return
    }
    const blob = await new Promise<Blob>((resolve) => {
      r.onstop = () => resolve(new Blob(chunks, { type: r.mimeType || "audio/webm" }))
      if (r.state === "inactive") resolve(new Blob(chunks, { type: r.mimeType || "audio/webm" }))
      else r.stop()
    })
    chunks = []
    releaseStream()
    if (!alive) return
    if (blob.size === 0) {
      setError("no audio captured")
      setVoiceState("idle")
      return
    }

    let sttRes: Record<string, unknown>
    try {
      const b64 = await blobToBase64(blob)
      sttRes = await app.client.call(
        "voice.stt",
        { audio_b64: b64, mime: blob.type || "audio/webm" },
        30000,
      )
    } catch (e) {
      if (alive) {
        setError(String(e))
        setVoiceState("idle")
      }
      return
    }
    if (!alive) return
    const text = String(sttRes.text ?? "").trim()
    setHeard(text)
    if (!text) {
      setVoiceState("idle")
      return
    }
    try {
      await sendAndSpeak(text)
    } catch (e) {
      if (alive) setError(String(e))
    }
    if (alive) setVoiceState("idle")
  }

  const toggleRecording = () => {
    const s = voiceState()
    if (s === "idle") void startRecording()
    else if (s === "listening") void stopAndSend()
    // thinking/speaking — ignore extra taps, same as the QML/TUI ports.
  }

  // -- session + reply --------------------------------------------------------------
  const ensureSession = async (): Promise<string> => {
    if (sessionId()) return sessionId()
    const res = await app.client.call("session.create", { profile: "coworker" }, 20000)
    const sid = String(res.session_id ?? "")
    if (!sid) throw new Error("session.create returned no session_id")
    await app.client.subscribe(sid)
    setSessionId(sid)
    return sid
  }

  const awaitReply = async (sid: string, timeoutMs: number): Promise<string> => {
    const q = app.client.queueFor(sid)
    if (!q) throw new Error("no event stream for this session")
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ev = await q.shift(Math.max(50, deadline - Date.now()))
      if (!alive) throw new Error("voice page closed")
      if (!ev) break
      const kind = String(ev.kind ?? "")
      if (kind === "message") {
        const role = ev.role === undefined ? "assistant" : String(ev.role)
        const text = String(ev.text ?? "").trim()
        if (role === "assistant" && text) return text
      } else if (kind === "error") {
        throw new Error(String(ev.message ?? "session error"))
      } else if (kind === "final") {
        break
      }
    }
    throw new Error("timed out waiting for a reply")
  }

  const sendAndSpeak = async (text: string) => {
    const sid = await ensureSession()
    await app.client.call("session.send", { session_id: sid, text }, 30000)
    const replyText = await awaitReply(sid, 45000)
    if (!alive) return
    setReply(replyText)
    setVoiceState("speaking")
    await speak(replyText)
  }

  const speak = async (text: string) => {
    const params: Record<string, unknown> = { text, format: "wav" }
    if (selectedVoice()) params.voice = selectedVoice()
    let res: Record<string, unknown>
    try {
      res = await app.client.call("voice.tts", params, 30000)
    } catch (e) {
      if (alive) setError(String(e))
      return
    }
    if (!alive) return
    const b64 = String(res.audio_b64 ?? "")
    if (!b64) return
    try {
      await playAudio(b64, String(res.mime ?? "audio/wav"))
    } catch (e) {
      if (alive) setError(`playback error: ${String(e)}`)
    }
  }

  const playAudio = (b64: string, mime: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const blob = base64ToBlob(b64, mime)
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      currentAudio = audio
      const cleanup = () => {
        URL.revokeObjectURL(url)
        if (currentAudio === audio) currentAudio = null
      }
      audio.onended = () => {
        cleanup()
        resolve()
      }
      audio.onerror = () => {
        cleanup()
        reject(new Error("audio playback failed"))
      }
      audio.play().catch((e: unknown) => {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })

  // -- space/escape shortcuts, only while THIS page is the active one (the
  // router keeps every visited page mounted, so this must not fire globally).
  const onKeydown = (e: KeyboardEvent) => {
    if (app.page() !== "voice" || isTypingTarget(e.target)) return
    if (e.code === "Space") {
      e.preventDefault()
      toggleRecording()
    } else if (e.key === "Escape") {
      cancelRecording()
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown)
  })

  onCleanup(() => {
    alive = false
    window.removeEventListener("keydown", onKeydown)
    teardownLevelMeter()
    cancelRecording()
    releaseStream()
    currentAudio?.pause()
    currentAudio = null
    const sid = sessionId()
    if (sid) void app.client.unsubscribe(sid).catch(() => {})
  })

  // -- derived visuals --------------------------------------------------------------
  const coreScale = () => {
    const s = voiceState()
    if (s === "listening") return 1 + 0.16 * level()
    if (s === "thinking" || s === "speaking") return 1 + pulse()
    return 1
  }
  const orbTint = () => {
    const s = voiceState()
    if (s === "thinking") return theme.violet
    if (s === "speaking") return theme.accentBright
    return theme.accent
  }
  const stateColor = () => {
    const s = voiceState()
    if (s === "thinking") return "var(--violet)"
    if (s === "speaking" || s === "listening") return "var(--accent-bright)"
    return "var(--accent)"
  }
  const stateLabel = () => {
    switch (voiceState()) {
      case "listening":
        return "LISTENING…"
      case "thinking":
        return `${phrase().toUpperCase()}…`
      case "speaking":
        return "SPEAKING…"
      default:
        return "READY"
    }
  }
  const talkLabel = () => {
    switch (voiceState()) {
      case "listening":
        return "STOP & SEND"
      case "thinking":
        return "THINKING…"
      case "speaking":
        return "SPEAKING…"
      default:
        return "TAP TO TALK"
    }
  }
  const busy = () => voiceState() === "thinking" || voiceState() === "speaking"

  return (
    <div class="voice-page page-enter">
      <style>{VOICE_CSS}</style>

      <div class="voice-header card">
        <div class="hud-label voice-title">VOICE MODE</div>
        <div class="voice-subtitle">
          Tap the orb (or press Space) to talk — Jarvis listens, thinks, and replies out loud.
        </div>
      </div>

      <div class="voice-controls card">
        <label class="voice-field">
          <span class="hud-label voice-field-label">VOICE</span>
          <select
            class="voice-select"
            value={selectedVoice()}
            disabled={voices().length === 0}
            onChange={(e) => setSelectedVoice(e.currentTarget.value)}
          >
            <Show when={voices().length === 0}>
              <option value="">default</option>
            </Show>
            <For each={voices()}>{(v) => <option value={v.id}>{v.label}</option>}</For>
          </select>
        </label>
      </div>

      <div class="voice-stage card">
        <div class="voice-orb-halo" data-state={voiceState()}>
          <div class="voice-orb-ring" />
          <div class="voice-orb-ring" />
          <div class="voice-orb-ring" />
          <button
            type="button"
            class="voice-orb-core"
            style={{ transform: `scale(${coreScale()})` }}
            onClick={toggleRecording}
            disabled={MIC_UNSUPPORTED || busy()}
            aria-label="Tap to talk"
          >
            <ArcReactor size={148} tint={orbTint()} />
          </button>
        </div>

        <div class="hud-label voice-state-label" style={{ color: stateColor() }}>
          {stateLabel()}
        </div>

        <Show when={micError()}>
          <div class="voice-mic-warning">⚠ {micError()}</div>
        </Show>
        <Show when={heard()}>
          <div class="voice-heard">“{heard()}”</div>
        </Show>
        <Show when={reply()}>
          <div class="voice-reply">{reply()}</div>
        </Show>
        <Show when={error()}>
          <div class="voice-error">⚠ {error()}</div>
        </Show>

        <div class="voice-actions">
          <button
            type="button"
            class="voice-talk-btn"
            classList={{ "voice-talk-btn--active": voiceState() === "listening" }}
            onClick={toggleRecording}
            disabled={MIC_UNSUPPORTED || busy()}
          >
            {talkLabel()}
          </button>
          <Show when={voiceState() === "listening"}>
            <button type="button" class="voice-cancel-btn" onClick={cancelRecording}>
              Cancel
            </button>
          </Show>
        </div>

        <div class="voice-hint">SPACE talk/send · Esc cancel · try "what's on my screen?"</div>
      </div>
    </div>
  )
}

const page: PageDef = { id: "voice", label: "VOICE", section: "WORKSPACE", order: 2, component: VoicePage }
export default page
