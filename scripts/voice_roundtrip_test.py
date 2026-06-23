#!/usr/bin/env python3
"""Mistral Voxtral voice round-trip test through jarvisd (Contract A).

Validates BOTH daemon-proxied Mistral endpoints with NO microphone:

    voice.tts("the quick brown fox") -> {audio_b64, mime}
        -> feed that audio back into ->
    voice.stt(audio_b64) -> {text}
        -> assert text contains "quick" / "brown" / "fox".

A green run proves: (1) the daemon loaded ~/.config/jarvis/mistral_api_key,
(2) POST /v1/audio/speech (voxtral-mini-tts-latest) returned base64 audio, and
(3) POST /v1/audio/transcriptions (voxtral-mini-latest) transcribed it back —
i.e. the laptop-proxied voice path works end to end.

Run with the project-sanctioned invocation (the host PYTHONPATH breaks venvs):

    env -u PYTHONPATH uv run --with websockets python scripts/voice_roundtrip_test.py

If jarvisd is not already listening on the control port, this script will build
(if needed) and launch it itself, then tear down ONLY the process it spawned.
The control token is read from ~/.config/jarvis/control_token.
"""

import asyncio
import base64
import json
import os
import signal
import socket
import subprocess
import sys
import time

try:
    import websockets
except ImportError:  # pragma: no cover - guidance only
    print("FAIL: missing 'websockets'. Run via: env -u PYTHONPATH uv run "
          "--with websockets python scripts/voice_roundtrip_test.py",
          file=sys.stderr)
    sys.exit(2)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")
MISTRAL_KEY_PATH = os.path.expanduser("~/.config/jarvis/mistral_api_key")
PHRASE = "the quick brown fox"
EXPECT_WORDS = ("quick", "brown", "fox")


def read_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}",
              file=sys.stderr)
        sys.exit(2)


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def find_jarvisd() -> str | None:
    for cand in (os.path.join(REPO, "build", "daemon", "jarvisd"),
                 os.path.join(REPO, "build", "jarvisd")):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def maybe_launch_daemon():
    """Return a Popen if we spawned jarvisd, else None (already running)."""
    if port_open(CONTROL_PORT):
        print(f"jarvisd already listening on :{CONTROL_PORT}")
        return None

    exe = find_jarvisd()
    if not exe:
        print("jarvisd binary not found; building it…")
        subprocess.run(
            ["cmake", "--build", os.path.join(REPO, "build"),
             "--target", "jarvisd"],
            check=True)
        exe = find_jarvisd()
    if not exe:
        print("FAIL: could not locate or build jarvisd", file=sys.stderr)
        sys.exit(2)

    print(f"launching {exe}")
    proc = subprocess.Popen([exe], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    # Wait for the control port to come up.
    for _ in range(50):
        if port_open(CONTROL_PORT):
            break
        if proc.poll() is not None:
            out = proc.stdout.read() if proc.stdout else ""
            print(f"FAIL: jarvisd exited early:\n{out}", file=sys.stderr)
            sys.exit(2)
        time.sleep(0.1)
    return proc


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
            if "id" not in msg:
                continue  # unsolicited event
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def call(self, method: str, params=None, timeout=60.0):
        self._next_id += 1
        mid = self._next_id
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


async def run() -> int:
    if not os.path.exists(MISTRAL_KEY_PATH):
        print(f"FAIL: {MISTRAL_KEY_PATH} not found; the daemon needs the "
              "Mistral key to proxy voice.", file=sys.stderr)
        return 2

    token = read_token()
    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    print(f"connecting to ws://127.0.0.1:{CONTROL_PORT}/control/ws?token=***")
    try:
        ws = await asyncio.wait_for(
            websockets.connect(url, max_size=None), timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to control WS: {exc}", file=sys.stderr)
        return 1

    client = Client(ws)
    reader_task = asyncio.create_task(client.reader())
    try:
        # settings.get should report the mistral key as set (daemon bootstrap).
        settings = await client.call("settings.get")
        keys = settings.get("api_keys_set", {})
        if not keys.get("mistral"):
            print("WARN: settings.get api_keys_set.mistral is false — the "
                  "daemon may not have loaded the key file.", file=sys.stderr)
        else:
            print("PASS  settings.get api_keys_set.mistral == true")

        # --- TTS: text -> speech -------------------------------------------
        print(f"voice.tts({PHRASE!r}) …")
        tts = await client.call(
            "voice.tts", {"text": PHRASE, "format": "mp3"})
        audio_b64 = tts.get("audio_b64", "")
        mime = tts.get("mime", "")
        assert audio_b64, "voice.tts returned no audio_b64"
        raw = base64.b64decode(audio_b64)
        assert len(raw) > 256, f"voice.tts audio too small ({len(raw)} bytes)"
        print(f"PASS  voice.tts -> {len(raw)} bytes, mime={mime}")

        # --- STT: speech -> text -------------------------------------------
        print("voice.stt(<that audio>) …")
        stt = await client.call(
            "voice.stt", {"audio_b64": audio_b64, "mime": mime})
        text = (stt.get("text") or "").lower()
        print(f"PASS  voice.stt -> text={text!r}")

        missing = [w for w in EXPECT_WORDS if w not in text]
        assert not missing, (
            f"transcript {text!r} missing expected words: {missing}")
        print(f"PASS  transcript contains {EXPECT_WORDS}")

        print("\n=== VOICE ROUND-TRIP PASS ===")
        return 0
    except (AssertionError, RuntimeError, asyncio.TimeoutError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        reader_task.cancel()
        await ws.close()


def main() -> int:
    proc = maybe_launch_daemon()
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 130
    finally:
        # Tear down ONLY the jarvisd we spawned, by PID (never a broad kill).
        if proc is not None and proc.poll() is None:
            print(f"stopping the jarvisd we launched (pid {proc.pid})")
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
