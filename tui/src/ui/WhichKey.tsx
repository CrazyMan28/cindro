// <WhichKey/> — the leader-key cheat sheet (OpenCode's which-key overlay).
// Shown after the leader prefix (ctrl+x) is pressed; lists every
// leader-bound action and its follow key. Auto-dismisses on any key (the
// caller resolves the pressed key against the bindings).

import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"

import type { Action } from "../commands/keybinds"
import { LEADER_LABELS } from "../commands/keybinds"
import { theme } from "../theme"

export function WhichKey(props: { entries: Array<{ action: Action; key: string }> }) {
  return (
    <box
      position="absolute"
      left={2}
      right={2}
      bottom={2}
      zIndex={70}
      flexDirection="column"
      border
      borderColor={theme.violet}
      backgroundColor={theme.surface}
    >
      <text fg={theme.violet} attributes={TextAttributes.BOLD} selectable={false}>
        LEADER — press a key
      </text>
      <box flexDirection="row" flexWrap="wrap" gap={2}>
        <For each={props.entries}>
          {(e) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
                {e.key}
              </text>
              <text fg={theme.textMuted} selectable={false}>
                {LEADER_LABELS[e.action]}
              </text>
            </box>
          )}
        </For>
      </box>
      <text fg={theme.textFaint} selectable={false}>
        Esc cancel
      </text>
    </box>
  )
}
