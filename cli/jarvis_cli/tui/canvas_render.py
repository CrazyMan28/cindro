"""Renders the Android WidgetBitmapRenderer DSL (the same spec Canvas/
Widgets/live-widget cards use everywhere else in Jarvis) as Rich
renderables, so the terminal shows the SAME widgets the GUI does instead of
punting to a labeled transcript line.

Layout node types: column, row, grid, text, badge, rect, divider, progress,
spacer, list, canvas, pager. Canvas ops (inside a "canvas" node's "ops"
list): circle, ellipse, rect, line, path.
"""

from __future__ import annotations

from typing import Any

from rich.console import Group, RenderableType
from rich.padding import Padding
from rich.panel import Panel
from rich.progress_bar import ProgressBar
from rich.table import Table
from rich.text import Text


def render_widget_spec(spec: dict[str, Any]) -> RenderableType:
    node_type = spec.get("type", "")
    if node_type == "column":
        return _render_container(spec, vertical=True)
    if node_type == "row":
        return _render_container(spec, vertical=False)
    if node_type == "grid":
        return _render_grid(spec)
    if node_type == "text":
        return _render_text(spec)
    if node_type == "badge":
        return Panel(Text(str(spec.get("text", "")), style="bold cyan"),
                     expand=False, border_style="cyan", padding=(0, 1))
    if node_type == "rect":
        return Panel("", height=1, style=f"on {spec.get('color', '#5FE0FF')}",
                     border_style=spec.get("color", "#5FE0FF"))
    if node_type == "divider":
        return Text("─" * 40, style=spec.get("color", "bright_black"))
    if node_type == "progress":
        bar = ProgressBar(total=1.0, completed=float(spec.get("value", 0.0)),
                          width=30)
        return bar
    if node_type == "spacer":
        return Text(" " * max(int(spec.get("size", 8)), 1))
    if node_type == "list":
        return _render_list(spec)
    if node_type == "canvas":
        return _render_canvas(spec)
    if node_type == "pager":
        pages = spec.get("pages", [])
        idx = int(spec.get("page", 0))
        if 0 <= idx < len(pages):
            return render_widget_spec(pages[idx])
        return Text("")
    return Text(f"[unsupported widget node: {node_type or '?'}]", style="bright_black")


def _apply_frame(spec: dict, renderable: RenderableType) -> RenderableType:
    if spec.get("border") or spec.get("bg"):
        return Panel(renderable, border_style=spec.get("border", "bright_black"),
                     style=f"on {spec['bg']}" if spec.get("bg") else "")
    if spec.get("pad"):
        return Padding(renderable, int(spec["pad"]))
    return renderable


def _render_container(spec: dict, *, vertical: bool) -> RenderableType:
    children = [render_widget_spec(c) for c in spec.get("children", [])]
    body = Group(*children) if vertical else Table.grid(padding=(0, int(spec.get("gap", 1))))
    if not vertical:
        row = body
        row.add_row(*children)
        return _apply_frame(spec, row)
    return _apply_frame(spec, body)


def _render_grid(spec: dict) -> RenderableType:
    cols = max(int(spec.get("cols", 1)), 1)
    table = Table.grid(padding=(0, int(spec.get("gap", 1))))
    for _ in range(cols):
        table.add_column()
    children = [render_widget_spec(c) for c in spec.get("children", [])]
    for i in range(0, len(children), cols):
        row = children[i:i + cols]
        row += [""] * (cols - len(row))
        table.add_row(*row)
    return _apply_frame(spec, table)


def _render_text(spec: dict) -> RenderableType:
    style = ""
    if spec.get("bold"):
        style += "bold "
    if spec.get("color"):
        style += spec["color"]
    return Text(str(spec.get("text", "")), style=style.strip() or None,
               justify=spec.get("align", "left"))


def _render_list(spec: dict) -> RenderableType:
    table = Table.grid(padding=(0, 1))
    table.add_column()
    for row in spec.get("rows", []):
        badge = f"[cyan]{row['badge']}[/]" if row.get("badge") else ""
        color = row.get("color", "")
        text = f"[{color}]{row.get('text', '')}[/]" if color else row.get("text", "")
        table.add_row(Text.from_markup(f"{text}  {badge}".strip()))
    return _apply_frame(spec, table)


def _render_canvas(spec: dict) -> RenderableType:
    # Terminal cells aren't pixels — canvas ops render as a compact
    # description list rather than a pixel-accurate raster (a deliberate,
    # documented translation, same treatment as MemoryGraph's Tree view).
    lines = []
    for op in spec.get("ops", []):
        kind = op.get("op", "?")
        if kind in ("circle", "ellipse"):
            lines.append(f"● at ({op.get('x', 0)},{op.get('y', 0)}) r={op.get('r', op.get('rx', 0))}")
        elif kind == "rect":
            lines.append(f"▭ ({op.get('x', 0)},{op.get('y', 0)}) {op.get('w', 0)}x{op.get('h', 0)}")
        elif kind == "line":
            lines.append(f"─ ({op.get('x1', 0)},{op.get('y1', 0)}) → ({op.get('x2', 0)},{op.get('y2', 0)})")
        elif kind == "path":
            pts = op.get("points", [])
            closed = " (closed)" if op.get("close") else ""
            lines.append(f"⟨path {len(pts)} pts{closed}⟩")
        else:
            lines.append(f"? {kind}")
    return _apply_frame(spec, Text("\n".join(lines) or "(empty canvas)", style="bright_black"))
