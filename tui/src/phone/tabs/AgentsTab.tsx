// AGENTS tab — PhoneAgentsTab.qml parity: roster via list_extensions with a
// list_agents fallback, status pill + current task, CALL (call_extension —
// the agents-tab variant passes only {extension}, PhoneAgentsTab.qml:350),
// and the per-agent CONFIG panel: voice picker grouped by speaker with
// emotion chips + preview, speaking rate cycle 0.5×-2×, model chips and
// thinking-effort chips, each change saved immediately with a live status
// line (the QML behavior — there is no separate save button).

import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { useApp } from "../../app-context"
import { Picker } from "../../chat/Picker"
import { theme } from "../../theme"
import type { Row, VoiceEntry } from "../api"
import {
  asList,
  brainForAgent,
  DEFAULT_VOICES,
  httpFailure,
  parseVoice,
  phoneHttp,
  phoneMcp,
  SPEED_STEPS,
  str,
  THINKING_LEVELS,
  usePhonePoll,
} from "../api"
import { Chip, Hint, Section, StatusLine } from "../ui"
import type { TabProps } from "./CallsTab"

interface AgentRow {
  ext: string
  name: string
  status: string
  task: string
}

export function AgentsTab(props: TabProps) {
  const app = useApp()
  const [agents, setAgents] = createSignal<AgentRow[]>([])
  const [listError, setListError] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [status, setStatus] = createSignal("")

  // config panel state (PhoneAgentsTab.qml:52-60)
  const [cfg, setCfg] = createSignal<{ ext: string; name: string } | null>(null)
  const [voices, setVoices] = createSignal<VoiceEntry[]>([])
  const [voiceId, setVoiceId] = createSignal("")
  const [voiceName, setVoiceName] = createSignal("(default)")
  const [speed, setSpeed] = createSignal(1.0)
  const [model, setModel] = createSignal("")
  const [models, setModels] = createSignal<string[]>([])
  const [thinking, setThinking] = createSignal("low")
  const [cfgStatus, setCfgStatus] = createSignal("")
  const [voicePicker, setVoicePicker] = createSignal(false)

  createEffect(() => props.onModalChange?.(voicePicker()))
  onCleanup(() => props.onModalChange?.(false))

  const populate = (data: unknown) => {
    setAgents(
      asList(data).map((a: Row, i) => ({
        ext: str(a.extension) || str(a.ext),
        name: a.name !== undefined ? str(a.name) : `Agent ${i}`,
        status: str(a.status, "offline"),
        task: str(a.current_task),
      })),
    )
    setSelected((i) => Math.min(i, Math.max(0, agents().length - 1)))
  }

  const refresh = async () => {
    setListError("")
    const res = await phoneMcp(app.client, "list_extensions")
    if (!res.error) {
      populate(res.data)
      return
    }
    const res2 = await phoneMcp(app.client, "list_agents")
    if (res2.error) {
      setListError(res2.error.message || "Could not load agents.")
      return
    }
    populate(res2.data)
  }
  usePhonePoll(app.client, props.active, 10000, refresh)

  const openConfig = async (agent: AgentRow) => {
    setCfg({ ext: agent.ext, name: agent.name })
    setVoiceId("")
    setVoiceName("(default)")
    setSpeed(1.0)
    setModel("")
    setModels([])
    setThinking("low")
    setCfgStatus("Loading…")

    const vres = await phoneHttp(app.client, "GET", "/api/voices")
    const vfail = httpFailure(vres)
    const arr = vfail ? [] : asList(vres.data, "voices")
    if (arr.length > 0) setVoices(arr.map((v, i) => parseVoice(v, i)))
    else setVoices(DEFAULT_VOICES)
    if (vfail) setCfgStatus(`voices: ${vfail} — using built-in list`)

    const pres = await phoneHttp(app.client, "GET", `/api/extensions/${agent.ext}/voice`)
    const pfail = httpFailure(pres)
    if (!pfail && pres.data) {
      const d = (pres.data ?? {}) as Row
      setVoiceId(str(d.voice_id) || str(d.id))
      setVoiceName(str(d.voice_name) || str(d.name) || "(default)")
      if (d.speed !== undefined) setSpeed(Number(d.speed) || 1.0)
    } else if (pfail) setCfgStatus(`voice profile: ${pfail}`)

    // Live model ids for this agent's brain, same model.list RPC the main
    // Jarvis picker uses (Chat.tsx) — replaces the old hardcoded MODEL_CHIPS,
    // which went stale the same way the main picker's used to before it was
    // wired to model.list.
    const brain = brainForAgent(agent.name)
    let modelIds: string[] = []
    if (brain) {
      try {
        const mlres = await app.client.call("model.list", { brain }, 8000)
        modelIds = ((mlres.models ?? []) as unknown[]).map(String)
        // The user may have opened a DIFFERENT agent while this await was in
        // flight — cfg() would then no longer match, and applying this
        // response now would wire the wrong brain's model ids to whichever
        // agent is currently displayed.
        if (cfg()?.ext !== agent.ext) return
        setModels(modelIds)
      } catch {
        // leave modelIds/models empty — the MODEL section just won't render
      }
    }
    if (cfg()?.ext !== agent.ext) return

    const mres = await phoneHttp(app.client, "GET", `/api/extensions/${agent.ext}/model`)
    const mfail = httpFailure(mres)
    if (cfg()?.ext !== agent.ext) return
    if (!mfail && mres.data) {
      const d = (mres.data ?? {}) as Row
      setModel(str(d.model) || modelIds[0] || "")
      setThinking(str(d.reasoning) || str(d.thinking) || "low")
      setCfgStatus("")
    } else if (mfail) setCfgStatus(`model config: ${mfail}`)
    else setCfgStatus("")
  }

  const saveVoice = async (vid: string, vname: string) => {
    setVoiceId(vid)
    setVoiceName(vname)
    setCfgStatus("Saving…")
    const res = await phoneHttp(app.client, "PUT", `/api/extensions/${cfg()!.ext}/voice`, {
      voice_id: vid,
      speed: speed(),
    })
    const fail = httpFailure(res)
    setCfgStatus(fail ? `Voice error: ${fail}` : "Voice saved.")
  }

  const cycleSpeed = async () => {
    const idx = SPEED_STEPS.findIndex((s) => Math.abs(s - speed()) < 0.01)
    const next = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length]
    setSpeed(next)
    const res = await phoneHttp(app.client, "PUT", `/api/extensions/${cfg()!.ext}/voice`, {
      voice_id: voiceId(),
      speed: next,
    })
    const fail = httpFailure(res)
    setCfgStatus(fail ? `Speed error: ${fail}` : "Speed saved.")
  }

  const saveModelConfig = async (m: string, th: string) => {
    if (m) setModel(m)
    if (th) setThinking(th)
    setCfgStatus("Saving model config…")
    const res = await phoneHttp(app.client, "PUT", `/api/extensions/${cfg()!.ext}/model`, {
      model: model(),
      reasoning: thinking(),
    })
    const fail = httpFailure(res)
    setCfgStatus(fail ? `Model error: ${fail}` : "Model saved.")
  }

  const preview = async () => {
    const vid = voiceId()
    if (!vid) {
      setCfgStatus("No voice selected.")
      return
    }
    setCfgStatus("Previewing…")
    const res = await phoneHttp(app.client, "GET", `/api/voices/${encodeURIComponent(vid)}/sample`)
    setCfgStatus(httpFailure(res) ? "Preview unavailable on this server." : "Playing preview…")
  }

  const callAgent = async (agent: AgentRow) => {
    setStatus(`Calling ${agent.name} (ext ${agent.ext})…`)
    const res = await phoneMcp(app.client, "call_extension", { extension: agent.ext })
    setStatus(res.error ? `Error: ${res.error.message}` : `Ringing ext ${agent.ext}`)
  }

  const speakers = createMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of voices()) {
      if (!seen.has(v.speaker)) {
        seen.add(v.speaker)
        out.push(v.speaker)
      }
    }
    return out
  })

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || voicePicker()) return
      if (cfg()) {
        switch (key.name) {
          case "escape":
            key.preventDefault()
            setCfg(null)
            break
          case "v":
            setVoicePicker(true)
            break
          case "p":
            void preview()
            break
          case "s":
            void cycleSpeed()
            break
          case "m": {
            const opts = models()
            if (opts.length === 0) break
            const i = opts.indexOf(model())
            void saveModelConfig(opts[(i + 1) % opts.length], "")
            break
          }
          case "t": {
            const i = THINKING_LEVELS.indexOf(thinking())
            void saveModelConfig("", THINKING_LEVELS[(i + 1) % THINKING_LEVELS.length])
            break
          }
          default:
            break
        }
        return
      }
      switch (key.name) {
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, agents().length - 1), i + 1))
          break
        case "c": {
          const a = agents()[selected()]
          if (a) void callAgent(a)
          break
        }
        case "return": {
          const a = agents()[selected()]
          if (a) void openConfig(a)
          break
        }
        case "r":
          void refresh()
          break
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show
        when={cfg()}
        fallback={
          <>
            <Hint text="↑↓ pick · c call · Enter config · r refresh" />
            <Show when={listError()}>
              <StatusLine text={`Error: ${listError()}`} kind="error" />
            </Show>
            <Show when={status()}>
              <StatusLine text={status()} />
            </Show>
            <Section title="AGENTS" />
            <scrollbox flexGrow={1}>
              <For
                each={agents()}
                fallback={
                  <text fg={theme.textFaint}>
                    {listError() ? "(roster unavailable)" : "No agents registered."}
                  </text>
                }
              >
                {(a, i) => (
                  <box
                    flexDirection="row"
                    gap={1}
                    backgroundColor={i() === selected() ? theme.surfaceStrong : undefined}
                    onMouseDown={() => setSelected(i())}
                  >
                    <text
                      fg={a.status === "online" ? theme.success : theme.textMuted}
                      selectable={false}
                    >
                      [{a.status.toUpperCase()}]
                    </text>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      {a.name}
                    </text>
                    <text fg={theme.textFaint}>ext {a.ext}</text>
                    <text fg={theme.textMuted}>{a.task || "No current task"}</text>
                  </box>
                )}
              </For>
            </scrollbox>
          </>
        }
      >
        {(c) => (
          <>
            <Hint text="v voice picker · p preview · s speed · m model · t thinking · Esc back" />
            <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
              CONFIG · {c().name} (ext {c().ext})
            </text>
            <Show when={cfgStatus()}>
              <StatusLine text={cfgStatus()} />
            </Show>
            <scrollbox flexGrow={1}>
              <Section title="VOICE" />
              <text fg={theme.accent}>Current: {voiceName()}</text>
              <For each={speakers()}>
                {(sp) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.textFaint} selectable={false}>
                      {sp.padEnd(8)}
                    </text>
                    <For each={voices().filter((v) => v.speaker === sp)}>
                      {(v) => <Chip label={v.emotion} on={voiceId() === v.vid} />}
                    </For>
                  </box>
                )}
              </For>
              <Section title="SPEAKING RATE" />
              <box flexDirection="row" gap={2}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  {Math.round(speed() * 100) / 100}×
                </text>
                <text fg={theme.textFaint} selectable={false}>
                  0.5× slow · 1× normal · 2× fast (s cycles)
                </text>
              </box>
              <Section title="MODEL" />
              <box flexDirection="row" gap={1}>
                <For each={models()}>
                  {(id) => <Chip label={id} on={model() === id} />}
                </For>
              </box>
              <text fg={theme.textFaint} selectable={false}>
                Thinking
              </text>
              <box flexDirection="row" gap={1}>
                <For each={THINKING_LEVELS}>
                  {(th) => <Chip label={th} on={thinking() === th} />}
                </For>
              </box>
            </scrollbox>
          </>
        )}
      </Show>

      <Show when={voicePicker()}>
        <Picker
          title={`VOICE · ${cfg()?.name ?? ""}`}
          options={voices().map((v) => ({
            label: `${v.speaker} · ${v.emotion}`,
            description: v.vid || "(server default)",
            value: v.vid,
          }))}
          onPick={(vid) => {
            const v = voices().find((x) => x.vid === vid)
            setVoicePicker(false)
            void saveVoice(vid, v?.emotion ?? v?.vname ?? "(default)")
          }}
          onCancel={() => setVoicePicker(false)}
        />
      </Show>
    </box>
  )
}
