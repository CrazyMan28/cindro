// SCREENING tab — PhoneScreeningTab.qml parity: polls get_screening_status
// every 4s (paused while hidden — the phone_pane.py pause_timers
// convention), caller/agent info card, live transcript bubbles, and the
// pulsing active dot (terminal translation: ● alternating bright/dim on the
// QML's 700ms half-period).

import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../app-context"
import { theme } from "../../theme"
import type { Row, TranscriptLine } from "../api"
import { asList, phoneMcp, str, usePhonePoll } from "../api"
import { Hint, Section } from "../ui"
import type { TabProps } from "./CallsTab"

export function ScreeningTab(props: TabProps) {
  const app = useApp()
  const [active, setActive] = createSignal(false)
  const [callerNum, setCallerNum] = createSignal("")
  const [callerName, setCallerName] = createSignal("")
  const [agentExt, setAgentExt] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("No active screening session")
  const [transcript, setTranscript] = createSignal<TranscriptLine[]>([])
  const [dotOn, setDotOn] = createSignal(true)

  const refresh = async () => {
    const res = await phoneMcp(app.client, "get_screening_status")
    if (res.error) {
      setStatusLine(`Error: ${res.error.message}`)
      setActive(false)
      return
    }
    const d = (res.data ?? {}) as Row
    setActive(Boolean(d.active))
    setCallerNum(str(d.caller_number))
    setCallerName(str(d.caller_name))
    setAgentExt(str(d.agent_extension))
    setStatusLine(d.active ? "Screening in progress" : "No active screening session")
    setTranscript(
      asList(d.transcript).map((m: Row): TranscriptLine => ({
        speaker:
          str(m.speaker) ||
          (m.from_extension !== undefined ? `ext ${str(m.from_extension)}` : "?"),
        body: str(m.text) || str(m.content) || str(m.message),
        isAgent: Boolean(m.is_agent || (m.speaker && m.speaker !== "caller")),
      })),
    )
  }
  usePhonePoll(app.client, props.active, 4000, refresh)

  onMount(() => {
    const timer = setInterval(() => setDotOn((v) => !v), 700)
    onCleanup(() => clearInterval(timer))
  })

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active()) return
      if (key.name === "r") void refresh()
    },
    {},
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <Section title="LIVE SCREENING" />
        <text
          fg={active() ? (dotOn() ? theme.success : theme.textFaint) : theme.textFaint}
          selectable={false}
        >
          ●
        </text>
        <Hint text="r refresh" />
      </box>

      <box
        flexDirection="column"
        flexShrink={0}
        border
        borderColor={active() ? theme.accent : theme.hairlineSoft}
      >
        <text
          fg={active() ? theme.accentBright : theme.textMuted}
          attributes={TextAttributes.BOLD}
          selectable={false}
        >
          {statusLine()}
        </text>
        <Show when={active()}>
          <box flexDirection="row" gap={4}>
            <box flexDirection="column">
              <text fg={theme.textFaint} selectable={false}>
                CALLER
              </text>
              <text fg={theme.text}>
                {callerName()
                  ? `${callerName()}  ${callerNum()}`
                  : callerNum() || "Unknown"}
              </text>
            </box>
            <box flexDirection="column">
              <text fg={theme.textFaint} selectable={false}>
                SCREENING AGENT
              </text>
              <text fg={theme.accent}>{agentExt() ? `ext ${agentExt()}` : "—"}</text>
            </box>
          </box>
        </Show>
      </box>

      <Section title="TRANSCRIPT" />
      <scrollbox flexGrow={1}>
        <For
          each={transcript()}
          fallback={
            <text fg={theme.textFaint}>
              {active() ? "Awaiting transcript…" : "No screening in progress"}
            </text>
          }
        >
          {(line) => (
            <box flexDirection="column" paddingLeft={line.isAgent ? 4 : 0}>
              <text fg={line.isAgent ? theme.accent : theme.amber} selectable={false}>
                {line.speaker.toUpperCase()}
              </text>
              <text fg={line.isAgent ? theme.accentBright : theme.text} wrapMode="word">
                {line.body}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}
