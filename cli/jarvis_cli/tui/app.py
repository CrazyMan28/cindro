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
from jarvis_cli.tui.chat import ChatPane
from jarvis_cli.tui.screens import (AgentsPane, MemoryPane, QueuePane,
                                    SessionsPane, SettingsPane, SkillsPane)


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

    # -- layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:
        yield Static(id="topbar")
        with TabbedContent(initial="tab-chat"):
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
            with TabPane("Settings", id="tab-settings"):
                yield SettingsPane(id="settings")
        yield Footer()

    async def on_mount(self) -> None:
        await self.client.start()
        self._set_topbar()
        self.load_daemon_line()

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

    def _on_broadcast(self, event: str, _data: dict) -> None:
        # session.opened / phone.event / auth.event — refresh the header lazily.
        if event == "session.opened":
            try:
                self.query_one("#sessions", SessionsPane).refresh_data()
            except Exception:
                pass

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
