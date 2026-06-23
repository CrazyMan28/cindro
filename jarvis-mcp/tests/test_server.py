"""Jarvis-MCP selftest.

Against the MOCK daemon (always runs):
- the jarvis_* tools are registered on the FastMCP server;
- MCP-layer tools/call of jarvis_list_sessions returns the mock sessions;
- jarvis_start_session round-trips through Contract A.

Against a LIVE daemon (skipped if :8795 control WS is unreachable):
- a real MCP initialize + tools/list over the ASGI app asserts jarvis_* tools
  are present, and one tools/call (jarvis_list_sessions) succeeds.
"""

import json

import pytest

from jarvis_mcp import config, tools_jarvis
from jarvis_mcp.control_client import ControlClient


# --- mock-daemon tests (no real jarvisd needed) ----------------------------

async def test_jarvis_tools_registered(mock_daemon):
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("jarvis-test")
    names = tools_jarvis.register(mcp)
    # Spec-required tools must all be present.
    required = {
        "jarvis_start_session", "jarvis_send", "jarvis_list_sessions",
        "jarvis_session_history", "jarvis_queue_task", "jarvis_memory_search",
        "jarvis_memory_add", "jarvis_skill_list", "jarvis_skill_invoke",
        "jarvis_today",
    }
    assert required.issubset(set(names))
    listed = {t.name for t in await mcp.list_tools()}
    assert required.issubset(listed)


async def test_list_sessions_via_mcp(mock_daemon, monkeypatch):
    from mcp.server.fastmcp import FastMCP
    import jarvis_mcp.control_client as cc

    # Use a fresh client bound to the mock so we don't share the module
    # singleton's (possibly stale) connection.
    fresh = ControlClient()
    monkeypatch.setattr(cc, "client", fresh)
    monkeypatch.setattr(tools_jarvis, "client", fresh)

    mcp = FastMCP("jarvis-test")
    tools_jarvis.register(mcp)
    result = await mcp.call_tool("jarvis_list_sessions", {})
    # FastMCP returns (content_blocks, structured) or a dict; normalise.
    structured = result[1] if isinstance(result, tuple) else result
    payload = structured.get("result", structured) if isinstance(structured, dict) else structured
    sessions = payload.get("sessions", []) if isinstance(payload, dict) else []
    assert any(s.get("id") == "sess_mock1" for s in sessions)
    await fresh.close()


async def test_start_session_roundtrip(mock_daemon, monkeypatch):
    from mcp.server.fastmcp import FastMCP
    import jarvis_mcp.control_client as cc

    fresh = ControlClient()
    monkeypatch.setattr(cc, "client", fresh)
    monkeypatch.setattr(tools_jarvis, "client", fresh)

    mcp = FastMCP("jarvis-test")
    tools_jarvis.register(mcp)
    result = await mcp.call_tool(
        "jarvis_start_session",
        {"profile": "coworker", "brain": "codex", "target": "agent"})
    structured = result[1] if isinstance(result, tuple) else result
    payload = structured.get("result", structured) if isinstance(structured, dict) else structured
    assert payload.get("session_id") == "sess_created"
    await fresh.close()


# --- live-daemon test (real Contract A + real MCP over HTTP) ----------------

def _live_daemon_available() -> bool:
    import asyncio
    import websockets

    async def _try():
        try:
            async with websockets.connect(config.control_ws_url(),
                                          open_timeout=2) as ws:
                await ws.send(json.dumps(
                    {"v": 1, "id": 1, "method": "ping", "params": {}}))
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
                return json.loads(raw).get("ok") is True
        except Exception:
            return False

    try:
        return asyncio.run(_try())
    except Exception:
        return False


@pytest.mark.skipif(not _live_daemon_available(),
                    reason="live jarvisd control WS (:8795) not reachable")
async def test_live_mcp_initialize_and_tools_list():
    """Full-stack: launch the real jarvis-mcp server in a subprocess on a test
    port and connect over loopback with the real MCP streamable-http client —
    exactly how Claude Code / Codex connect. Asserts initialize + tools/list
    (jarvis_* present, computer-use re-exported as jarvis_cu_*) + one tools/call.
    """
    import asyncio
    import os
    import socket
    import sys

    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    # Pick a free port; pass a known inbound token via env.
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    test_port = sock.getsockname()[1]
    sock.close()
    token = "selftest-token"

    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.update({"JARVIS_MCP_TOKEN": token, "JARVIS_MCP_PORT": str(test_port),
                "JARVIS_MCP_HOST": "127.0.0.1"})

    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "jarvis_mcp.server", env=env,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    base = f"http://127.0.0.1:{test_port}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        # Wait for /health to come up.
        import httpx
        async with httpx.AsyncClient() as hc:
            for _ in range(60):
                try:
                    r = await hc.get(f"{base}/health", timeout=1)
                    if r.status_code == 200:
                        break
                except Exception:
                    pass
                await asyncio.sleep(0.25)
            else:
                raise AssertionError("jarvis-mcp server did not become healthy")
            health = (await hc.get(f"{base}/health")).json()
            assert health["service"] == "jarvis-mcp"

        async with streamablehttp_client(f"{base}/mcp", headers=headers) as (
                read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = (await session.list_tools()).tools
                names = {t.name for t in tools}
                assert any(n.startswith("jarvis_") for n in names)
                assert "jarvis_list_sessions" in names
                # computer-use should be re-exported when the engine is up.
                if health.get("computer_use_reexported", 0):
                    assert any(n.startswith("jarvis_cu_") for n in names)

                res = await session.call_tool("jarvis_list_sessions", {})
                assert not res.isError
    finally:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()
