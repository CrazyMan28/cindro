// <TablePage/> — the generic renderer for ANY manifest "table" page
// (Sessions/Memory/Skills/Agents/Queue/Activity/MCP/Plugins/SSH/Schedules
// today; a future daemon feature gets its page for free). One consistent
// key model everywhere, replacing the legacy TUI's inconsistent per-pane
// key tables:
//   ↑↓ select row · Enter action menu · r refresh · f search (when the page
//   has one) · a alternate source (archived/running/…) · i input action ·
//   Esc handled by the host (closes the overlay).
// Data: data.list verb + result_key; refresh_events re-fetch (throttled 3s,
// the legacy REFRESH_THROTTLE_S); actions run through param substitution
// with confirm-step and detail-view support.

import type { InputRenderable, KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../app-context"
import { Picker } from "../../chat/Picker"
import { theme } from "../../theme"
import type { ManifestAction, ManifestPage, Row } from "./types"
import { actionVisible, columnWidths, formatCell, substituteParams, truncate } from "./types"

const REFRESH_THROTTLE_MS = 3000
const PAGE_WIDTH = 100

interface PendingInput {
  action: ManifestAction
  row: Row
  label: string
}

export function TablePage(props: { page: ManifestPage; active: () => boolean }) {
  const app = useApp()
  const [rows, setRows] = createSignal<Row[]>([])
  const [selected, setSelected] = createSignal(0)
  const [sourceKey, setSourceKey] = createSignal("list")
  const [searching, setSearching] = createSignal(false)
  const [pendingInput, setPendingInput] = createSignal<PendingInput | null>(null)
  const [menuRow, setMenuRow] = createSignal<Row | null>(null)
  const [confirming, setConfirming] = createSignal<{ action: ManifestAction; row: Row } | null>(null)
  const [detail, setDetail] = createSignal("")
  const [status, setStatus] = createSignal("")
  let inputRef: InputRenderable | undefined
  let lastFetch = 0

  const source = () => props.page.data?.[sourceKey()] ?? props.page.data?.list
  const altSourceKey = () =>
    Object.keys(props.page.data ?? {}).find((k) => k !== "list" && k !== "search")

  const fetchRows = async (params: Record<string, unknown> = {}, force = false) => {
    const src = source()
    if (!src) return
    const now = Date.now()
    if (!force && now - lastFetch < REFRESH_THROTTLE_MS) return
    lastFetch = now
    try {
      const res = await app.client.call(src.verb, { ...(src.params ?? {}), ...params }, 15000)
      const list = (res[src.result_key] ?? []) as Row[]
      setRows(Array.isArray(list) ? list : [])
      setSelected((i) => Math.min(i, Math.max(0, list.length - 1)))
      setStatus("")
    } catch (e) {
      setStatus(`fetch failed: ${String(e)}`)
    }
  }

  onMount(() => {
    void fetchRows({}, true)
    const offs = (props.page.refresh_events ?? []).map((ev) =>
      app.client.on(ev, () => void fetchRows()),
    )
    onCleanup(() => {
      for (const off of offs) off()
    })
  })

  const runAction = async (action: ManifestAction, row: Row, input = "") => {
    if (action.confirm && !confirming()) {
      setConfirming({ action, row })
      return
    }
    setConfirming(null)
    if (action.input && !input) {
      setPendingInput({ action, row, label: action.input })
      queueMicrotask(() => inputRef?.focus())
      return
    }
    if (action.kind === "navigate") {
      app.navigate(action.target ?? props.page.id)
      return
    }
    if (action.kind === "send_chat") {
      const text = (action.text ?? "").replaceAll("$name", String(row.name ?? ""))
      app.navigate("chat")
      app.notify(`sent: ${text}`)
      return
    }
    if (!action.verb) return
    try {
      const res = await app.client.call(action.verb, substituteParams(action.params, row, input))
      if (action.show === "detail") {
        setDetail(JSON.stringify(res, null, 2).slice(0, 4000))
      } else {
        const ok = res.ok === undefined ? true : Boolean(res.ok)
        setStatus(`${ok ? "✓" : "✕"} ${action.label}`)
      }
      void fetchRows({}, true)
    } catch (e) {
      setStatus(`${action.label} failed: ${String(e)}`)
    }
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || menuRow() || confirming() || pendingInput() || searching()) {
        if (props.active() && key.name === "escape") {
          // Consumed HERE — preventDefault stops the host from also closing
          // the whole overlay page on the same keypress.
          key.preventDefault()
          setMenuRow(null)
          setConfirming(null)
          setPendingInput(null)
          setSearching(false)
          setDetail("")
        }
        return
      }
      if (detail()) {
        if (key.name === "escape" || key.name === "q") {
          key.preventDefault()
          setDetail("")
        }
        return
      }
      switch (key.name) {
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, rows().length - 1), i + 1))
          break
        case "return": {
          const row = rows()[selected()]
          const actions = (props.page.row_actions ?? []).filter((a) =>
            row ? actionVisible(a, row) : false,
          )
          if (row && actions.length) setMenuRow(row)
          break
        }
        case "r":
          void fetchRows({}, true)
          break
        case "f":
          if (props.page.data?.search) {
            setSearching(true)
            queueMicrotask(() => inputRef?.focus())
          }
          break
        case "a": {
          const alt = altSourceKey()
          if (alt) {
            setSourceKey((k) => (k === alt ? "list" : alt))
            void fetchRows({}, true)
          }
          break
        }
        case "i": {
          const ia = props.page.input_actions?.[0]
          if (ia) {
            setPendingInput({ action: ia, row: {}, label: ia.placeholder ?? ia.id })
            queueMicrotask(() => inputRef?.focus())
          }
          break
        }
        default:
          break
      }
    },
    {},
  )

  const widths = createMemo(() =>
    columnWidths(props.page.columns ?? [], rows(), PAGE_WIDTH - 4),
  )

  const riskFg = (value: string) =>
    value === "high" ? theme.danger : value === "low" ? theme.success : theme.amber

  const submitInput = (text: string) => {
    const pending = pendingInput()
    if (pending) {
      setPendingInput(null)
      void runAction(pending.action, pending.row, text)
      if (inputRef) inputRef.value = ""
      return
    }
    if (searching()) {
      setSearching(false)
      const src = props.page.data?.search
      if (src?.query_param && text.trim()) {
        setSourceKey("search")
        void fetchRows({ [src.query_param]: text.trim() }, true)
      } else {
        setSourceKey("list")
        void fetchRows({}, true)
      }
      if (inputRef) inputRef.value = ""
    }
  }

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          // {props.page.title.toUpperCase()}
        </text>
        <text fg={theme.textFaint} selectable={false}>
          ↑↓ row · Enter actions · r refresh
          {props.page.data?.search ? " · f search" : ""}
          {altSourceKey() ? ` · a ${altSourceKey()}` : ""}
          {props.page.input_actions?.length ? " · i add" : ""}
        </text>
        <Show when={sourceKey() !== "list"}>
          <text fg={theme.amber} selectable={false}>
            [{sourceKey()}]
          </text>
        </Show>
      </box>

      <Show when={detail()}>
        <scrollbox flexGrow={1} border borderColor={theme.accent}>
          <text fg={theme.text}>{detail()}</text>
        </scrollbox>
      </Show>

      <Show when={!detail()}>
        {/* header */}
        <box flexDirection="row">
          <For each={props.page.columns ?? []}>
            {(col, i) => (
              <text fg={theme.textMuted} attributes={TextAttributes.BOLD} selectable={false}>
                {truncate(col.label, widths()[i()] ?? 8)}
              </text>
            )}
          </For>
        </box>
        <scrollbox flexGrow={1}>
          <For
            each={rows()}
            fallback={<text fg={theme.textFaint}>(empty — r to refresh)</text>}
          >
            {(row, ri) => (
              <box
                flexDirection="row"
                backgroundColor={ri() === selected() ? theme.surfaceStrong : undefined}
                onMouseDown={() => setSelected(ri())}
              >
                <For each={props.page.columns ?? []}>
                  {(col, ci) => {
                    const raw = formatCell(row[col.key], col.format)
                    return (
                      <text
                        fg={
                          col.format === "risk"
                            ? riskFg(raw)
                            : ci() === 0
                              ? theme.text
                              : theme.textMuted
                        }
                        selectable={false}
                      >
                        {truncate(raw, widths()[ci()] ?? 8)}
                      </text>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>

      <Show when={status()}>
        <text fg={theme.textMuted} selectable={false}>
          {status()}
        </text>
      </Show>

      <Show when={searching() || pendingInput()}>
        <box flexDirection="row" height={3} flexShrink={0} border borderColor={theme.accent}>
          <text fg={theme.accent} selectable={false}>
            {pendingInput() ? `${pendingInput()!.label}: ` : "search: "}
          </text>
          <input
            ref={(r: InputRenderable) => {
              inputRef = r
            }}
            flexGrow={1}
            onSubmit={(v: unknown) => submitInput(typeof v === "string" ? v : "")}
          />
        </box>
      </Show>

      <Show when={menuRow()}>
        {(row) => (
          <Picker
            title={`${props.page.title.toUpperCase()} · ACTIONS`}
            options={(props.page.row_actions ?? [])
              .filter((a) => actionVisible(a, row()))
              .map((a) => ({ label: a.label, description: a.verb ?? a.kind ?? "", value: a.id }))}
            onPick={(id) => {
              const action = props.page.row_actions?.find((a) => a.id === id)
              // Read the narrowed accessor BEFORE clearing menuRow — reading
              // it after the <Show> goes falsy is a solid "stale read" crash.
              const rowValue = row()
              setMenuRow(null)
              if (action) void runAction(action, rowValue)
            }}
            onCancel={() => setMenuRow(null)}
          />
        )}
      </Show>

      <Show when={confirming()}>
        {(c) => (
          <Picker
            title={`CONFIRM: ${c().action.label}?`}
            options={[
              { label: `Yes — ${c().action.label}`, value: "yes" },
              { label: "Cancel", value: "no" },
            ]}
            onPick={(v) => {
              const pending = c()
              setConfirming(null)
              if (v === "yes") {
                // re-enter with confirm already satisfied
                const action = { ...pending.action, confirm: false }
                void runAction(action, pending.row)
              }
            }}
            onCancel={() => setConfirming(null)}
          />
        )}
      </Show>
    </box>
  )
}
