"""CommandPalette — the "/" popup: fuzzy-filters built-in + custom
commands as you type, arrow keys + enter/tab to pick. Mirrors Claude
Code's own slash-command menu."""

from __future__ import annotations

from textual.containers import Vertical
from textual.css.query import NoMatches
from textual.widgets import ListItem, ListView, Static

# Entrance/exit animation timing — short and snappy (crisp, not sluggish),
# matching GitHub Copilot CLI / Claude Code's own polished popup motion.
# Shared with chat.py's _close_palette, which delays the actual `.remove()`
# by this long so the fade-out CSS transition gets to finish playing first.
PALETTE_TRANSITION_MS = 150


class CommandPalette(Vertical):
    # Starts invisible and slightly below its resting position; on_mount
    # (via _animate_in, deferred to call_after_refresh so the mounted state
    # is committed first) flips both styles to their resting values, and the
    # `transition:` rule below animates that change instead of it snapping.
    DEFAULT_CSS = f"""
    CommandPalette {{
        opacity: 0;
        offset: 0 2;
        transition: offset {PALETTE_TRANSITION_MS}ms, opacity {PALETTE_TRANSITION_MS}ms;
    }}
    """

    def __init__(self, builtins: list[tuple[str, str]], customs: list[tuple[str, str]], **kw) -> None:
        super().__init__(**kw)
        self.all_commands = builtins + customs
        self.matches: list[tuple[str, str]] = list(self.all_commands)
        # True once _close_palette has started the exit fade — guards against
        # a second close (or a reopen) re-triggering the animation/removal.
        self.closing = False

    def compose(self):
        yield ListView(id="palette-list")

    def on_mount(self) -> None:
        self._render_matches()
        # Set the resting styles right after mount (not in __init__/compose)
        # so the widget actually paints at its `opacity: 0` / offset start
        # state for one frame first — that's what makes the CSS `transition`
        # animate the change rather than jumping straight to the target.
        self.call_after_refresh(self._animate_in)

    def _animate_in(self) -> None:
        self.styles.opacity = 1.0
        self.styles.offset = (0, 0)

    def start_exit(self) -> None:
        """Begin the fade/slide-out. The caller (chat.py's _close_palette)
        is responsible for actually removing the widget after the
        transition has had time to play (PALETTE_TRANSITION_MS)."""
        self.closing = True
        self.styles.opacity = 0.0
        self.styles.offset = (0, 2)

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
