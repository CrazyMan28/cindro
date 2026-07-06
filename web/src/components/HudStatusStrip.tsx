// Top telemetry bar, ported from desktop/qml/HudStatusStrip.qml: reactor
// mini, MCP server count, active-agent count (pulses while >0), LINK status
// (pulses while connected), and the "Search or jump…" ⌘K command bar.
//
// NOTE: the QML original also shows CPU/RAM/NET gauges and a plan/build/
// coworker mode chip — both read local host state a browser tab genuinely
// cannot see (Bridge.cpp polls /proc directly; there's no Contract A verb for
// it). Rather than fabricate numbers, this strip omits them; status.get's
// real mcp/agents_running fields and client.connected drive everything shown
// here.
import { createSignal, onCleanup, onMount } from "solid-js"

import { useApp } from "../core/app-context"
import { theme } from "../core/theme"
import { ArcReactor } from "./ArcReactor"

export function HudStatusStrip(props: { onOpenPalette: () => void }) {
  const app = useApp()
  const [connected, setConnected] = createSignal(false)
  const [version, setVersion] = createSignal("")
  const [mcpTotal, setMcpTotal] = createSignal(0)
  const [mcpEnabled, setMcpEnabled] = createSignal(0)
  const [agentsRunning, setAgentsRunning] = createSignal(0)

  const refreshStatus = async () => {
    if (!app.client.connected) return
    try {
      const res = await app.client.call("status.get", {}, 8000)
      if (typeof res.version === "string") setVersion(res.version)
      const mcp = (res.mcp ?? {}) as Record<string, unknown>
      setMcpTotal(Number(mcp.total ?? 0))
      setMcpEnabled(Number(mcp.enabled ?? 0))
      setAgentsRunning(Number(res.agents_running ?? 0))
    } catch {
      // best-effort — status.get may not exist on every daemon build
    }
  }

  onMount(() => {
    const poll = setInterval(() => setConnected(app.client.connected), 500)
    const statusPoll = setInterval(refreshStatus, 12000)
    void refreshStatus()
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(statusPoll)
    })
  })

  return (
    <div class="status-strip">
      <ArcReactor size={24} tint={connected() ? theme.accent : theme.textFaint} />

      <div class="status-stat">
        <span class="status-stat-label hud-label">MCP</span>
        <span class="status-stat-value">
          {mcpEnabled()}/{mcpTotal() || "—"}
        </span>
      </div>

      <div class="status-stat">
        <span class="status-stat-label hud-label">AGENTS</span>
        <span class="status-stat-value" classList={{ pulsing: agentsRunning() > 0 }}>
          {agentsRunning()}
        </span>
      </div>

      <button type="button" class="status-search" onClick={props.onOpenPalette}>
        <span class="status-search-icon">⌕</span>
        <span class="status-search-text">Search or jump…</span>
        <span class="status-search-kbd">⌘K</span>
      </button>

      <div class="status-link">
        <span class="status-link-dot" classList={{ connected: connected() }} />
        <span class="hud-label" style={{ color: connected() ? "var(--success)" : "var(--danger)" }}>
          {connected() ? "LINK" : "OFFLINE"}
        </span>
      </div>

      {version() && <span class="status-version">v{version()}</span>}
    </div>
  )
}
