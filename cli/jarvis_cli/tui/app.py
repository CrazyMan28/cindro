"""JarvisTui — the full-screen terminal agent.

One TabbedContent mirroring the GUI's screens (Chat, Sessions, Memory, Skills,
Agents, Queue, Settings) over ONE shared streaming ControlClient. The header
line shows live daemon/brain state; broadcast frames keep it fresh without
polling. Arc-reactor palette: near-black blues, cyan accents.

Inherently-graphical GUI pages (Canvas, Computer view, Voice) have no terminal
equivalent — canvas widgets surface as labeled lines in the chat transcript.
"""

from __future__ import annotations

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.widgets import Footer, Static, TabbedContent, TabPane

from jarvis_cli import __version__, config
from jarvis_cli.control import ControlClient
from jarvis_cli.tui.activity_pane import ActivityPane, ReplayPane
from jarvis_cli.tui.arc_reactor import ArcReactorWidget
from jarvis_cli.tui.browser_pane import BrowserPane
from jarvis_cli.tui.canvas_pane import CanvasPane, WidgetsPane
from jarvis_cli.tui.chat import ChatPane
from jarvis_cli.tui.computer_pane import ComputerPane
from jarvis_cli.tui.lock_gate import LockGateScreen
from jarvis_cli.tui.misc_panes import HomePane, MemoryGraphPane, SchedulesPane
from jarvis_cli.tui.phone_pane import PhonePane
from jarvis_cli.tui.quick_view import QuickViewScreen
from jarvis_cli.tui.screens import (AgentsPane, MemoryPane, QueuePane,
                                    SessionsPane, SettingsPane, SkillsPane)
from jarvis_cli.tui.setup_wizard import SetupWizardScreen
from jarvis_cli.tui.system_panes import McpPane, PluginsPane, SshPane
from jarvis_cli.tui.voice_mode import VoiceModeScreen


