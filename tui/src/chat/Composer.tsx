// <Composer/> — the chat input + the inline "/" popup, built so the two
// legacy root-cause bugs are STRUCTURALLY impossible:
//
//   Root cause A (nothing ever focused the input): the composer focuses its
//   own <input> on mount and re-focuses whenever the Chat page activates —
//   focus is the composer's job, not a hope.
//
//   Root cause B (Textual's ancestor-only binding chain meant the popup's
//   list could never receive Up/Down/Enter while the input had focus): here
//   ONE owner — this component — holds both the input and the popup
//   selection state. A useKeyboard layer, enabled only while the popup is
//   open, shadows Up/Down/Tab/Escape and the input's own onSubmit consults
//   the selection. The input NEVER loses focus; the arrows always work;
//   Escape always closes. (The OpenCode autocomplete pattern.)

import type { InputRenderable, KeyEvent } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import type { CommandEntry } from "../commands/registry"
import { theme } from "../theme"

export interface ComposerProps {
  active: () => boolean // Chat page visible (gates keys + focus)
  placeholder?: string
  onValueChange?: (value: string) => void
  onSubmitText: (text: string) => void
  onSlash: (name: string, args: string) => void
}

const POPUP_MAX = 8

export function Composer(props: ComposerProps) {
  const app = useApp()
  const [value, setValue] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [popupClosed, setPopupClosed] = createSignal(false) // Escape latch
  let inputRef: InputRenderable | undefined

  const focus = () => inputRef?.focus()
  onMount(focus)
  // Re-focus every time Chat becomes the active page (root cause A's fix).
  createEffect(() => {
    if (props.active()) queueMicrotask(focus)
  })

  const matches = createMemo<CommandEntry[]>(() => {
    const v = value()
    if (popupClosed() || !v.startsWith("/") || v.includes(" ")) return []
    return app.registry.filter(v.slice(1)).slice(0, POPUP_MAX)
  })
  const popupOpen = createMemo(() => matches().length > 0)

  // The popup's key layer lives ON the focused input itself (the OpenCode
  // pattern): while the popup is open, Up/Down/Tab/Escape are shadowed here
  // — before the input's own defaults — and the input NEVER loses focus.
  const onKeyDown = (key: KeyEvent) => {
    if (!popupOpen()) return
    switch (key.name) {
      case "up":
        setSelected((i) => (i - 1 + matches().length) % matches().length)
        key.preventDefault()
        break
      case "down":
        setSelected((i) => (i + 1) % matches().length)
        key.preventDefault()
        break
      case "tab": {
        const pick = matches()[selected()]
        if (pick) setInput(`/${pick.name} `)
        key.preventDefault()
        break
      }
      case "escape":
        setPopupClosed(true)
        key.preventDefault()
        break
      default:
        break
    }
  }

  const setInput = (text: string) => {
    setValue(text)
    if (inputRef) inputRef.value = text
    props.onValueChange?.(text)
    setPopupClosed(false)
    setSelected(0)
    focus()
  }

  const onInput = (v: string) => {
    setValue(v)
    props.onValueChange?.(v)
    setSelected(0)
    if (!v.startsWith("/")) setPopupClosed(false) // latch resets off slash-mode
  }

  const submit = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    if (popupOpen()) {
      // Enter with the popup open runs the HIGHLIGHTED entry (typed-name
      // fallback still applies because the highlight starts on the best
      // fuzzy match).
      const pick = matches()[selected()]
      if (pick) {
        const rest = text.slice(1).split(/\s+/).slice(1).join(" ")
        setInput("")
        props.onSlash(pick.name, rest)
        return
      }
    }
    setInput("")
    if (text.startsWith("/")) {
      const [name = "", ...rest] = text.slice(1).split(/\s+/)
      props.onSlash(name, rest.join(" "))
      return
    }
    props.onSubmitText(text)
  }

  return (
    <box flexDirection="column" position="relative">
      <Show when={popupOpen()}>
        {/* Floated ABOVE the input as an overlay (legacy palette-above-input
            look) — absolute so a crowded layout can never squeeze the rows
            into each other. */}
        <box
          position="absolute"
          bottom={3}
          left={0}
          right={0}
          zIndex={40}
          flexDirection="column"
          border
          borderColor={theme.hairline}
          backgroundColor={theme.surface}
        >
          <For each={matches()}>
            {(entry, i) => (
              <box
                flexDirection="row"
                flexShrink={0}
                gap={1}
                backgroundColor={i() === selected() ? theme.surfaceStrong : undefined}
                onMouseDown={() => {
                  setSelected(i())
                  submit(`/${entry.name}`)
                }}
              >
                <text
                  fg={i() === selected() ? theme.accentBright : theme.text}
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
            ↑↓ pick · Enter run · Tab complete · Esc close
          </text>
        </box>
      </Show>
      <box flexDirection="row" height={3} flexShrink={0} border borderColor={theme.hairlineSoft}>
        <text fg={theme.accent} flexShrink={0} selectable={false}>
          ❯{" "}
        </text>
        <input
          ref={(r: InputRenderable) => {
            inputRef = r
          }}
          flexGrow={1}
          placeholder={props.placeholder ?? "message · / for commands"}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onSubmit={(v: unknown) => submit(typeof v === "string" ? v : value())}
        />
      </box>
    </box>
  )
}
