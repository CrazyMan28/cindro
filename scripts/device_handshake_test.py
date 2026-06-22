#!/usr/bin/env python3
"""Contract C device-channel end-to-end test for jarvisd.

Exercises the full phone pairing + authed-session flow:

  1. Generate an ed25519 device keypair (pynacl).
  2. Call the control WS (Contract A) devices.pair_start -> get a 6-digit code.
  3. Connect to the device WS (:8796 /device/ws), send `hello` WITH the pair
     code + device pubkey -> assert the daemon acks {paired:true, device_id}.
  4. Reconnect (no code), send `hello` -> receive {challenge}; sign it and send
     {sig} -> assert {authed:true}.
  5. session.create + session.send("…PONG…") and assert a streamed
     session.event of kind message OR final arrives.
  6. devices.list (control WS) shows the paired device.

Prints PASS/FAIL. Run with the project-sanctioned invocation (the host
PYTHONPATH breaks venvs):

    env -u PYTHONPATH uv run --with 'websockets,pynacl' python \\
        scripts/device_handshake_test.py

Prereqs: jarvisd must already be running (Contract C / device server enabled).
The control token is read from ~/.config/jarvis/control_token.
"""

import asyncio
import base64
import json
import os
import sys
import time

try:
    import websockets
    from nacl.signing import SigningKey
except ImportError:  # pragma: no cover - guidance only
    print("FAIL: missing deps. Run via: env -u PYTHONPATH uv run "
          "--with 'websockets,pynacl' python scripts/device_handshake_test.py",
          file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
DEVICE_PORT = int(os.environ.get("JARVIS_DEVICE_PORT", "8796"))
DEVICE_HOST = os.environ.get("JARVIS_DEVICE_HOST", "127.0.0.1")
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")
DEADLINE_S = 120.0
SESSION_MODEL = os.environ.get("JARVIS_E2E_MODEL", "gpt-5-codex")


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def read_token() -> str:
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}",
              file=sys.stderr)
        sys.exit(2)


async def control_call(ws, mid, method, params=None, timeout=15.0):
    """Send one Contract A request and await its matching response."""
    frame = {"v": 1, "id": mid, "method": method, "params": params or {}}
    await ws.send(json.dumps(frame))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(raw)
        if msg.get("id") == mid and "ok" in msg:
            if not msg.get("ok"):
                err = msg.get("error", {})
                raise RuntimeError(
                    f"{method} failed: {err.get('code')}: {err.get('message')}")
            return msg.get("result", {})


async def recv_until(ws, predicate, timeout):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    msg = json.loads(raw)
    if not predicate(msg):
        raise RuntimeError(f"unexpected device frame: {msg}")
    return msg


