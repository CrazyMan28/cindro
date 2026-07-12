// SCREENING tab body — ported from desktop/qml/PhoneScreeningTab.qml (cross-
// checked against tui/src/phone/tabs/ScreeningTab.tsx for the exact
// phone.mcp call shape). Polls `get_screening_status` every 4s while this
// tab is active, rendering the live caller/agent info card and a chat-bubble
// transcript — caller on the left, agent on the right — same as the
// QML/TUI originals.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { ControlClient } from "../../core/control-client"
import { PhoneTabPanel, usePhoneTab } from "./index"

interface PhoneErr {
  code: string
  message: string
}
interface McpRes {
  tool?: string
  data?: unknown
  text?: string
  error?: PhoneErr
}
type Row = Record<string, unknown>

async function phoneMcp(client: ControlClient, name: string, args: Row = {}): Promise<McpRes> {
  try {
    return (await client.call("phone.mcp", { name, arguments: args }, 30000)) as McpRes
  } catch (e) {
    return { tool: name, error: { code: "transport_error", message: String(e) } }
  }
}

function asList(data: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(data)) return data as Row[]
  if (typeof data === "object" && data !== null) {
    for (const k of keys) {
      const v = (data as Row)[k]
      if (Array.isArray(v)) return v as Row[]
    }
  }
  return []
}

function str(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v)
}

interface TranscriptLine {
  speaker: string
  body: string
  isAgent: boolean
}

