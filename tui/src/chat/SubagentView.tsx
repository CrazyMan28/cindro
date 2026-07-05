// <SubagentView/> — watch a running subagent's OWN chat. Subagents are child
// sessions (their own session_id); this binds a fresh SessionController to
// that id, loads its history, subscribes for live events, and renders the
// same <Transcript>. Opened from an inline subagent card or the /agents
// subpage. Read-only: you observe, you don't type into it.

import { onCleanup, onMount } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import { SessionController } from "./session"
import { Transcript } from "./Transcript"

export function SubagentView(props: { sessionId: string; onClose: () => void }) {
  const app = useApp()
  const controller = new SessionController(app.client)

  onMount(() => {
    void controller
      .openSession(props.sessionId, `subagent ${props.sessionId.slice(0, 8)}`)
      .catch((e) => controller.notice(`couldn't attach: ${String(e)}`, "error"))
  })
  onCleanup(() => controller.dispose())

  return (
    <box flexDirection="column" flexGrow={1} border borderColor={theme.violet}>
      <text fg={theme.violet} selectable={false}>
        ◇ subagent chat · Esc → back
      </text>
      <Transcript session={controller} />
    </box>
  )
}
