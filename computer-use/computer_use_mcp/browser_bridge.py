"""WebSocket hub connecting the Chrome extension to the browser_* MCP tools.

Protocol (JSON text frames):
  server -> ext : {"id": "...", "method": "tabs.list", "params": {...}}
  ext -> server : {"id": "...", "result": {...}} or {"id": "...", "error": {"message": "..."}}
  ext -> server : {"event": "hello", "params": {...}} once after connecting
"""

import asyncio
import json
import uuid
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect

from computer_use_mcp import auth
from computer_use_mcp.config import load_config

NOT_CONNECTED = (
    "Chrome extension not connected. Is Chrome running? Is the extension loaded "
    "and enabled at chrome://extensions (and the token/port set in its Options)? "
    "It reconnects within ~30s of Chrome starting."
)


class BridgeNotConnected(RuntimeError):
    pass


class ExtensionBridge:
    """Multiplexes browser commands from any number of concurrent MCP clients
    (Claude Code, Codex, tailnet agents) onto the single extension WebSocket.

    Each command gets a unique id and its own future, so independent agents'
    requests never collide on the response path. The one shared resource is the
    socket's write side: a lock serializes send_text so concurrent agents can't
    interleave half-frames. Reads stay single-consumer in handle().
    """

    def __init__(self) -> None:
        self._ws: Optional[WebSocket] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._send_lock = asyncio.Lock()
        self.hello: dict = {}
        self._command_count = 0

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def handle(self, ws: WebSocket) -> None:
        """Endpoint coroutine: auth, single-connection policy, response pump."""
        if not auth.ws_ok(ws):
            await ws.close(code=4401)
            return
        await ws.accept()

        old, self._ws = self._ws, ws
        if old is not None:
            try:
                await old.close(code=4000)  # replaced by a newer connection
            except Exception:
                pass

        try:
            while True:
                msg = json.loads(await ws.receive_text())
                if msg.get("event") == "hello":
                    self.hello = msg.get("params", {})
                    continue
                fut = self._pending.pop(msg.get("id"), None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
        except WebSocketDisconnect:
            pass
        finally:
            if self._ws is ws:
                self._ws = None
                self.hello = {}
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(BridgeNotConnected(NOT_CONNECTED))
            self._pending.clear()

    async def send_command(self, method: str, params: Optional[dict] = None,
                           timeout: Optional[float] = None) -> Any:
        ws = self._ws
        if ws is None:
            raise BridgeNotConnected(NOT_CONNECTED)
        if timeout is None:
            timeout = float(load_config()["ws_command_timeout"])

        mid = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        self._command_count += 1
        payload = json.dumps({"id": mid, "method": method, "params": params or {}})
        try:
            # Serialize writes only: many agents may be awaiting responses at
            # once, but two concurrent send_text calls could interleave frames.
            async with self._send_lock:
                await ws.send_text(payload)
            msg = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"Extension command {method!r} timed out after {timeout}s "
                "(Chrome may be frozen, or the tab is unresponsive)"
            )
        finally:
            self._pending.pop(mid, None)

        if msg.get("error"):
            err = msg["error"]
            detail = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            raise RuntimeError(f"Extension error for {method}: {detail}")
        return msg.get("result")

    async def ping_loop(self) -> None:
        """App-level pings keep Chrome's MV3 service worker alive (protocol
        pings don't reset its idle timer; JSON messages do)."""
        while True:
            await asyncio.sleep(20)
            if self._ws is None:
                continue
            try:
                await self.send_command("ping", timeout=10)
            except Exception:
                pass  # disconnect cleanup happens in handle()


bridge = ExtensionBridge()