class JarvisTui(App):
    TITLE = "JARVIS"

    CSS = """
    Screen {
        background: #06090d;
    }
    #topbar-row {
        height: auto;
        background: #0a1017;
    }
    #topbar-spinner {
        margin: 0 1 0 1;
    }
    #topbar {
        height: 1;
        background: #0a1017;
        color: #35c8f0;
        padding: 0 1;
    }
    TabbedContent {
        background: #06090d;
    }
    Tabs {
        background: #0a1017;
    }
    Tab {
        color: #7f8ea0;
    }
    Tab.-active {
        color: #35c8f0;
        text-style: bold;
    }
    #transcript {
        background: #06090d;
        border: round #14212e;
        scrollbar-color: #14212e;
    }
    #landing-reactor {
        margin: 1 0 1 1;
    }
    #typing-preview {
        color: #c9d6e3;
        padding: 0 1;
    }
    #status-row {
        height: auto;
    }
    #status-reactor {
        margin: 0 1 0 1;
    }
    #chat-status {
        height: 1;
        color: #7f8ea0;
        padding: 0 1;
    }
    Input {
        background: #0a1017;
        border: round #1b3242;
    }
    Input:focus {
        border: round #35c8f0;
    }
    DataTable {
        background: #06090d;
        border: round #14212e;
    }
    DataTable > .datatable--header {
        background: #0a1017;
        color: #35c8f0;
    }
    DataTable > .datatable--cursor {
        background: #122433;
    }
    .pane-hint {
        height: 1;
        padding: 0 1;
        background: #0a1017;
    }
    .pane-spinner {
        margin: 0 0 0 1;
    }
    """

    # Ctrl+Q is the unambiguous, single-press quit. Ctrl+C is left to
    # action_quit_confirm (below) instead of Textual's own default
    # ctrl+c -> action_help_quit, so a single stray Ctrl+C — the muscle-memory
    # key people mash by accident — never has any destructive effect; it only
    # arms a short "press again to quit" window (see QUIT_CONFIRM_WINDOW_S).
    QUIT_CONFIRM_WINDOW_S = 2.0

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("ctrl+c", "quit_confirm", "Quit", show=False),
        Binding("ctrl+n", "new_chat", "New chat"),
        Binding("f5", "refresh_tab", "Refresh"),
        Binding("f2", "voice_mode", "Voice"),
    ]

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.client = ControlClient(on_broadcast=self._on_broadcast)
        self._daemon_line = "connecting…"
        # last-seen page dict per custom-page id, keyed the same as the
        # tab-custom-{id} pane — lets tui.layout.changed reconciliation tell
        # add vs. edit vs. remove apart without re-diffing widget internals.
        self._custom_pages: dict[str, dict] = {}
        # double-Ctrl+C-to-quit: True while the "press again" window is open.
        self._quit_armed = False
        self._quit_confirm_timer = None

    # -- layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:
        with Horizontal(id="topbar-row"):
            # Boot spinner: visible from first paint while the first
            # settings.get round-trip (below, in load_daemon_line) is in
            # flight — removed once it resolves, success or failure, so the
            # header collapses back to its normal single line. Same
            # ArcReactorWidget(thinking=True) idiom TablePane uses for its
            # per-tab spinner, just always-on rather than hidden-by-default
            # (the topbar is live from t=0, unlike a not-yet-active tab).
            yield ArcReactorWidget(size=5, thinking=True, id="topbar-spinner")
            yield Static(id="topbar")
        with TabbedContent(initial="tab-home"):
            with TabPane("Home", id="tab-home"):
                yield HomePane(id="home")
            with TabPane("Chat", id="tab-chat"):
                yield ChatPane(id="chat")
            with TabPane("Sessions", id="tab-sessions"):
                yield SessionsPane(id="sessions")
            with TabPane("Memory", id="tab-memory"):
                yield MemoryPane(id="memory")
            with TabPane("Skills", id="tab-skills"):
                yield SkillsPane(id="skills")
            with TabPane("Agents", id="tab-agents"):
                yield AgentsPane(id="agents")
            with TabPane("Queue", id="tab-queue"):
                yield QueuePane(id="queue")
            with TabPane("Schedules", id="tab-schedules"):
                yield SchedulesPane(id="schedules")
            with TabPane("Settings", id="tab-settings"):
                yield SettingsPane(id="settings")
            with TabPane("Canvas", id="tab-canvas"):
                yield CanvasPane(id="canvas")
            with TabPane("Widgets", id="tab-widgets"):
                yield WidgetsPane(id="widgets")
            with TabPane("Phone", id="tab-phone"):
                yield PhonePane(id="phone")
            with TabPane("Computer", id="tab-computer"):
                yield ComputerPane(id="computer")
            with TabPane("Browser", id="tab-browser"):
                yield BrowserPane(id="browser")
            with TabPane("Activity", id="tab-activity"):
                yield ActivityPane(id="activity")
            with TabPane("Graph", id="tab-memorygraph"):
                yield MemoryGraphPane(id="memorygraph")
            with TabPane("Replay", id="tab-replay"):
                yield ReplayPane(id="replay")
            with TabPane("MCP", id="tab-mcp"):
                yield McpPane(id="mcp")
            with TabPane("Plugins", id="tab-plugins"):
                yield PluginsPane(id="plugins")
            with TabPane("SSH", id="tab-ssh"):
                yield SshPane(id="ssh")
        yield Footer()

    async def on_mount(self) -> None:
        await self.client.start()
        self._set_topbar()
        self.load_daemon_line()
        self.run_worker(self.load_custom_pages())
        self.run_worker(self._startup_gates())

    async def on_unmount(self) -> None:
        await self.client.close()

    # -- startup overlays: LockGate then (only once resolved) SetupWizard -------
    async def _startup_gates(self) -> None:
        """Sequenced startup gates, run as ONE worker so the ordering is a
        real guarantee, not a race between two independently-scheduled
        workers: the 2FA/fingerprint LockGate (if a phone is paired) fully
        resolves FIRST (``_check_lock_gate`` blocks on it via
        ``push_screen_wait``), and only THEN is first-run onboarding even
        considered. A locked device must never flash the setup wizard before
        (or underneath) the lock screen."""
        await self._check_lock_gate()
        await self._check_first_run()

    # -- 2FA / fingerprint cross-device unlock (LockGate) -----------------------
    async def _check_lock_gate(self) -> None:
        """Mirrors the desktop GUI's LockGate.qml + Bridge.cpp auth.request
        flow (jarvis 2FA). Mints a challenge ONCE at startup; FAILS OPEN (no
        screen ever shown, app proceeds immediately) on ANY error — daemon
        unreachable, an older daemon lacking auth.* ("unknown_method"), no
        phone paired, or an already-approved state. Only when there's a REAL
        pending challenge to wait on does LockGateScreen get pushed — so a
        user with no paired device (or a daemon that isn't up yet) is never
        locked out, and this never delays/blocks startup otherwise.

        Uses ``push_screen_wait`` (not a bare ``push_screen``) so this
        genuinely blocks until the gate dismisses — required for
        ``_startup_gates`` above to sequence the SetupWizard strictly after
        it, not just after the gate is merely mounted."""
        try:
            result = await self.client.call(
                "auth.request", {"origin": "desktop"}, timeout=15)
        except Exception:
            return
        if not result.get("paired") or result.get("state") == "approved":
            return
        await self.push_screen_wait(
            LockGateScreen(self.client, result.get("challenge_id", "")))

    # -- first-run onboarding (SetupWizard) --------------------------------------
    async def _check_first_run(self) -> None:
        """Mirrors Main.qml showing SetupWizard.qml whenever settings.get's
        ``setup_complete`` is falsy — the EXACT SAME flag the desktop uses
        (SettingsStore::setupComplete(), round-tripped through
        handleSettingsGet/handleSettingsSet), not a separate TUI-only marker.
        That's deliberate: finishing the wizard from either front-end
        persists on the one shared daemon, so the two can never desync.
        Fails open (no daemon reachable => no wizard) just like the lock
        gate above, for the same reason: never block startup on a daemon
        that isn't up yet."""
        try:
            result = await self.client.call("settings.get", {}, timeout=15)
        except Exception:
            return
        settings = result.get("settings", result)
        if settings.get("setup_complete"):
            return
        await self.push_screen_wait(SetupWizardScreen(self.client))

    # -- header ----------------------------------------------------------------
    def _set_topbar(self) -> None:
        state = "[green]●[/green]" if self.client.connected else "[red]●[/red]"
        bar = (f"[bold cyan]◉ JARVIS[/bold cyan] "
               f"[bright_black]terminal v{__version__}[/bright_black]  "
               f"{state} {self._daemon_line}")
        self.query_one("#topbar", Static).update(Text.from_markup(bar))

    @work(exclusive=True)
    async def load_daemon_line(self) -> None:
        try:
            s = await self.client.call("settings.get", {}, timeout=8)
            s = s.get("settings", s)
            self._daemon_line = (f"jarvisd v{s.get('version', '?')} · "
                                 f"{s.get('default_brain', '?')}"
                                 f" · :{config.control_port()}")
        except Exception as exc:
            self._daemon_line = f"daemon unreachable ({exc})"
        try:
            await self.query_one("#topbar-spinner", ArcReactorWidget).remove()
        except Exception:
            pass
        try:
            self._set_topbar()
        except Exception:
            # The app may be mid-teardown (or #topbar otherwise gone) by the
            # time this settings.get round-trip resolves — query_one raising
            # NoMatches here must not crash the worker (WorkerFailed).
            pass

    async def load_custom_pages(self) -> None:
        try:
            res = await self.client.call("tui.layout.list", {})
        except Exception:
            return
        for page in res.get("pages", []):
            self._mount_custom_page(page)

    def _mount_custom_page(self, page: dict) -> None:
        tabbed = self.query_one(TabbedContent)
        tab_id = f"tab-custom-{page['id']}"
        if tabbed.query(f"#{tab_id}"):
            return
        from jarvis_cli.tui.custom_pane import CustomPane
        pane = CustomPane(page["id"], page["title"], page["kind"], page.get("config", {}),
                          id=f"custom-{page['id']}")
        tabbed.add_pane(TabPane(page["title"], pane, id=tab_id))
        self._custom_pages[page["id"]] = page

    async def _reconcile_custom_pages(self, pages: list[dict]) -> None:
        """Full reconciliation against the daemon's CURRENT page list — called
        on every tui.layout.changed broadcast (fired for add/edit/remove/
        reorder alike). CustomPane bakes its config in __init__, so an edited
        page can't be patched in place: drop the pane for any page that
        vanished (tui_remove_page took effect) or whose kind/title/config
        changed (tui_edit_page), then remount fresh; anything unchanged is
        left alone; anything brand new gets mounted. This is what makes the
        documented "live, no restart needed" promise actually true."""
        tabbed = self.query_one(TabbedContent)
        new_ids = {page["id"] for page in pages}
        for stale_id in [pid for pid in self._custom_pages if pid not in new_ids]:
            tab_id = f"tab-custom-{stale_id}"
            if tabbed.query(f"#{tab_id}"):
                await tabbed.remove_pane(tab_id)
            del self._custom_pages[stale_id]
        for page in pages:
            prev = self._custom_pages.get(page["id"])
            changed = prev is not None and (
                prev.get("kind") != page.get("kind")
                or prev.get("config") != page.get("config")
                or prev.get("title") != page.get("title")
            )
            if changed:
                tab_id = f"tab-custom-{page['id']}"
                if tabbed.query(f"#{tab_id}"):
                    await tabbed.remove_pane(tab_id)
                del self._custom_pages[page["id"]]
            self._mount_custom_page(page)

    def _on_broadcast(self, event: str, data: dict) -> None:
        # session.opened / phone.event / auth.event — refresh the header lazily.
        if event == "session.opened":
            try:
                self.query_one("#sessions", SessionsPane).refresh_data()
            except Exception:
                pass
        elif event == "tui.layout.changed":
            self.run_worker(self._reconcile_custom_pages(data.get("pages", [])))

    # -- cross-tab actions --------------------------------------------------------
    async def open_chat(self, session_id: str, title: str) -> None:
        """Sessions tab → Chat tab (existing session or a fresh one).

        Selecting a session from the inline `/sessions` QuickViewScreen popup
        must both switch to Chat AND close the popup — otherwise the modal is
        left floating on top of the Chat tab it just switched to."""
        if isinstance(self.screen, QuickViewScreen):
            self.pop_screen()
        chat = self.query_one("#chat", ChatPane)
        self.query_one(TabbedContent).active = "tab-chat"
        if session_id:
            await chat.open_session(session_id, title)
        else:
            chat.new_session()
        chat.query_one("#chat-input").focus()

    async def run_skill(self, name: str) -> None:
        """Skills tab → invoke in the chat session (like the GUI's Run)."""
        chat = self.query_one("#chat", ChatPane)
        self.query_one(TabbedContent).active = "tab-chat"
        await chat._send(f"/{name}")

    # -- bindings ----------------------------------------------------------------
    def action_quit_confirm(self) -> None:
        """Ctrl+C: first press arms a short confirm window and notifies
        instead of quitting outright (a single stray Ctrl+C — the
        muscle-memory key people mash by accident — must never silently kill
        the app); a second press before the window closes actually quits.
        Ctrl+Q (action_quit) is unaffected — that one's unambiguous."""
        if self._quit_armed:
            self._disarm_quit()
            self.exit()
            return
        self._quit_armed = True
        self.notify("Press Ctrl+C again to quit", title="Quit?", timeout=self.QUIT_CONFIRM_WINDOW_S)
        self._quit_confirm_timer = self.set_timer(self.QUIT_CONFIRM_WINDOW_S, self._disarm_quit)

    def _disarm_quit(self) -> None:
        self._quit_armed = False
        if self._quit_confirm_timer is not None:
            self._quit_confirm_timer.stop()
            self._quit_confirm_timer = None

    def action_new_chat(self) -> None:
        self.query_one("#chat", ChatPane).new_session()
        self.query_one(TabbedContent).active = "tab-chat"

    def action_voice_mode(self) -> None:
        """F2 — push the full-screen push-to-talk voice UI (VoiceModeScreen),
        the terminal analog of desktop/qml/VoiceMode.qml."""
        self.push_screen(VoiceModeScreen(self.client))

    def action_refresh_tab(self) -> None:
        active = self.query_one(TabbedContent).active
        widget_id = active.removeprefix("tab-")
        try:
            pane = self.query_one(f"#{widget_id}")
            if hasattr(pane, "refresh_data"):
                pane.refresh_data()
        except Exception:
            pass

    def on_tabbed_content_tab_activated(self, event) -> None:
        """Refresh a data tab when it becomes visible (throttled — mount
        already fetched, and tab-hopping shouldn't hammer the daemon)."""
        try:
            widget_id = event.pane.id.removeprefix("tab-")
            pane = self.query_one(f"#{widget_id}")
            if hasattr(pane, "refresh_if_stale"):
                pane.refresh_if_stale()
        except Exception:
            pass
