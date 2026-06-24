#!/usr/bin/env python3
"""Live control-WS verification of the roadmap features against a running jarvisd.

Exercises, on one authenticated control socket:
  1. settings.get      -> stt_provider/tts_provider + stt_providers/tts_providers lists
  2. voice.list_voices -> voices[] + provider lists (STT/TTS pluggable providers)
  3. settings.set      -> flip stt_provider to whisper, read back, restore voxtral
  4. connectors.list   -> Google connectors framework reachable (list shape)
  5. auth.status       -> cross-device auth gate machinery responds
  6. session.create    -> unsolicited session.opened frame for that id, then delete

Run:  env -u PYTHONPATH uv run --with websockets python scripts/roadmap_live_verify.py
"""

import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:
    print("FAIL: need websockets; run via "
          "env -u PYTHONPATH uv run --with websockets python "
          "scripts/roadmap_live_verify.py", file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")

fails = 0


def check(cond, msg):
    global fails
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}", file=sys.stderr)
        fails += 1


class Client:
    def __init__(self, ws):
        self.ws = ws
        self._id = 0
        self._pending = {}
        self.opened = []

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("event") == "session.opened":
                self.opened.append(msg.get("data", {}))
                continue
            if msg.get("event") is not None:
                continue
            fut = self._pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def call(self, method, params=None, timeout=30.0):
        self._id += 1
        mid = self._id
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps(
            {"v": 1, "id": mid, "method": method, "params": params or {}}))
        resp = await asyncio.wait_for(fut, timeout=timeout)
        if not resp.get("ok", False):
            err = resp.get("error", {})
            raise RuntimeError(f"{method}: {err.get('code')}: {err.get('message')}")
        return resp.get("result", {})

    async def wait_opened(self, sid, timeout=20.0):
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            for d in self.opened:
                if d.get("session_id") == sid:
                    return d
            await asyncio.sleep(0.05)
        return None


def ids(arr):
    return [o.get("id") for o in arr if isinstance(o, dict)]


async def run():
    token = open(TOKEN_PATH).read().strip()
    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    ws = await asyncio.wait_for(websockets.connect(url, max_size=None), timeout=10.0)
    c = Client(ws)
    rt = asyncio.create_task(c.reader())
    try:
        print("[1] settings.get — voice provider settings + enumerations")
        s = await c.call("settings.get")
        check(s.get("stt_provider") in ("voxtral", "whisper"),
              f"stt_provider present ({s.get('stt_provider')})")
        check(s.get("tts_provider") in ("voxtral", "piper"),
              f"tts_provider present ({s.get('tts_provider')})")
        stt_ids = ids(s.get("stt_providers", []))
        tts_ids = ids(s.get("tts_providers", []))
        check("voxtral" in stt_ids and "whisper" in stt_ids,
              f"stt_providers lists voxtral+whisper ({stt_ids})")
        check("voxtral" in tts_ids and "piper" in tts_ids,
              f"tts_providers lists voxtral+piper ({tts_ids})")

        print("[2] voice.list_voices — voices + provider lists")
        v = await c.call("voice.list_voices")
        voices = v.get("voices", [])
        check(len(voices) >= 1, f"voices[] non-empty ({len(voices)} voices)")
        check("stt_providers" in v and "tts_providers" in v,
              "list_voices carries stt_providers/tts_providers")

        print("[3] settings.set — flip stt_provider to whisper, read back, restore")
        await c.call("settings.set", {"patch": {"stt_provider": "whisper"}})
        s2 = await c.call("settings.get")
        check(s2.get("stt_provider") == "whisper", "stt_provider flipped to whisper")
        await c.call("settings.set", {"patch": {"stt_provider": "voxtral"}})
        s3 = await c.call("settings.get")
        check(s3.get("stt_provider") == "voxtral", "stt_provider restored to voxtral")

        print("[4] connectors.list — Google connectors framework reachable")
        try:
            conn = await c.call("connectors.list")
            items = conn.get("connectors", conn.get("items", conn))
            check(isinstance(items, (list, dict)),
                  f"connectors.list returns a list/obj ({type(items).__name__})")
        except RuntimeError as e:
            check(False, f"connectors.list errored: {e}")

        print("[5] auth.status — cross-device auth gate machinery")
        try:
            a = await c.call("auth.status")
            check(isinstance(a, dict), f"auth.status returns object ({list(a.keys())})")
        except RuntimeError as e:
            check(False, f"auth.status errored: {e}")

        print("[6] session.create -> session.opened fan-out -> delete")
        created = await c.call("session.create",
                               {"profile": "coder", "brain": "codex"})
        sid = created.get("session_id")
        check(bool(sid), f"session.create returned id ({sid})")
        if sid:
            data = await c.wait_opened(sid)
            check(data is not None and data.get("session_id") == sid,
                  "session.opened frame arrived for that id")
            try:
                await c.call("session.delete", {"session_id": sid})
                print(f"  (cleaned up test session {sid})")
            except RuntimeError as e:
                print(f"  (note: could not delete test session: {e})")
    finally:
        rt.cancel()
        await ws.close()


def main():
    try:
        asyncio.run(run())
    except Exception as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1
    if fails:
        print(f"\n=== {fails} CHECK(S) FAILED ===", file=sys.stderr)
        return 1
    print("\n=== ALL LIVE CHECKS PASS ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
