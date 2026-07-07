"""Minimal MCP JSON-RPC-over-HTTP client for the Project Tracker server.

Used directly by proxmox-mcp (the pve-resident agent's own check-in calls).
The laptop side (computer_use_mcp's proxmox_agent_checkin tool) has its own
copy of this same small handshake — it is deliberately NOT factored into a
shared installable package: the whole thing is the same 3-step
initialize -> notifications/initialized -> tools/call handshake ApiBrain.cpp
already implements in C++ (mcpPost/ensureMcpInitialized/mcpExtractRpcResult),
mirrored here in ~40 lines. A shared package would mean plumbing one more
pip-installable library across two independently uv-managed venvs for less
code than the plumbing itself would cost.

Response bodies are accepted either as plain JSON or as an SSE stream of
`data: <json>` lines (mirrors mcpExtractRpcResult's dual handling — some MCP
servers reply with one, some the other depending on the Accept negotiation).
"""

from __future__ import annotations

import json

import httpx


class TrackerError(RuntimeError):
    pass


def _extract_rpc_result(body: str, want_id: int | None = None) -> dict:
    """Mirrors ApiBrain.cpp's mcpExtractRpcResult: accepts plain JSON or an
    SSE `data:` line, but ALSO requires the response `id` to match `want_id`
    when given (skip any stray/duplicate message sharing the session, e.g. a
    leftover from initialize/notifications/initialized) — the C++ original
    calls this out by name as a safety check; dropping it here would let a
    body containing more than one JSON-RPC message silently return the wrong
    one instead of failing closed."""
    def matches(obj: object) -> bool:
        if not isinstance(obj, dict) or ("result" not in obj and "error" not in obj):
            return False
        return want_id is None or obj.get("id") == want_id

    body = body.strip()
    try:
        obj = json.loads(body)
        if matches(obj):
            return obj
    except ValueError:
        pass
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        try:
            obj = json.loads(line[len("data:"):].strip())
            if matches(obj):
                return obj
        except ValueError:
            continue
    raise TrackerError(f"no JSON-RPC result/error found for id={want_id!r} in response: "
                       f"{body[:200]!r}")


def call_tool(url: str, bearer: str, tool_name: str, arguments: dict,
              timeout: float = 10.0) -> dict:
    """Full initialize -> notifications/initialized -> tools/call handshake
    against one MCP endpoint, then unwrap the tool's JSON text content."""
    headers = {"Accept": "application/json, text/event-stream",
               "Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"

    with httpx.Client(timeout=timeout) as client:
        init = client.post(url, headers=headers, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "proxmox-mcp", "version": "1.0"}},
        })
        init.raise_for_status()
        session_headers = dict(headers)
        sid = init.headers.get("Mcp-Session-Id") or init.headers.get("mcp-session-id")
        if sid:
            session_headers["Mcp-Session-Id"] = sid

        client.post(url, headers=session_headers, json={
            "jsonrpc": "2.0", "method": "notifications/initialized", "params": {},
        })

        resp = client.post(url, headers=session_headers, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        })
        resp.raise_for_status()
        rpc = _extract_rpc_result(resp.text, want_id=2)

    if "error" in rpc:
        raise TrackerError(rpc["error"].get("message", "unknown MCP error"))
    result = rpc.get("result", {})
    for c in result.get("content", []):
        if c.get("type") == "text":
            try:
                return json.loads(c["text"])
            except ValueError:
                return {"text": c["text"]}
    return result


def agent_checkin(url: str, bearer: str, name: str, project_id: str = "") -> dict:
    return call_tool(url, bearer, "agent_checkin", {"name": name, "project_id": project_id})


def agent_update_status(url: str, bearer: str, name: str, status: str) -> dict:
    return call_tool(url, bearer, "agent_update_status", {"name": name, "status": status})


def agent_set_project(url: str, bearer: str, name: str, project_id: str) -> dict:
    return call_tool(url, bearer, "agent_set_project",
                     {"name": name, "project_id": project_id})


def agent_list_active(url: str, bearer: str) -> dict:
    return call_tool(url, bearer, "agent_list_active", {})
