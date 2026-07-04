"""CustomPane — renders a user/Jarvis-defined custom TUI page (declarative
content spec only, no code: kind in log/table/markdown/widget/list). This
is what makes tui_add_page/tui_edit_page (tools_tui_ops.py) actually show
up live in the running terminal."""

from __future__ import annotations

import json

from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import DataTable, ListItem, ListView, Markdown, Static

from jarvis_cli.tui.canvas_render import render_widget_spec


class CustomPane(VerticalScroll):
    def __init__(self, page_id: str, title: str, kind: str, config: dict, **kw) -> None:
        super().__init__(**kw)
        self.page_id = page_id
        self.title = title
        self.kind = kind
        self.config = config or {}

    def compose(self) -> ComposeResult:
        if self.kind == "log":
            yield Static(id="custom-log")
        elif self.kind == "table":
            table = DataTable()
            cols = self.config.get("columns") or (
                list(self.config["rows"][0].keys()) if self.config.get("rows") else [])
            table.add_columns(*cols)
            for row in self.config.get("rows", []):
                table.add_row(*[str(row.get(c, "")) for c in cols])
            yield table
        elif self.kind == "markdown":
            yield Markdown(self.config.get("text", ""))
        elif self.kind == "widget":
            yield Static(render_widget_spec(self.config.get("spec", {})))
        elif self.kind == "list":
            lv = ListView()
            for item in self.config.get("items", []):
                lv.append(ListItem(Static(str(item))))
            yield lv
        else:
            yield Static(f"[unsupported custom page kind: {self.kind}]")

    def on_mount(self) -> None:
        if self.kind == "log":
            self.refresh_log()

    def refresh_if_stale(self) -> None:
        if self.kind == "log":
            self.refresh_log()

    def refresh_log(self) -> None:
        path = self.config.get("path", "")
        text = "(no path configured)"
        if path:
            try:
                with open(path, "r", errors="replace") as f:
                    lines = f.readlines()[-200:]
                text = "".join(lines) or "(empty)"
            except OSError as exc:
                text = f"(couldn't read {path}: {exc})"
        self.query_one("#custom-log", Static).update(text)
