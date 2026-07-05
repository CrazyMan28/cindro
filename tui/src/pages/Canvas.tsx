// Canvas — the live ad-hoc widget feed (GUI CanvasPage parity the legacy
// TUI only half had): newest-on-top, 20-item cap, update-by-id, and
// per-card actions — ★ save to library (s), delete (x). Pop-out has no
// terminal analog (documented translation: the Widgets library + Home pins
// cover persistent placement).

import { TextAttributes } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"

import { theme } from "../theme"
import type { CanvasStore } from "../widgets/store"
import { saveToLibrary } from "../widgets/store"
import { Widget } from "../widgets/Widget"

function relTime(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

export function CanvasPage(props: {
  store: CanvasStore
  active: () => boolean
  onSendChat: (text: string) => void
}) {
  const [selected, setSelected] = createSignal(0)
  const [status, setStatus] = createSignal("")

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active()) return
      const items = props.store.items()
      switch (key.name) {
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, items.length - 1), i + 1))
          break
        case "s": {
          const item = items[selected()]
          if (item) {
            try {
              saveToLibrary(item)
              setStatus(`★ saved "${item.title}" to the library`)
            } catch (e) {
              setStatus(`save failed: ${String(e)}`)
            }
          }
          break
        }
        case "x": {
          const item = items[selected()]
          if (item) {
            props.store.remove(item.id)
            setStatus(`deleted "${item.title}" from the feed`)
          }
          break
        }
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          // CANVAS
        </text>
        <text fg={theme.textFaint} selectable={false}>
          live widget feed · ↑↓ card · s save★ · x delete
        </text>
        <Show when={status()}>
          <text fg={theme.textMuted} selectable={false}>
            {status()}
          </text>
        </Show>
      </box>
      <scrollbox flexGrow={1}>
        <For
          each={props.store.items()}
          fallback={
            <text fg={theme.textFaint}>
              nothing rendered yet — ask Jarvis for a widget (render_widget) and it
              streams in here live
            </text>
          }
        >
          {(item, i) => (
            <box
              flexDirection="column"
              flexShrink={0}
              border
              borderColor={i() === selected() ? theme.accent : theme.hairlineSoft}
              onMouseDown={() => setSelected(i())}
            >
              <box flexDirection="row" gap={1}>
                <text
                  fg={i() === selected() ? theme.accentBright : theme.accent}
                  attributes={TextAttributes.BOLD}
                  selectable={false}
                >
                  ◆ {item.title}
                </text>
                <text fg={theme.textFaint} selectable={false}>
                  {relTime(item.at)}
                </text>
              </box>
              <Widget
                spec={item.spec}
                onAction={(a) => {
                  if (a.send) props.onSendChat(a.send)
                  else if (a.skill) props.onSendChat(`/${a.skill} ${a.args ?? ""}`.trim())
                }}
              />
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}
