// PHONE HUB page — the six-tab shell (PhonePage.qml parity): CALLS, AGENTS,
// INBOX, HUD, SETTINGS, SCREENING. Tabs cycle with [ / ]; the numbered row
// in the header is the tab order (digits themselves belong to the tabs —
// CALLS uses 1-6 for quick-dial chips, INBOX uses 1-9 for quiz options).
// Each tab refreshes on activate and pauses its polling whenever it (or the
// whole page) is inactive; a tab with an open prompt/picker locks tab
// switching so [ ] typed into an input can never yank the page away.

import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Match, Switch } from "solid-js"

import { theme } from "../theme"
import { AgentsTab } from "./tabs/AgentsTab"
import { CallsTab } from "./tabs/CallsTab"
import { HudTab } from "./tabs/HudTab"
import { InboxTab } from "./tabs/InboxTab"
import { ScreeningTab } from "./tabs/ScreeningTab"
import { SettingsTab } from "./tabs/SettingsTab"

const TABS = ["CALLS", "AGENTS", "INBOX", "HUD", "SETTINGS", "SCREENING"]

export function PhonePage(props: { active: () => boolean }) {
  const [tab, setTab] = createSignal(0)
  const [locked, setLocked] = createSignal(false)

  const onModalChange = (open: boolean) => setLocked(open)

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || locked()) return
      if (key.name === "[") setTab((t) => (t + TABS.length - 1) % TABS.length)
      else if (key.name === "]") setTab((t) => (t + 1) % TABS.length)
    },
    {},
  )

  const isActive = (i: number) => () => props.active() && tab() === i

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          {"// PHONE HUB"}
        </text>
        <For each={TABS}>
          {(title, i) => (
            <text
              fg={tab() === i() ? theme.accentBright : theme.textMuted}
              attributes={tab() === i() ? TextAttributes.BOLD : undefined}
              selectable={false}
              onMouseDown={() => {
                if (!locked()) setTab(i())
              }}
            >
              {i() + 1} {title}
            </text>
          )}
        </For>
        <text fg={theme.textFaint} selectable={false}>
          [ ] switch
        </text>
      </box>
      <Switch>
        <Match when={tab() === 0}>
          <CallsTab active={isActive(0)} onModalChange={onModalChange} />
        </Match>
        <Match when={tab() === 1}>
          <AgentsTab active={isActive(1)} onModalChange={onModalChange} />
        </Match>
        <Match when={tab() === 2}>
          <InboxTab active={isActive(2)} onModalChange={onModalChange} />
        </Match>
        <Match when={tab() === 3}>
          <HudTab active={isActive(3)} onModalChange={onModalChange} />
        </Match>
        <Match when={tab() === 4}>
          <SettingsTab active={isActive(4)} onModalChange={onModalChange} />
        </Match>
        <Match when={tab() === 5}>
          <ScreeningTab active={isActive(5)} onModalChange={onModalChange} />
        </Match>
      </Switch>
    </box>
  )
}
