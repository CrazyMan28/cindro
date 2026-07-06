// Left sidebar nav, structured exactly like desktop/qml/NavRail.qml:
// WORKSPACE / MIND / SYSTEM sections in a scrollable list, with SETTINGS
// pinned separately at the bottom (never scrolls away). Item set/order comes
// from the page registry (core/router.ts), which pages populate themselves —
// this file does not enumerate ids and never needs editing when a page is
// added.
import { createMemo, For, Show } from "solid-js"

import { theme } from "../core/theme"
import { getPages, type Section } from "../core/router"
import { ArcReactor } from "./ArcReactor"
import { NavIcon } from "./NavIcon"

const SECTION_ORDER: Section[] = ["WORKSPACE", "MIND", "SYSTEM"]
const PINNED_ID = "settings"

export function NavRail(props: { current: () => string; onNavigate: (id: string) => void }) {
  const grouped = createMemo(() => {
    const pages = getPages().filter((p) => p.id !== PINNED_ID && (!p.gated || p.gated()))
    return SECTION_ORDER.map((section) => ({
      section,
      items: pages.filter((p) => p.section === section),
    })).filter((g) => g.items.length > 0)
  })
  const pinned = createMemo(() => getPages().find((p) => p.id === PINNED_ID))

  return (
    <nav class="nav-rail">
      <div class="nav-rail-brand">
        <ArcReactor size={30} />
        <span class="hud-label">J.A.R.V.I.S</span>
      </div>
      <div class="nav-rail-divider" />
      <div class="nav-rail-list">
        <For each={grouped()}>
          {(group) => (
            <div class="nav-rail-section">
              <div class="nav-rail-section-label hud-label">{group.section}</div>
              <For each={group.items}>
                {(item, i) => (
                  <button
                    type="button"
                    class="nav-rail-item"
                    classList={{ active: props.current() === item.id }}
                    onClick={() => props.onNavigate(item.id)}
                    data-page-id={item.id}
                    style={{ "animation-delay": `${i() * 26}ms` }}
                  >
                    <NavIcon
                      glyph={item.id}
                      color={props.current() === item.id ? theme.accent : theme.textMuted}
                      glow={props.current() === item.id}
                    />
                    <span>{item.label}</span>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <Show when={pinned()}>
        {(page) => (
          <div class="nav-rail-pinned">
            <button
              type="button"
              class="nav-rail-item"
              classList={{ active: props.current() === page().id }}
              onClick={() => props.onNavigate(page().id)}
              data-page-id={page().id}
            >
              <NavIcon
                glyph="settings"
                color={props.current() === page().id ? theme.accent : theme.textMuted}
                glow={props.current() === page().id}
              />
              <span>{page().label}</span>
            </button>
          </div>
        )}
      </Show>
    </nav>
  )
}
