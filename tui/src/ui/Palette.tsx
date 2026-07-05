// <Palette/> — the Ctrl+K global command palette (Claude Code Ctrl+K /
// OpenCode ctrl+p). A focused input owns the fuzzy filter; the list's
// Up/Down/Enter are shadowed on that same input via onKeyDown (the exact
// pattern that made the "/" popup work), so it can never hit the legacy
// dead-list bug. Runs any command in the registry from anywhere.

import type { InputRenderable, KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onMount } from "solid-js"

import { useApp } from "../app-context"
import type { CommandEntry } from "../commands/registry"
import { theme } from "../theme"

const MAX = 12

export function Palette(props: { onClose: () => void; onRun: (name: string) => void }) {
  const app = useApp()
  const [query, setQuery] = createSignal("")
  const [sel, setSel] = createSignal(0)
  let inputRef: InputRenderable | undefined
  onMount(() => inputRef?.focus())

  const matches = createMemo<CommandEntry[]>(() => app.registry.filter(query()).slice(0, MAX))

  const onKeyDown = (key: KeyEvent) => {
    switch (key.name) {
      case "up":
        setSel((i) => (i - 1 + Math.max(1, matches().length)) % Math.max(1, matches().length))
        key.preventDefault()
        break
      case "down":
        setSel((i) => (i + 1) % Math.max(1, matches().length))
        key.preventDefault()
        break
      case "escape":
        key.preventDefault()
        props.onClose()
        break
      default:
        break
    }
  }

  const run = () => {
    const pick = matches()[sel()]
    if (pick) {
      props.onClose()
      props.onRun(pick.name)
    }
  }

  return (
    <box
      position="absolute"
      left={6}
      right={6}
      top={3}
      zIndex={80}
      flexDirection="column"
      border
      borderColor={theme.accent}
      backgroundColor={theme.surface}
    >
      <box flexDirection="row" height={3} flexShrink={0} border={["bottom"]} borderColor={theme.hairlineSoft}>
        <text fg={theme.accent} selectable={false}>
          ⌘{" "}
        </text>
        <input
          ref={(r: InputRenderable) => {
            inputRef = r
          }}
          flexGrow={1}
          placeholder="run a command…"
          onInput={(v: string) => {
            setQuery(v)
            setSel(0)
          }}
          onKeyDown={onKeyDown}
          onSubmit={run}
        />
      </box>
      <For
        each={matches()}
        fallback={<text fg={theme.textFaint}>no matching command</text>}
      >
        {(entry, i) => (
          <box
            flexDirection="row"
            gap={1}
            flexShrink={0}
            backgroundColor={i() === sel() ? theme.surfaceStrong : undefined}
            onMouseDown={() => {
              setSel(i())
              run()
            }}
          >
            <text
              fg={i() === sel() ? theme.accentBright : theme.text}
              attributes={i() === sel() ? TextAttributes.BOLD : undefined}
              selectable={false}
            >
              /{entry.name}
            </text>
            <text fg={theme.textFaint} selectable={false}>
              {entry.description}
              {entry.source === "custom" ? "  ✦" : ""}
            </text>
          </box>
        )}
      </For>
      <text fg={theme.textFaint} flexShrink={0} selectable={false}>
        ↑↓ pick · Enter run · Esc close
      </text>
    </box>
  )
}
