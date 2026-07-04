"""CanvasPane (live widget.* broadcast feed) + WidgetsPane (saved widget
library, ~/.local/share/jarvis/saved_widgets.json) — real terminal
rendering via canvas_render, closing the GUI-parity gap the old TUI
punted on."""

from __future__ import annotations

import json

from rich.console import Group
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import ListItem, ListView, Static

from jarvis_cli import config
from jarvis_cli.tui.canvas_render import render_widget_spec


class CanvasPane(VerticalScroll):
    """Tails widget.render/remove/clear broadcasts (already sent to every
    connected control client — no new daemon work needed here)."""

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.items: dict[str, Static] = {}

    def compose(self) -> ComposeResult:
        yield Static(Text("live canvas — renders as widgets stream in",
                          style="bright_black"), classes="pane-hint")

    def on_mount(self) -> None:
        self.app.client.on_broadcast_extra = self._maybe_dispatch

    def _maybe_dispatch(self, event: str, data: dict) -> None:
        if event.startswith("widget."):
            self._on_widget_event(event, data)

    def _on_widget_event(self, event: str, data: dict) -> None:
        wid = data.get("id", "")
        if event == "widget.clear":
            for w in list(self.items.values()):
                w.remove()
            self.items.clear()
            return
        if event == "widget.remove":
            widget = self.items.pop(wid, None)
            if widget:
                widget.remove()
            return
        spec = data.get("spec")
        if isinstance(spec, str):
            spec = json.loads(spec)
        title = data.get("title", "") or wid
        rendered = render_widget_spec(spec or {})
        header = Text(f"── {title} ──\n", style="cyan")
        combined = header + rendered if isinstance(rendered, Text) else Group(header, rendered)
        block = Static(combined)
        if wid in self.items:
            self.items[wid].remove()
        self.items[wid] = block
        self.mount(block)


class WidgetsPane(VerticalScroll):
    """The saved-widget library — reads/writes the SAME
    ~/.local/share/jarvis/saved_widgets.json the desktop app's Widgets page
    uses (Bridge.cpp:3137), via config.data_dir() so profile isolation
    (JARVIS_DATA_DIR) matches the daemon's jarvis::dataDir()."""

    HINT = "enter: render to Canvas · r: refresh"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.saved: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield ListView(id="widgets-list")

    def on_mount(self) -> None:
        self.refresh_saved()

    def refresh_if_stale(self) -> None:
        self.refresh_saved()

    def _library_path(self):
        return config.data_dir() / "saved_widgets.json"

    def refresh_saved(self) -> None:
        path = self._library_path()
        self.saved = []
        if path.exists():
            try:
                data = json.loads(path.read_text())
                self.saved = list(data.get("widgets", []))
            except Exception as exc:
                self.notify(str(exc), severity="error")
        lv = self.query_one("#widgets-list", ListView)
        lv.clear()
        for w in self.saved:
            lv.append(ListItem(Static(w.get("name", w.get("id", "?")))))

    async def on_list_view_selected(self, event: ListView.Selected) -> None:
        idx = self.query_one("#widgets-list", ListView).index
        if idx is None or not (0 <= idx < len(self.saved)):
            return
        w = self.saved[idx]
        spec = w.get("spec")
        if isinstance(spec, str):
            spec = json.loads(spec)
        canvas = self.app.query_one("#canvas", CanvasPane)
        self.app.query_one("TabbedContent").active = "tab-canvas"
        canvas._on_widget_event("widget.render", {
            "id": f"saved:{w.get('id', '')}", "title": w.get("name", ""), "spec": spec,
        })
