"""Async streaming client for the jarvisd control WebSocket (Contract A).

Adapted from acp-bridge's client (the battle-tested shape): ONE dedicated
reader task resolves per-id reply futures and fans `session.event` frames into
per-session asyncio.Queues, so a chat turn receives events the instant the
daemon emits them. Reconnects with backoff and re-sends the subscription set.

The CLI additionally taps BROADCAST frames (session.opened, auth.event,
phone.event, widget.*) via an optional callback so the TUI header/status can
react without polling.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Optional

import websockets

from jarvis_cli import config

log = logging.getLogger("jarvis_cli.control")


class ControlError(Exception):
    """A Contract-A {"ok":false,"error":{code,message}} response."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class ControlClient:
    def __init__(
        self,
        url_factory: Callable[[], str] = config.control_ws_url,
        *,
        max_backoff: float = 15.0,
        on_broadcast: Optional[Callable[[str, dict], None]] = None,
    ):
        # url_factory is a callable so the token is re-read on every (re)connect.
        self._url_factory = url_factory
        self._max_backoff = max_backoff
        self.on_broadcast = on_broadcast

        self._ws: Optional[Any] = None
        self._next_id = 0
        self._pending: dict[int, "asyncio.Future[dict[str, Any]]"] = {}
        self._queues: dict[str, "asyncio.Queue[dict[str, Any]]"] = {}
        self._subscribed: set[str] = set()

        self._write_lock = asyncio.Lock()
        self._connected = asyncio.Event()
        self._supervisor: Optional[asyncio.Task] = None
        self._closing = False

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    # -- lifecycle ------------------------------------------------------------
    async def start(self) -> None:
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
                self._ws = await asyncio.wait_for(
                    websockets.connect(
                        self._url_factory(), max_size=32 * 1024 * 1024,
                        open_timeout=5, ping_interval=20,
                    ),
                    timeout=6,
                )
            except Exception as exc:
                self._connected.clear()
                log.debug("control connect failed (%s); retry in %.1fs", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self._max_backoff)
                continue

            backoff = 0.5
            self._connected.set()
            if self._subscribed:
                try:
                    await self._send_subscribe()
                except Exception as exc:
                    log.warning("re-subscribe after reconnect failed: %s", exc)
            try:
                async for raw in self._ws:
                    self._on_frame(raw)
            except Exception as exc:
                log.debug("control reader ended: %s", exc)
            finally:
                self._connected.clear()
                self._ws = None
                self._fail_pending(ConnectionError("control connection lost"))

            if self._closing:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._max_backoff)

    # -- frame handling ---------------------------------------------------------
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
                # Session-scoping defense: only tracked sessions get events.
                q.put_nowait(data.get("ev") or {})
            return
        if event:
            # Broadcast frames (session.opened / auth.event / phone.event /
            # widget.*) — surfaced to the TUI when it cares, else ignored.
            if self.on_broadcast is not None:
                try:
                    self.on_broadcast(event, msg.get("data") or {})
                except Exception:
                    log.exception("broadcast handler failed for %s", event)
            return

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

    # -- requests ---------------------------------------------------------------
    async def call(self, method: str, params: Optional[dict[str, Any]] = None,
                   timeout: float = 60.0) -> dict[str, Any]:
        await self.start()
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=min(timeout, 8.0))
        except asyncio.TimeoutError:
            raise ConnectionError(
                f"jarvisd is not reachable at {config.control_host()}:"
                f"{config.control_port()} — is the daemon running? "
                f"(try: jarvis start / jarvis doctor)"
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
                    f"control send failed for '{method}': {exc}") from exc
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise TimeoutError(f"control call '{method}' timed out")

    # -- subscriptions ------------------------------------------------------------
    async def subscribe(self, session_id: str) -> "asyncio.Queue[dict[str, Any]]":
        """Track a session's events. Re-sends the FULL set (the daemon treats
        each session.subscribe as authoritative). Call IMMEDIATELY after
        session.create so no other chat's events can leak in."""
        q = self._queues.get(session_id)
        if q is None:
            q = asyncio.Queue()
            self._queues[session_id] = q
        self._subscribed.add(session_id)
        await self._send_subscribe()
        return q

    async def _send_subscribe(self) -> dict[str, Any]:
        return await self.call("session.subscribe",
                               {"session_ids": sorted(self._subscribed)}, timeout=20)

    async def unsubscribe(self, session_id: str) -> None:
        self._queues.pop(session_id, None)
        self._subscribed.discard(session_id)
        try:
            await self._send_subscribe()
        except Exception:
            pass


async def one_call(method: str, params: Optional[dict] = None,
                   timeout: float = 15.0) -> dict:
    """Open, call once, close — for the one-shot subcommands."""
    c = ControlClient()
    try:
        return await c.call(method, params, timeout=timeout)
    finally:
        await c.close()
