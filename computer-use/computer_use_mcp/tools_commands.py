"""MCP tools for the slash-command engine — lets Jarvis author a NEW /
command for itself (same trust model as create_skill: Jarvis writes the
definition, the user sees what runs).

Tool functions are module-level (rather than nested inside register(), the
tools_jarvis_ops.py style) so they're directly importable/testable,
mirroring tools_tui_ops.py's precedent; register() wires each one into the
FastMCP instance via mcp.tool()(fn) so the name/docstring/behavior seen by
the model is identical to the nested-@mcp.tool() style."""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client
from computer_use_mcp.tools_jarvis_ops import _err


def create_slash_command(name: str, description: str, action_kind: str,
                         action_target: str, body: str) -> str:
    """Author a NEW / command. action_kind is one of:
    - "prompt": body is sent as a chat turn ({{ARGS}} substituted)
    - "mcp_tool": action_target is the MCP tool name to call with the
      command's args
    - "shell": action_target is a script path under
      ~/.local/share/jarvis/commands/scripts/
    Fails if `name` collides with a built-in command."""
    try:
        return json.dumps(daemon_client.call("command.create", {
            "name": name, "description": description,
            "action_kind": action_kind, "action_target": action_target,
            "body": body,
        }))
    except Exception as exc:
        return _err(exc)


def list_slash_commands() -> str:
    """List every custom / command (built-ins aren't included — they're
    always present client-side)."""
    try:
        return json.dumps(daemon_client.call("command.list", {}))
    except Exception as exc:
        return _err(exc)


def remove_slash_command(name: str) -> str:
    """Remove a custom / command."""
    try:
        return json.dumps(daemon_client.call("command.remove", {"name": name}))
    except Exception as exc:
        return _err(exc)


def register(mcp: FastMCP) -> None:
    mcp.tool()(create_slash_command)
    mcp.tool()(list_slash_commands)
    mcp.tool()(remove_slash_command)
