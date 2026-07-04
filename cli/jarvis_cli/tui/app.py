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
from textual.widgets import Footer, Static, TabbedContent, TabPane

from jarvis_cli import __version__, config
from jarvis_cli.control import ControlClient
from jarvis_cli.tui.activity_pane import ActivityPane, ReplayPane
from jarvis_cli.tui.browser_pane import BrowserPane
from jarvis_cli.tui.canvas_pane import CanvasPane, WidgetsPane
from jarvis_cli.tui.chat import ChatPane
from jarvis_cli.tui.computer_pane import ComputerPane
from jarvis_cli.tui.misc_panes import HomePane, MemoryGraphPane, SchedulesPane
from jarvis_cli.tui.phone_pane import PhonePane
from jarvis_cli.tui.screens import (AgentsPane, MemoryPane, QueuePane,
                                    SessionsPane, SettingsPane, SkillsPane)
from jarvis_cli.tui.system_panes import McpPane, PluginsPane, SshPane


class JarvisTui(App):
    TITLE = "JARVIS"

    CSS = """
    Screen {
        background: #06090d;
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
    """

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("ctrl+n", "new_chat", "New chat"),
        Binding("f5", "refresh_tab", "Refresh"),
    ]

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.client = ControlClient(on_broadcast=self._on_broadcast)
        self._daemon_line = "connecting…"
        # last-seen page dict per custom-page id, keyed the same as the
        # tab-custom-{id} pane — lets tui.layout.changed reconciliation tell
        # add vs. edit vs. remove apart without re-diffing widget internals.
        self._custom_pages: dict[str, dict] = {}

    # -- layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:
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

    async def on_unmount(self) -> None:
        await self.client.close()

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
        self._set_topbar()

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
        """Sessions tab → Chat tab (existing session or a fresh one)."""
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
    def action_new_chat(self) -> None:
        self.query_one("#chat", ChatPane).new_session()
        self.query_one(TabbedContent).active = "tab-chat"

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
