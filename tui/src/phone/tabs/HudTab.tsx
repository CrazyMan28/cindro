// HUD tab — PhoneHudTab.qml parity: the 6-card ops status grid (Twilio /
// Screening / Active calls / Agents / Daemon / Phone server), the rolling
// 20-entry activity log, and the RED ALERT broadcast (red_alert tool →
// every agent + a war-room thread) behind a confirm step.

import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"

import { useApp } from "../../app-context"
import { Picker } from "../../chat/Picker"
import { theme } from "../../theme"
import type { Row } from "../api"
import { asList, phoneMcp, str, usePhonePoll } from "../api"
import type { PromptSpec } from "../ui"
import { Hint, PromptBar, Section, StatusLine } from "../ui"
import type { TabProps } from "./CallsTab"

const LOG_MAX = 20

interface LogEntry {
  ts: string
  msg: string
  level: "info" | "warn" | "error"
}

export function HudTab(props: TabProps) {
  const app = useApp()
  const [twilioOk, setTwilioOk] = createSignal(false)
  const [twilioNumber, setTwilioNumber] = createSignal("—")
  const [screeningOn, setScreeningOn] = createSignal(false)
  const [activeCallCount, setActiveCallCount] = createSignal(0)
  const [agentCount, setAgentCount] = createSignal(0)
  const [onlineCount, setOnlineCount] = createSignal(0)
  const [lastRefresh, setLastRefresh] = createSignal("—")
  const [daemonUp, setDaemonUp] = createSignal(false)
  const [log, setLog] = createSignal<LogEntry[]>([])
  const [alertStatus, setAlertStatus] = createSignal("")
  const [prompt, setPrompt] = createSignal<PromptSpec | null>(null)
  const [confirming, setConfirming] = createSignal<string | null>(null)

  createEffect(() => props.onModalChange?.(prompt() !== null || confirming() !== null))
  onCleanup(() => props.onModalChange?.(false))

  const logAdd = (msg: string, level: LogEntry["level"] = "info") => {
    setLog((l) => [{ ts: new Date().toLocaleTimeString(), msg, level }, ...l].slice(0, LOG_MAX))
  }

  const countAgents = (data: unknown) => {
    const arr = asList(data)
    setAgentCount(arr.length)
    setOnlineCount(arr.filter((a: Row) => a.status === "online").length)
  }

  const refresh = async () => {
    setLastRefresh(new Date().toLocaleTimeString())
    setDaemonUp(app.client.connected)
    const tw = await phoneMcp(app.client, "twilio_status")
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
    if (ac.error) logAdd(`list_active_calls: ${ac.error.message}`, "warn")
    setActiveCallCount(asList(ac.data).length)
    const ex = await phoneMcp(app.client, "list_extensions")
    if (!ex.error && Array.isArray(ex.data)) countAgents(ex.data)
    else {
      const ag = await phoneMcp(app.client, "list_agents")
      if (ag.error) logAdd(`agents: ${ag.error.message}`, "warn")
      else countAgents(ag.data)
    }
  }
  usePhonePoll(app.client, props.active, 10000, refresh)

  const fireRedAlert = async (message: string) => {
    const res = await phoneMcp(app.client, "red_alert", { message })
    setAlertStatus(res.error ? `Error: ${res.error.message}` : "Alert broadcast")
    logAdd(`Red alert: ${message}`, res.error ? "error" : "warn")
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || confirming()) return
      if (prompt()) {
        if (key.name === "escape") {
          key.preventDefault()
          setPrompt(null)
        }
        return
      }
      switch (key.name) {
        case "a":
          setPrompt({
            label: "RED ALERT message",
            onSubmit: (msg) => {
              setPrompt(null)
              if (msg.trim()) setConfirming(msg.trim())
            },
          })
          break
        case "r":
          void refresh()
          break
        default:
          break
      }
    },
    {},
  )

  const Card = (p: { title: string; value: string; ok?: boolean; sub?: string }) => (
    <box flexDirection="row" gap={1} border borderColor={theme.hairlineSoft} flexShrink={0}>
      <text fg={theme.text} selectable={false}>
        {" "}
        {p.title}
      </text>
      <text
        fg={p.ok === undefined ? theme.accent : p.ok ? theme.success : theme.danger}
        attributes={TextAttributes.BOLD}
        selectable={false}
      >
        {p.value}
      </text>
      <Show when={p.sub}>
        <text fg={theme.textFaint} selectable={false}>
          {p.sub}{" "}
        </text>
      </Show>
    </box>
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <Hint text="a red alert · r refresh" />
      <text fg={theme.textFaint} selectable={false}>
        OPS HUD · last updated {lastRefresh()}
      </text>

      <box flexDirection="row" gap={1} flexShrink={0}>
        <Card title="Twilio" value={twilioOk() ? "OK" : "FAIL"} ok={twilioOk()} sub={twilioNumber()} />
        <Card title="Screening" value={screeningOn() ? "ON" : "OFF"} ok={screeningOn()} />
        <Card title="Active calls" value={String(activeCallCount())} />
      </box>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <Card title="Agents" value={String(agentCount())} sub={`${onlineCount()} online`} />
        <Card title="Daemon" value={daemonUp() ? "CONNECTED" : "OFFLINE"} ok={daemonUp()} />
        <Card
          title="Phone server"
          value={twilioOk() ? "Responding" : "Check connection"}
          ok={twilioOk()}
        />
      </box>

      <Section title="ACTIVITY LOG" />
      <scrollbox flexGrow={1}>
        <For
          each={log()}
          fallback={<text fg={theme.textFaint}>No activity yet — r to refresh</text>}
        >
          {(e) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textFaint} selectable={false}>
                {e.ts}
              </text>
              <text
                fg={e.level === "warn" ? theme.amber : e.level === "error" ? theme.danger : theme.textMuted}
              >
                {e.msg}
              </text>
            </box>
          )}
        </For>
      </scrollbox>

      <Section title="WAR ROOM" />
      <text fg={theme.textMuted} flexShrink={0}>
        RED ALERT broadcasts to every agent and opens a war-room thread. (a)
      </text>
      <Show when={alertStatus()}>
        <StatusLine text={alertStatus()} />
      </Show>

      <Show when={confirming()}>
        {(msg) => (
          <Picker
            title="CONFIRM RED ALERT?"
            options={[
              { label: `Yes — broadcast "${msg()}"`, value: "yes" },
              { label: "Cancel", value: "no" },
            ]}
            onPick={(v) => {
              const message = confirming()
              setConfirming(null)
              if (v === "yes" && message) void fireRedAlert(message)
            }}
            onCancel={() => setConfirming(null)}
          />
        )}
      </Show>

      <Show when={prompt()} keyed>
        {(p) => <PromptBar prompt={p} />}
      </Show>
    </box>
  )
}
