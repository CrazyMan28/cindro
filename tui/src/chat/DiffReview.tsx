// <DiffReview/> — the reviewable per-file diff panel for chat `diff` events,
// parity with desktop/qml/DiffReviewPanel.qml + cli diff_render.py: per-file
// card with +N/-N stat chips, a collapsible tinted unified diff capped at 30
// lines ("… N more lines" beyond), and the diff.* action verbs as a key
// footer — s stage · c commit (optional-message prompt) · o open PR ·
// v revert (gated behind a confirm Picker; destructive, same as the GUI's
// inline approval). ↑↓ selects which file card the actions target; each
// card shows the daemon's returned ok/message/url on its own status line.
//
// Keys fire only while the host marks the panel active (`active` prop,
// default true) — a transcript full of diff cards must never eat typing.

import type { InputRenderable, KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import { Picker } from "./Picker"

const MAX_DIFF_LINES = 30 // DiffReviewPanel.qml's Repeater cap, kept tight

export interface DiffFile {
  path: string
  patch: string
}

interface ActionStatus {
  ok: boolean
  text: string
}

/** (added, removed) — same rule as computeStats()/diff_stats: a leading +/-
 * counts unless it's the +++/--- file header. */
function diffStats(patch: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++
    else if (line.startsWith("-") && !line.startsWith("---")) del++
  }
  return { add, del }
}

function lineFg(line: string) {
  if (line.startsWith("@@")) return theme.violet
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))
    return theme.textFaint
  if (line.startsWith("+")) return theme.success
  if (line.startsWith("-")) return theme.danger
  return theme.textMuted
}

