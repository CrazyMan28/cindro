// <VoicePage/> — push-to-talk voice mode, a faithful port of
// cli/jarvis_cli/tui/voice_mode.py's VoiceModeScreen (see that file's module
// docstring for why this is push-to-talk rather than the GUI's hands-free
// duplex: continuous-capture + local VAD has no sane terminal equivalent).
//
// State machine: idle -> listening -> thinking -> speaking -> idle.
//   SPACE toggles record/stop-and-send; auto-stops at MAX_RECORD_SECONDS as
//   a backstop under the manual toggle (recordWav's own `-d` cap is the
//   hard backstop underneath THAT — see src/voice/audio.ts).
//   record -> voice.stt -> session.send (adopted into a SessionController so
//   we watch its items/busy signals instead of hand-rolling the raw
//   AsyncQueue the way voice_mode.py's `_await_assistant_reply` does) ->
//   voice.tts -> playWav.
//   'b'/'m'/'v' open brain/model/voice pickers (same settings.get/
//   model.list/voice.list_voices calls Chat.tsx's pickers use); picking a
//   brain/model drops the current SessionController so the next turn opens
//   a fresh session with the new brain (mirrors action_pick_brain/model's
//   `self.session_id = ""` reset).
//   Escape cancels an in-flight recording without sending it.

import { TextAttributes } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { Picker } from "../chat/Picker"
import { SessionController } from "../chat/session"
import { theme } from "../theme"
import { ArcReactor } from "../ui/ArcReactor"
import { playWav, recordWav, stopRecording } from "../voice/audio"
import type { CanvasStore } from "../widgets/store"
import { Widget } from "../widgets/Widget"

export interface VoicePageProps {
  active: () => boolean
  store?: CanvasStore
}

type VoiceState = "idle" | "listening" | "thinking" | "speaking"

const STATE_LABELS: Record<Exclude<VoiceState, "thinking">, string> = {
  idle: "READY — press space to talk",
  listening: "LISTENING…",
  speaking: "SPEAKING…",
}

const MAX_RECORD_SECONDS = 100
const PHRASE_ROTATE_MS = 2500

// 60+ original Jarvis-flavored "thinking" phrases (in the spirit of
// VoiceMode.qml's ~200-entry WORK_PHRASES / voice_mode.py's THINKING_PHRASES,
// written fresh for this port rather than copied from either).
export const THINKING_PHRASES = [
  "Polishing the arc reactor", "Recalibrating the neural lattice", "Spinning up the repulsors",
  "Cross-checking the telemetry", "Rerouting auxiliary power", "Syncing with the mothership",
  "Decompiling your intentions", "Warming the vacuum tubes", "Consulting the holotable",
  "Threading the quantum needle", "Pinging low orbit", "Indexing the archive",
  "Sharpening Occam's razor", "Rebalancing the servos", "Distilling the signal from the noise",
  "Booting the backup brain", "Whispering to the mainframe", "Untangling the wiring harness",
  "Running a diagnostic sweep", "Calibrating the sensors", "Priming the thruster array",
  "Negotiating with the firmware", "Fetching the missing puzzle piece", "Aligning the satellite dish",
  "Draining the capacitor bank", "Sketching a contingency plan", "Rendering the next move",
  "Sifting through the archives", "Consulting the old blueprints", "Adjusting the parameters",
  "Spooling up the turbines", "Chasing down a stray electron", "Refactoring on the fly",
  "Rebooting the imagination engine", "Fine-tuning the amplifier", "Assembling the response",
  "Scanning for anomalies", "Cross-referencing the manuals", "Overclocking the processor",
  "Balancing the equations", "Testing a hypothesis", "Consulting the star charts",
  "Weighing the options", "Powering the auxiliary core", "Untangling a knot of logic",
  "Reviewing the schematics", "Assembling the toolkit", "Compiling the response",
  "Grinding through the numbers", "Locking onto the target", "Charting a course",
  "Verifying the coordinates", "Warming up the diagnostics", "Double-checking the math",
  "Syncing the databanks", "Coaxing the algorithm", "Rewiring a shortcut",
  "Reading between the lines", "Running the simulation", "Tuning the frequency",
  "Loading the countermeasures", "Stress-testing the theory", "Polishing the final answer",
  "Bracing for a breakthrough", "Assembling the pieces", "Querying the knowledge base",
  "Distilling wisdom from chaos",
]

interface PickerState {
  title: string
  options: Array<{ label: string; description?: string; value: string }>
  onPick: (value: string) => void
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function pickPhrase(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]
}

/** Waits for the SessionController to land a fresh assistant reply (any item
 * pushed after `sinceId`), instead of hand-rolling `client.queueFor(...)`
 * the way voice_mode.py's `_await_assistant_reply` does. */
async function awaitReply(
  session: SessionController,
  sinceId: number,
  timeoutMs: number,
  isAlive: () => boolean,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error("voice page closed")
    if (!session.busy()) {
      for (let i = session.items.length - 1; i >= 0; i--) {
        const item = session.items[i]
        if (item.id <= sinceId) break
        if (item.kind === "assistant" && item.text.trim()) return item.text.trim()
        if (item.kind === "error") throw new Error(item.message)
      }
    }
    await sleep(50)
  }
  throw new Error("timed out waiting for a reply")
}

