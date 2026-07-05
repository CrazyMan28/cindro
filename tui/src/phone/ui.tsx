// Small shared UI atoms for the phone hub tabs: the staged prompt input bar
// (TablePage's pendingInput pattern — focus deferred a microtask so the key
// that OPENED the prompt never lands in the input), chip rows, section
// labels, and the status line coloring convention.

import type { InputRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { onMount } from "solid-js"

import { theme } from "../theme"

export interface PromptSpec {
  label: string
  onSubmit: (text: string) => void
}

export function PromptBar(props: { prompt: PromptSpec }) {
  let ref: InputRenderable | undefined
  onMount(() => queueMicrotask(() => ref?.focus()))
  return (
    <box flexDirection="row" height={3} flexShrink={0} border borderColor={theme.accent}>
      <text fg={theme.accent} selectable={false}>
        {props.prompt.label}:{" "}
      </text>
      <input
        ref={(r: InputRenderable) => {
          ref = r
        }}
        flexGrow={1}
        onSubmit={(v: unknown) => props.prompt.onSubmit(typeof v === "string" ? v : "")}
      />
    </box>
  )
}

export function Chip(props: { label: string; on: boolean }) {
  return (
    <text
      fg={props.on ? theme.accentBright : theme.textMuted}
      attributes={props.on ? TextAttributes.BOLD : undefined}
      selectable={false}
    >
      [{props.label}]
    </text>
  )
}

export function Section(props: { title: string }) {
  return (
    <text fg={theme.textFaint} attributes={TextAttributes.BOLD} selectable={false}>
      {"// "}
      {props.title}
    </text>
  )
}

export function Hint(props: { text: string }) {
  return (
    <text fg={theme.textFaint} flexShrink={0} selectable={false}>
      {props.text}
    </text>
  )
}

/** Status line: "Error"-bearing text renders danger (QML configStatus rule). */
export function StatusLine(props: { text: string; kind?: "info" | "error" | "success" }) {
  const fg = () =>
    props.kind === "error" || props.text.includes("Error")
      ? theme.danger
      : props.kind === "success"
        ? theme.success
        : theme.amber
  return (
    <text fg={fg()} flexShrink={0} wrapMode="word">
      {props.text}
    </text>
  )
}
