#!/usr/bin/env python3
"""Control-WS proof for the live-widget viewer-lease flow (battery gating).

Connects to the control WebSocket and exercises the new `widget.viewing` method:
  1. widget.viewing {scope:"all", kind:"canvas", active:true}  -> a lease file
     appears under ~/.local/share/jarvis/widget_viewers/ with scope "all".
  2. widget.viewing {scope:"all", active:false}                -> the lease is gone.
This proves the daemon records/clears the leases the engine's live-widget
supervisor reads to decide whether a live widget should run.

Run with the project-sanctioned invocation (the host PYTHONPATH breaks venvs):

    env -u PYTHONPATH uv run --with websockets python scripts/widget_lease_ws.py

The control token is read from ~/.config/jarvis/control_token. Prereq: a jarvisd
with the widget.viewing handler must already be running.
"""

import asyncio
import glob
import json
import os
import sys

try:
    import websockets
except ImportError:  # pragma: no cover - guidance only
    print("FAIL: missing 'websockets'. Run via: env -u PYTHONPATH uv run "
          "--with websockets python scripts/widget_lease_ws.py", file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")
VIEWERS_DIR = os.path.expanduser(
    os.environ.get("JARVIS_WIDGET_VIEWERS",
                   "~/.local/share/jarvis/widget_viewers"))


def read_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}", file=sys.stderr)
        sys.exit(2)


def lease_scopes() -> set:
    scopes = set()
    for p in glob.glob(os.path.join(VIEWERS_DIR, "*.json")):
        try:
            with open(p, "r", encoding="utf-8") as fh:
                scopes.add(json.load(fh).get("scope"))
        except (OSError, ValueError):
            pass
    return scopes


class Client:
    def __init__(self, ws):
        self.ws = ws
        self._next_id = 0
        self._pending = {}

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("event") is not None:
                continue
            fut = self._pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def call(self, method, params=None, timeout=15.0):
        self._next_id += 1
        mid = self._next_id
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps({"v": 1, "id": mid, "method": method,
                                       "params": params or {}}))
        resp = await asyncio.wait_for(fut, timeout=timeout)
        if not resp.get("ok", False):
            err = resp.get("error", {})
            raise RuntimeError(f"{method} failed: {err.get('code')}: {err.get('message')}")
        return resp.get("result", {})


async def run() -> int:
    token = read_token()
    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    print(f"connecting to ws://127.0.0.1:{CONTROL_PORT}/control/ws?token=***")
    try:
        ws = await asyncio.wait_for(websockets.connect(url, max_size=None), timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to control WS: {exc}\n      is jarvisd running?",
              file=sys.stderr)
        return 1

    client = Client(ws)
    reader_task = asyncio.create_task(client.reader())
    try:
        await client.call("widget.viewing", {"scope": "all", "kind": "canvas", "active": True})
        await asyncio.sleep(0.2)
        if "all" not in lease_scopes():
            print("FAIL: no 'all' lease after widget.viewing active=true", file=sys.stderr)
            return 1
        print("ok: widget.viewing active=true -> 'all' lease present")

        await client.call("widget.viewing", {"scope": "all", "active": False})
        await asyncio.sleep(0.2)
        if "all" in lease_scopes():
            print("FAIL: 'all' lease still present after active=false", file=sys.stderr)
            return 1
        print("ok: widget.viewing active=false -> 'all' lease cleared")

        print("PASS: widget viewer-lease flow works end-to-end")
        return 0
    finally:
        reader_task.cancel()
        await ws.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