async def run() -> int:
    token = read_token()
    sk = SigningKey.generate()
    device_pub = bytes(sk.verify_key)  # 32-byte ed25519 public key
    device_pub_b64 = b64(device_pub)

    control_url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    device_url = f"ws://{DEVICE_HOST}:{DEVICE_PORT}/device/ws"

    # --- 1) control WS: get a pairing code --------------------------------
    try:
        control = await asyncio.wait_for(
            websockets.connect(control_url, max_size=None), timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to control WS: {exc}", file=sys.stderr)
        print("      is jarvisd running?", file=sys.stderr)
        return 1

    try:
        pong = await control_call(control, 1, "ping")
        assert pong.get("pong") is True, "control ping did not pong"
        print("PASS  control ping")

        pair = await control_call(control, 2, "devices.pair_start")
        code = pair.get("code")
        payload = pair.get("payload", "")
        qr_svg = pair.get("qr_svg", "")
        assert code and len(code) == 6 and code.isdigit(), \
            f"pair_start returned a bad code: {code!r}"
        assert payload.startswith("jarvis://pair?host="), \
            f"pair_start payload malformed: {payload!r}"
        assert "fp=" in payload, "pair_start payload missing daemon fp"
        assert qr_svg.startswith("<svg") and "</svg>" in qr_svg, \
            "pair_start qr_svg is not a valid SVG"
        print(f"PASS  devices.pair_start (code={code}, payload={payload})")

        # --- 2) device WS: pair with the code -----------------------------
        async with websockets.connect(device_url, max_size=None) as dev:
            hello = {"hello": True, "device_pubkey": device_pub_b64,
                     "name": "handshake-test", "pair_code": code}
            await dev.send(json.dumps(hello))
            ack = json.loads(await asyncio.wait_for(dev.recv(), timeout=10.0))
            assert ack.get("paired") is True, f"pairing not acked: {ack}"
            device_id = ack.get("device_id")
            assert device_id, "paired ack missing device_id"
            assert "capabilities" in ack, "paired ack missing capability tiers"
            caps = ack["capabilities"]
            assert caps.get("approval.respond") == "biometric", \
                "approval.respond should be the biometric tier"
            print(f"PASS  device pair (device_id={device_id}, caps ok)")

        # --- 3) reconnect, sign the challenge -----------------------------
        async with websockets.connect(device_url, max_size=None) as dev:
            hello = {"hello": True, "device_pubkey": device_pub_b64,
                     "name": "handshake-test"}
            await dev.send(json.dumps(hello))
            ch = json.loads(await asyncio.wait_for(dev.recv(), timeout=10.0))
            nonce_b64 = ch.get("challenge")
            assert nonce_b64, f"expected a challenge, got: {ch}"
            nonce = base64.b64decode(nonce_b64)
            sig = sk.sign(nonce).signature  # detached 64-byte signature
            await dev.send(json.dumps({"sig": b64(sig)}))
            authed = json.loads(await asyncio.wait_for(dev.recv(), timeout=10.0))
            assert authed.get("authed") is True, f"not authed: {authed}"
            print("PASS  device challenge/response authed")

            # --- 4) authed session.create + send --------------------------
            created = await control_call(
                dev, 100, "session.create",
                {"profile": "coder", "brain": "codex", "model": SESSION_MODEL})
            session_id = created.get("session_id")
            assert session_id, "session.create returned no session_id"
            print(f"PASS  device session.create (session_id={session_id})")

            sent = await control_call(
                dev, 101, "session.send",
                {"session_id": session_id,
                 "text": "Reply with exactly the word PONG and stop."})
            assert sent.get("accepted") is True, "session.send not accepted"
            print("PASS  device session.send (accepted) — awaiting events…")

            # --- 5) collect streamed events -------------------------------
            kinds = []
            got_terminal = False
            start = time.monotonic()
            while time.monotonic() - start < DEADLINE_S:
                try:
                    remaining = DEADLINE_S - (time.monotonic() - start)
                    raw = await asyncio.wait_for(dev.recv(),
                                                 timeout=max(1.0, remaining))
                except asyncio.TimeoutError:
                    break
                msg = json.loads(raw)
                if msg.get("event") == "session.event":
                    k = msg.get("data", {}).get("ev", {}).get("kind")
                    if k:
                        kinds.append(k)
                    if k in ("message", "final", "error"):
                        got_terminal = True
                        break

            print(f"\ncollected device session.event kinds={kinds}")
            assert got_terminal, \
                f"no message/final/error event within {DEADLINE_S:.0f}s"
            assert "message" in kinds or "final" in kinds, \
                "no streamed message/final event arrived over the device channel"
            if "message" in kinds:
                print("PASS  streamed NormalizedBrainEvent kind message")
            else:
                print(f"PASS  streamed kind final (model '{SESSION_MODEL}' may "
                      "be unsupported by this codex login; set JARVIS_E2E_MODEL)")

        # --- 6) devices.list shows the paired device ----------------------
        listed = await control_call(control, 3, "devices.list")
        ids = [d.get("id") for d in listed.get("devices", [])]
        assert device_id in ids, \
            f"devices.list missing the paired device {device_id}: {ids}"
        print(f"PASS  devices.list shows paired device ({device_id})")

        print("\n=== DEVICE HANDSHAKE PASS ===")
        return 0

    except (AssertionError, RuntimeError, asyncio.TimeoutError,
            ConnectionError, OSError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        await control.close()


def main() -> int:
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
