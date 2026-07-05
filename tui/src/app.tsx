// App shell — topbar + tab strip + page router. Phase 1 carries Home and
// honest per-phase placeholders for every other builtin page (the phases
// that implement them are tracked in the master plan; nothing here pretends
// to work before it does).

import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"

import type { AppApi } from "./app-context"
import { AppContext } from "./app-context"
import type { Action } from "./commands/keybinds"
import { Keybinds } from "./commands/keybinds"
import { dataDir } from "./config"
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
import { SubagentView } from "./chat/SubagentView"
import { CustomPage } from "./pages/engine/CustomPage"
import { TablePage } from "./pages/engine/TablePage"
import { HomeDashboard } from "./pages/Home"
import { ReplayPage } from "./pages/Replay"
import { SettingsPage } from "./pages/Settings"
import { VoicePage } from "./pages/Voice"
import { WidgetsPage } from "./pages/Widgets"
import { CallOverlay } from "./phone/CallOverlay"
import { PhonePage } from "./phone/PhonePage"
import { cycleTheme, theme } from "./theme"
import { Palette } from "./ui/Palette"
import { createToasts, ToastLayer } from "./ui/Toasts"
import { Topbar } from "./ui/Topbar"
import { WhichKey } from "./ui/WhichKey"
import { CanvasStore } from "./widgets/store"

export interface AppProps {
  client: ControlClient
  registry: CommandRegistry
  onQuit: () => void
}

