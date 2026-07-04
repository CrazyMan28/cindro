"""CommandPalette — the "/" popup: fuzzy-filters built-in + custom
commands as you type, arrow keys + enter/tab to pick. Mirrors Claude
Code's own slash-command menu."""

from __future__ import annotations

from textual.containers import Vertical
from textual.css.query import NoMatches
from textual.widgets import ListItem, ListView, Static


class CommandPalette(Vertical):
    def __init__(self, builtins: list[tuple[str, str]], customs: list[tuple[str, str]], **kw) -> None:
        super().__init__(**kw)
        self.all_commands = builtins + customs
        self.matches: list[tuple[str, str]] = list(self.all_commands)

    def compose(self):
        yield ListView(id="palette-list")

    def on_mount(self) -> None:
        self._render_matches()

    def filter(self, query: str) -> list[tuple[str, str]]:
        q = query.lower()
        self.matches = [c for c in self.all_commands if q in c[0].lower()]
        self._render_matches()
        return self.matches

    def _render_matches(self) -> None:
        # filter() is also exercised standalone (unmounted, e.g. plain unit
        # tests of the matching logic) — the ListView only exists once
        # compose()/on_mount() has actually run, so tolerate not-yet-mounted.
        try:
            lv = self.query_one("#palette-list", ListView)
        except NoMatches:
            return
        lv.clear()
        for name, desc in self.matches:
            lv.append(ListItem(Static(f"/{name}  [bright_black]{desc}[/]"), name=name))

    def selected_name(self) -> str | None:
        lv = self.query_one("#palette-list", ListView)
        if lv.index is None or not (0 <= lv.index < len(self.matches)):
            return None
        return self.matches[lv.index][0]
