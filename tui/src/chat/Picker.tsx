// <Picker/> — a small centered list overlay (model/provider/voice pickers;
// the QuickView PickerWidget analog). Built on the core <select> renderable,
// which owns its own Up/Down/Enter keys while focused; Escape cancels.

import type { SelectOption, SelectRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { onMount } from "solid-js"

import { theme } from "../theme"

export interface PickerProps {
  title: string
  options: Array<{ label: string; description?: string; value: string }>
  onPick: (value: string) => void
  onCancel: () => void
}

export function Picker(props: PickerProps) {
  let ref: SelectRenderable | undefined
  onMount(() => ref?.focus())

  useKeyboard(
    (key: { name?: string }) => {
      if (key.name === "escape") props.onCancel()
    },
    {},
  )

  return (
    <box
      position="absolute"
      left={4}
      top={2}
      flexDirection="column"
      border
      borderColor={theme.accent}
      backgroundColor={theme.surface}
      minWidth={44}
      zIndex={50}
    >
      <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
        {props.title}
      </text>
      <select
        ref={(r: SelectRenderable) => {
          ref = r
        }}
        height={Math.min(10, Math.max(3, props.options.length))}
        options={props.options.map(
          (o): SelectOption => ({
            name: o.label,
            description: o.description ?? "",
            value: o.value,
          }),
        )}
        onSelect={(_i: number, option: SelectOption | null) => {
          if (option) props.onPick(String(option.value ?? option.name))
        }}
      />
      <text fg={theme.textFaint} selectable={false}>
        ↑↓ pick · Enter confirm · Esc cancel
      </text>
    </box>
  )
}