export function App(props: AppProps) {
  // Single-view: chat is root; `overlay` is the /command subpage on top of
  // it (null = plain chat). `page()` in the shared context = the visible
  // surface id.
  const [overlay, setOverlay] = createSignal<string | null>(null)
  const page = () => overlay() ?? "chat"
  const [subagentView, setSubagentView] = createSignal<string | null>(null)
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

  // Every manifest page — builtin, data, AND Jarvis-authored custom (e.g.
  // "GitHub Open PRs") — gets a /command that opens it as a subpage, so a
  // page Jarvis creates with tui_add_page is instantly reachable by /id.
  const syncPageCommands = () => {
    props.registry.registerLocal(
      manifest.pages().map((p) => ({
        name: p.id,
        description: `open ${p.title}${p.source === "custom" ? " ✦" : ""}`,
        kind: "navigate" as const,
        target: p.id,
        run: () => navigate(p.id),
      })),
    )
  }
  void manifest.refresh().then(syncPageCommands)
  props.client.on("ui.manifest.changed", () => void manifest.refresh().then(syncPageCommands))
  props.client.on("tui.layout.changed", () => void manifest.refresh().then(syncPageCommands))

  const keybinds = Keybinds.load()
  const toasts = createToasts()
  const [showDiff, setShowDiff] = createSignal(false)
  const [showPalette, setShowPalette] = createSignal(false)
  const [leaderActive, setLeaderActive] = createSignal(false)
  let leaderTimer: ReturnType<typeof setTimeout> | undefined

  const runCommand = (name: string) => {
    void api.registry
      .execute(name, "", {
        navigate,
        sendChat,
        call: (m, p) => props.client.call(m, p ?? {}),
        notify: (msg, sev) => toasts.push(msg, sev ?? "info"),
        openPicker: () => {},
        openHelp: () => setShowPalette(true),
      })
      .then((found) => {
        if (!found) toasts.push(`unknown command: /${name}`, "warn")
      })
  }

  const exportTranscript = () => {
    const lines = session.items.map((it) => {
      if (it.kind === "user") return `> ${it.text}`
      if (it.kind === "assistant") return it.text
      if (it.kind === "tool") return `  [tool ${it.name} ${it.state}] ${it.output}`.trim()
      if (it.kind === "error") return `! ${it.message}`
      if (it.kind === "notice") return it.text
      return ""
    })
    const md = `# Jarvis session ${session.sessionId() || "(new)"}\n\n${lines
      .filter(Boolean)
      .join("\n\n")}\n`
    const path = join(dataDir(), `transcript-${session.sessionId() || "session"}.md`)
    try {
      writeFileSync(path, md)
      toasts.push(`exported → ${path}`, "success")
    } catch (e) {
      toasts.push(`export failed: ${String(e)}`, "error")
    }
  }

  const runLeader = (action: Action) => {
    switch (action) {
      case "palette":
        setShowPalette(true)
        break
      case "voice":
        navigate("voice")
        break
      case "help":
        setShowPalette(true)
        break
      case "export":
        exportTranscript()
        break
      case "theme":
        toasts.push(`theme: ${cycleTheme()}`, "info")
        break
      case "sessions":
        navigate("sessions")
        break
      case "new":
        void session.newSession().catch((e) => toasts.push(String(e), "error"))
        navigate("chat")
        break
      default:
        break
    }
  }

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

  // Single-view model (Claude Code style): chat is the ONE root screen.
  // Every other surface — home/canvas/widgets/settings/phone/computer/
  // browser/replay/voice + manifest data pages + Jarvis-authored custom
  // pages — opens as a full-screen SUBPAGE overlay via its /command, and
  // Esc returns to chat. There is no tab bar.
  const KNOWN_SUBPAGES = new Set([
    "home", "canvas", "widgets", "settings", "phone", "computer",
    "browser", "replay", "voice",
  ])
  const navigate = (id: string) => {
    if (id === "chat") {
      setOverlay(null)
      return
    }
    if (KNOWN_SUBPAGES.has(id) || manifest.page(id)) {
      setOverlay(id)
      return
    }
    setNotice(`no such page: ${id}`)
  }

  const api: AppApi = {
    client: props.client,
    registry: props.registry,
    page,
    navigate,
    notify: (message) => toasts.push(message, "info"),
    quit: props.onQuit,
  }

  useKeyboard(
    (key: {
      name?: string
      ctrl?: boolean
      meta?: boolean
      option?: boolean
      shift?: boolean
      defaultPrevented?: boolean
    }) => {
      // Leader chord: after the leader prefix, the next key resolves to a
      // leader action (which-key overlay shows the menu meanwhile).
      if (leaderActive()) {
        setLeaderActive(false)
        if (leaderTimer) clearTimeout(leaderTimer)
        if (key.name === "escape") return
        const hit = keybinds.leaderActions().find((e) => e.key === key.name)
        if (hit) runLeader(hit.action)
        return
      }
      if (keybinds.isLeader(key)) {
        setLeaderActive(true)
        leaderTimer = setTimeout(() => setLeaderActive(false), 2000)
        return
      }
      if (keybinds.matches("palette", key)) {
        setShowPalette(true)
        return
      }
      if (keybinds.matches("quit", key)) {
        props.onQuit()
        return
      }
      if (keybinds.matches("voice", key)) {
        navigate("voice")
        return
      }
      if (key.name === "escape" && showPalette()) {
        setShowPalette(false)
        return
      }
      if (key.name === "escape" && subagentView()) {
        setSubagentView(null)
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
    },
    {},
  )

  return (
    <AppContext.Provider value={api}>
      <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg}>
        <Topbar />
        {/* Chat is the ONE root screen. Everything else is a /command
            subpage overlaid on top (below). */}
        <Chat
          session={session}
          active={() => !overlay() && !showPalette() && !showDiff() && !gate()}
          onOpenSubagent={(sid) => setSubagentView(sid)}
        />
        {/* Full-screen subpage overlay — the surface a /command opens. */}
        <Show when={overlay()}>
          {(id) => (
            <box
              position="absolute"
              left={0}
              right={0}
              top={3}
              bottom={1}
              zIndex={30}
              flexDirection="column"
              backgroundColor={theme.bg}
            >
              <Switch
                fallback={
                  <Show
                    when={manifest.page(id())}
                    fallback={
                      <text fg={theme.amber}>{id()} — not available</text>
                    }
                  >
                    {(mp) => (
                      <Switch
                        fallback={
                          <CustomPage page={mp()} onSendChat={(t) => { setOverlay(null); sendChat(t) }} />
                        }
                      >
                        <Match when={mp().kind === "table"}>
                          <TablePage page={mp()} active={() => !!overlay()} />
                        </Match>
                      </Switch>
                    )}
                  </Show>
                }
              >
                <Match when={id() === "home"}>
                  <HomeDashboard
                    active={() => overlay() === "home"}
                    onOpenSession={(sid, title) => {
                      setOverlay(null)
                      void session.openSession(sid, title).catch((e) => setNotice(String(e)))
                    }}
                  />
                </Match>
                <Match when={id() === "canvas"}>
                  <CanvasPage store={canvasStore} active={() => overlay() === "canvas"} onSendChat={sendChat} />
                </Match>
                <Match when={id() === "widgets"}>
                  <WidgetsPage
                    active={() => overlay() === "widgets"}
                    onRenderToCanvas={(item) => { canvasStore.inject(item); navigate("canvas") }}
                    onRenderToChat={(title, spec) => { session.injectWidget(title, spec); setOverlay(null) }}
                  />
                </Match>
                <Match when={id() === "settings"}>
                  <SettingsPage active={() => overlay() === "settings"} />
                </Match>
                <Match when={id() === "phone"}>
                  <PhonePage active={() => overlay() === "phone"} />
                </Match>
                <Match when={id() === "computer"}>
                  <ComputerPage active={() => overlay() === "computer"} />
                </Match>
                <Match when={id() === "browser"}>
                  <BrowserPage active={() => overlay() === "browser"} />
                </Match>
                <Match when={id() === "replay"}>
                  <ReplayPage active={() => overlay() === "replay"} />
                </Match>
                <Match when={id() === "voice"}>
                  <VoicePage active={() => overlay() === "voice"} store={canvasStore} />
                </Match>
              </Switch>
              <text fg={theme.textFaint} selectable={false}>
                Esc → chat
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
            {notice() || "/ commands & subpages · Ctrl+K palette · Ctrl+Q quit"}
          </text>
        </box>
        <Show when={subagentView()}>
          {(sid) => (
            <box
              position="absolute"
              left={0}
              right={0}
              top={3}
              bottom={1}
              zIndex={50}
              flexDirection="column"
              backgroundColor={theme.bg}
            >
              <SubagentView sessionId={sid()} onClose={() => setSubagentView(null)} />
            </box>
          )}
        </Show>
        <CallOverlay />
        <ToastLayer toasts={toasts.toasts} />
        <Show when={leaderActive()}>
          <WhichKey entries={keybinds.leaderActions()} />
        </Show>
        <Show when={showPalette()}>
          <Palette onClose={() => setShowPalette(false)} onRun={runCommand} />
        </Show>
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