export function DiffReview(props: {
  files: DiffFile[]
  sessionId?: string
  active?: () => boolean
}) {
  const app = useApp()
  const isActive = () => props.active?.() ?? true

  const [selected, setSelected] = createSignal(0)
  const [collapsed, setCollapsed] = createSignal<Record<number, boolean>>({})
  const [statuses, setStatuses] = createSignal<Record<number, ActionStatus>>({})
  const [commitPrompt, setCommitPrompt] = createSignal(false)
  const [confirmRevert, setConfirmRevert] = createSignal<{ path: string; index: number } | null>(
    null,
  )
  let inputRef: InputRenderable | undefined

  const selectedFile = () => props.files[Math.min(selected(), props.files.length - 1)]

  const setStatus = (index: number, s: ActionStatus) =>
    setStatuses((m) => ({ ...m, [index]: s }))

  // One shape for all four verbs (Bridge.cpp/Chat.tsx param parity): the
  // daemon answers {ok, message?} — or {ok, url} for a successful open_pr —
  // and failures must stay visible on the targeted card.
  const callDiff = async (
    verb: "stage" | "revert" | "commit" | "open_pr",
    params: Record<string, unknown>,
    label: string,
    index: number,
  ) => {
    if (props.sessionId) params.session_id = props.sessionId
    try {
      const res = await app.client.call(`diff.${verb}`, params)
      const ok = res.ok === undefined ? true : Boolean(res.ok)
      const detail = String(res.url ?? res.message ?? "")
      setStatus(index, { ok, text: `${ok ? "✓" : "✕"} ${label}${detail ? `  ${detail}` : ""}` })
    } catch (e) {
      setStatus(index, { ok: false, text: `✕ ${label}: ${String(e)}` })
    }
  }

  const submitCommit = (message: string) => {
    setCommitPrompt(false)
    if (inputRef) inputRef.value = ""
    const params: Record<string, unknown> = {}
    if (message.trim()) params.message = message.trim() // else the daemon crafts one
    void callDiff("commit", params, "commit", selected())
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!isActive() || key.ctrl || key.meta || key.option) return
      if (confirmRevert() || commitPrompt()) return // picker/input own the keys
      const file = selectedFile()
      switch (key.name) {
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, props.files.length - 1), i + 1))
          break
        case "e": // fold / unfold the selected card
          setCollapsed((m) => ({ ...m, [selected()]: !m[selected()] }))
          break
        case "s":
          if (file) void callDiff("stage", { path: file.path }, "stage", selected())
          break
        case "c":
          setCommitPrompt(true)
          queueMicrotask(() => inputRef?.focus())
          break
        case "o":
          void callDiff("open_pr", {}, "open PR", selected())
          break
        case "v": // destructive → confirm Picker first (GUI approval-gate parity)
          if (file) setConfirmRevert({ path: file.path, index: selected() })
          break
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="column" position="relative">
      <For
        each={props.files}
        fallback={<text fg={theme.textFaint}>(empty diff)</text>}
      >
        {(file, i) => {
          const stats = diffStats(file.patch)
          const lines = file.patch.split("\n")
          const isSelected = () => i() === selected() && props.files.length > 0
          const expanded = () => !collapsed()[i()]
          return (
            <box
              flexDirection="column"
              border
              borderColor={isSelected() ? theme.accent : theme.hairlineSoft}
            >
              {/* header: path + stat chips + fold state */}
              <box flexDirection="row" gap={1}>
                <text
                  fg={isSelected() ? theme.accentBright : theme.accent}
                  attributes={TextAttributes.BOLD}
                >
                  {isSelected() ? "▸" : " "} ✎ {file.path || "(unnamed file)"}
                </text>
                <Show when={stats.add > 0}>
                  <text fg={theme.success} selectable={false}>
                    +{stats.add}
                  </text>
                </Show>
                <Show when={stats.del > 0}>
                  <text fg={theme.danger} selectable={false}>
                    -{stats.del}
                  </text>
                </Show>
                <text fg={theme.textMuted} selectable={false}>
                  {expanded() ? "▾" : "▸"}
                </text>
              </box>

              {/* tinted unified diff, capped at 30 lines */}
              <Show when={expanded()}>
                <box
                  flexDirection="column"
                  paddingLeft={1}
                  border={["left"]}
                  borderColor={theme.hairlineFaint}
                >
                  <For each={lines.slice(0, MAX_DIFF_LINES)}>
                    {(line) => <text fg={lineFg(line)}>{line || " "}</text>}
                  </For>
                  <Show when={lines.length > MAX_DIFF_LINES}>
                    <text fg={theme.textFaint} selectable={false}>
                      … {lines.length - MAX_DIFF_LINES} more lines
                    </text>
                  </Show>
                </box>
              </Show>

              {/* last action result for THIS card (daemon ok/message/url) */}
              <Show when={statuses()[i()]}>
                {(s) => (
                  <text fg={s().ok ? theme.success : theme.danger} wrapMode="word">
                    {s().text}
                  </text>
                )}
              </Show>
            </box>
          )
        }}
      </For>

      {/* action footer */}
      <Show when={props.files.length > 0}>
        <text fg={theme.textFaint} selectable={false}>
          s stage · c commit · o open PR · v revert
          {props.files.length > 1 ? " · ↑↓ file" : ""} · e fold
        </text>
      </Show>

      {/* optional commit-message prompt */}
      <Show when={commitPrompt()}>
        <box flexDirection="row" height={3} flexShrink={0} border borderColor={theme.accent}>
          <text fg={theme.accent} selectable={false}>
            commit message (optional):{" "}
          </text>
          <input
            ref={(r: InputRenderable) => {
              inputRef = r
            }}
            flexGrow={1}
            onKeyDown={(key: KeyEvent) => {
              if (key.name === "escape") {
                key.preventDefault()
                setCommitPrompt(false)
                if (inputRef) inputRef.value = ""
              }
            }}
            onSubmit={(v: unknown) => submitCommit(typeof v === "string" ? v : "")}
          />
        </box>
      </Show>

      {/* revert confirm gate — destructive, so never one keypress away */}
      <Show when={confirmRevert()}>
        {(c) => (
          <Picker
            title={`CONFIRM: revert ${c().path}?`}
            options={[
              { label: "Yes — discard local changes", description: c().path, value: "yes" },
              { label: "Cancel", value: "no" },
            ]}
            onPick={(v) => {
              const pending = c()
              setConfirmRevert(null)
              if (v === "yes")
                void callDiff("revert", { path: pending.path }, "revert", pending.index)
            }}
            onCancel={() => setConfirmRevert(null)}
          />
        )}
      </Show>
    </box>
  )
}
