// App shell — topbar + tab strip + page router. Phase 1 carries Home and
// honest per-phase placeholders for every other builtin page (the phases
// that implement them are tracked in the master plan; nothing here pretends
// to work before it does).

import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"

import type { AppApi } from "./app-context"
import { AppContext } from "./app-context"
import { SessionController } from "./chat/session"
import type { CommandRegistry } from "./commands/registry"
import type { ControlClient } from "./control/client"
import { LockGate } from "./gates/LockGate"
import { SetupWizard } from "./gates/SetupWizard"
import { ManifestStore } from "./manifest"
import { BrowserPage } from "./pages/Browser"
import { CanvasPage } from "./pages/Canvas"
import { Chat } from "./pages/Chat"
import { ComputerPage } from "./pages/Computer"
import { DiffReview } from "./chat/DiffReview"
import { CustomPage } from "./pages/engine/CustomPage"
import { TablePage } from "./pages/engine/TablePage"
import { HomeDashboard } from "./pages/Home"
import { ReplayPage } from "./pages/Replay"
import { SettingsPage } from "./pages/Settings"
import { VoicePage } from "./pages/Voice"
import { WidgetsPage } from "./pages/Widgets"
import { CallOverlay } from "./phone/CallOverlay"
import { PhonePage } from "./phone/PhonePage"
import { theme } from "./theme"
import { Topbar } from "./ui/Topbar"
import { CanvasStore } from "./widgets/store"

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
  const [overlay, setOverlay] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal("")
  // Startup gates, run in order like the legacy _startup_gates worker:
  // lock gate (when auth_lock_enabled) then setup wizard (when
  // !setup_complete). Both fail open — a dead daemon never locks the user
  // out of their own terminal.
  const [gate, setGate] = createSignal<"lock" | "wizard" | null>(null)
  void (async () => {
    try {
      const s = await props.client.call("settings.get", {}, 8000)
      const settings = (s.settings ?? s) as Record<string, unknown>
      if (settings.auth_lock_enabled === true) setGate("lock")
      else if (settings.setup_complete !== true) setGate("wizard")
    } catch {
      // fail open
    }
  })()
  const afterLock = async () => {
    try {
      const s = await props.client.call("settings.get", {}, 8000)
      const settings = (s.settings ?? s) as Record<string, unknown>
      setGate(settings.setup_complete !== true ? "wizard" : null)
    } catch {
      setGate(null)
    }
  }
  const session = new SessionController(props.client)
  const manifest = new ManifestStore(props.client)
  const canvasStore = new CanvasStore(props.client)
  void manifest.refresh()

  const [showDiff, setShowDiff] = createSignal(false)

  const sendChat = (text: string) => {
    navigate("chat")
    void session.send(text).catch((e) => setNotice(String(e)))
  }

  // App-level commands (available on every screen, not just Chat): voice
  // mode and the diff review overlay. Chat registers its own session-scoped
  // ones (new/stop/y/n/model…).
  onMount(() => {
    props.registry.registerLocal([
      {
        name: "voice",
        description: "open voice mode",
        kind: "navigate",
        target: "voice",
        run: () => navigate("voice"),
      },
      {
        name: "diff",
        description: "review pending file changes",
        kind: "action",
        run: () => {
          setShowDiff(true)
        },
      },
    ])
  })

  const navigate = (id: string) => {
    if (
      TABS.some((t) => t.id === id) ||
      id === "voice" || // full-page bespoke route (F2 / /voice), not a tab
      manifest.page(id)?.source === "custom"
    ) {
      setOverlay(null)
      setPage(id)
      return
    }
    // Non-tab manifest pages (the 11 data pages) open as an overlay route on
    // top of whatever tab is active — the QuickViewScreen pattern, kept.
    if (manifest.page(id)) setOverlay(id)
    else setNotice(`no such page: ${id}`)
  }

  const api: AppApi = {
    client: props.client,
    registry: props.registry,
    page,
    navigate,
    notify: (message) => setNotice(message),
    quit: props.onQuit,
  }

  useKeyboard(
    (key: {
      name?: string
      ctrl?: boolean
      meta?: boolean
      option?: boolean
      defaultPrevented?: boolean
    }) => {
      if (key.ctrl && key.name === "q") {
        props.onQuit()
        return
      }
      if (key.name === "f2") {
        navigate("voice")
        return
      }
      // Escape closes an open overlay page — but only if nothing INSIDE the
      // overlay (action menu, confirm, search input) consumed it first, so
      // check after every handler has run.
      if (key.name === "escape" && showDiff()) {
        setTimeout(() => {
          if (!key.defaultPrevented) setShowDiff(false)
        }, 0)
        return
      }
      if (key.name === "escape" && overlay()) {
        setTimeout(() => {
          if (!key.defaultPrevented) setOverlay(null)
        }, 0)
        return
      }
      // Alt+digit switches tabs (ESC-prefixed, so it works in legacy
      // terminals too — Ctrl+digit famously doesn't encode; bare digits
      // belong to the chat composer and question shortcuts).
      const n = Number.parseInt(key.name ?? "", 10)
      if ((key.meta || key.option) && Number.isInteger(n) && n >= 1 && n <= TABS.length) {
        setOverlay(null)
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
                onMouseDown={() => navigate(tab.id)}
              >
                {i() + 1}:{tab.title}
              </text>
            )}
          </For>
          <For each={manifest.customPages()}>
            {(cp) => (
              <text
                fg={page() === cp.id ? theme.accentBright : theme.violet}
                attributes={page() === cp.id ? TextAttributes.BOLD : undefined}
                selectable={false}
                onMouseDown={() => navigate(cp.id)}
              >
                ✦{cp.title}
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
            <HomeDashboard
              active={() => page() === "home" && !overlay()}
              onOpenSession={(id, title) => {
                navigate("chat")
                void session.openSession(id, title).catch((e) => setNotice(String(e)))
              }}
            />
          </Match>
          <Match when={page() === "chat"}>
            <Chat session={session} active={() => page() === "chat" && !overlay()} />
          </Match>
          <Match when={page() === "canvas"}>
            <CanvasPage
              store={canvasStore}
              active={() => page() === "canvas" && !overlay()}
              onSendChat={sendChat}
            />
          </Match>
          <Match when={page() === "widgets"}>
            <WidgetsPage
              active={() => page() === "widgets" && !overlay()}
              onRenderToCanvas={(item) => {
                canvasStore.inject(item)
                navigate("canvas")
              }}
              onRenderToChat={(title, spec) => {
                session.injectWidget(title, spec)
                navigate("chat")
              }}
            />
          </Match>
          <Match when={page() === "settings"}>
            <SettingsPage active={() => page() === "settings" && !overlay()} />
          </Match>
          <Match when={page() === "phone"}>
            <PhonePage active={() => page() === "phone" && !overlay()} />
          </Match>
          <Match when={page() === "computer"}>
            <ComputerPage active={() => page() === "computer" && !overlay()} />
          </Match>
          <Match when={page() === "browser"}>
            <BrowserPage active={() => page() === "browser" && !overlay()} />
          </Match>
          <Match when={page() === "replay"}>
            <ReplayPage active={() => page() === "replay" && !overlay()} />
          </Match>
          <Match when={page() === "voice"}>
            <VoicePage active={() => page() === "voice" && !overlay()} store={canvasStore} />
          </Match>
          <Match when={manifest.page(page())?.source === "custom"}>
            <CustomPage page={manifest.page(page())!} onSendChat={sendChat} />
          </Match>
        </Switch>
        <Show when={overlay() ? manifest.page(overlay()!) : undefined}>
          {(op) => (
            <box
              position="absolute"
              left={0}
              right={0}
              top={4}
              bottom={1}
              zIndex={30}
              flexDirection="column"
              backgroundColor={theme.bg}
              border
              borderColor={theme.accent}
            >
              <Switch
                fallback={
                  <CustomPage
                    page={op()}
                    onSendChat={(text) => {
                      setOverlay(null)
                      navigate("chat")
                      void session.send(text).catch((e) => setNotice(String(e)))
                    }}
                  />
                }
              >
                <Match when={op().kind === "table"}>
                  <TablePage page={op()} active={() => true} />
                </Match>
              </Switch>
              <text fg={theme.textFaint} selectable={false}>
                Esc close
              </text>
            </box>
          )}
        </Show>
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
        <CallOverlay />
        <Show when={showDiff()}>
          <box
            position="absolute"
            left={0}
            right={0}
            top={4}
            bottom={1}
            zIndex={60}
            flexDirection="column"
            backgroundColor={theme.bg}
            border
            borderColor={theme.accent}
          >
            <Show
              when={session.diffFiles().length > 0}
              fallback={
                <box padding={2} flexDirection="column" gap={1}>
                  <text fg={theme.amber} attributes={TextAttributes.BOLD}>
                    No pending changes to review
                  </text>
                  <text fg={theme.textMuted}>
                    diff cards appear here as Jarvis edits files this session. Esc close.
                  </text>
                </box>
              }
            >
              <DiffReview
                files={session.diffFiles()}
                sessionId={session.sessionId() || undefined}
                active={() => showDiff()}
              />
            </Show>
            <text fg={theme.textFaint} selectable={false}>
              Esc close
            </text>
          </box>
        </Show>
        <Show when={gate() === "lock"}>
          <box
            position="absolute"
            left={0}
            right={0}
            top={0}
            bottom={0}
            zIndex={100}
            backgroundColor={theme.bgDeep}
          >
            <LockGate onDone={() => void afterLock()} />
          </box>
        </Show>
        <Show when={gate() === "wizard"}>
          <box
            position="absolute"
            left={0}
            right={0}
            top={0}
            bottom={0}
            zIndex={100}
            backgroundColor={theme.bgDeep}
          >
            <SetupWizard onDone={() => setGate(null)} />
          </box>
        </Show>
      </box>
    </AppContext.Provider>
  )
}
