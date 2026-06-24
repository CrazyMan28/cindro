#!/usr/bin/env python3
"""Control-WS proof for the session.opened fan-out.

Connects to the control WebSocket, calls session.create, and asserts that an
UNSOLICITED {"event":"session.opened","data":{session_id,title}} frame arrives
on the SAME socket whose data.session_id equals the session_id the create call
returned. This is the spec's required "session.create now also yields a
session.opened event on a subscribed socket" proof — it mirrors the existing
auth.event / file.offer fan-out pattern.

Run with the project-sanctioned invocation (the host PYTHONPATH breaks venvs):

    env -u PYTHONPATH uv run --with websockets python scripts/session_opened_ws.py

The control token is read from ~/.config/jarvis/control_token. Prereq: jarvisd
must already be running (it auto-creates the token on first start).
"""

import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:  # pragma: no cover - guidance only
    print("FAIL: missing 'websockets'. Run via: "
          "env -u PYTHONPATH uv run --with websockets python "
          "scripts/session_opened_ws.py", file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")
# A plain chat (codex brain) is enough to prove the broadcast; the session need
# not produce any turn. Override the brain if the local login differs.
SESSION_BRAIN = os.environ.get("JARVIS_SESSION_BRAIN", "codex")
SESSION_PROFILE = os.environ.get("JARVIS_SESSION_PROFILE", "coder")
DEADLINE_S = 30.0


def read_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}",
              file=sys.stderr)
        sys.exit(2)


class Client:
    """Minimal control-WS client that also captures session.opened frames."""

    def __init__(self, ws):
        self.ws = ws
        self._next_id = 0
        self._pending = {}        # id -> asyncio.Future
        self.opened = []          # collected session.opened data dicts

    def _alloc_id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # The unsolicited fan-out we are proving.
            if msg.get("event") == "session.opened":
                self.opened.append(msg.get("data", {}))
                continue
            # Ignore other unsolicited events (session.event, auth.event, ...).
            if msg.get("event") is not None:
                continue
            mid = msg.get("id")
            fut = self._pending.pop(mid, None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def call(self, method: str, params=None, timeout=30.0):
        mid = self._alloc_id()
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        frame = {"v": 1, "id": mid, "method": method, "params": params or {}}
        await self.ws.send(json.dumps(frame))
        resp = await asyncio.wait_for(fut, timeout=timeout)
        if not resp.get("ok", False):
            err = resp.get("error", {})
            raise RuntimeError(
                f"{method} failed: {err.get('code')}: {err.get('message')}")
        return resp.get("result", {})

    async def wait_for_opened(self, session_id: str, timeout=DEADLINE_S):
        """Wait until a session.opened frame for `session_id` is captured."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            for data in self.opened:
                if data.get("session_id") == session_id:
                    return data
            await asyncio.sleep(0.05)
        return None


async def run() -> int:
    token = read_token()
    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    print(f"connecting to {url.split('token=')[0]}token=***")

    try:
        ws = await asyncio.wait_for(websockets.connect(url, max_size=None),
                                    timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to control WS: {exc}", file=sys.stderr)
        print("      is jarvisd running?", file=sys.stderr)
        return 1

    client = Client(ws)
    reader_task = asyncio.create_task(client.reader())

    try:
        # Subscribe-by-reading: the control WS pushes session.opened to every
        # connected client, so just being connected is enough.
        created = await client.call(
            "session.create",
            {"profile": SESSION_PROFILE, "brain": SESSION_BRAIN})
        session_id = created.get("session_id")
        assert session_id, "session.create returned no session_id"
        print(f"PASS  session.create (session_id={session_id})")

        data = await client.wait_for_opened(session_id)
        if data is None:
            print(f"\nFAIL: no session.opened frame for {session_id} within "
                  f"{DEADLINE_S:.0f}s", file=sys.stderr)
            print(f"      captured frames: {client.opened}", file=sys.stderr)
            return 1

        print("received session.opened frame:")
        print("  " + json.dumps({"event": "session.opened", "data": data},
                                 ensure_ascii=False))
        assert data.get("session_id") == session_id, \
            (f"session.opened session_id mismatch: "
             f"{data.get('session_id')!r} != {session_id!r}")
        # title is carried through (defaults to "Untitled session").
        assert "title" in data, "session.opened frame missing data.title"

        print("\n=== session.opened PASS ===")
        return 0

    except (AssertionError, RuntimeError, asyncio.TimeoutError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        reader_task.cancel()
        await ws.close()


def main() -> int:
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
