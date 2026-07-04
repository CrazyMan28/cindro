"""QuickViewScreen — a reusable inline popup overlay for peeking at any pane
without leaving the tab you're on.

Any of the existing tab panes (MemoryPane, SkillsPane, AgentsPane, QueuePane,
ActivityPane, MemoryGraphPane, SchedulesPane, McpPane, PluginsPane, SshPane,
SessionsPane, …) can be popped up as a floating overlay on top of whatever
screen is active (e.g. Chat) via:

    self.app.push_screen(QuickViewScreen("Memory", lambda: MemoryPane(id="memory-quick")))

Every one of those pane classes already fetches its own data in on_mount(),
so a FRESH instance built by ``pane_factory`` is fully self-sufficient — do
NOT try to reuse the instance already mounted inside the main TabbedContent
(a Textual widget can only be mounted in one place at a time). Give the
fresh instance its own id if the factory sets one, to avoid colliding with
the id of the pane already living in the main TabbedContent.

Escape closes the overlay and returns to whatever screen was underneath
(e.g. still Chat) without touching the main TabbedContent's active tab.
"""

from __future__ import annotations

from typing import Callable

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.screen import ModalScreen
from textual.widget import Widget
from textual.widgets import Static


class QuickViewScreen(ModalScreen[None]):
    """Bordered, centered popup (~80% x 70%) hosting a fresh pane instance."""

    BINDINGS = [
        Binding("escape", "dismiss_overlay", "Close"),
    ]

    DEFAULT_CSS = """
    QuickViewScreen {
        align: center middle;
        background: #06090d 60%;
    }
    QuickViewScreen > #quick-view-box {
        width: 80%;
        height: 70%;
        background: #0a1017;
        border: round #35c8f0;
    }
    QuickViewScreen #quick-view-title {
        height: 1;
        background: #14212e;
        color: #35c8f0;
        text-style: bold;
        padding: 0 1;
    }
    QuickViewScreen > #quick-view-box > Widget {
        height: 1fr;
    }
    """

    def __init__(self, title: str, pane_factory: Callable[[], Widget]) -> None:
        super().__init__()
        self._title = title
        self._pane_factory = pane_factory

    def compose(self) -> ComposeResult:
        with Container(id="quick-view-box"):
            yield Static(f"{self._title}  [bright_black](Esc to close)[/bright_black]",
                         id="quick-view-title", markup=True)
            yield self._pane_factory()

    def action_dismiss_overlay(self) -> None:
        self.dismiss()
