// CALLS tab — terminal analog of PhoneDialerTab.qml: quick-dial chips
// (101-105 + 900), free-text dial (numeric /^\d{1,6}$/ → call_extension,
// else call_user — phone_pane.py:dial), IN-APP/PSTN extended dialer with
// reason + TTS "say" (twilio_call_and_wait), the active-calls list with
// state coloring, per-call transcript, and end-call. Polls
// list_active_calls every 3s, paused while the tab is hidden.

import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"

import { useApp } from "../../app-context"
import { theme } from "../../theme"
import type { Row, TranscriptLine } from "../api"
import {
  asList,
  callStateColor,
  EXTENSION_RE,
  mergeTranscript,
  phoneMcp,
  QUICK_DIAL,
  str,
  usePhonePoll,
} from "../api"
import type { PromptSpec } from "../ui"
import { Chip, Hint, PromptBar, Section, StatusLine } from "../ui"

export interface TabProps {
  active: () => boolean
  onModalChange?: (open: boolean) => void
}

export function CallsTab(props: TabProps) {
  const app = useApp()
  const [calls, setCalls] = createSignal<Row[]>([])
  const [selected, setSelected] = createSignal(0)
  const [status, setStatus] = createSignal("")
  const [statusKind, setStatusKind] = createSignal<"info" | "error" | "success">("info")
  const [transcriptFor, setTranscriptFor] = createSignal("")
  const [transcript, setTranscript] = createSignal<TranscriptLine[]>([])
  const [pstn, setPstn] = createSignal(false)
  const [prompt, setPrompt] = createSignal<PromptSpec | null>(null)

  createEffect(() => props.onModalChange?.(prompt() !== null))
  onCleanup(() => props.onModalChange?.(false))

  const note = (msg: string, kind: "info" | "error" | "success" = "info") => {
    setStatus(msg)
    setStatusKind(kind)
  }

  const refresh = async () => {
    const res = await phoneMcp(app.client, "list_active_calls")
    if (res.error) {
      note(`list_active_calls: ${res.error.message}`, "error")
      return
    }
    const list = asList(res.data)
    setCalls(list)
    setSelected((i) => Math.min(i, Math.max(0, list.length - 1)))
  }
  usePhonePoll(app.client, props.active, 3000, refresh)

  const dialExtension = async (ext: string) => {
    note(`Ringing ${ext}…`)
    const res = await phoneMcp(app.client, "call_extension", {
      from_extension: "100",
      extension: ext,
    })
    if (res.error) note(`Error: ${res.error.message}`, "error")
    else note(`Connected to ${ext}`, "success")
    void refresh()
  }

  const dialUser = async (reason: string) => {
    note("Calling user…")
    const res = await phoneMcp(app.client, "call_user", { reason })
    if (res.error) note(`Error: ${res.error.message}`, "error")
    else note("In-app call placed", "success")
    void refresh()
  }

  /** Numeric → extension dial, anything else → in-app user call (the QML
   * call-button split, PhoneDialerTab.qml:242-245 / phone_pane.py:261). */
  const dial = (target: string) => {
    const t = target.trim()
    if (!t) return
    if (EXTENSION_RE.test(t)) void dialExtension(t)
    else void dialUser(t)
  }

  const loadTranscript = async (callId: string) => {
    setTranscriptFor(callId)
    setTranscript([])
    const res = await phoneMcp(app.client, "get_call_transcript", { call_id: callId })
    if (res.error) {
      note(`transcript: ${res.error.message}`, "error")
      return
    }
    setTranscript(mergeTranscript(res.data))
  }

  const endCall = async (callId: string) => {
    const res = await phoneMcp(app.client, "end_call", { call_id: callId })
    if (res.error) note(`end_call: ${res.error.message}`, "error")
    else note("Call ended", "success")
    if (transcriptFor() === callId) {
      setTranscriptFor("")
      setTranscript([])
    }
    void refresh()
  }

  /** Staged extended-dial flow — IN-APP: reason → call_user; PSTN: number →
   * reason → say → twilio_call_and_wait (PhoneDialerTab.qml:465-480). */
  const extendedDial = () => {
    if (!pstn()) {
      setPrompt({
        label: "Reason (in-app call to user)",
        onSubmit: (reason) => {
          setPrompt(null)
          void dialUser(reason.trim() || "Calling from desktop")
        },
      })
      return
    }
    setPrompt({
      label: "Phone number +1XXXXXXXXXX",
      onSubmit: (num) => {
        const toNumber = num.trim()
        if (!toNumber) {
          setPrompt(null)
          return
        }
        setPrompt({
          label: "Reason (e.g. Approval needed)",
          onSubmit: (reason) => {
            setPrompt({
              label: "Say (TTS spoken on PSTN call)",
              onSubmit: (say) => {
                setPrompt(null)
                note("Placing PSTN call…")
                void phoneMcp(app.client, "twilio_call_and_wait", {
                  to_number: toNumber,
                  reason: reason.trim() || "Desktop call",
                  say,
                }).then((res) => {
                  if (res.error) note(`PSTN Error: ${res.error.message}`, "error")
                  else note("PSTN call placed", "success")
                  void refresh()
                })
              },
            })
          },
        })
      },
    })
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active()) return
      if (prompt()) {
        if (key.name === "escape") {
          key.preventDefault()
          setPrompt(null)
        }
        return
      }
      const chip = Number.parseInt(key.name ?? "", 10)
      if (Number.isInteger(chip) && chip >= 1 && chip <= QUICK_DIAL.length) {
        void dialExtension(QUICK_DIAL[chip - 1])
        return
      }
      switch (key.name) {
        case "d":
          setPrompt({
            label: "Dial (extension or reason text)",
            onSubmit: (t) => {
              setPrompt(null)
              dial(t)
            },
          })
          break
        case "p":
          setPstn((v) => !v)
          break
        case "x":
          extendedDial()
          break
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, calls().length - 1), i + 1))
          break
        case "t":
        case "return": {
          const c = calls()[selected()]
          if (c) void loadTranscript(str(c.id))
          break
        }
        case "e": {
          const c = calls()[selected()]
          if (c) void endCall(str(c.id))
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
      <Hint text="1-6 quick dial · d dial · p in-app/pstn · x extended call · ↑↓ pick · t transcript · e end · r refresh" />

      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.textFaint} selectable={false}>
          QUICK
        </text>
        <For each={QUICK_DIAL}>
          {(ext, i) => (
            <text fg={theme.accent} selectable={false} onMouseDown={() => void dialExtension(ext)}>
              {`${i() + 1}:${ext}`}
            </text>
          )}
        </For>
      </box>

      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.textFaint} selectable={false}>
          MODE
        </text>
        <Chip label="IN-APP" on={!pstn()} />
        <Chip label="PSTN" on={pstn()} />
        <Show when={pstn()}>
          <text fg={theme.textFaint} selectable={false}>
            x → number · reason · say (TTS via twilio_call_and_wait)
          </text>
        </Show>
      </box>

      <Show when={status()}>
        <StatusLine text={status()} kind={statusKind()} />
      </Show>

      <Section title="ACTIVE CALLS" />
      <scrollbox flexGrow={1}>
        <For
          each={calls()}
          fallback={<text fg={theme.textFaint}>(no active calls)</text>}
        >
          {(c, i) => (
            <box
              flexDirection="row"
              gap={1}
              backgroundColor={i() === selected() ? theme.surfaceStrong : undefined}
              onMouseDown={() => setSelected(i())}
            >
              <text fg={callStateColor(str(c.state))} selectable={false}>
                ●
              </text>
              <text fg={theme.text}>{str(c.reason) || `Call ${str(c.id)}`}</text>
              <text fg={theme.textMuted}>
                {str(c.from_extension, "—")} → {str(c.to_extension, "—")} [{str(c.state, "unknown")}]
              </text>
            </box>
          )}
        </For>
      </scrollbox>

      <Show when={transcriptFor()}>
        <box flexDirection="column" flexShrink={0} border borderColor={theme.hairline}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
            TRANSCRIPT · {transcriptFor()}
          </text>
          <scrollbox height={6}>
            <For
              each={transcript()}
              fallback={<text fg={theme.textFaint}>(no messages yet)</text>}
            >
              {(line) => (
                <text fg={line.isAgent ? theme.accentBright : theme.text} wrapMode="word">
                  [{line.speaker}] {line.body}
                </text>
              )}
            </For>
          </scrollbox>
        </box>
      </Show>

      <Show when={prompt()} keyed>
        {(p) => <PromptBar prompt={p} />}
      </Show>
    </box>
  )
}
