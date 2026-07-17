#!/usr/bin/env python3
"""Control-WS proof for Plan Mode's daemon-side plan.enter/plan.exit/plan.status.

Exercises the new Contract A methods live against a running jarvisd:
  1. Settings-driven path: settings.set(agent_mode=plan) -> plan.status reports
     restricted:true, source:"settings" for ANY session id (global).
  2. Self-initiated path: plan.enter(session A) -> plan.status(A) restricted,
     source:"self"; plan.status(B, a DIFFERENT session id) stays unrestricted
     (the self flag is per-session, not global).
  3. plan.exit(A) -> plan.status(A) unrestricted again.
  4. Restores agent_mode to whatever it was before the run.

Run with the project-sanctioned invocation (the host PYTHONPATH breaks venvs):

    env -u PYTHONPATH uv run --with websockets python scripts/plan_mode_ws_check.py

The control token is read from $JARVIS_CONFIG_DIR/control_token (or
~/.config/jarvis/control_token if unset). Prereq: jarvisd must already be
running. Point JARVIS_CONTROL_PORT at an isolated test instance if you don't
want to touch a real running daemon's global agent_mode setting.
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
          "scripts/plan_mode_ws_check.py", file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
CONFIG_DIR = os.environ.get("JARVIS_CONFIG_DIR") or os.path.expanduser("~/.config/jarvis")
TOKEN_PATH = os.path.join(CONFIG_DIR, "control_token")


def read_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}", file=sys.stderr)
        sys.exit(2)


class Client:
    def __init__(self, ws):
        self.ws = ws
        self._next_id = 0
        self._pending = {}

    def _alloc_id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("event") is not None:
                continue
            mid = msg.get("id")
            fut = self._pending.pop(mid, None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def call(self, method: str, params=None, timeout=15.0):
        mid = self._alloc_id()
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        frame = {"v": 1, "id": mid, "method": method, "params": params or {}}
        await self.ws.send(json.dumps(frame))
        resp = await asyncio.wait_for(fut, timeout=timeout)
        if not resp.get("ok", False):
            err = resp.get("error", {})
            raise RuntimeError(f"{method} failed: {err.get('code')}: {err.get('message')}")
        return resp.get("result", {})


def check(cond, msg):
    status = "PASS" if cond else "FAIL"
    print(f"{status}  {msg}")
    return cond


async def run() -> int:
    token = read_token()
    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    print(f"connecting to {url.split('token=')[0]}token=***")

    try:
        ws = await asyncio.wait_for(websockets.connect(url, max_size=None), timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to control WS: {exc}", file=sys.stderr)
        print("      is jarvisd running?", file=sys.stderr)
        return 1

    client = Client(ws)
    reader_task = asyncio.create_task(client.reader())
    ok = True
    original_mode = None

    try:
        settings = await client.call("settings.get")
        original_mode = settings.get("agent_mode", "coworker")
        print(f"(original agent_mode: {original_mode!r} — will restore at the end)")

        # --- 1. Settings-driven (global) path ---
        await client.call("settings.set", {"patch": {"agent_mode": "plan"}})
        status = await client.call("plan.status", {"session_id": "any-session-x"})
        ok &= check(status.get("restricted") is True and status.get("source") == "settings",
                    f"settings agent_mode=plan -> plan.status restricted (got {status})")

        status_other = await client.call("plan.status", {"session_id": "any-session-y"})
        ok &= check(status_other.get("restricted") is True and status_other.get("source") == "settings",
                    f"global setting restricts EVERY session id, not just one (got {status_other})")

        await client.call("settings.set", {"patch": {"agent_mode": "coworker"}})
        status = await client.call("plan.status", {"session_id": "any-session-x"})
        ok &= check(status.get("restricted") is False,
                    f"agent_mode=coworker -> plan.status unrestricted (got {status})")

        # --- 2. Self-initiated (ephemeral, per-session) path ---
        SID_A, SID_B = "test-sess-A", "test-sess-B"
        await client.call("plan.enter", {"session_id": SID_A})
        status_a = await client.call("plan.status", {"session_id": SID_A})
        ok &= check(status_a.get("restricted") is True and status_a.get("source") == "self",
                    f"plan.enter(A) -> plan.status(A) restricted, source=self (got {status_a})")

        status_b = await client.call("plan.status", {"session_id": SID_B})
        ok &= check(status_b.get("restricted") is False,
                    f"plan.enter(A) must NOT restrict a DIFFERENT session B (got {status_b})")

        # --- 3. Exit clears only the self-initiated flag ---
        await client.call("plan.exit", {"session_id": SID_A})
        status_a2 = await client.call("plan.status", {"session_id": SID_A})
        ok &= check(status_a2.get("restricted") is False,
                    f"plan.exit(A) -> plan.status(A) unrestricted again (got {status_a2})")

        # plan.exit on a session that was never in self-plan-mode is a harmless no-op.
        await client.call("plan.exit", {"session_id": "never-entered"})
        print("PASS  plan.exit on a session never in self-plan-mode does not raise")

        # --- 4. Session-scoped approval (Codex review, PR #132): approving one
        # session's plan must NOT flip the global setting and silently unblock a
        # DIFFERENT, concurrently-running plan-restricted session. present_plan's
        # "Approve & Build" calls plan.exit (clears any self-initiated flag) AND
        # plan.approve (grants the session-scoped override) -- plan.exit alone no
        # longer takes an `approved` param; that was the pre-reconciliation shape.
        await client.call("settings.set", {"patch": {"agent_mode": "plan"}})
        SID_C, SID_D = "test-sess-C", "test-sess-D"
        await client.call("plan.exit", {"session_id": SID_C})
        await client.call("plan.approve", {"session_id": SID_C})
        status_c = await client.call("plan.status", {"session_id": SID_C})
        ok &= check(status_c.get("restricted") is False,
                    f"plan.exit+plan.approve(C) -> C unblocked (got {status_c})")

        status_d = await client.call("plan.status", {"session_id": SID_D})
        ok &= check(status_d.get("restricted") is True and status_d.get("source") == "settings",
                    f"approving C must NOT unblock a different session D "
                    f"still under the global setting (got {status_d})")

        settings_after = await client.call("settings.get")
        ok &= check(settings_after.get("agent_mode") == "plan",
                    "approving a session must NOT flip the global agent_mode setting "
                    f"(got {settings_after.get('agent_mode')!r})")
        await client.call("settings.set", {"patch": {"agent_mode": "coworker"}})

        print("\n=== plan mode WS check: ALL PASS ===" if ok else
              "\n=== plan mode WS check: SOME CHECKS FAILED ===")
        return 0 if ok else 1

    except (AssertionError, RuntimeError, asyncio.TimeoutError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        if original_mode is not None:
            try:
                await client.call("settings.set", {"patch": {"agent_mode": original_mode}})
                print(f"(restored agent_mode to {original_mode!r})")
            except Exception as exc:  # noqa: BLE001
                print(f"WARN: failed to restore agent_mode: {exc}", file=sys.stderr)
        reader_task.cancel()
        await ws.close()


def main() -> int:
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