export function PhoneScreeningTab() {
  const app = useApp()
  const shell = usePhoneTab()
  const active = () => shell.tab() === "screening"

  const [connected, setConnected] = createSignal(app.client.connected)
  const [callActive, setCallActive] = createSignal(false)
  const [callerNum, setCallerNum] = createSignal("")
  const [callerName, setCallerName] = createSignal("")
  const [agentExt, setAgentExt] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("No active screening session")
  const [transcript, setTranscript] = createSignal<TranscriptLine[]>([])

  onMount(() => {
    const poll = setInterval(() => setConnected(app.client.connected), 500)
    onCleanup(() => clearInterval(poll))
  })

  const refresh = async () => {
    const res = await phoneMcp(app.client, "get_screening_status")
    if (res.error) {
      setStatusLine(`Error: ${res.error.message}`)
      setCallActive(false)
      return
    }
    const d = (res.data ?? {}) as Row
    const isActive = Boolean(d.active)
    setCallActive(isActive)
    setCallerNum(str(d.caller_number))
    setCallerName(str(d.caller_name))
    setAgentExt(str(d.agent_extension))
    setStatusLine(isActive ? "Screening in progress" : "No active screening session")
    setTranscript(
      asList(d.transcript).map((m): TranscriptLine => ({
        speaker: str(m.speaker) || (m.from_extension !== undefined ? `ext ${str(m.from_extension)}` : "?"),
        body: str(m.text) || str(m.content) || str(m.message),
        isAgent: Boolean(m.is_agent || (m.speaker && m.speaker !== "caller")),
      })),
    )
  }

  // Runs once on mount and again whenever the shell's refresh button bumps
  // refreshNonce (mirrors PhonePage.qml's onTabActivated()/refresh()).
  createEffect(() => {
    shell.refreshNonce()
    if (active()) void refresh()
  })

  // Auto-poll every 4s while this tab is the active one, paused when the
  // daemon link is down (PhoneScreeningTab.qml's Timer running: tab.visible
  // && bridge.connected).
  onMount(() => {
    const t = setInterval(() => {
      if (active() && app.client.connected) void refresh()
    }, 4000)
    onCleanup(() => clearInterval(t))
  })

  return (
    <PhoneTabPanel>
      <style>{`
        .phscr-header { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .phscr-title { font-size: 9px; color: var(--text-faint); letter-spacing: var(--track-wide); }
        .phscr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
        .phscr-dot.on { background: var(--success); animation: phscr-pulse 1400ms ease-in-out infinite; }
        @keyframes phscr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .phscr-refresh {
          all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs);
          display: flex; align-items: center; justify-content: center;
          color: var(--text-muted); border: 1px solid var(--hairline-soft); font-size: 13px;
          transition: background var(--dur-fast) ease;
        }
        .phscr-refresh:hover { background: rgba(255,255,255,0.06); }

        .phscr-info { transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease; flex-shrink: 0; }
        .phscr-info.active { background: var(--accent-faint); border-color: var(--accent); }
        .phscr-status {
          font-family: var(--font-display); font-size: 10px; letter-spacing: 0.8px; font-weight: 600;
          color: var(--text-muted);
        }
        .phscr-status.active { color: var(--accent-bright); }
        .phscr-info-row { display: flex; gap: 24px; margin-top: 8px; flex-wrap: wrap; }
        .phscr-info-col { display: flex; flex-direction: column; gap: 2px; }
        .phscr-info-label { font-family: var(--font-display); font-size: 8px; letter-spacing: 1px; color: var(--text-faint); }
        .phscr-info-value { font-size: 13px; color: var(--text); }
        .phscr-info-value.accent { color: var(--accent); }
        .phscr-info-value.mono { font-family: var(--font-mono); }

        .phscr-section { font-size: 9px; color: var(--text-faint); letter-spacing: var(--track-wide); flex-shrink: 0; }

        .phscr-transcript { flex: 1; min-height: 160px; overflow-y: auto; display: flex; flex-direction: column; }
        .phscr-empty {
          flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 8px; color: var(--text-faint); font-size: 12px; text-align: center;
        }
        .phscr-empty-icon { font-size: 32px; }

        .phscr-bubbles { display: flex; flex-direction: column; gap: 8px; }
        .phscr-bubble-row { display: flex; }
        .phscr-bubble-row.agent { justify-content: flex-end; }
        .phscr-bubble {
          max-width: 80%; padding: 8px 12px; border-radius: var(--radius-xs);
          background: var(--surface-strong); border: 1px solid var(--hairline-soft);
          display: flex; flex-direction: column; gap: 2px;
        }
        .phscr-bubble.agent { background: var(--accent-dim); border-color: var(--accent); }
        .phscr-bubble-speaker { font-family: var(--font-display); font-size: 7px; letter-spacing: 0.8px; color: var(--amber); }
        .phscr-bubble.agent .phscr-bubble-speaker { color: var(--accent); }
        .phscr-bubble-body { font-size: 12px; color: var(--text); line-height: 1.4; word-break: break-word; }
        .phscr-bubble.agent .phscr-bubble-body { color: var(--accent-bright); }

        .phscr-offline { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; border-color: var(--amber-dim); }
      `}</style>

      <div class="phscr-header">
        <div class="hud-label phscr-title">LIVE SCREENING</div>
        <span class="phscr-dot" classList={{ on: callActive() }} />
        <div style={{ flex: 1 }} />
        <button type="button" class="phscr-refresh" title="Refresh" onClick={() => void refresh()}>↺</button>
      </div>

      <div class="card phscr-info" classList={{ active: callActive() }}>
        <div class="phscr-status" classList={{ active: callActive() }}>{statusLine()}</div>
        <Show when={callActive()}>
          <div class="phscr-info-row">
            <div class="phscr-info-col">
              <div class="phscr-info-label">CALLER</div>
              <div class="phscr-info-value">
                {callerName() ? `${callerName()}  ${callerNum()}` : callerNum() || "Unknown"}
              </div>
            </div>
            <div class="phscr-info-col">
              <div class="phscr-info-label">SCREENING AGENT</div>
              <div class="phscr-info-value accent mono">{agentExt() ? `ext ${agentExt()}` : "—"}</div>
            </div>
          </div>
        </Show>
      </div>

      <div class="hud-label phscr-section">TRANSCRIPT</div>
      <div class="card phscr-transcript">
        <Show
          when={transcript().length > 0}
          fallback={
            <div class="phscr-empty">
              <div class="phscr-empty-icon">📵</div>
              <div>{callActive() ? "Awaiting transcript…" : "No screening in progress"}</div>
            </div>
          }
        >
          <div class="phscr-bubbles">
            <For each={transcript()}>
              {(line) => (
                <div class="phscr-bubble-row" classList={{ agent: line.isAgent }}>
                  <div class="phscr-bubble" classList={{ agent: line.isAgent }}>
                    <div class="phscr-bubble-speaker">{line.speaker.toUpperCase()}</div>
                    <div class="phscr-bubble-body">{line.body}</div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={!connected()}>
        <div class="card phscr-offline">
          <div class="hud-label" style={{ color: "var(--amber)", "font-size": "9px" }}>OFFLINE</div>
          <div style={{ color: "var(--text-muted)", "font-size": "11px" }}>
            Connect to the Orin daemon to enable screening view.
          </div>
        </div>
      </Show>
    </PhoneTabPanel>
  )
}
