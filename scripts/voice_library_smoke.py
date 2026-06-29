#!/usr/bin/env python3
"""voice_library_smoke.py — end-to-end smoke for the named voice library.

Spins up a THROWAWAY jarvisd (isolated $HOME + alternate ports, so it never
touches the user's running daemon, config, or phone subsystem) and drives the new
Contract A voice.* methods over the control WS:

  voice.list_voices -> voice.create_clone -> voice.list_voices (sees the new voice)
  -> voice.set_default -> voice.list_voices (is_default flips) -> voice.delete_clone
  -> default repairs.

No Mistral key needed: create_clone uses clean=false (stores raw bytes, no ffmpeg),
and there is no phone.env in the temp HOME, so set_default does NOT restart any
service. Hermetic + safe to run anytime.

  env -u PYTHONPATH uv run --with websockets python scripts/voice_library_smoke.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

import websockets

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTROL_PORT = 8895
DEVICE_PORT = 8896


def find_jarvisd() -> str | None:
    for cand in (os.path.join(REPO, "build", "daemon", "jarvisd"),
                 os.path.join(REPO, "build", "jarvisd")):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def minimal_wav() -> str:
    """A tiny but valid WAV (silence) -> base64, for create_clone(clean=false)."""
    import struct
    sample_rate = 24000
    data = b"\x00\x00" * 240  # ~10ms of silence
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    hdr += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(data))
    return base64.b64encode(hdr + data).decode()


class Client:
    def __init__(self, ws):
        self.ws = ws
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}

    async def reader(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if "id" not in msg:
                continue
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def call(self, method, params=None, timeout=30.0):
        self._next_id += 1
        mid = self._next_id
        fut = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps({"v": 1, "id": mid, "method": method, "params": params or {}}))
        resp = await asyncio.wait_for(fut, timeout=timeout)
        if not resp.get("ok", False):
            err = resp.get("error", {})
            raise RuntimeError(f"{method} failed: {err.get('code')}: {err.get('message')}")
        return resp.get("result", {})


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


async def run(home: str) -> int:
    token_path = os.path.join(home, ".config", "jarvis", "control_token")
    for _ in range(100):
        if port_open(CONTROL_PORT) and os.path.exists(token_path):
            break
        time.sleep(0.1)
    else:
        fail("throwaway jarvisd did not come up")

    token = open(token_path, encoding="utf-8").read().strip()
    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    ws = await asyncio.wait_for(websockets.connect(url, max_size=None), timeout=10.0)
    client = Client(ws)
    asyncio.create_task(client.reader())

    def customs(res):
        return [v for v in res.get("voices", []) if v.get("custom")]

    # 1) fresh library (temp HOME has no clips) -> no custom voices
    res = await client.call("voice.list_voices")
    if customs(res):
        fail(f"expected no custom voices on a fresh HOME, got {customs(res)}")
    print("PASS  voice.list_voices (fresh) -> 0 custom voices")

    # 2) create a named clone from a raw wav (clean=false, no ffmpeg/key needed)
    res = await client.call("voice.create_clone", {
        "name": "Smoke Voice", "audio_b64": minimal_wav(),
        "format": "wav", "clean": False, "source": "record",
    })
    voice = res.get("voice", {})
    if voice.get("slug") != "smoke_voice" or voice.get("voice") != "clone:smoke_voice":
        fail(f"create_clone returned unexpected voice: {voice}")
    print(f"PASS  voice.create_clone -> voice={voice.get('voice')} raw={voice.get('raw')}")

    # 3) it shows up in the catalog
    res = await client.call("voice.list_voices")
    ids = [v.get("id") for v in customs(res)]
    if "clone:smoke_voice" not in ids:
        fail(f"new voice missing from list: {ids}")
    print(f"PASS  voice.list_voices -> custom voices {ids}")

    # 4) set it as default -> is_default flips, and the result echoes it
    res = await client.call("voice.set_default", {"voice": "clone:smoke_voice"})
    if res.get("default") != "clone:smoke_voice":
        fail(f"set_default did not stick: {res.get('default')}")
    res = await client.call("voice.list_voices")
    sm = next((v for v in customs(res) if v.get("id") == "clone:smoke_voice"), None)
    if not sm or not sm.get("is_default"):
        fail(f"is_default did not flip: {sm}")
    if res.get("default") != "clone:smoke_voice":
        fail(f"list default mismatch: {res.get('default')}")
    print("PASS  voice.set_default -> default is clone:smoke_voice (no phone.env => no restart)")

    # 5) preview without a Mistral key fails gracefully (no crash); tolerate either
    try:
        await client.call("voice.preview_clone", {"voice": "clone:smoke_voice", "text": "hi"})
        print("PASS  voice.preview_clone -> ok (a Mistral key is configured)")
    except RuntimeError as exc:
        if "no_voice_key" in str(exc) or "voice_tts_failed" in str(exc):
            print("PASS  voice.preview_clone -> graceful failure with no key")
        else:
            fail(f"preview failed unexpectedly: {exc}")

    # 6) delete it -> gone, default repairs to a stock voice (empty lib)
    await client.call("voice.delete_clone", {"id": "clone:smoke_voice"})
    res = await client.call("voice.list_voices")
    if customs(res):
        fail(f"voice not deleted: {customs(res)}")
    if res.get("default") != "en_paul_neutral":
        fail(f"default did not repair to stock after delete: {res.get('default')}")
    print("PASS  voice.delete_clone -> removed; default repaired to en_paul_neutral")

    await ws.close()
    print("\nALL PASS  voice_library_smoke")
    return 0


def main() -> int:
    exe = find_jarvisd()
    if not exe:
        fail("jarvisd not built (cmake --build build --target jarvisd)")
    if port_open(CONTROL_PORT):
        fail(f"port {CONTROL_PORT} already in use; refusing to collide")

    home = tempfile.mkdtemp(prefix="jarvis-voice-smoke-")
    cfgdir = os.path.join(home, ".config", "jarvis")
    os.makedirs(cfgdir, exist_ok=True)
    with open(os.path.join(cfgdir, "config.toml"), "w", encoding="utf-8") as fh:
        fh.write(f"control_port = {CONTROL_PORT}\ndevice_port = {DEVICE_PORT}\n")

    env = dict(os.environ)
    env["HOME"] = home
    env.pop("XDG_CONFIG_HOME", None)
    env.pop("XDG_DATA_HOME", None)
    proc = subprocess.Popen([exe], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, env=env)
    try:
        return asyncio.run(run(home))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        import shutil
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
