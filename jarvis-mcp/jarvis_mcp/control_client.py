"""Async client for the jarvisd control WebSocket (Contract A).

Contract A (see docs/BUILD_SPEC.md) is a single-JSON-object protocol over a
loopback WebSocket:

    Request:  {"v":1,"id":<int>,"method":"<m>","params":{...}}
    Response: {"v":1,"id":<int>,"ok":true,"result":{...}}
              {"v":1,"id":<int>,"ok":false,"error":{"code","message"}}
    Event:    {"v":1,"event":"session.event","data":{...}}   (unsolicited)

This client opens one connection, correlates responses to requests by `id`,
buffers unsolicited session events (so jarvis_session_events can drain them),
and reconnects on demand. A single asyncio.Lock serialises the request/response
round-trips over the one socket so concurrent MCP tool calls never interleave.
"""

import asyncio
import json
from collections import deque
from typing import Any, Optional

import websockets

from jarvis_mcp import config


class ControlError(Exception):
    """A Contract-A {"ok":false,"error":{code,message}} response."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class ControlClient:
    def __init__(self, url_factory=config.control_ws_url, event_buffer: int = 500):
        # url_factory is a callable so the token is re-read on every (re)connect
        # — the daemon may have (re)generated control_token between attempts.
        self._url_factory = url_factory
        self._ws: Optional[Any] = None
        self._next_id = 0
        self._send_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        # Unsolicited session events, newest-last, capped.
        self._events: deque[dict[str, Any]] = deque(maxlen=event_buffer)

    async def _ensure(self) -> Any:
        if self._ws is not None and not self._closed(self._ws):
            return self._ws
        async with self._connect_lock:
            if self._ws is not None and not self._closed(self._ws):
                return self._ws
            url = self._url_factory()
            # Contract A is loopback-only; short timeouts keep tool calls snappy
            # and surface a daemon-down condition instead of hanging.
            self._ws = await asyncio.wait_for(
                websockets.connect(url, max_size=32 * 1024 * 1024,
                                   open_timeout=5, ping_interval=20),
                timeout=6,
            )
            return self._ws

    @staticmethod
    def _closed(ws: Any) -> bool:
        # websockets>=11/16: .closed attribute; fall back to state check.
        closed = getattr(ws, "closed", None)
        if closed is not None:
            return bool(closed)
        state = getattr(ws, "state", None)
        return state is not None and getattr(state, "name", "") == "CLOSED"

    async def call(self, method: str, params: Optional[dict[str, Any]] = None,
                   timeout: float = 60.0) -> dict[str, Any]:
        """One Contract-A request->response round-trip. Raises ControlError on
        an {"ok":false} reply and ConnectionError if the daemon is unreachable.
        """
        params = params or {}
        try:
            ws = await self._ensure()
        except Exception as exc:  # connection/refused/timeout
            raise ConnectionError(
                f"jarvisd control WS unreachable ({config.DEFAULT_CONTROL_WS}): {exc}"
            ) from exc

        async with self._send_lock:
            self._next_id += 1
            req_id = self._next_id
            frame = {"v": 1, "id": req_id, "method": method, "params": params}
            try:
                await ws.send(json.dumps(frame))
                # Read until we see OUR id; stash unsolicited events meanwhile.
                deadline = asyncio.get_event_loop().time() + timeout
                while True:
                    remaining = deadline - asyncio.get_event_loop().time()
                    if remaining <= 0:
                        raise TimeoutError(f"control call '{method}' timed out")
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    msg = json.loads(raw)
                    if msg.get("event"):
                        self._events.append(msg)
                        continue
                    if msg.get("id") != req_id:
                        # A late response to a previous (timed-out) call; skip.
                        continue
                    if msg.get("ok"):
                        return msg.get("result", {}) or {}
                    err = msg.get("error", {}) or {}
                    raise ControlError(err.get("code", "error"),
                                       err.get("message", "unknown error"))
            except (websockets.ConnectionClosed, ConnectionError) as exc:
                # Drop the dead socket so the next call reconnects.
                self._ws = None
                raise ConnectionError(
                    f"jarvisd control connection lost during '{method}': {exc}"
                ) from exc

    def drain_events(self, limit: int = 100) -> list[dict[str, Any]]:
        """Pop up to `limit` buffered unsolicited session events (oldest first)."""
        out: list[dict[str, Any]] = []
        while self._events and len(out) < limit:
            out.append(self._events.popleft())
        return out

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None


# Module-level singleton used by the tool layer.
client = ControlClient()
