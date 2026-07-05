// Topbar — the HUD status strip (GUI HudStatusStrip parity, minus the
// pieces later phases add): mini arc reactor, wordmark, daemon identity,
// agent-mode chip, LIVE MCP/AGENTS counters (status.get — the GUI hardcoded
// mcpCount=1 for months), and the LINK/OFFLINE dot.

import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import { ArcReactor } from "./ArcReactor"

interface StatusInfo {
  version: string
  brain: string
  mcpEnabled: number
  mcpTotal: number
  agentsRunning: number
}

const POLL_MS = 5000

export function Topbar() {
  const app = useApp()
  const [status, setStatus] = createSignal<StatusInfo | null>(null)
  const [mode, setMode] = createSignal("")
  const [connected, setConnected] = createSignal(false)

  const refresh = async () => {
    setConnected(app.client.connected)
    try {
      const s = await app.client.call("status.get", {}, 4000)
      const mcp = (s.mcp ?? {}) as Record<string, unknown>
      setStatus({
        version: String(s.version ?? "?"),
        brain: String(s.default_brain ?? "?"),
        mcpEnabled: Number(mcp.enabled ?? 0),
        mcpTotal: Number(mcp.total ?? 0),
        agentsRunning: Number(s.agents_running ?? 0),
      })
      setConnected(true)
    } catch {
      setStatus(null)
      setConnected(app.client.connected)
    }
    try {
      const s = await app.client.call("settings.get", {}, 4000)
      const settings = (s.settings ?? s) as Record<string, unknown>
      setMode(String(settings.agent_mode ?? ""))
    } catch {
      // keep the previous mode chip on transient errors
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    // Settings changes (F3 mode cycle, Settings page) should reflect fast.
    const offSession = app.client.on("session.opened", () => void refresh())
    onCleanup(() => {
      clearInterval(timer)
      offSession()
    })
  })

  return (
    <box
      flexDirection="row"
      alignItems="center"
      gap={2}
      paddingLeft={1}
      paddingRight={1}
      border={["bottom"]}
      borderColor={theme.hairlineSoft}
    >
      <ArcReactor size={5} thinking={!connected} />
      <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
        J.A.R.V.I.S
      </text>
      <Show
        when={status()}
        fallback={
          <text fg={theme.textFaint} selectable={false}>
            daemon unreachable — jarvis start / jarvis doctor
          </text>
        }
      >
        {(s) => (
          <>
            <text fg={theme.textMuted} selectable={false}>
              jarvisd v{s().version} · {s().brain}
            </text>
            <Show when={mode()}>
              <text fg={theme.amber} selectable={false}>
                mode: {mode()}
              </text>
            </Show>
            <text fg={theme.textMuted} selectable={false}>
              MCP {s().mcpEnabled}/{s().mcpTotal}
            </text>
            <text fg={theme.textMuted} selectable={false}>
              AGENTS {s().agentsRunning}
            </text>
          </>
        )}
      </Show>
      <box flexGrow={1} />
      <text
        fg={connected() ? theme.success : theme.danger}
        attributes={TextAttributes.BOLD}
        selectable={false}
      >
        {connected() ? "● LINK" : "○ OFFLINE"}
      </text>
    </box>
  )
}
