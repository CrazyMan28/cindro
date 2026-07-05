// SETTINGS sub-screens — DiagnosticsPanel (the 6-check runner from
// PhoneSettingsTab.qml:141-210/392-401) and HistoryPanel (GET /api/calls,
// missed calls colored). Each runs on mount; the parent SettingsTab
// remounts them (keyed) to re-run.

import { TextAttributes } from "@opentui/core"
import { createEffect, createSignal, For, Show } from "solid-js"

import { useApp } from "../../app-context"
import { theme } from "../../theme"
import type { Row } from "../api"
import { asList, httpFailure, phoneHttp, phoneMcp, shortTime, str } from "../api"
import { Section } from "../ui"

interface DiagCheck {
  label: string
  detail: string
  ok: boolean | null
}

export function DiagnosticsPanel(props: { seq: number }) {
  const app = useApp()
  const [checks, setChecks] = createSignal<DiagCheck[]>([
    { label: "Server alive", detail: "GET /health", ok: null },
    { label: "Twilio configured", detail: "twilio_status", ok: null },
    { label: "Tailscale / WS", detail: "control websocket", ok: null },
    { label: "Ext-100 online", detail: "…", ok: null },
    { label: "Mistral voice key", detail: "GET /api/mistral-health", ok: null },
    { label: "Mistral chat key", detail: "GET /api/mistral-health", ok: null },
  ])
  const [running, setRunning] = createSignal(true)
  const [lastError, setLastError] = createSignal("")

  const setCheck = (i: number, ok: boolean, detail?: string) =>
    setChecks((c) => c.map((chk, j) => (j === i ? { ...chk, ok, ...(detail ? { detail } : {}) } : chk)))

  const run = async () => {
    setRunning(true)
    setLastError("")
    // 3. Tailscale/WS — synchronous snapshot (QML:164 uses bridge.connected).
    setCheck(2, app.client.connected)
    // 1. Server health — GET /health.
    const health = await phoneHttp(app.client, "GET", "/health")
    const hd = (health.data ?? {}) as Row
    setCheck(0, !httpFailure(health) && hd.ok === true)
    // 2. Twilio configured.
    const tw = await phoneMcp(app.client, "twilio_status")
    const twd = (tw.data ?? {}) as Row
    setCheck(1, !tw.error && twd.configured === true)
    if (tw.error) setLastError(tw.error.message || "Twilio error")
    // 4. Extensions (ext-100 online per QML:184-189) + agents count.
    const ex = await phoneMcp(app.client, "list_extensions")
    let extCount = 0
    let ext100 = false
    if (!ex.error && Array.isArray(ex.data)) {
      const arr = asList(ex.data)
      extCount = arr.length
      const e100 = arr.find((e: Row) => (str(e.extension) || str(e.ext)) === "100")
      ext100 = Boolean(
        e100 && (e100.status === "online" || e100.online === true || e100.connected === true),
      )
    } else if (ex.error) setLastError(ex.error.message)
    const ag = await phoneMcp(app.client, "list_agents")
    const agentCount = !ag.error && Array.isArray(ag.data) ? asList(ag.data).length : 0
    setCheck(3, ext100, `${extCount} ext · ${agentCount} agents`)
    // 5+6. Mistral key health — GET /api/mistral-health.
    const mh = await phoneHttp(app.client, "GET", "/api/mistral-health")
    const md = (mh.data ?? {}) as Row
    const mFail = httpFailure(mh)
    if (mFail) setLastError(mFail)
    setCheck(4, !mFail && Boolean((md.voice_key as Row | undefined)?.ok === true))
    setCheck(5, !mFail && Boolean((md.chat_key as Row | undefined)?.ok === true))
    setRunning(false)
  }
  // Runs on mount and again whenever the parent bumps `seq` (the d key).
  createEffect(() => {
    void props.seq
    void run()
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2}>
        <Section title="DIAGNOSTICS" />
        <text fg={running() ? theme.amber : theme.textFaint} selectable={false}>
          {running() ? "RUNNING…" : "done · d re-run · Esc back"}
        </text>
      </box>
      <For each={checks()}>
        {(c) => (
          <box flexDirection="row" gap={1}>
            <text
              fg={c.ok === true ? theme.success : c.ok === false ? theme.danger : theme.textMuted}
              attributes={TextAttributes.BOLD}
              selectable={false}
            >
              {c.ok === true ? "✓ OK  " : c.ok === false ? "✗ FAIL" : "? —   "}
            </text>
            <text fg={theme.text}>{c.label}</text>
            <text fg={theme.textFaint}>{c.detail}</text>
          </box>
        )}
      </For>
      <Show when={lastError()}>
        <text fg={theme.danger} wrapMode="word">
          Last error: {lastError()}
        </text>
      </Show>
    </box>
  )
}

export function HistoryPanel(props: { seq: number }) {
  const app = useApp()
  const [rows, setRows] = createSignal<Row[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const load = async () => {
    setLoading(true)
    setError("")
    const res = await phoneHttp(app.client, "GET", "/api/calls")
    setLoading(false)
    const fail = httpFailure(res)
    if (fail) {
      setError(fail)
      return
    }
    setRows(
      asList(res.data, "calls").map((c: Row) => ({
        from: str(c.from_extension) || str(c.from) || "—",
        to: str(c.to_extension) || str(c.to) || "—",
        state: str(c.state),
        reason: str(c.reason),
        ts: str(c.created_at) || str(c.timestamp),
        missed: c.missed === true,
      })),
    )
  }
  // Runs on mount and again whenever the parent bumps `seq` (the h key).
  createEffect(() => {
    void props.seq
    void load()
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2}>
        <Section title="CALL HISTORY" />
        <text fg={theme.textFaint} selectable={false}>
          h re-load · Esc back
        </text>
      </box>
      <Show when={loading()}>
        <text fg={theme.textFaint}>Loading…</text>
      </Show>
      <Show when={error()}>
        <text fg={theme.danger}>history: {error()}</text>
      </Show>
      <scrollbox flexGrow={1}>
        <For
          each={rows()}
          fallback={
            <Show when={!loading() && !error()}>
              <text fg={theme.textFaint}>No call history yet.</text>
            </Show>
          }
        >
          {(r) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>
                {str(r.from)} → {str(r.to)}
              </text>
              <text fg={theme.textMuted}>
                {[str(r.state), str(r.reason)].filter((s) => s.length > 0).join(" · ")}
              </text>
              <text fg={r.missed ? theme.danger : theme.success} selectable={false}>
                {shortTime(str(r.ts))}
                {r.missed ? " missed" : ""}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}
