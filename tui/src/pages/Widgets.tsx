// Widgets — the saved-widget library (same saved_widgets.json as the
// desktop Widgets page). GUI action parity, terminal-translated:
//   Enter → Canvas (render into the live feed and jump there)
//   c     → Chat   (render inline into the chat transcript)
//   p     → 📌 pin/unpin on Home (additive pinned flag; the GUI ignores it)
//   x     → delete (confirm)   ·   r → refresh   ·   ↑↓ select + live preview

import { TextAttributes } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, onMount, Show } from "solid-js"

import { Picker } from "../chat/Picker"
import { theme } from "../theme"
import type { SavedWidget } from "../widgets/store"
import { loadLibrary, saveLibrary, specOf } from "../widgets/store"
import { Widget } from "../widgets/Widget"

export function WidgetsPage(props: {
  active: () => boolean
  onRenderToCanvas: (item: { id: string; title: string; spec: unknown }) => void
  onRenderToChat: (title: string, spec: Record<string, unknown>) => void
}) {
  const [widgets, setWidgets] = createSignal<SavedWidget[]>([])
  const [rawFile, setRawFile] = createSignal<Record<string, unknown>>({})
  const [selected, setSelected] = createSignal(0)
  const [confirmingDelete, setConfirmingDelete] = createSignal<SavedWidget | null>(null)
  const [status, setStatus] = createSignal("")

  const refresh = () => {
    const { widgets: w, raw } = loadLibrary()
    setWidgets(w)
    setRawFile(raw)
    setSelected((i) => Math.min(i, Math.max(0, w.length - 1)))
  }
  onMount(refresh)

  const persist = (next: SavedWidget[]) => {
    try {
      saveLibrary(next, rawFile())
      refresh()
    } catch (e) {
      setStatus(`save failed: ${String(e)}`)
    }
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active() || confirmingDelete()) {
        return
      }
      const current = widgets()[selected()]
      switch (key.name) {
        case "up":
          setSelected((i) => Math.max(0, i - 1))
          break
        case "down":
          setSelected((i) => Math.min(Math.max(0, widgets().length - 1), i + 1))
          break
        case "return":
          if (current) {
            props.onRenderToCanvas({
              id: `saved:${current.id}`,
              title: current.name,
              spec: specOf(current),
            })
            setStatus(`→ Canvas: ${current.name}`)
          }
          break
        case "c":
          if (current) {
            props.onRenderToChat(current.name, specOf(current))
            setStatus(`→ Chat: ${current.name}`)
          }
          break
        case "p":
          if (current) {
            const maxOrder = Math.max(0, ...widgets().map((w) => w.pin_order ?? 0))
            persist(
              widgets().map((w) =>
                w.id === current.id
                  ? { ...w, pinned: !w.pinned, pin_order: w.pinned ? undefined : maxOrder + 1 }
                  : w,
              ),
            )
            setStatus(current.pinned ? `unpinned ${current.name}` : `📌 pinned ${current.name} to Home`)
          }
          break
        case "x":
          if (current) setConfirmingDelete(current)
          break
        case "r":
          refresh()
          setStatus("refreshed")
          break
        default:
          break
      }
    },
    {},
  )

  return (
    <box flexDirection="row" flexGrow={1} paddingLeft={1} paddingRight={1} gap={2}>
      <box flexDirection="column" minWidth={34} flexShrink={0}>
        <text fg={theme.accentBright} attributes={TextAttributes.BOLD} selectable={false}>
          // WIDGETS
        </text>
        <text fg={theme.textFaint} selectable={false}>
          Enter →Canvas · c →Chat · p 📌Home
        </text>
        <text fg={theme.textFaint} selectable={false}>
          x delete · r refresh
        </text>
        <scrollbox flexGrow={1}>
          <For
            each={widgets()}
            fallback={<text fg={theme.textFaint}>(library empty — save from Canvas with s)</text>}
          >
            {(w, i) => (
              <box flexDirection="row" gap={1} onMouseDown={() => setSelected(i())}>
                <text
                  fg={i() === selected() ? theme.accentBright : theme.text}
                  attributes={i() === selected() ? TextAttributes.BOLD : undefined}
                  selectable={false}
                >
                  {w.pinned ? "📌 " : "   "}
                  {w.name || w.id}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
        <Show when={status()}>
          <text fg={theme.textMuted} selectable={false}>
            {status()}
          </text>
        </Show>
      </box>
      <box flexDirection="column" flexGrow={1} border borderColor={theme.hairlineSoft}>
        <text fg={theme.textFaint} selectable={false}>
          preview
        </text>
        <scrollbox flexGrow={1}>
          <Show
            when={widgets()[selected()]}
            fallback={<text fg={theme.textFaint}>(nothing selected)</text>}
          >
            {(w) => <Widget spec={specOf(w())} />}
          </Show>
        </scrollbox>
      </box>

      <Show when={confirmingDelete()}>
        {(w) => (
          <Picker
            title={`DELETE "${w().name}" from the library?`}
            options={[
              { label: "Yes — delete", value: "yes" },
              { label: "Cancel", value: "no" },
            ]}
            onPick={(v) => {
              const target = w()
              setConfirmingDelete(null)
              if (v === "yes") persist(widgets().filter((x) => x.id !== target.id))
            }}
            onCancel={() => setConfirmingDelete(null)}
          />
        )}
      </Show>
    </box>
  )
}
