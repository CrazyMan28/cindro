// Toast queue (OpenCode's top-right toast stack). app.notify() feeds it;
// each toast auto-dismisses. Replaces the single-line footer notice with
// stacked, severity-colored, self-expiring messages.

import { createSignal } from "solid-js"
import { For } from "solid-js"

import { theme } from "../theme"

export interface Toast {
  id: number
  text: string
  severity: "info" | "warn" | "error" | "success"
}

const DISMISS_MS = 4000
let seq = 1

export function createToasts() {
  const [toasts, setToasts] = createSignal<Toast[]>([])
  const push = (text: string, severity: Toast["severity"] = "info") => {
    const id = seq++
    setToasts((t) => [...t, { id, text, severity }].slice(-5))
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), DISMISS_MS)
  }
  return { toasts, push }
}

export function ToastLayer(props: { toasts: () => Toast[] }) {
  const color = (s: Toast["severity"]) =>
    s === "error"
      ? theme.danger
      : s === "warn"
        ? theme.amber
        : s === "success"
          ? theme.success
          : theme.accent
  return (
    <box position="absolute" right={1} top={4} zIndex={90} flexDirection="column" gap={0}>
      <For each={props.toasts()}>
        {(t) => (
          <box border borderColor={color(t.severity)} backgroundColor={theme.surface} flexShrink={0}>
            <text fg={color(t.severity)} selectable={false}>
              {" "}
              {t.text.slice(0, 80)}{" "}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}
