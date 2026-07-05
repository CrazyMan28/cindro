// Home — Phase-1 skeleton of the GUI HomePage: greeting + connection pill +
// the manifest-driven page directory (proving the ui.manifest contract
// end-to-end). The hero agent card, quick actions, recent sessions, CPU/RAM
// sparklines and pinned widgets land in Phase 4b per the master plan.

import { TextAttributes } from "@opentui/core"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import { ArcReactor } from "../ui/ArcReactor"

interface PageEntry {
  id: string
  title: string
  section: string
  kind: string
  source?: string
}

function greeting(hour: number, name: string): string {
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"
  return name ? `Good ${part}, ${name}` : `Good ${part}`
}

export function Home() {
  const app = useApp()
  const [userName, setUserName] = createSignal("")
  const [pages, setPages] = createSignal<PageEntry[]>([])
  const [connected, setConnected] = createSignal(false)

  const load = async () => {
    try {
      const s = await app.client.call("settings.get", {}, 5000)
      const settings = (s.settings ?? s) as Record<string, unknown>
      setUserName(String(settings.user_name ?? ""))
      setConnected(true)
    } catch {
      setConnected(false)
    }
    try {
      const m = await app.client.call("ui.manifest.get", {}, 5000)
      setPages(((m.pages ?? []) as PageEntry[]).filter((p) => p.id !== "home"))
    } catch {
      // manifest unavailable — the static tab strip still works
    }
  }

  onMount(() => {
    void load()
    const offManifest = app.client.on("ui.manifest.changed", () => void load())
    onCleanup(offManifest)
  })

  const sections = () => {
    const by = new Map<string, PageEntry[]>()
    for (const p of pages()) {
      const list = by.get(p.section) ?? []
      list.push(p)
      by.set(p.section, list)
    }
    return [...by.entries()]
  }

  return (
    <box flexDirection="column" padding={1} gap={1} flexGrow={1}>
      <box flexDirection="row" gap={2} alignItems="center">
        <ArcReactor size={11} />
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {greeting(new Date().getHours(), userName())}
          </text>
          <text fg={connected() ? theme.success : theme.danger}>
            {connected() ? "● ONLINE" : "○ CONNECTING…"}
          </text>
          <text fg={theme.textFaint}>
            / for commands · Ctrl+K palette (Phase 5) · Ctrl+Q quit
          </text>
        </box>
      </box>

      <Show when={pages().length > 0}>
        <box flexDirection="column" gap={0}>
          <For each={sections()}>
            {([section, entries]) => (
              <box flexDirection="column">
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  // {section.toUpperCase()}
                </text>
                <For each={entries}>
                  {(p) => (
                    <box flexDirection="row" gap={1} paddingLeft={2}>
                      <text fg={theme.text}>{p.title}</text>
                      <text fg={theme.textFaint}>
                        /{p.id}
                        {p.source === "custom" ? "  ✦ custom" : ""}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
