"""stdio JSON-RPC 2.0 peer + entry point for cindro-acp.

ACP transport is **newline-delimited JSON-RPC 2.0 over stdio**: the editor spawns
this process and speaks one JSON object per line on stdin/stdout (diagnostics go
to stderr — stdout is the protocol channel and must carry *only* framed JSON).
Set ``JARVIS_ACP_FRAMING=content-length`` to use LSP-style ``Content-Length``
framing instead (kept behind a flag for clients that expect it).

``AcpPeer`` is a bidirectional peer: it dispatches inbound client requests /
notifications to the :class:`~acp_bridge.bridge.Bridge`, and lets the bridge send
its own requests (``session/request_permission``) and notifications
(``session/update``) back to the editor, correlating replies by id.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Any, Optional

from acp_bridge.bridge import Bridge, MethodNotFound
from acp_bridge.control import ControlClient

log = logging.getLogger("acp_bridge")


# --------------------------------------------------------------------------
# Transports
# --------------------------------------------------------------------------
class _EOF:
    pass


class StdioTransport:
    """Newline-delimited (default) or Content-Length-framed JSON over asyncio
    stream pipes wrapping stdin/stdout."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                 *, content_length: bool = False):
        self._reader = reader
        self._writer = writer
        self._cl = content_length

    async def read_message(self) -> Optional[dict[str, Any]]:
        if self._cl:
            return await self._read_content_length()
        while True:
            line = await self._reader.readline()
            if not line:
                return None  # EOF
            line = line.strip()
            if not line:
                continue  # tolerate blank lines between frames
            try:
                return json.loads(line)
            except Exception as exc:
                log.warning("dropping unparseable line: %s", exc)
                continue

    async def _read_content_length(self) -> Optional[dict[str, Any]]:
        length = 0
        while True:
            header = await self._reader.readline()
            if not header:
                return None
            header = header.strip()
            if not header:
                break  # end of headers
            if b":" in header:
                k, _, v = header.partition(b":")
                if k.strip().lower() == b"content-length":
                    try:
                        length = int(v.strip())
                    except ValueError:
                        length = 0
        if length <= 0:
            return await self._read_content_length()
        body = await self._reader.readexactly(length)
        try:
            return json.loads(body)
        except Exception as exc:
            log.warning("dropping unparseable body: %s", exc)
            return await self._read_content_length()

    async def write_message(self, obj: dict[str, Any]) -> None:
        data = json.dumps(obj).encode("utf-8")
        if self._cl:
            self._writer.write(
                f"Content-Length: {len(data)}\r\n\r\n".encode("ascii") + data
            )
        else:
            self._writer.write(data + b"\n")
        await self._writer.drain()


# --------------------------------------------------------------------------
# JSON-RPC peer
# --------------------------------------------------------------------------
class RpcError(Exception):
    def __init__(self, err: dict[str, Any]):
        self.code = err.get("code", -32603)
        self.message = err.get("message", "error")
        self.data = err.get("data")
        super().__init__(f"{self.code}: {self.message}")


class AcpPeer:
    """A JSON-RPC 2.0 peer over a message transport. Inbound requests /
    notifications go to ``handler.handle(method, params, self)``; outbound
    ``request()`` / ``notify()`` talk back to the other side."""

    def __init__(self, transport: Any, handler: Any):
        self.transport = transport
        self.handler = handler
        self._pending: dict[str, "asyncio.Future[Any]"] = {}
        self._next_id = 0
        self._write_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()

    async def run(self) -> None:
        while True:
            msg = await self.transport.read_message()
            if msg is None:
                break  # stdin closed -> editor is done with us
            if not isinstance(msg, dict):
                continue
            self._dispatch(msg)
        # Drain in-flight handler tasks on shutdown.
        for t in list(self._tasks):
            t.cancel()

    def _dispatch(self, msg: dict[str, Any]) -> None:
        if "method" in msg:
            if msg.get("id") is not None:
                self._spawn(self._handle_request(msg))
            else:
                self._spawn(self._handle_notification(msg))
            return
        # A response to one of OUR outgoing requests.
        fut = self._pending.pop(_key(msg.get("id")), None)
        if fut is None or fut.done():
            return
        if "error" in msg and msg["error"] is not None:
            fut.set_exception(RpcError(msg["error"]))
        else:
            fut.set_result(msg.get("result"))

    def _spawn(self, coro: Any) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def _handle_request(self, msg: dict[str, Any]) -> None:
        mid = msg["id"]
        method = msg.get("method", "")
        params = msg.get("params") or {}
        try:
            result = await self.handler.handle(method, params, self)
            await self._send({"jsonrpc": "2.0", "id": mid,
                              "result": {} if result is None else result})
        except MethodNotFound:
            await self._send({"jsonrpc": "2.0", "id": mid,
                              "error": {"code": -32601,
                                        "message": f"method not found: {method}"}})
        except Exception as exc:  # noqa: BLE001 — surface as a JSON-RPC error
            log.exception("handler for %s failed", method)
            await self._send({"jsonrpc": "2.0", "id": mid,
                              "error": {"code": -32603, "message": str(exc)}})

    async def _handle_notification(self, msg: dict[str, Any]) -> None:
        method = msg.get("method", "")
        params = msg.get("params") or {}
        try:
            await self.handler.handle(method, params, self)
        except MethodNotFound:
            pass  # notifications get no response, even for unknown methods
        except Exception:
            log.exception("notification handler for %s failed", method)

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        self._next_id += 1
        # String-prefixed ids so ours never collide with the client's integer ids.
        mid = f"acp-{self._next_id}"
        loop = asyncio.get_event_loop()
        fut: "asyncio.Future[Any]" = loop.create_future()
        self._pending[mid] = fut
        await self._send({"jsonrpc": "2.0", "id": mid,
                          "method": method, "params": params})
        return await fut

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _send(self, obj: dict[str, Any]) -> None:
        async with self._write_lock:
            await self.transport.write_message(obj)


def _key(mid: Any) -> str:
    return f"acp-{mid}" if isinstance(mid, int) else str(mid)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
async def _stdio_streams() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
    )
    w_transport, w_protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout
    )
    writer = asyncio.StreamWriter(w_transport, w_protocol, reader, loop)
    return reader, writer


async def _amain() -> None:
    logging.basicConfig(
        level=os.environ.get("JARVIS_ACP_LOG", "INFO").upper(),
        stream=sys.stderr,
        format="%(asctime)s cindro-acp %(levelname)s %(name)s: %(message)s",
    )
    content_length = os.environ.get("JARVIS_ACP_FRAMING", "ndjson").lower() in (
        "content-length", "content_length", "lsp",
    )

    reader, writer = await _stdio_streams()
    transport = StdioTransport(reader, writer, content_length=content_length)

    control = ControlClient()
    await control.start()
    bridge = Bridge(control)
    peer = AcpPeer(transport, bridge)
    try:
        await peer.run()
    finally:
        await control.close()


def main() -> None:
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
