"""Async client for the jarvisd control WebSocket (Contract A) — streaming.

Contract A (see ``docs/ARCHITECTURE.md`` §"Contract A") is a single-JSON-object
protocol over a loopback WebSocket:

    Request:  {"v":1,"id":<int>,"method":"<m>","params":{...}}
    Response: {"v":1,"id":<int>,"ok":true,"result":{...}}
              {"v":1,"id":<int>,"ok":false,"error":{"code","message"}}
    Event:    {"v":1,"event":"session.event","data":{"session_id","ev":{kind,...}}}

Unlike jarvis-mcp's ``control_client.py`` (which buffers events in a deque and
drains them *while blocked in a request/response round-trip*), this client is
built for **true streaming**: one dedicated reader task consumes every frame off
the socket and fans ``session.event`` frames into a **per-session asyncio.Queue**,
while replies resolve per-``id`` futures. A ``session/prompt`` turn can therefore
await its session's queue and receive events the instant the daemon emits them,
even between control calls. The connection self-heals with exponential backoff
and re-sends its subscription set on reconnect.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Optional

import websockets

log = logging.getLogger("acp_bridge.control")

# --- Contract A endpoint & token (mirrors jarvis-mcp/jarvis_mcp/config.py) ----
JARVIS_CONFIG_DIR = Path.home() / ".config" / "jarvis"
CONTROL_TOKEN_FILE = JARVIS_CONFIG_DIR / "control_token"
DEFAULT_CONTROL_WS = "ws://127.0.0.1:8795/control/ws"


def control_token() -> str:
    """The jarvisd control token. Env ``JARVIS_CONTROL_TOKEN`` wins (tests / mock
    daemons); otherwise read ``~/.config/jarvis/control_token`` (0600)."""
    env = os.environ.get("JARVIS_CONTROL_TOKEN")
    if env:
        return env.strip()
    try:
        return CONTROL_TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def control_ws_url() -> str:
    """jarvisd control WS with ``?token=`` appended (Contract A auth). Env
    ``JARVIS_CONTROL_WS`` overrides the base URL."""
    base = os.environ.get("JARVIS_CONTROL_WS", DEFAULT_CONTROL_WS)
    token = control_token()
    if not token:
        return base
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}token={token}"


class ControlError(Exception):
    """A Contract-A {"ok":false,"error":{code,message}} response."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class ControlClient:
    """One streaming Contract A connection, shared across every ACP session.

    Use ``call()`` for request/response, ``subscribe()`` to open a per-session
    event queue, and ``close()`` to tear everything down.
    """

    def __init__(
        self,
        url_factory: Callable[[], str] = control_ws_url,
        *,
        max_backoff: float = 15.0,
        queue_maxsize: int = 0,
    ):
        # url_factory is a callable so the token is re-read on every (re)connect —
        # the daemon may (re)generate control_token between attempts.
        self._url_factory = url_factory
        self._max_backoff = max_backoff
        self._queue_maxsize = queue_maxsize

        self._ws: Optional[Any] = None
        self._next_id = 0
        self._pending: dict[int, "asyncio.Future[dict[str, Any]]"] = {}
        # session_id -> queue of NormalizedBrainEvent dicts ({"kind":..., ...}).
        self._queues: dict[str, "asyncio.Queue[dict[str, Any]]"] = {}
        self._subscribed: set[str] = set()

        self._write_lock = asyncio.Lock()
        self._connected = asyncio.Event()
        self._supervisor: Optional[asyncio.Task] = None
        self._closing = False

    # -- lifecycle ----------------------------------------------------------
    async def start(self) -> None:
        """Idempotently launch the background connect+reader supervisor."""
        if self._supervisor is None or self._supervisor.done():
            self._closing = False
            self._supervisor = asyncio.create_task(self._supervise())

    async def close(self) -> None:
        self._closing = True
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._supervisor is not None:
            self._supervisor.cancel()
            try:
                await self._supervisor
            except (asyncio.CancelledError, Exception):
                pass
            self._supervisor = None
        self._fail_pending(ConnectionError("control client closed"))

    async def _supervise(self) -> None:
        backoff = 0.5
        while not self._closing:
            try:
                url = self._url_factory()
                self._ws = await asyncio.wait_for(
                    websockets.connect(
                        url, max_size=32 * 1024 * 1024,
                        open_timeout=5, ping_interval=20,
                    ),
                    timeout=6,
                )
            except Exception as exc:
                self._connected.clear()
                log.warning("control connect failed (%s); retry in %.1fs", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self._max_backoff)
                continue

            backoff = 0.5
            self._connected.set()
            # Re-establish scoping after a reconnect so streams don't go dark.
            if self._subscribed:
                try:
                    await self._send_subscribe()
                except Exception as exc:
                    log.warning("re-subscribe after reconnect failed: %s", exc)
            try:
                async for raw in self._ws:
                    self._on_frame(raw)
            except Exception as exc:
                log.info("control reader ended: %s", exc)
            finally:
                self._connected.clear()
                self._ws = None
                self._fail_pending(ConnectionError("control connection lost"))

            if self._closing:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._max_backoff)

    # -- frame handling -----------------------------------------------------
    def _on_frame(self, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            return
        if not isinstance(msg, dict):
            return

        event = msg.get("event")
        if event == "session.event":
            data = msg.get("data") or {}
            sid = data.get("session_id") or ""
            q = self._queues.get(sid)
            if q is not None:
                # Client-side session-scoping defense: only sessions we track get
                # their events. A foreign session_id (never subscribed) is dropped.
                q.put_nowait(data.get("ev") or {})
            else:
                log.debug("dropping event for untracked session %r", sid)
            return
        if event:
            # Broadcast frames that arrive regardless of scoping: auth.event,
            # session.opened, widget.* — nothing for us to do; log and ignore.
            log.debug("ignoring broadcast frame: %s", event)
            return

        # Otherwise it's a reply to one of our requests.
        mid = msg.get("id")
        fut = self._pending.pop(mid, None)
        if fut is None or fut.done():
            return
        if msg.get("ok"):
            fut.set_result(msg.get("result") or {})
        else:
            err = msg.get("error") or {}
            fut.set_exception(ControlError(err.get("code", "error"),
                                           err.get("message", "unknown error")))

    def _fail_pending(self, exc: BaseException) -> None:
        pending, self._pending = self._pending, {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(exc)

    # -- requests -----------------------------------------------------------
    async def call(self, method: str, params: Optional[dict[str, Any]] = None,
                   timeout: float = 60.0) -> dict[str, Any]:
        """One Contract-A request->response round-trip. Raises ``ControlError``
        on an ``{"ok":false}`` reply, ``ConnectionError`` if the daemon is
        unreachable, and ``TimeoutError`` if no reply arrives in ``timeout``s."""
        await self.start()
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=min(timeout, 10.0))
        except asyncio.TimeoutError:
            raise ConnectionError(
                f"jarvisd control WS unreachable ({DEFAULT_CONTROL_WS})"
            )

        loop = asyncio.get_event_loop()
        fut: "asyncio.Future[dict[str, Any]]" = loop.create_future()
        async with self._write_lock:
            if self._ws is None:
                raise ConnectionError("jarvisd control connection lost")
            self._next_id += 1
            req_id = self._next_id
            self._pending[req_id] = fut
            frame = {"v": 1, "id": req_id, "method": method, "params": params or {}}
            try:
                await self._ws.send(json.dumps(frame))
            except Exception as exc:
                self._pending.pop(req_id, None)
                raise ConnectionError(
                    f"jarvisd control send failed for '{method}': {exc}"
                ) from exc
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise TimeoutError(f"control call '{method}' timed out")

    # -- subscriptions ------------------------------------------------------
    async def subscribe(self, session_id: str) -> "asyncio.Queue[dict[str, Any]]":
        """Register (and return) the per-session event queue for ``session_id``
        and (re)send ``session.subscribe`` with the FULL active set. The daemon
        treats each ``session.subscribe`` as authoritative for the connection, so
        we always re-send every session we track — subscribing session B keeps
        session A scoped in. Call this IMMEDIATELY after ``session.create`` so no
        other chat's events can leak in before scoping is applied."""
        q = self._queues.get(session_id)
        if q is None:
            q = asyncio.Queue(maxsize=self._queue_maxsize)
            self._queues[session_id] = q
        self._subscribed.add(session_id)
        await self._send_subscribe()
        return q

    async def _send_subscribe(self) -> dict[str, Any]:
        return await self.call(
            "session.subscribe",
            {"session_ids": sorted(self._subscribed)},
            timeout=20,
        )

    def queue_for(self, session_id: str) -> Optional["asyncio.Queue[dict[str, Any]]"]:
        return self._queues.get(session_id)

    async def unsubscribe(self, session_id: str) -> None:
        self._queues.pop(session_id, None)
        self._subscribed.discard(session_id)
        try:
            await self._send_subscribe()
        except Exception:
            pass
