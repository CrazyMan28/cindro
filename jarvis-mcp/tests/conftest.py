"""Shared fixtures: a mock Contract-A daemon WS, and an in-process ASGI MCP
client so tests don't need a separately-running cindro-mcp process."""

import asyncio
import contextlib
import json

import pytest
import pytest_asyncio
import websockets


class MockDaemon:
    """A minimal Contract-A control WS server for tests. Answers ping,
    session.list, session.create, schedule.list, memory.search, skills.list,
    skills.today — enough to exercise the jarvis_* tools without a real daemon."""

    def __init__(self):
        self.server = None
        self.host = "127.0.0.1"
        self.port = 0  # OS-assigned
        self.token = "mock-control-token"
        self.sessions = [
            {"id": "sess_mock1", "brain": "codex", "profile": "coworker",
             "model": "gpt-5.5", "state": "idle", "title": "Mock session"},
        ]

    async def _handler(self, ws):
        # Contract A path/token check is enforced by jarvisd; the mock accepts
        # any path and just answers framed requests.
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            rid = msg.get("id", 0)
            method = msg.get("method", "")
            params = msg.get("params", {}) or {}
            result = self._dispatch(method, params)
            if result is None:
                resp = {"v": 1, "id": rid, "ok": False,
                        "error": {"code": "unknown_method", "message": method}}
            else:
                resp = {"v": 1, "id": rid, "ok": True, "result": result}
            await ws.send(json.dumps(resp))

    def _dispatch(self, method, params):
        if method == "ping":
            return {"pong": True, "ts": 0}
        if method == "session.list":
            return {"sessions": self.sessions}
        if method == "session.create":
            sid = "sess_created"
            self.sessions.append(
                {"id": sid, "brain": params.get("brain", "codex"),
                 "profile": params.get("profile", "coworker"),
                 "model": params.get("model", "gpt-5.5"),
                 "state": "idle", "title": params.get("title", "")})
            return {"session_id": sid}
        if method == "schedule.list":
            return {"schedules": []}
        if method == "schedule.create":
            return {"id": "sched_mock"}
        if method == "memory.search":
            return {"memories": []}
        if method == "skills.list":
            return {"skills": []}
        if method == "skills.today":
            return {"digest": "# Today\n(mock)\n"}
        return None

    async def start(self):
        self.server = await websockets.serve(self._handler, self.host, 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    @property
    def ws_url(self):
        return f"ws://{self.host}:{self.port}/control/ws"


@pytest_asyncio.fixture
async def mock_daemon(monkeypatch):
    daemon = MockDaemon()
    await daemon.start()
    # Point the cindro-mcp control client at the mock + give it the mock token.
    monkeypatch.setenv("JARVIS_CONTROL_WS", daemon.ws_url)
    monkeypatch.setenv("JARVIS_CONTROL_TOKEN", daemon.token)
    try:
        yield daemon
    finally:
        await daemon.stop()
