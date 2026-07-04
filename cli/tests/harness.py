"""A scriptable fake Contract A daemon for jarvis-cli tests (adapted from
acp-bridge's MockDaemon — same wire dialect, wider method table: the CLI
touches settings/memory/skills/agents/queue/search too).

Tests are plain sync functions calling ``run(coro)`` — no pytest-asyncio
required (though it is installed in the cli venv).
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Awaitable, Callable, Optional

import websockets


def run(coro: Awaitable) -> Any:
    return asyncio.run(coro)


class MockDaemon:
    def __init__(self):
        self.server = None
        self.host = "127.0.0.1"
        self.port = 0
        self.token = "mock-control-token"
        self.created_sid = "sess_cli_1"
        self.calls: list[tuple[str, dict]] = []
        self.subscribed: list[str] = []
        self.ws = None  # the most recent client connection — tests that need
                        # to push a session.event out-of-band (e.g. an
                        # approval arriving without a session.send) use this
                        # directly with .emit() instead of the on_send hook.
        self.settings: dict = {
            "version": "9.9.9", "git_sha": "abc1234",
            "default_brain": "codex", "default_model": "",
            "brains": ["codex", "claude", "api"],
            "available_brains": {"codex": True, "claude": True, "api": True},
            "self_improve": "off", "auto_continue": "off",
            "auto_update": True, "auto_update_apply": False,
        }
        self.models_by_brain: dict = {
            "codex": ["gpt-5.5", "gpt-5.5-mini"],
            "claude": ["claude-sonnet-5", "claude-haiku-4-5"],
            "api": ["mistral-small-latest"],
        }
        self.sessions: list[dict] = [
            {"id": "s1", "title": "hello world", "brain": "codex", "state": "idle"},
        ]
        self.memories: list[dict] = [
            {"id": "m1", "text": "user likes cyan", "tags": ["auto"]},
        ]
        self.skills: list[dict] = [
            {"name": "deploy", "group": "self", "description": "ship it",
             "use_count": 3, "pinned": False},
        ]
        self.queue_items: list[dict] = []
        self.on_send: Optional[Callable[["MockDaemon", Any, dict],
                                        Awaitable[None]]] = None
        self._bg: set[asyncio.Task] = set()

    async def _handler(self, ws):
        self.ws = ws
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            rid = msg.get("id", 0)
            method = msg.get("method", "")
            params = msg.get("params") or {}
            self.calls.append((method, params))
            result = await self._dispatch(ws, method, params)
            if result is None:
                resp = {"v": 1, "id": rid, "ok": False,
                        "error": {"code": "unknown_method", "message": method}}
            else:
                resp = {"v": 1, "id": rid, "ok": True, "result": result}
            await ws.send(json.dumps(resp))

    async def _dispatch(self, ws, method, params):
        if method == "ping":
            return {"pong": True}
        if method == "settings.get":
            return {"settings": dict(self.settings)}
        if method == "settings.set":
            self.settings.update(params.get("patch") or {})
            return {"ok": True}
        if method == "model.list":
            brain = params.get("brain") or self.settings.get("default_brain", "codex")
            return {"brain": brain, "models": list(self.models_by_brain.get(brain, []))}
        if method == "session.create":
            return {"session_id": self.created_sid}
        if method == "session.subscribe":
            self.subscribed = list(params.get("session_ids") or [])
            return {"subscribed": self.subscribed}
        if method == "session.send":
            if self.on_send is not None:
                self._spawn(self.on_send(self, ws, params))
            return {"ok": True}
        if method == "session.cancel":
            return {"ok": True}
        if method == "session.list":
            return {"sessions": list(self.sessions)}
        if method == "session.delete":
            self.sessions = [s for s in self.sessions
                             if s.get("id") != params.get("session_id")]
            return {"ok": True}
        if method == "session.history":
            return {"events": [
                {"seq": 1, "ts": 0,
                 "ev": {"kind": "message", "role": "user", "text": "hi"}},
                {"seq": 2, "ts": 0,
                 "ev": {"kind": "message", "role": "assistant", "text": "hello"}},
            ]}
        if method == "session.search":
            return {"hits": [{"session_id": "s1", "session_title": "hello world",
                              "seq": 2, "ts": 0, "score": 1.5,
                              "ev": {"kind": "message", "role": "assistant",
                                     "text": "hello"},
                              "context": []}]}
        if method == "session.set_goals":
            return {"ok": True}
        if method == "approval.respond":
            self._spawn(self.emit(ws, params.get("session_id"), {"kind": "final"}))
            return {"ok": True}
        if method == "memory.list" or method == "memory.search":
            return {"memories": list(self.memories)}
        if method == "memory.remove":
            self.memories = [m for m in self.memories
                             if m.get("id") != params.get("id")]
            return {"ok": True}
        if method == "skills.list":
            return {"skills": list(self.skills)}
        if method == "skills.list_archived":
            return {"skills": []}
        if method == "skills.pin":
            for sk in self.skills:
                if sk["name"] == params.get("name"):
                    sk["pinned"] = bool(params.get("pinned"))
            return {"ok": True}
        if method == "agents.running":
            # SessionRow-shaped (like the real handleAgentsRunning) + flags.
            return {"agents": [{"id": "s9", "agent": "researcher",
                                "title": "sort downloads", "state": "running",
                                "live": True, "running": True}]}
        if method == "queue.list":
            return {"items": list(self.queue_items)}
        if method == "queue.add":
            item = {"id": f"q{len(self.queue_items) + 1}",
                    "title": params.get("title", ""), "status": "pending",
                    "priority": params.get("priority", 0)}
            self.queue_items.append(item)
            return {"id": item["id"]}
        if method == "queue.cancel":
            for it in self.queue_items:
                if it["id"] == params.get("id"):
                    it["status"] = "cancelled"
            return {"ok": True}
        if method == "phone.event.subscribe":
            return {"subscribed": True, "bridge_connected": False}
        return None

    def _spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    async def emit(self, ws, session_id, ev):
        frame = {"v": 1, "event": "session.event",
                 "data": {"session_id": session_id, "ev": ev}}
        await ws.send(json.dumps(frame))

    async def broadcast(self, ws, event, data):
        await ws.send(json.dumps({"v": 1, "event": event, "data": data}))

    async def start(self):
        self.server = await websockets.serve(self._handler, self.host, 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        for t in list(self._bg):
            t.cancel()
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    @property
    def url(self):
        return f"ws://{self.host}:{self.port}/control/ws?token={self.token}"


class DaemonThread:
    """MockDaemon on its OWN event loop in a background thread — for tests of
    sync entry points (cmd_ask/cmd_status/main) that call asyncio.run
    themselves: the daemon must outlive multiple foreground loops."""

    def __init__(self, on_send=None):
        self.daemon = MockDaemon()
        if on_send is not None:
            self.daemon.on_send = on_send
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def __enter__(self):
        self._thread.start()
        asyncio.run_coroutine_threadsafe(self.daemon.start(), self.loop).result(10)
        return self.daemon

    def __exit__(self, *exc):
        asyncio.run_coroutine_threadsafe(self.daemon.stop(), self.loop).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(10)
        self.loop.close()
