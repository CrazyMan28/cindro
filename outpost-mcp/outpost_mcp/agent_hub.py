"""AgentHub — the persistent WebSocket relay to dialed-in outpost agents.

Each agent holds one WS to /agent/ws. exec/screenshot requests are pushed down
that socket with a correlation req_id; the agent's reply resolves the awaiting
future. The socket is held by the /agent/ws endpoint loop (server.py), which
routes exec_result / screenshot_result frames back into AgentConnection.resolve."""

import asyncio
import json
from typing import Any

from starlette.websockets import WebSocketDisconnect


class AgentConnection:
    def __init__(self, machine_id: str, ws: Any):
        self.machine_id = machine_id
        self.ws = ws
        self._pending: dict[str, asyncio.Future] = {}
        self._counter = 0

    def _next_req_id(self) -> str:
        self._counter += 1
        return f"r{self._counter}"

    async def request(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        req_id = self._next_req_id()
        payload["req_id"] = req_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        try:
            await self.ws.send_text(json.dumps(payload))
        except (WebSocketDisconnect, RuntimeError) as exc:
            # A dying/dead socket raises WebSocketDisconnect (send hit an
            # OSError) or RuntimeError ("Cannot call 'send' once a close
            # message has been sent."/already-disconnected state). Normalize
            # both into a ConnectionError sentinel so callers (AgentHub.exec /
            # screenshot) can treat this exactly like machine_offline instead
            # of letting a raw exception surface as an uncaught 500.
            self._pending.pop(req_id, None)
            raise ConnectionError(f"agent socket unusable: {exc}") from exc
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    def resolve(self, req_id: str, result: dict[str, Any]) -> None:
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_result(result)


class AgentHub:
    def __init__(self, registry: Any):
        self._registry = registry
        self._conns: dict[str, AgentConnection] = {}

    def register(self, conn: AgentConnection) -> None:
        self._conns[conn.machine_id] = conn
        self._registry.set_status(conn.machine_id, "online")

    def unregister(self, machine_id: str, conn: "AgentConnection | None" = None) -> None:
        """Tear down the registered connection for machine_id.

        If `conn` is given, this is a best-effort teardown from a WS loop that
        just exited (e.g. /agent/ws's `finally`) and may be stale: a newer
        connection can already have replaced it in `_conns` (reconnect/roam
        raced ahead of this one noticing its socket died). In that case we
        must NOT touch the registry — only pop/mark-offline if `_conns[machine_id]`
        is still THIS exact connection. If `conn` is None, the caller is an
        intentional forced disconnect (e.g. revoke) and should always win.
        """
        if conn is not None and self._conns.get(machine_id) is not conn:
            return
        self._conns.pop(machine_id, None)
        self._registry.set_status(machine_id, "offline", seen=False)

    def online(self, machine_id: str) -> bool:
        return machine_id in self._conns

    async def exec(self, machine: str, cmd: str, timeout: float = 30.0,
                   shell: str = "auto") -> dict[str, Any]:
        m = self._registry.get(machine)
        if not m:
            return {"ok": False, "exit_code": -1, "output": "", "error": "unknown_machine"}
        conn = self._conns.get(m["id"])
        if not conn:
            return {"ok": False, "exit_code": -1, "output": "", "error": "machine_offline"}
        try:
            res = await conn.request(
                {"type": "exec", "cmd": cmd, "timeout": timeout, "shell": shell},
                timeout=timeout + 5,
            )
        except asyncio.TimeoutError:
            return {"ok": False, "exit_code": -1, "output": "", "error": "agent_timeout"}
        except ConnectionError:
            # The socket died mid-request (send_text failed). Tear down the
            # now-useless connection so the next call doesn't retry it.
            self.unregister(m["id"], conn)
            return {"ok": False, "exit_code": -1, "output": "", "error": "machine_offline"}
        self._registry.set_status(m["id"], "online")
        return {
            "ok": bool(res.get("ok")),
            "exit_code": int(res.get("exit_code", -1)),
            "output": res.get("output", ""),
            "error": res.get("error", ""),
        }

    async def screenshot(self, machine: str) -> dict[str, Any]:
        m = self._registry.get(machine)
        if not m:
            return {
                "ok": False, "image_base64": "", "width": 0, "height": 0,
                "captured_at": 0, "error": "unknown_machine",
            }
        conn = self._conns.get(m["id"])
        if not conn:
            return {
                "ok": False, "image_base64": "", "width": 0, "height": 0,
                "captured_at": 0, "error": "machine_offline",
            }
        try:
            res = await conn.request({"type": "screenshot"}, timeout=45)
        except asyncio.TimeoutError:
            return {
                "ok": False, "image_base64": "", "width": 0, "height": 0,
                "captured_at": 0, "error": "agent_timeout",
            }
        except ConnectionError:
            self.unregister(m["id"], conn)
            return {
                "ok": False, "image_base64": "", "width": 0, "height": 0,
                "captured_at": 0, "error": "machine_offline",
            }
        self._registry.set_status(m["id"], "online")
        return {
            "ok": bool(res.get("ok")),
            "image_base64": res.get("image_base64", ""),
            "width": int(res.get("width", 0)),
            "height": int(res.get("height", 0)),
            "captured_at": res.get("captured_at", 0),
            "error": res.get("error", ""),
        }
