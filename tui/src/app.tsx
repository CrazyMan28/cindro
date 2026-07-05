// App shell — topbar + tab strip + page router. Phase 1 carries Home and
// honest per-phase placeholders for every other builtin page (the phases
// that implement them are tracked in the master plan; nothing here pretends
// to work before it does).

import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Match, Switch } from "solid-js"

import type { AppApi } from "./app-context"
import { AppContext } from "./app-context"
import { SessionController } from "./chat/session"
import type { CommandRegistry } from "./commands/registry"
import type { ControlClient } from "./control/client"
import { Chat } from "./pages/Chat"
import { Home } from "./pages/Home"
import { theme } from "./theme"
import { Topbar } from "./ui/Topbar"

// The 9 main-bar tabs (same set the Textual TUI ships; the 11 popup pages
// arrive with the pages engine in Phase 3).
const TABS: Array<{ id: string; title: string; phase?: string }> = [
  { id: "home", title: "Home" },
  { id: "chat", title: "Chat" },
  { id: "canvas", title: "Canvas", phase: "Phase 4b" },
  { id: "widgets", title: "Widgets", phase: "Phase 4b" },
  { id: "phone", title: "Phone", phase: "Phase 4a" },
  { id: "computer", title: "Computer", phase: "Phase 4c" },
  { id: "browser", title: "Browser", phase: "Phase 4c" },
  { id: "replay", title: "Replay", phase: "Phase 4e" },
  { id: "settings", title: "Settings", phase: "Phase 4d" },
]

export interface AppProps {
  client: ControlClient
  registry: CommandRegistry
  onQuit: () => void
}

export function App(props: AppProps) {
  const [page, setPage] = createSignal("home")
  const [notice, setNotice] = createSignal("")
  const session = new SessionController(props.client)

  const api: AppApi = {
    client: props.client,
    registry: props.registry,
    page,
    navigate: (p) => setPage(p),
    notify: (message) => setNotice(message),
    quit: props.onQuit,
  }

  useKeyboard(
    (key: { name?: string; ctrl?: boolean; meta?: boolean; option?: boolean }) => {
      if (key.ctrl && key.name === "q") {
        props.onQuit()
        return
      }
      // Alt+digit switches tabs (ESC-prefixed, so it works in legacy
      // terminals too — Ctrl+digit famously doesn't encode; bare digits
      // belong to the chat composer and question shortcuts).
      const n = Number.parseInt(key.name ?? "", 10)
      if ((key.meta || key.option) && Number.isInteger(n) && n >= 1 && n <= TABS.length) {
        setPage(TABS[n - 1].id)
      }
    },
    {},
  )

  return (
    <AppContext.Provider value={api}>
      <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg}>
        <Topbar />
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <For each={TABS}>
            {(tab, i) => (
              <text
                fg={page() === tab.id ? theme.accentBright : theme.textMuted}
                attributes={page() === tab.id ? TextAttributes.BOLD : undefined}
                selectable={false}
              >
                {i() + 1}:{tab.title}
              </text>
            )}
          </For>
        </box>
        <Switch
          fallback={
            <box padding={2} flexDirection="column" gap={1} flexGrow={1}>
              <text fg={theme.amber} attributes={TextAttributes.BOLD}>
                {TABS.find((t) => t.id === page())?.title ?? page()}
              </text>
              <text fg={theme.textMuted}>
                Lands in {TABS.find((t) => t.id === page())?.phase ?? "a later phase"} of
                the TUI v2 build — the legacy TUI (jarvis tui --legacy) still has it
                today.
              </text>
            </box>
          }
        >
          <Match when={page() === "home"}>
            <Home />
          </Match>
          <Match when={page() === "chat"}>
            <Chat session={session} active={() => page() === "chat"} />
          </Match>
        </Switch>
        <box
          flexDirection="row"
          paddingLeft={1}
          border={["top"]}
          borderColor={theme.hairlineSoft}
        >
          <text fg={theme.textFaint} selectable={false}>
            {notice() || "Alt+1-9 tabs · / commands · Ctrl+Q quit"}
          </text>
        </box>
      </box>
    </AppContext.Provider>
  )
}
