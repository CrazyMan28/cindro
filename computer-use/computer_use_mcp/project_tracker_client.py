"""Minimal MCP JSON-RPC-over-HTTP client for the Project Tracker server, used
by proxmox_agent_checkin (tools_jarvis_ops.py) to check whether an enrolled
Proxmox workload-manager agent is alive.

stdlib-only (urllib) on purpose: computer_use_mcp deliberately keeps its
dependency list minimal (see pyproject.toml's comment about mirroring every
new dep into windows/engine/requirements-windows.txt) and this is a handful
of JSON-RPC calls, not worth a new httpx dependency + its Windows mirror.
proxmox-mcp (a separate, Linux-only package) has its own httpx-based copy of
this same small handshake — see its tracker_client.py doc comment for why
it's duplicated rather than shared.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class TrackerError(RuntimeError):
    pass


def _extract_rpc_result(body: str, want_id: int | None = None) -> dict:
    """Mirrors ApiBrain.cpp's mcpExtractRpcResult: plain JSON or an SSE
    `data:` line, AND requires the response `id` to match `want_id` when
    given, so a stray/duplicate message sharing the session can't be
    silently returned as this call's result."""
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


def _post(url: str, headers: dict, payload: dict, timeout: float) -> tuple[str, dict]:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace"), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raise TrackerError(f"HTTP {exc.code} from {url}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise TrackerError(f"unreachable: {exc.reason}") from exc


def call_tool(url: str, bearer: str, tool_name: str, arguments: dict,
              timeout: float = 10.0) -> dict:
    """Full initialize -> notifications/initialized -> tools/call handshake."""
    headers = {"Accept": "application/json, text/event-stream"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"

    _, init_headers = _post(url, headers, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "jarvis-local", "version": "1.0"}},
    }, timeout)
    session_headers = dict(headers)
    sid = init_headers.get("Mcp-Session-Id") or init_headers.get("mcp-session-id")
    if sid:
        session_headers["Mcp-Session-Id"] = sid

    _post(url, session_headers, {
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {},
    }, timeout)

    body, _ = _post(url, session_headers, {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }, timeout)
    rpc = _extract_rpc_result(body, want_id=2)

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


def agent_list_active(url: str, bearer: str) -> dict:
    return call_tool(url, bearer, "agent_list_active", {})
