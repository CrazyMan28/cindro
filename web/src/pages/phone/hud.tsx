// HUD tab body — ops dashboard, ported from desktop/qml/PhoneHudTab.qml (and
// cross-checked against tui/src/phone/tabs/HudTab.tsx for the exact
// phone.mcp call shapes): a 6-card status grid (Twilio / Screening / Active
// calls / Agents / Daemon / Phone server), a rolling 20-entry activity log,
// and the RED ALERT broadcast (every agent + a war-room thread) behind a
// one-step confirm.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { ControlClient } from "../../core/control-client"
import { ArcReactor } from "../../components/ArcReactor"
import { NavIcon } from "../../components/NavIcon"
import { theme } from "../../core/theme"
import { PhoneTabPanel, usePhoneTab } from "./index"

// -- shared phone.mcp wire helper (see tui/src/phone/api.ts for the reference
// implementation this mirrors — jarvisd proxies every phone tool through the
// same phone.mcp {name, arguments} verb regardless of frontend). ------------
interface PhoneErr {
  code: string
  message: string
}
interface McpRes {
  tool?: string
  data?: unknown
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

interface LogEntry {
  ts: string
  msg: string
  level: "info" | "warn" | "error"
}

const LOG_MAX = 20

function StatusCard(props: {
  glyph?: string
  dot?: boolean
  title: string
  value: string
  sub?: string
  ok?: boolean | null
}) {
  const okState = () => props.ok ?? null
  const borderColor = () => {
    const ok = okState()
    if (ok === true) return "rgba(57, 230, 160, 0.35)"
    if (ok === false) return "var(--danger-dim)"
    return "var(--hairline-soft)"
  }
  const valueColor = () => {
    const ok = okState()
    if (ok === true) return "var(--success)"
    if (ok === false) return "var(--danger)"
    return "var(--accent)"
  }
  return (
    <div class="hud-card" style={{ "border-color": borderColor() }}>
      <div class="hud-card-icon" classList={{ dot: Boolean(props.dot) }} style={{ background: `${valueColor()}22` }}>
        <Show when={props.glyph} fallback={<span class="hud-card-dot" style={{ background: valueColor() }} />}>
          <NavIcon glyph={props.glyph!} color={valueColor()} />
        </Show>
      </div>
      <div class="hud-card-mid">
        <div class="hud-card-title">{props.title}</div>
        <Show when={props.sub}>
          <div class="hud-card-sub">{props.sub}</div>
        </Show>
      </div>
      <div class="hud-card-value" style={{ color: valueColor() }}>
        {props.value}
      </div>
    </div>
  )
}

export function PhoneHudTab() {
  const app = useApp()
  const ctx = usePhoneTab()

  const [twilioOk, setTwilioOk] = createSignal(false)
  const [twilioNumber, setTwilioNumber] = createSignal("—")
  const [screeningOn, setScreeningOn] = createSignal(false)
  const [activeCallCount, setActiveCallCount] = createSignal(0)
  const [agentCount, setAgentCount] = createSignal(0)
  const [onlineCount, setOnlineCount] = createSignal(0)
  const [lastRefresh, setLastRefresh] = createSignal("—")
  const [daemonUp, setDaemonUp] = createSignal(app.client.connected)
  const [log, setLog] = createSignal<LogEntry[]>([])

  const [alertMsg, setAlertMsg] = createSignal("")
  const [alertStatus, setAlertStatus] = createSignal("")
  const [confirmingAlert, setConfirmingAlert] = createSignal(false)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const logAdd = (msg: string, level: LogEntry["level"] = "info") => {
    if (!alive) return
    setLog((l) => [{ ts: new Date().toLocaleTimeString(), msg, level }, ...l].slice(0, LOG_MAX))
  }

  const countAgents = (data: unknown) => {
    const arr = asList(data)
    setAgentCount(arr.length)
    setOnlineCount(arr.filter((a) => a.status === "online").length)
  }

  const refresh = async () => {
    setLastRefresh(new Date().toLocaleTimeString())

    const tw = await phoneMcp(app.client, "twilio_status")
    if (!alive) return
    if (!tw.error) {
      const d = (tw.data ?? {}) as Row
      setTwilioOk(d.configured === true)
      setTwilioNumber(str(d.from_number, "—"))
      setScreeningOn(d.screening_enabled === true)
      logAdd("Twilio status refreshed", "info")
    } else {
      setTwilioOk(false)
      logAdd(`Twilio: ${tw.error.message || "error"}`, "warn")
    }

    const ac = await phoneMcp(app.client, "list_active_calls")
    if (!alive) return
    if (ac.error) logAdd(`list_active_calls: ${ac.error.message}`, "warn")
    setActiveCallCount(asList(ac.data).length)

    const ex = await phoneMcp(app.client, "list_extensions")
    if (!alive) return
    if (!ex.error && Array.isArray(ex.data)) {
      countAgents(ex.data)
    } else {
      const ag = await phoneMcp(app.client, "list_agents")
      if (!alive) return
      if (ag.error) logAdd(`agents: ${ag.error.message}`, "warn")
      else countAgents(ag.data)
    }
  }

  // Initial load + reacts to the shell's refresh button (usePhoneTab contract).
  createEffect(() => {
    ctx.refreshNonce()
    void refresh()
  })
  // Background cadence, matching PhonePane's HUD poll interval.
  onMount(() => {
    const timer = setInterval(() => void refresh(), 10000)
    onCleanup(() => clearInterval(timer))
  })
  // Daemon link indicator — same 500ms poll HudStatusStrip uses.
  onMount(() => {
    const timer = setInterval(() => setDaemonUp(app.client.connected), 500)
    onCleanup(() => clearInterval(timer))
  })

  const askRedAlert = () => {
    if (!alertMsg().trim()) return
    setConfirmingAlert(true)
  }

  const fireRedAlert = async () => {
    setConfirmingAlert(false)
    const message = alertMsg().trim()
    if (!message) return
    const res = await phoneMcp(app.client, "red_alert", { message })
    setAlertStatus(res.error ? `Error: ${res.error.message}` : "Alert broadcast")
    logAdd(`Red alert: ${message}`, res.error ? "error" : "warn")
    if (!res.error) setAlertMsg("")
  }

  return (
    <PhoneTabPanel>
      <div class="hud-page">
        <div class="hud-topbar">
          <ArcReactor size={22} tint={daemonUp() ? theme.accent : theme.textFaint} />
          <span class="hud-label hud-topbar-title">OPS HUD</span>
          <div style={{ flex: 1 }} />
          <span class="hud-lastref">Last updated: {lastRefresh()}</span>
        </div>

        <div class="hud-grid">
          <StatusCard glyph="phone" title="Twilio" sub={twilioNumber()} value={twilioOk() ? "OK" : "FAIL"} ok={twilioOk()} />
          <StatusCard glyph="voice" title="Screening" value={screeningOn() ? "ON" : "OFF"} ok={screeningOn() ? true : null} />
          <StatusCard glyph="phone" title="Active calls" value={String(activeCallCount())} ok={activeCallCount() > 0 ? true : null} />
          <StatusCard glyph="agents" title="Agents" sub={`${onlineCount()} online`} value={String(agentCount())} />
          <StatusCard dot title="Daemon" value={daemonUp() ? "CONNECTED" : "OFFLINE"} ok={daemonUp()} />
          <StatusCard
            glyph="activity"
            title="Phone server"
            sub={twilioOk() ? "Responding" : "Check connection"}
            value={twilioOk() ? "OK" : "—"}
            ok={twilioOk() ? true : null}
          />
        </div>

        <div class="hud-section-label hud-label">ACTIVITY LOG</div>
        <div class="hud-log card">
          <Show
            when={log().length > 0}
            fallback={<div class="hud-log-empty">No activity yet — press ↺ to refresh</div>}
          >
            <For each={log()}>
              {(e) => (
                <div class="hud-log-row">
                  <span class="hud-log-ts">{e.ts}</span>
                  <span
                    class="hud-log-msg"
                    style={{
                      color: e.level === "warn" ? "var(--amber)" : e.level === "error" ? "var(--danger)" : "var(--text-muted)",
                    }}
                  >
                    {e.msg}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="hud-section-label hud-label">WAR ROOM</div>
        <div class="hud-warroom card">
          <div class="hud-warroom-intro">
            <ArcReactor size={18} tint={theme.danger} />
            <span>RED ALERT broadcasts to every agent and opens a war-room thread.</span>
          </div>
          <div class="hud-warroom-row">
            <input
              class="hud-input"
              placeholder="Alert message…"
              value={alertMsg()}
              onInput={(e) => setAlertMsg(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askRedAlert()
              }}
            />
            <button type="button" class="hud-alert-btn" onClick={askRedAlert}>
              RED ALERT
            </button>
          </div>
          <Show when={confirmingAlert()}>
            <div class="hud-confirm">
              <span>Broadcast “{alertMsg().trim()}” to every agent?</span>
              <button type="button" class="hud-confirm-yes" onClick={() => void fireRedAlert()}>
                Yes, broadcast
              </button>
              <button type="button" class="hud-confirm-no" onClick={() => setConfirmingAlert(false)}>
                Cancel
              </button>
            </div>
          </Show>
          <Show when={alertStatus()}>
            <div class="hud-alert-status">{alertStatus()}</div>
          </Show>
        </div>
      </div>

      <style>{HUD_CSS}</style>
    </PhoneTabPanel>
  )
}

// ---------------------------------------------------------------------------
// styles — page-scoped (hud-* prefix); tokens from theme.css
// ---------------------------------------------------------------------------

const HUD_CSS = `
.hud-page { display: flex; flex-direction: column; gap: 12px; }
.hud-topbar { display: flex; align-items: center; gap: 8px; }
.hud-topbar-title { font-size: 11px; color: var(--text-faint); }
.hud-lastref { font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }

.hud-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.hud-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--hairline-soft);
  transition: border-color var(--dur-fast) ease, transform var(--dur-fast) ease, box-shadow var(--dur-fast) ease;
  animation: hud-card-in var(--dur-slow) ease-out backwards;
}
@keyframes hud-card-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.hud-card:hover { transform: translateY(-1px); box-shadow: 0 8px 20px -12px rgba(0,0,0,0.6); }
.hud-card-icon {
  flex-shrink: 0;
  width: 32px; height: 32px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
}
.hud-card-icon.dot { width: 32px; height: 32px; }
.hud-card-dot { width: 9px; height: 9px; border-radius: 50%; }
.hud-card-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hud-card-title { font-size: 12px; color: var(--text); }
.hud-card-sub { font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-card-value { flex-shrink: 0; font-family: var(--font-display); font-size: 15px; font-weight: 700; letter-spacing: 0.4px; }

.hud-section-label { font-size: 9px; color: var(--text-faint); letter-spacing: 2px; margin-top: 2px; }

.hud-log {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
}
.hud-log-empty { color: var(--text-faint); font-size: 11px; text-align: center; padding: 10px 0; }
.hud-log-row { display: flex; gap: 10px; font-size: 11px; }
.hud-log-ts { flex-shrink: 0; width: 68px; color: var(--text-faint); font-family: var(--font-mono); }
.hud-log-msg { flex: 1; min-width: 0; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.hud-warroom { display: flex; flex-direction: column; gap: 10px; border-color: var(--danger-dim) !important; }
.hud-warroom-intro { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted); }
.hud-warroom-row { display: flex; gap: 8px; }
.hud-input {
  all: unset;
  box-sizing: border-box;
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft);
  background: var(--surface-input);
  color: var(--text);
  font-size: 12px;
}
.hud-input:focus { border-color: var(--danger); }
.hud-input::placeholder { color: var(--text-faint); }
.hud-alert-btn {
  all: unset;
  cursor: pointer;
  height: 32px;
  padding: 0 16px;
  border-radius: var(--radius-xs);
  background: var(--danger-dim);
  color: var(--text);
  font-family: var(--font-display);
  font-size: 10px;
  letter-spacing: 1.2px;
  font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  transition: background var(--dur-fast) ease;
}
.hud-alert-btn:hover { background: var(--danger); }
.hud-confirm { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--amber); flex-wrap: wrap; }
.hud-confirm-yes, .hud-confirm-no {
  all: unset;
  cursor: pointer;
  height: 26px;
  padding: 0 12px;
  border-radius: var(--radius-xs);
  font-family: var(--font-display);
  font-size: 9px;
  letter-spacing: 0.6px;
  display: flex; align-items: center; justify-content: center;
}
.hud-confirm-yes { background: var(--danger-dim); color: var(--text); }
.hud-confirm-yes:hover { background: var(--danger); }
.hud-confirm-no { border: 1px solid var(--hairline-soft); color: var(--text-muted); }
.hud-confirm-no:hover { background: rgba(255,255,255,0.08); }
.hud-alert-status { font-size: 11px; color: var(--amber); font-family: var(--font-mono); }
`
