"""Model TODO — a plan/checklist the agent maintains and the user can watch.

The model calls `todo_write([...])` to publish or update its task list for the
current job. Each item is {text, status} with status ∈ {pending, in_progress,
done}. The list is persisted per session (so `todo_read` survives across tool
calls) AND rendered as a live checklist card on the widget bus under a stable id
— so it shows inline in chat and on the Canvas, on BOTH the desktop and the
phone, with zero extra UI plumbing (it reuses the generative-widget renderer).

Persisted to:
    ~/.local/share/jarvis/todos/<session>.json   (override dir via JARVIS_TODOS_DIR)

Like the widgets bus, every write is best-effort and never raises into the tool
path. The widget card uses id "__todo__:<session>" so each re-write REPLACES the
card in place instead of stacking duplicates.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import widgets_bus

# ~/.local/share/jarvis/todos/ (override for tests via env).
_DEFAULT_TODOS_DIR = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "jarvis" / "todos"

_VALID_STATUS = ("pending", "in_progress", "done")
_file_lock = threading.Lock()


def todos_dir() -> Path:
    """Resolved at call time so tests can redirect via JARVIS_TODOS_DIR."""
    override = os.environ.get("JARVIS_TODOS_DIR")
    return Path(override) if override else _DEFAULT_TODOS_DIR


def _session_or_env(session_id: str | None) -> str:
    sid = (session_id if session_id is not None
           else os.environ.get("JARVIS_AGENT_SESSION", ""))
    sid = str(sid or "").strip() or "default"
    # Keep the filename filesystem-safe (session ids are usually slugs already).
    return re.sub(r"[^A-Za-z0-9._-]", "_", sid)


def _todos_file(session_id: str | None) -> Path:
    return todos_dir() / f"{_session_or_env(session_id)}.json"


def normalize_items(items) -> list[dict]:
    """Coerce arbitrary input into [{text, status}] with valid statuses.

    Accepts a list of dicts ({text, status}) or bare strings; drops blank text;
    normalizes an unknown/missing status to "pending". Never raises.
    """
    out: list[dict] = []
    if not isinstance(items, (list, tuple)):
        return out
    for it in items:
        if isinstance(it, str):
            text, status = it, "pending"
        elif isinstance(it, dict):
            text = it.get("text", it.get("title", ""))
            status = it.get("status", it.get("state", "pending"))
        else:
            continue
        text = str(text or "").strip()
        if not text:
            continue
        status = str(status or "pending").strip().lower().replace("-", "_")
        if status in ("doing", "active", "wip", "in_progress"):
            status = "in_progress"
        elif status in ("done", "complete", "completed", "finished"):
            status = "done"
        else:
            status = "pending"
        out.append({"text": text, "status": status})
    return out


def write_todos(items, session_id: str | None = None) -> list[dict]:
    """Normalize + persist the list AND render the checklist card. Returns the
    normalized items. Best-effort; never raises into the tool path."""
    norm = normalize_items(items)
    path = _todos_file(session_id)
    payload = {"ts": int(time.time() * 1000), "items": norm}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _file_lock:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
    except (OSError, TypeError, ValueError):
        pass
    render_todo_widget(norm, session_id=session_id)
    return norm


def read_todos(session_id: str | None = None) -> list[dict]:
    """Return the current list (or [] when none/unreadable)."""
    path = _todos_file(session_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("items") if isinstance(data, dict) else data
        return normalize_items(items)
    except (OSError, ValueError):
        return []


def clear_todos(session_id: str | None = None) -> bool:
    """Delete the list and remove its checklist card. True if a file existed."""
    path = _todos_file(session_id)
    existed = path.exists()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    widgets_bus.append_op("remove", widget_id=_card_id(session_id))
    return existed


def _card_id(session_id: str | None) -> str:
    return f"__todo__:{_session_or_env(session_id)}"


# --- checklist widget spec (pure builder, unit-tested) ----------------------

_GLYPH = {"done": "✓", "in_progress": "◐", "pending": "○"}
_GLYPH_COLOR = {"done": "#4ADE80", "in_progress": "#3DD6FF", "pending": "#5A6B7A"}
_TEXT_COLOR = {"done": "#5A6B7A", "in_progress": "#E8F4FF", "pending": "#AEC2D0"}


def todo_widget_spec(items: list[dict], title: str = "") -> dict:
    """Build a checklist card spec from normalized items (pure function)."""
    total = len(items)
    done = sum(1 for i in items if i.get("status") == "done")
    rows: list[dict] = [{
        "type": "row", "gap": 8,
        "children": [
            {"type": "text", "text": "📋  PLAN", "weight": 700, "size": 12,
             "color": "#7FF4FF", "spacing": 1.5, "display": True},
            {"type": "spacer", "grow": True},
            {"type": "badge", "text": f"{done}/{total}", "color": "#3DD6FF"},
        ],
    }, {"type": "divider", "color": "#1E3140"}]

    if not items:
        rows.append({"type": "text", "text": "No items yet.", "size": 12,
                     "color": "#5A6B7A", "italic": True})
    for it in items:
        status = it.get("status", "pending")
        rows.append({
            "type": "row", "gap": 10,
            "children": [
                {"type": "text", "text": _GLYPH.get(status, "○"), "size": 15,
                 "weight": 700, "color": _GLYPH_COLOR.get(status, "#5A6B7A")},
                {"type": "text", "text": it.get("text", ""), "size": 13, "grow": True,
                 "color": _TEXT_COLOR.get(status, "#AEC2D0"),
                 "weight": (700 if status == "in_progress" else 400),
                 "line": 1.25},
            ],
        })

    return {
        "type": "column", "gap": 8, "pad": 14, "fill": True,
        "bg": "#0C141C", "radius": 12, "border": "#16232E", "borderW": 1,
        "children": rows,
    }


def render_todo_widget(items: list[dict], session_id: str | None = None) -> dict:
    """Append the checklist card to the widget bus under the stable per-session
    id (so a re-write replaces it in place). Surfaces in chat + canvas."""
    spec = todo_widget_spec(items)
    return widgets_bus.append_widget(
        spec, title="Plan", widget_id=_card_id(session_id), target="chat",
        session_id=(session_id if session_id is not None
                    else os.environ.get("JARVIS_AGENT_SESSION", "")))


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    def todo_write(items: list) -> str:
        """Publish or UPDATE your plan / task list for the current job.

        Call this whenever you take on a multi-step task: write the steps up
        front, then call again to flip each step's status as you go. It renders a
        live checklist card the user can watch (in chat and on the Canvas, on the
        desktop AND their phone), and it persists so you can recall it later with
        todo_read.

        `items` is a list of {"text": "<step>", "status": "<status>"} where
        status is one of:
          "pending"      — not started yet (○)
          "in_progress"  — working on it now (◐). Keep exactly ONE in_progress.
          "done"         — finished (✓)
        A bare string is treated as a pending item. Re-send the WHOLE list each
        time (it replaces the card in place); to change one step, send the full
        list with that step's new status.

        Use this for any task with 3+ steps, or when the user asks "what's your
        plan?". Skip it for trivial one-shot requests. Returns the normalized
        list and a count.
        """
        norm = write_todos(items)
        done = sum(1 for i in norm if i["status"] == "done")
        return json.dumps({"ok": True, "items": norm, "done": done, "total": len(norm)})

    @mcp.tool()
    def todo_read() -> str:
        """Read back your current plan / task list for this session (the items
        you last published with todo_write). Use it to remember where you were."""
        items = read_todos()
        done = sum(1 for i in items if i["status"] == "done")
        return json.dumps({"ok": True, "items": items, "done": done, "total": len(items)})

    @mcp.tool()
    def todo_clear() -> str:
        """Clear your plan / task list and remove its checklist card (e.g. when
        the whole job is finished)."""
        existed = clear_todos()
        return json.dumps({"ok": True, "cleared": existed})
