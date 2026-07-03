"""Test harness: a scriptable fake Contract A daemon (asyncio websockets server)
and an in-memory ACP client that drives the AcpPeer over queues.

Kept plugin-free on purpose: tests are plain sync functions that call
``run(coro)`` (asyncio.run), so they pass in the engine venv which has
``websockets`` + ``pytest`` but no ``pytest-asyncio``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable, Optional

import websockets

from acp_bridge.bridge import Bridge
from acp_bridge.control import ControlClient
from acp_bridge.main import AcpPeer, RpcError, _EOF


def run(coro: Awaitable) -> Any:
    return asyncio.run(coro)


# --------------------------------------------------------------------------
# Fake Contract A control WS daemon
# --------------------------------------------------------------------------
class MockDaemon:
    """A minimal, scriptable Contract-A control WS server. Answers ping,
    session.create, session.subscribe, session.send, approval.respond,
    session.cancel — and can emit canned ``session.event`` frames via
    ``on_send`` (an async callback ``(daemon, ws, params) -> None``)."""

    def __init__(self):
        self.server = None
        self.host = "127.0.0.1"
        self.port = 0
        self.token = "mock-control-token"
        self.created_sid = "sess_acp_1"
        self.calls: list[tuple[str, dict]] = []       # every (method, params), in order
        self.approvals: list[dict] = []               # recorded approval.respond params
        self.subscribed: list[str] = []               # last session.subscribe set
        self.on_send: Optional[Callable[["MockDaemon", Any, dict], Awaitable[None]]] = None
        self._bg: set[asyncio.Task] = set()

    async def _handler(self, ws):
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
            return {"pong": True, "ts": 0}
        if method == "session.create":
            return {"session_id": self.created_sid}
        if method == "session.subscribe":
            self.subscribed = list(params.get("session_ids") or [])
            return {"subscribed": self.subscribed}
        if method == "session.send":
            if self.on_send is not None:
                self._spawn(self.on_send(self, ws, params))
            return {"ok": True}
        if method == "approval.respond":
            self.approvals.append(params)
            # A real daemon resumes the turn after a decision; end it with a final.
            self._spawn(self.emit(ws, params.get("session_id"), {"kind": "final"}))
            return {"ok": True}
        if method == "session.cancel":
            return {"ok": True}
        if method == "session.history":
            return {"events": []}
        return None

    def _spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    async def emit(self, ws, session_id, ev):
        frame = {"v": 1, "event": "session.event",
                 "data": {"session_id": session_id, "ev": ev}}
        await ws.send(json.dumps(frame))

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


# --------------------------------------------------------------------------
# In-memory ACP transport + client
# --------------------------------------------------------------------------
class QueueTransport:
    """A duplex message transport backed by two asyncio queues. The AcpPeer reads
    from ``inbox`` (client -> agent) and writes to ``outbox`` (agent -> client)."""

    def __init__(self):
        self.inbox: "asyncio.Queue[Any]" = asyncio.Queue()
        self.outbox: "asyncio.Queue[Any]" = asyncio.Queue()

    async def read_message(self):
        obj = await self.inbox.get()
        return None if obj is _EOF else obj

    async def write_message(self, obj):
        await self.outbox.put(obj)


class FakeAcpClient:
    """Acts as the editor: sends ACP requests/notifications to the agent, collects
    ``session/update`` notifications, and auto-answers ``session/request_permission``
    with a configurable choice."""

    def __init__(self, transport: QueueTransport):
        self.transport = transport
        self._next_id = 0
        self._pending: dict[int, "asyncio.Future[Any]"] = {}
        self.updates: list[dict] = []
        self.permission_requests: list[dict] = []
        self.permission_choice: Optional[str] = "allow_once"  # None -> cancelled
        self._reader: Optional[asyncio.Task] = None

    def start(self):
        self._reader = asyncio.ensure_future(self._read_loop())

    def stop(self):
        if self._reader:
            self._reader.cancel()

    async def _read_loop(self):
        while True:
            msg = await self.transport.outbox.get()
            if msg is _EOF:
                break
            await self._on_msg(msg)

    async def _on_msg(self, msg):
        if "method" in msg:
            method = msg["method"]
            params = msg.get("params") or {}
            if msg.get("id") is not None:
                await self._on_request(msg["id"], method, params)
            elif method == "session/update":
                self.updates.append(params)
            return
        fut = self._pending.pop(msg.get("id"), None)
        if fut and not fut.done():
            if msg.get("error") is not None:
                fut.set_exception(RpcError(msg["error"]))
            else:
                fut.set_result(msg.get("result"))

    async def _on_request(self, mid, method, params):
        if method == "session/request_permission":
            self.permission_requests.append(params)
            if self.permission_choice is None:
                outcome = {"outcome": "cancelled"}
            else:
                outcome = {"outcome": "selected", "optionId": self.permission_choice}
            await self.transport.inbox.put(
                {"jsonrpc": "2.0", "id": mid, "result": {"outcome": outcome}})
        else:
            await self.transport.inbox.put(
                {"jsonrpc": "2.0", "id": mid,
                 "error": {"code": -32601, "message": f"no client method {method}"}})

    async def request(self, method, params=None, timeout=10):
        self._next_id += 1
        mid = self._next_id
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.transport.inbox.put(
            {"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})
        return await asyncio.wait_for(fut, timeout=timeout)

    async def notify(self, method, params=None):
        await self.transport.inbox.put(
            {"jsonrpc": "2.0", "method": method, "params": params or {}})

    def updates_of_kind(self, kind: str) -> list[dict]:
        return [u for u in self.updates
                if (u.get("update") or {}).get("sessionUpdate") == kind]

    def message_texts(self) -> list[str]:
        return [(u["update"].get("content") or {}).get("text", "")
                for u in self.updates_of_kind("agent_message_chunk")]


# --------------------------------------------------------------------------
# Wiring
# --------------------------------------------------------------------------
class Harness:
    def __init__(self, mock: MockDaemon):
        self.mock = mock
        self.control = ControlClient(url_factory=lambda: mock.url)
        self.transport = QueueTransport()
        self.bridge = Bridge(self.control, default_client="Zed")
        self.peer = AcpPeer(self.transport, self.bridge)
        self.client = FakeAcpClient(self.transport)
        self._peer_task: Optional[asyncio.Task] = None

    async def __aenter__(self):
        await self.control.start()
        self._peer_task = asyncio.ensure_future(self.peer.run())
        self.client.start()
        return self

    async def __aexit__(self, *exc):
        await self.transport.inbox.put(_EOF)  # signal the peer EOF
        try:
            await asyncio.wait_for(self._peer_task, timeout=5)
        except Exception:
            if self._peer_task:
                self._peer_task.cancel()
        self.client.stop()
        await self.control.close()

    async def initialize(self, name="Zed"):
        return await self.client.request(
            "initialize", {"protocolVersion": 1, "clientInfo": {"name": name}})

    async def new_session(self):
        res = await self.client.request(
            "session/new", {"cwd": "/tmp", "mcpServers": []})
        return res["sessionId"]
