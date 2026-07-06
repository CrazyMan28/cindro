// Ctrl/Cmd+K fuzzy palette over the page registry, ported from
// desktop/qml/CommandPalette.qml. Fuzzy-matches via fuzzysort (same library
// tui/ already depends on for its Picker).
import fuzzysort from "fuzzysort"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { getPages } from "../core/router"

export function CommandPalette(props: {
  open: () => boolean
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)

  const results = createMemo(() => {
    const q = query().trim()
    const pages = getPages()
    if (!q) return pages
    const hits = fuzzysort.go(q, pages, { key: "label", limit: 20 })
    return hits.map((h) => h.obj)
  })

  const choose = (id: string) => {
    props.onSelect(id)
    setQuery("")
    setActiveIndex(0)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      props.onClose()
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results().length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const page = results()[activeIndex()]
      if (page) choose(page.id)
    }
  }

  const onGlobalKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      if (props.open()) props.onClose()
      else props.onSelect("__open__")
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onGlobalKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onGlobalKeyDown))
  })

  return (
    <Show when={props.open()}>
      <div
        class="command-palette-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div class="command-palette">
          <input
            ref={(r) => queueMicrotask(() => r.focus())}
            placeholder="Jump to a page…"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
          />
          <div class="command-palette-list">
            <For each={results()}>
              {(page, i) => (
                <div
                  class="command-palette-item"
                  classList={{ active: i() === activeIndex() }}
                  onMouseEnter={() => setActiveIndex(i())}
                  onClick={() => choose(page.id)}
                >
                  {page.label} <span style={{ opacity: 0.5 }}>· {page.section}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
