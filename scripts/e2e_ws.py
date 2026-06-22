#!/usr/bin/env python3
"""End-to-end Contract A v2 smoke test for jarvisd.

Connects to the control WebSocket, creates a codex coder session, sends a
one-shot prompt, and asserts at least one NormalizedBrainEvent of kind
'message' (or 'final') arrives within the time budget. Also exercises the
Contract A v2 read methods (settings.get, mcp.list, plugins.catalog,
session.list) so a regression in any of them shows up here.

Run with the project-sanctioned invocation (the host PYTHONPATH breaks venvs):

    env -u PYTHONPATH uv run --with websockets python scripts/e2e_ws.py

The control token is read from ~/.config/jarvis/control_token. Prereq:
jarvisd must already be running (it auto-creates the token on first start).
codex is spawned by the daemon with stdin </dev/null per spikes/RESULTS.md.
"""

import asyncio
import json
import os
import sys
import time

try:
    import websockets
except ImportError:  # pragma: no cover - guidance only
    print("FAIL: missing 'websockets'. Run via: "
          "env -u PYTHONPATH uv run --with websockets python scripts/e2e_ws.py",
          file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")
DEADLINE_S = 120.0
# Model for the codex session. gpt-5-codex is the contract example, but some
# auth tiers (e.g. a ChatGPT-account codex) reject it with a 400; override with
# JARVIS_E2E_MODEL=gpt-5.5 to drive a model the local codex login supports.
SESSION_MODEL = os.environ.get("JARVIS_E2E_MODEL", "gpt-5-codex")


def read_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}",
              file=sys.stderr)
        sys.exit(2)


class Client:
    """Minimal Contract A v1/v2 JSON-RPC-ish client over the control WS."""

    def __init__(self, ws):
        self.ws = ws
        self._next_id = 0
        self._pending = {}        # id -> asyncio.Future
        self.events = []          # collected session.event frames

    def _alloc_id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("event") == "session.event":
                self.events.append(msg.get("data", {}))
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


def kinds_seen(events) -> list:
    out = []
    for ev in events:
        inner = ev.get("ev", {})
        k = inner.get("kind")
        if k:
            out.append(k)
    return out


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
        # --- ping ----------------------------------------------------------
        pong = await client.call("ping")
        assert pong.get("pong") is True, "ping did not pong"
        print("PASS  ping")

        # --- Contract A v2 read methods (must not error) -------------------
        settings = await client.call("settings.get")
        assert "brains" in settings and "models_by_brain" in settings, \
            "settings.get missing v2 fields"
        assert "api_keys_set" in settings, "settings.get missing api_keys_set"
        # Booleans only — never raw secret values.
        for k, v in settings["api_keys_set"].items():
            assert isinstance(v, bool), f"api_keys_set[{k}] is not a bool"
        print(f"PASS  settings.get (brains={settings['brains']})")

        mcp = await client.call("mcp.list")
        ids = [s.get("id") for s in mcp.get("servers", [])]
        assert "computer-use" in ids, "mcp.list missing built-in computer-use"
        print(f"PASS  mcp.list (servers={ids})")

        plugins = await client.call("plugins.catalog")
        pids = [p.get("id") for p in plugins.get("plugins", [])]
        assert len(pids) >= 1, "plugins.catalog is empty (no seeded manifests)"
        print(f"PASS  plugins.catalog (plugins={pids})")

        await client.call("session.list")
        print("PASS  session.list")

        # --- create + send + collect events --------------------------------
        created = await client.call(
            "session.create",
            {"profile": "coder", "brain": "codex", "model": SESSION_MODEL})
        session_id = created.get("session_id")
        assert session_id, "session.create returned no session_id"
        print(f"PASS  session.create (session_id={session_id})")

        await client.call(
            "session.send",
            {"session_id": session_id,
             "text": "Reply with exactly the word PONG and stop."})
        print("PASS  session.send (accepted) — waiting for brain events…")

        start = time.monotonic()
        got_terminal = False
        while time.monotonic() - start < DEADLINE_S:
            await asyncio.sleep(0.5)
            ks = kinds_seen(client.events)
            if "message" in ks or "final" in ks or "error" in ks:
                got_terminal = True
                break

        ks = kinds_seen(client.events)
        print(f"\ncollected {len(client.events)} session.event frames; "
              f"kinds={ks}")
        for ev in client.events:
            print("  event:", json.dumps(ev, ensure_ascii=False))

        if not got_terminal:
            print("\nFAIL: no message/final/error event within "
                  f"{DEADLINE_S:.0f}s", file=sys.stderr)
            return 1

        # Acceptance (per BUILD_SPEC role): at least one NormalizedBrainEvent of
        # kind 'message' OR 'final' arrives.
        assert "message" in ks or "final" in ks, \
            "no NormalizedBrainEvent of kind message/final arrived"

        if "message" in ks:
            print("\nPASS  received NormalizedBrainEvent kind message")
        else:
            # final-only (e.g. the chosen model was rejected by codex auth). The
            # contract pipeline is proven; warn so the model issue is visible.
            print("\nPASS  received NormalizedBrainEvent kind final "
                  f"(no assistant message — model '{SESSION_MODEL}' may be "
                  "unsupported by this codex login; set JARVIS_E2E_MODEL).")
        print("\n=== E2E PASS ===")
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
