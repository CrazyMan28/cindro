"""Run JavaScript inside KWin and get the result back over DBus.

KWin scripts have no stdout/filesystem; their only output channel is
callDBus(). So this module owns a bus name (org.computeruse.KWinBridge)
exposing Result(req_id, payload), wraps caller JS so its return value is
JSON-serialized into that callback, and drives KWin's script lifecycle
(loadScript -> run -> unloadScript) — the kdotool approach.

dbus-fast is asyncio-only while MCP tools here are sync (FastMCP runs them in
worker threads), so the bus lives on a dedicated daemon thread with its own
event loop; run_js() is the thread-safe sync facade.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid

from dbus_fast import Message, MessageType
from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, method

from computer_use_mcp.session import USER_BUS

# PID-unique: several processes (the systemd service + ad-hoc scripts/tests)
# may run bridges concurrently; a shared name would route KWin's callDBus
# results to whichever process owns it and time the others out.
BUS_NAME = f"org.computeruse.KWinBridge.p{os.getpid()}"
SCRIPTS_DIR = os.path.expanduser("~/.cache/computer-use/kwin")
KWIN = "org.kde.KWin"
SCRIPTING_PATH = "/Scripting"
SCRIPTING_IFACE = "org.kde.kwin.Scripting"
SCRIPT_IFACE = "org.kde.kwin.Script"


class _ResultInterface(ServiceInterface):
    def __init__(self, bridge: "KWinBridge"):
        super().__init__(BUS_NAME)
        self._bridge = bridge

    @method()
    def Result(self, req_id: "s", payload: "s"):
        self._bridge._resolve(req_id, payload)


class KWinBridge:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._bus: MessageBus | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._ready = threading.Event()
        self._start_error: Exception | None = None

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="kwin-bridge")
        self._thread.start()
        self._ready.wait(10)

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._setup())
        except Exception as exc:
            self._start_error = exc
            self._ready.set()
            return
        self._ready.set()
        self._loop.run_forever()

    async def _setup(self) -> None:
        self._bus = await MessageBus(bus_address=USER_BUS).connect()
        self._bus.export("/", _ResultInterface(self))
        await self._bus.request_name(BUS_NAME)

    def _resolve(self, req_id: str, payload: str) -> None:
        fut = self._pending.pop(req_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    # -- DBus plumbing (runs on the bridge loop) ------------------------------

    async def _call(self, path: str, iface: str, member: str,
                    signature: str = "", body: list | None = None) -> Message:
        reply = await self._bus.call(Message(
            destination=KWIN, path=path, interface=iface,
            member=member, signature=signature, body=body or [],
        ))
        return reply

    async def _load_script(self, path: str, name: str) -> int:
        reply = await self._call(SCRIPTING_PATH, SCRIPTING_IFACE, "loadScript", "ss", [path, name])
        if reply.message_type == MessageType.ERROR:
            # Older signature without pluginName
            reply = await self._call(SCRIPTING_PATH, SCRIPTING_IFACE, "loadScript", "s", [path])
        if reply.message_type == MessageType.ERROR:
            raise RuntimeError(f"KWin loadScript failed: {reply.body}")
        return int(reply.body[0])

    async def _run_script(self, script_id: int) -> None:
        last_err = None
        for obj_path in (f"/Scripting/Script{script_id}", f"/{script_id}"):
            reply = await self._call(obj_path, SCRIPT_IFACE, "run")
            if reply.message_type != MessageType.ERROR:
                return
            last_err = reply.body
        # Last resort: start() runs every loaded-but-stopped script.
        reply = await self._call(SCRIPTING_PATH, SCRIPTING_IFACE, "start")
        if reply.message_type == MessageType.ERROR:
            raise RuntimeError(f"KWin script run failed: {last_err} / start: {reply.body}")

    async def _unload_script(self, name: str) -> None:
        try:
            await self._call(SCRIPTING_PATH, SCRIPTING_IFACE, "unloadScript", "s", [name])
        except Exception:
            pass

    async def _exec(self, req_id: str, path: str, name: str, timeout: float) -> str:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            script_id = await self._load_script(path, name)
            await self._run_script(script_id)
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(req_id, None)
            await self._unload_script(name)

    # -- public sync API -------------------------------------------------------

    def run_js(self, body: str, timeout: float = 5.0):
        """Execute `body` (a JS function body; use `return`) inside KWin and
        return its JSON-decoded result. Raises with the JS error if it threw."""
        self.start()
        if self._start_error is not None:
            raise RuntimeError(
                f"KWin bridge unavailable ({self._start_error}). Window tools fall "
                "back to sway only. Is the user session bus up?"
            )

        req_id = uuid.uuid4().hex
        wrapped = (
            "(function() {\n"
            "  var result;\n"
            f"  try {{ result = (function() {{\n{body}\n}})(); }}\n"
            "  catch (e) { result = {__kwin_error: String(e)}; }\n"
            f'  callDBus("{BUS_NAME}", "/", "{BUS_NAME}", "Result", "{req_id}",\n'
            "    JSON.stringify(result === undefined ? null : result));\n"
            "})();\n"
        )
        os.makedirs(SCRIPTS_DIR, exist_ok=True)
        script_path = os.path.join(SCRIPTS_DIR, f"{req_id}.js")
        with open(script_path, "w") as f:
            f.write(wrapped)
        name = f"computeruse-{req_id[:8]}"
        try:
            payload = asyncio.run_coroutine_threadsafe(
                self._exec(req_id, script_path, name, timeout), self._loop
            ).result(timeout + 5)
        except asyncio.TimeoutError:
            raise RuntimeError(
                "KWin script produced no result within timeout — is the KDE "
                "session running? (busctl --user introspect org.kde.KWin /Scripting)"
            )
        finally:
            try:
                os.unlink(script_path)
            except OSError:
                pass

        result = json.loads(payload) if payload else None
        if isinstance(result, dict) and "__kwin_error" in result:
            raise RuntimeError(f"KWin script error: {result['__kwin_error']}")
        return result


kwin = KWinBridge()


def cursor_pos() -> tuple[int, int]:
    """Exact cursor position from KWin (KDE session only)."""
    r = kwin.run_js("return {x: workspace.cursorPos.x, y: workspace.cursorPos.y};")
    return round(r["x"]), round(r["y"])
