"""MCP tools letting Jarvis reshape the TUI's own page layout live — a
declarative CRUD over custom pages (add/edit/remove/reorder), NOT code.
The 20 builtin pages are reserved and rejected daemon-side; this module is
a thin proxy over the tui.layout.* Contract-A verbs, same shape as
tools_jarvis_ops.py's schedule_task/remember/create_skill.

Tool functions are module-level (rather than nested inside register(), the
tools_jarvis_ops.py style) so they're directly importable/testable, mirroring
tools_todo.py's core-logic-functions precedent; register() wires each one
into the FastMCP instance via mcp.tool()(fn) so the name/docstring/behavior
seen by the model is identical to the nested-@mcp.tool() style."""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client
from computer_use_mcp.tools_jarvis_ops import _err


def _as_obj(value):
    if isinstance(value, str):
        return json.loads(value) if value.strip() else {}
    return value


def tui_list_pages() -> str:
    """List the terminal client's CUSTOM pages (not the 20 builtins)."""
    try:
        return json.dumps(daemon_client.call("tui.layout.list", {}))
    except Exception as exc:
        return _err(exc)


def tui_add_page(page_id: str, title: str, kind: str, config: str | dict = "{}") -> str:
    """Add a NEW custom TUI page (declarative content spec, no code).
    kind must be one of: log, table, markdown, widget, list. `config`
    is a JSON object shaped for that kind (e.g. {"path": "..."} for
    log). Fails if page_id collides with a builtin page."""
    try:
        return json.dumps(daemon_client.call("tui.layout.add", {
            "id": page_id, "title": title, "kind": kind,
            "config": _as_obj(config),
        }))
    except Exception as exc:
        return _err(exc)


def tui_edit_page(page_id: str, config: str | dict) -> str:
    """Replace a custom TUI page's content spec."""
    try:
        return json.dumps(daemon_client.call("tui.layout.edit", {
            "id": page_id, "config": _as_obj(config),
        }))
    except Exception as exc:
        return _err(exc)


def tui_remove_page(page_id: str) -> str:
    """Remove a custom TUI page."""
    try:
        return json.dumps(daemon_client.call("tui.layout.remove", {"id": page_id}))
    except Exception as exc:
        return _err(exc)


def tui_reorder_pages(order: str | list) -> str:
    """Reorder ALL custom TUI pages. `order` is the full list of custom
    page ids in the desired order (must include every existing one)."""
    try:
        order_list = json.loads(order) if isinstance(order, str) else order
        return json.dumps(daemon_client.call("tui.layout.reorder", {"order": order_list}))
    except Exception as exc:
        return _err(exc)


def register(mcp: FastMCP) -> None:
    mcp.tool()(tui_list_pages)
    mcp.tool()(tui_add_page)
    mcp.tool()(tui_edit_page)
    mcp.tool()(tui_remove_page)
    mcp.tool()(tui_reorder_pages)
