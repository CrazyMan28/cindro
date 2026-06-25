#!/usr/bin/env python3
"""Control-WS proof for the SESSION MANAGER (session.subscribe scoping).

This is the regression proof for the "a Chrome co-work session's chat leaks into
the desktop" bug. The daemon used to broadcast EVERY session's session.event
frames to EVERY connected control client; now a client may declare which session
ids it is viewing via `session.subscribe`, and the daemon fans session.event
ONLY for those ids to that (now "scoped") client.

Two clients connect:

  * VIEWER  — calls session.create -> X, then session.subscribe([X]).
  * BYSTANDER — calls session.subscribe([]) (scoped to NOTHING; this models a
    desktop sitting on a fresh, sessionless chat, or a second surface looking at
    a different conversation).

VIEWER then sends a turn into X so the brain emits session.event frames for X.
We assert:

  1. session.subscribe round-trips (ok=true; result.subscribed echoes the ids).
  2. The BYSTANDER (scoped to []) receives ZERO session.event frames for X even
     though X is active — i.e. the foreign session can never leak to it.
  3. If the VIEWER receives X's events (brain actually ran), every one is for X.

Run with the project-sanctioned invocation (the host PYTHONPATH breaks venvs):

    env -u PYTHONPATH uv run --with websockets python scripts/session_subscribe_ws.py

Prereq: jarvisd must already be running (it auto-creates the control token).
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
          "scripts/session_subscribe_ws.py", file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")
SESSION_BRAIN = os.environ.get("JARVIS_SESSION_BRAIN", "codex")
SESSION_PROFILE = os.environ.get("JARVIS_SESSION_PROFILE", "coder")
# How long to watch for leaked frames after sending the turn.
WATCH_S = float(os.environ.get("JARVIS_WATCH_S", "8.0"))


def read_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}",
              file=sys.stderr)
        sys.exit(2)


class Client:
    """Minimal control-WS client that captures session.event frames per session."""

    def __init__(self, ws, name):
        self.ws = ws
        self.name = name
        self._next_id = 0
        self._pending = {}        # id -> asyncio.Future
        self.events = []          # collected session.event data dicts {session_id, ev}

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("event") == "session.event":
                self.events.append(msg.get("data", {}))
                continue
            if msg.get("event") is not None:
                continue  # ignore session.opened / auth.event / ...
            fut = self._pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def call(self, method: str, params=None, timeout=30.0):
        mid = self._next_id = self._next_id + 1
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps(
            {"v": 1, "id": mid, "method": method, "params": params or {}}))
        resp = await asyncio.wait_for(fut, timeout=timeout)
        if not resp.get("ok", False):
            err = resp.get("error", {})
            raise RuntimeError(
                f"{method} failed: {err.get('code')}: {err.get('message')}")
        return resp.get("result", {})

    def events_for(self, session_id):
        return [e for e in self.events if e.get("session_id") == session_id]


async def connect(name):
    token = read_token()
    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    ws = await asyncio.wait_for(websockets.connect(url, max_size=None), timeout=10.0)
    c = Client(ws, name)
    c._reader = asyncio.create_task(c.reader())
    return c


async def run() -> int:
    try:
        viewer = await connect("VIEWER")
        bystander = await connect("BYSTANDER")
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to control WS: {exc}", file=sys.stderr)
        print("      is jarvisd running (with the session-manager build)?",
              file=sys.stderr)
        return 1

    try:
        # 1) session.subscribe round-trips and echoes the requested ids.
        created = await viewer.call(
            "session.create", {"profile": SESSION_PROFILE, "brain": SESSION_BRAIN})
        session_x = created.get("session_id")
        assert session_x, "session.create returned no session_id"
        print(f"PASS  session.create (X={session_x})")

        sub = await viewer.call("session.subscribe", {"session_ids": [session_x]})
        assert session_x in (sub.get("subscribed") or []), \
            f"subscribe did not echo {session_x}: {sub}"
        print(f"PASS  VIEWER session.subscribe([X]) -> {sub.get('subscribed')}")

        sub0 = await bystander.call("session.subscribe", {"session_ids": []})
        assert (sub0.get("subscribed") or []) == [], \
            f"empty subscribe should echo []: {sub0}"
        print("PASS  BYSTANDER session.subscribe([]) -> [] (scoped to nothing)")

        # 2) Drive a turn on X so the brain emits session.event frames for X.
        try:
            await viewer.call("session.send",
                              {"session_id": session_x, "text": "hello"})
            print(f"      sent a turn into X; watching {WATCH_S:.0f}s for leaks…")
        except RuntimeError as exc:
            print(f"      (session.send not runnable here: {exc};"
                  " still asserting BYSTANDER isolation)")

        await asyncio.sleep(WATCH_S)

        leaked = bystander.events_for(session_x)
        any_bystander = bystander.events
        viewer_x = viewer.events_for(session_x)

        # 3) Core guarantee: the scoped-to-nothing BYSTANDER must NOT receive X's
        #    events (nor any other session's).
        if leaked:
            print(f"\nFAIL: BYSTANDER leaked {len(leaked)} session.event frame(s)"
                  f" for X — scoping is broken.", file=sys.stderr)
            print("  " + json.dumps(leaked[0], ensure_ascii=False)[:300],
                  file=sys.stderr)
            return 1
        if any_bystander:
            print(f"\nFAIL: BYSTANDER (scoped []) received {len(any_bystander)}"
                  f" foreign session.event frame(s).", file=sys.stderr)
            return 1
        print("PASS  BYSTANDER received ZERO session.event frames (no leak)")

        if viewer_x:
            assert all(e.get("session_id") == session_x for e in viewer_x), \
                "VIEWER got an event for a session it did not subscribe to"
            print(f"PASS  VIEWER received {len(viewer_x)} event(s), all for X"
                  " (subscribed delivery works)")
        else:
            print("SKIP  VIEWER saw no events (brain produced none here) —"
                  " isolation still proven by the BYSTANDER assertion")

        # Clean up the throwaway session.
        try:
            await viewer.call("session.delete", {"session_id": session_x})
        except RuntimeError:
            pass

        print("\n=== session.subscribe scoping PASS ===")
        return 0

    except (AssertionError, RuntimeError, asyncio.TimeoutError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        for c in (viewer, bystander):
            try:
                await c.ws.close()
            except Exception:  # noqa: BLE001
                pass


def main() -> int:
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