export function VoicePage(props: VoicePageProps) {
  const app = useApp()
  const [state, setState] = createSignal<VoiceState>("idle")
  const [phrase, setPhrase] = createSignal(pickPhrase())
  const [heard, setHeard] = createSignal("")
  const [reply, setReply] = createSignal("")
  const [error, setError] = createSignal("")
  const [brain, setBrain] = createSignal("")
  const [model, setModel] = createSignal("")
  const [voice, setVoice] = createSignal("")
  const [picker, setPicker] = createSignal<PickerState | null>(null)

  let session: SessionController | null = null
  let recordPromise: ReturnType<typeof recordWav> | null = null
  let recordStartedAt = 0
  let alive = true

  const ensureSessionController = (): SessionController => {
    if (!session) session = new SessionController(app.client)
    return session
  }

  /** Drops the current SessionController so the next turn opens a fresh
   * session (mirrors voice_mode.py resetting `self.session_id` on a
   * brain/model change). dispose() stops its background event pump; we
   * deliberately don't also unsubscribe the old session id here, matching
   * the python source's own behavior (it never unsubscribes on a switch
   * either — only on_unmount does). */
  const resetSession = () => {
    session?.dispose()
    session = null
  }

  const fail = (message: string) => {
    if (!alive) return
    setError(message)
    setState("idle")
  }

  const startRecording = () => {
    setError("")
    setHeard("")
    setReply("")
    setState("listening")
    recordStartedAt = Date.now()
    recordPromise = recordWav(MAX_RECORD_SECONDS)
  }

  const ensureVoiceSession = async (s: SessionController): Promise<void> => {
    if (s.sessionId()) return
    if (!brain() && !model()) return // s.send() will lazily create one itself
    const params: Record<string, unknown> = { profile: "coworker" }
    if (brain()) params.brain = brain()
    if (model()) params.model = model()
    const res = await app.client.call("session.create", params, 20000)
    const sid = String(res.session_id ?? "")
    if (!sid) throw new Error("session.create returned no session_id")
    await s.openSession(sid)
  }

  const sendAndSpeak = async (text: string): Promise<void> => {
    const s = ensureSessionController()
    await ensureVoiceSession(s)
    const sinceId = s.items.length ? s.items[s.items.length - 1].id : 0
    await s.send(text)
    const replyText = await awaitReply(s, sinceId, 30000, () => alive)
    if (!alive) return
    setReply(replyText)
    setState("speaking")
    await speak(replyText)
  }

  const speak = async (text: string): Promise<void> => {
    const params: Record<string, unknown> = { text, format: "wav" }
    if (voice()) params.voice = voice()
    let res: Record<string, unknown>
    try {
      res = await app.client.call("voice.tts", params, 30000)
    } catch (e) {
      if (alive) setError(String(e))
      return
    }
    const b64 = String(res.audio_b64 ?? "")
    if (!b64) return
    try {
      await playWav(b64)
    } catch (e) {
      if (alive) setError(`playback error: ${String(e)}`)
    }
  }

  const stopAndSend = async (): Promise<void> => {
    recordStartedAt = 0
    setState("thinking")
    setPhrase(pickPhrase()) // don't leave a stale LISTENING label up for 2.5s
    const p = recordPromise
    recordPromise = null
    stopRecording()
    if (!p) return fail("no audio captured")
    const result = await p
    if (!alive) return
    if ("error" in result) return fail(result.error)

    let sttRes: Record<string, unknown>
    try {
      // Params/result names per voice_mode.py's handleVoiceStt call exactly
      // (audio_b64 / mime / text) — NOT the {format:"wav"} shape voice.tts
      // uses; the two verbs take different param shapes on this daemon.
      sttRes = await app.client.call(
        "voice.stt",
        { audio_b64: result.b64, mime: "audio/wav" },
        30000,
      )
    } catch (e) {
      return fail(String(e))
    }
    if (!alive) return
    const text = String(sttRes.text ?? "").trim()
    setHeard(text)
    if (!text) {
      setState("idle")
      return
    }
    try {
      await sendAndSpeak(text)
    } catch (e) {
      return fail(String(e))
    }
    if (!alive) return
    setState("idle")
  }

  const toggleRecord = () => {
    if (state() === "idle") startRecording()
    else if (state() === "listening") void stopAndSend()
    // busy (thinking/speaking) — ignore extra presses, same as the py.
  }

  const cancelRecording = () => {
    if (state() !== "listening") return
    recordStartedAt = 0
    const p = recordPromise
    recordPromise = null
    stopRecording()
    // Deliberately discard the in-flight recording's result — this is a
    // user-requested cancel, not a swallowed error.
    if (p) void p.catch(() => {})
    setState("idle")
  }

  onMount(() => {
    const phraseTimer = setInterval(() => {
      if (state() === "thinking") setPhrase(pickPhrase())
    }, PHRASE_ROTATE_MS)
    const capTimer = setInterval(() => {
      if (
        state() === "listening" &&
        recordStartedAt &&
        Date.now() - recordStartedAt >= MAX_RECORD_SECONDS * 1000
      ) {
        void stopAndSend()
      }
    }, 1000)
    onCleanup(() => {
      alive = false
      clearInterval(phraseTimer)
      clearInterval(capTimer)
      stopRecording()
      if (session) {
        const sid = session.sessionId()
        session.dispose()
        if (sid) void app.client.unsubscribe(sid).catch(() => {})
        session = null
      }
    })
  })

  // -- brain / model / voice pickers (same calls Chat.tsx's pickers use) ------
  const callOrNotify = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    try {
      return await app.client.call(method, params, 15000)
    } catch (e) {
      app.notify(String(e), "error")
      return null
    }
  }

  const pickBrain = async () => {
    const res = await callOrNotify("settings.get", {})
    if (!res) return
    const settings = (res.settings ?? res) as Record<string, unknown>
    const brains = ((settings.brains ?? ["codex", "claude", "api"]) as unknown[]).map(String)
    const available = (settings.available_brains ?? {}) as Record<string, unknown>
    const current = brain() || String(settings.default_brain ?? "")
    setPicker({
      title: "BRAIN",
      options: brains.map((b) => ({
        label:
          b + (b === current ? " (current)" : "") + (available[b] === false ? " (unavailable)" : ""),
        value: b,
      })),
      onPick: (v) => {
        setBrain(v)
        setModel("")
        resetSession()
      },
    })
  }

  const pickModel = async () => {
    const res = await callOrNotify("model.list", brain() ? { brain: brain() } : {})
    if (!res) return
    const models = ((res.models ?? []) as unknown[]).map(String)
    if (!models.length) return app.notify("no models available", "warn")
    setPicker({
      title: "MODEL",
      options: models.map((m) => ({ label: m + (m === model() ? " (current)" : ""), value: m })),
      onPick: (v) => {
        setModel(v)
        resetSession()
      },
    })
  }

  const pickVoice = async () => {
    const res = await callOrNotify("voice.list_voices", {})
    if (!res) return
    const voices = (res.voices ?? []) as Array<Record<string, unknown>>
    if (!voices.length) return app.notify("no voices available", "warn")
    setPicker({
      title: "VOICE",
      options: voices.map((v) => {
        const vid = String(v.id ?? "")
        return { label: String(v.label ?? vid) + (vid === voice() ? " (current)" : ""), value: vid }
      }),
      onPick: (v) => setVoice(v),
    })
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || picker()) return
      if (key.name === "space") toggleRecord()
      else if (key.name === "escape") cancelRecording()
      else if (key.name === "b") void pickBrain()
      else if (key.name === "m") void pickModel()
      else if (key.name === "v") void pickVoice()
    },
    {},
  )

  const stateLabel = () => {
    const s = state()
    return s === "thinking" ? `${phrase().toUpperCase()}…` : STATE_LABELS[s]
  }
  const prefsLine = () =>
    `BRAIN ${brain() || "default"}  ·  MODEL ${model() || "default"}  ·  VOICE ${voice() || "default"}`

  return (
    <box flexDirection="row" flexGrow={1} gap={2} padding={1}>
      <box flexDirection="column" alignItems="center" flexGrow={1}>
        <ArcReactor size={15} thinking={state() === "listening" || state() === "thinking"} />
        <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
          {stateLabel()}
        </text>
        <Show when={heard()}>
          <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} selectable={false}>
            "{heard()}"
          </text>
        </Show>
        <Show when={reply()}>
          <text fg={theme.text} selectable={false} wrapMode="word">
            {reply()}
          </text>
        </Show>
        <Show when={error()}>
          <text fg={theme.danger} selectable={false} wrapMode="word">
            ⚠ {error()}
          </text>
        </Show>
        <text fg={theme.textFaint} selectable={false}>
          {prefsLine()}
        </text>
        <text fg={theme.textFaint} selectable={false}>
          SPACE talk/send · b brain · m model · v voice · Esc cancel
        </text>
      </box>
      <Show when={props.store}>
        {(store) => (
          <box flexDirection="column" width={30} flexShrink={0} border borderColor={theme.hairline}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
              WIDGETS
            </text>
            <For each={store().items().slice(0, 3)}>
              {(item) => (
                <box
                  flexDirection="column"
                  border
                  borderColor={theme.hairlineSoft}
                  padding={1}
                  flexShrink={0}
                >
                  <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
                    {item.title}
                  </text>
                  <Widget spec={item.spec} />
                </box>
              )}
            </For>
          </box>
        )}
      </Show>
      <Show when={picker()}>
        {(p) => (
          <Picker
            title={p().title}
            options={p().options}
            onPick={(v) => {
              setPicker(null)
              p().onPick(v)
            }}
            onCancel={() => setPicker(null)}
          />
        )}
      </Show>
    </box>
  )
}
