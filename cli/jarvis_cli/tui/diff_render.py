"""Renders a `diff`-kind chat event (a reviewable per-file patch, matching
desktop/qml/DiffReviewPanel.qml) as Rich renderables for the transcript
RichLog, plus the pure helpers chat.py needs for the /stage /commit /revert
/openpr slash commands.

Event shape: the daemon side of this feature (ControlServer.cpp / the
NormalizedBrainEvent "diff" kind) is not implemented yet anywhere in this
repo — Bridge.cpp's diff.* calls currently degrade on "unknown_method" and
DiffReviewPanel.qml is wired ahead of the daemon landing it. So this module
is deliberately liberal about the event's exact keys: it accepts either a
single-file shape (top-level "path"/"patch", mirroring the QML panel's own
`path`/`patch` properties 1:1) or a multi-file shape ("files": [{"path",
"patch"}, ...]), and tolerates "file"/"diff" as aliases for "path"/"patch"
on each entry.
"""

from __future__ import annotations

from typing import Any

from rich.console import Group, RenderableType
from rich.text import Text

# Mirrors DiffReviewPanel.qml's Repeater cap (model: panel.lines.slice(0, 30))
# — every row is built at once (no virtualization), so keep it tight.
MAX_DIFF_LINES = 30


def extract_diff_files(ev: dict) -> list[dict[str, str]]:
    """Normalize a `diff` event into a list of {"path", "patch"} dicts."""
    files = ev.get("files")
    if isinstance(files, list) and files:
        out = []
        for f in files:
            if not isinstance(f, dict):
                continue
            path = str(f.get("path") or f.get("file") or "")
            patch = str(f.get("patch") or f.get("diff") or "")
            if path or patch:
                out.append({"path": path, "patch": patch})
        return out
    path = str(ev.get("path") or ev.get("file") or "")
    patch = str(ev.get("patch") or ev.get("diff") or "")
    if path or patch:
        return [{"path": path, "patch": patch}]
    return []


def diff_stats(patch: str) -> tuple[int, int]:
    """(added, removed) line counts — same rule as DiffReviewPanel.qml's
    computeStats(): a leading +/- counts unless it's the +++/--- file header."""
    added = removed = 0
    for line in patch.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


def _line_style(line: str) -> str:
    if line.startswith("@@"):
        return "magenta"
    if line.startswith("+++") or line.startswith("---") or line.startswith("diff "):
        return "bright_black"
    if line.startswith("+"):
        return "green"
    if line.startswith("-"):
        return "red"
    return "bright_black"


def render_diff_file(path: str, patch: str) -> RenderableType:
    """One file's compact summary: header (name + stat chips) then a
    truncated unified-diff snippet with +/- lines colored green/red, same
    truncate-and-note treatment chat.py already uses for long tool_result
    output."""
    added, removed = diff_stats(patch)
    header = Text()
    header.append("✎ ", style="cyan")
    header.append(path or "(unknown file)", style="bold")
    if added:
        header.append(f"  +{added}", style="bold green")
    if removed:
        header.append(f"  -{removed}", style="bold red")

    lines = patch.splitlines()
    body: list[RenderableType] = [header]
    for line in lines[:MAX_DIFF_LINES]:
        body.append(Text("  " + (line if line else " "), style=_line_style(line)))
    if len(lines) > MAX_DIFF_LINES:
        body.append(Text(f"  … {len(lines) - MAX_DIFF_LINES} more lines",
                         style="bright_black"))
    return Group(*body)


def render_diff_event(ev: dict[str, Any]) -> RenderableType:
    """The full transcript entry for a `diff`-kind event: every file's
    summary, followed by a reminder of the slash commands that act on it.
    RichLog entries aren't interactive (no clickable buttons like the QML
    panel's PillButtons), so the actions are plain `/`-commands instead —
    consistent with how the rest of this TUI drives everything through the
    Input + command palette rather than inline widgets."""
    files = extract_diff_files(ev)
    if not files:
        return Text("(empty diff)", style="bright_black")
    blocks = [render_diff_file(f["path"], f["patch"]) for f in files]
    blocks.append(Text(
        "  use /stage <file> · /commit · /revert <file> · /openpr",
        style="bright_black"))
    return Group(*blocks)
