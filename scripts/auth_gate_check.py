#!/usr/bin/env python3
"""2FA + fingerprint cross-device unlock — daemon integration check.

Proves the control-WS unlock flow end to end against a LIVE jarvisd:

  a) control WS auth.request{origin:"desktop"}:
       - NO device paired -> FAIL-OPEN: result.paired==false AND
         result.state=="approved" (the desktop LockGate unlocks immediately).
  b) The PHONE leg, without a real phone: pair a synthetic ed25519 device over the
     device WS (Contract C hello+pair using a devices.pair_start code requested
     over control), then auth.request again (now paired -> pending) and send
     auth.approve{challenge_id} over the AUTHED device WS.
  c) Back on control WS, auth.status{challenge_id} -> result.state=="approved".
  d) The control WS received an unsolicited {"event":"auth.event",
     "data":{state:"approved"}} push.

The synthetic device is REVOKED at the end so the daemon's paired-device state is
left as it started.

Run (the host PYTHONPATH breaks venvs, so strip it):

    env -u PYTHONPATH python3 scripts/auth_gate_check.py
    # or, if deps aren't on the system python:
    env -u PYTHONPATH uv run --with 'websockets,pynacl' python \\
        scripts/auth_gate_check.py

Prints "AUTH GATE OK" and exits 0 on success.
"""

import asyncio
import base64
import json
import os
import sys

try:
    import websockets
    from nacl.signing import SigningKey
except ImportError:
    print("FAIL: missing deps. Run via: env -u PYTHONPATH uv run "
          "--with 'websockets,pynacl' python scripts/auth_gate_check.py",
          file=sys.stderr)
    sys.exit(2)

CONTROL_PORT = int(os.environ.get("JARVIS_CONTROL_PORT", "8795"))
DEVICE_PORT = int(os.environ.get("JARVIS_DEVICE_PORT", "8796"))
DEVICE_HOST = os.environ.get("JARVIS_DEVICE_HOST", "127.0.0.1")
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")


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


async def call(ws, mid, method, params=None, timeout=15.0):
    """Send one Contract A request; await its matching response (skips events).

    Used on the DEVICE WS (single reader). The control WS is read by a dedicated
    multiplexing listener (see [ControlMux]) since events arrive there unsolicited.
    """
    await ws.send(json.dumps(
        {"v": 1, "id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        if msg.get("id") == mid and "ok" in msg:
            if not msg.get("ok"):
                err = msg.get("error", {})
                raise RuntimeError(
                    f"{method} failed: {err.get('code')}: {err.get('message')}")
            return msg.get("result", {})


class ControlMux:
    """Single reader over the control WS that fans replies (by id) to waiting
    futures and collects unsolicited auth.event pushes — so a request/response
    `call` and the event listener never both call recv() on the same socket."""

    def __init__(self, ws):
        self.ws = ws
        self.pending = {}            # id -> Future
        self.auth_events = []        # collected {challenge_id,state}
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._loop())

    async def _loop(self):
        while not self._stop.is_set():
            try:
                msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=1.0))
            except asyncio.TimeoutError:
                continue
            except Exception:  # noqa: BLE001
                break
            if msg.get("event") == "auth.event":
                self.auth_events.append(msg.get("data", {}))
                continue
            mid = msg.get("id")
            if mid in self.pending and "ok" in msg:
                fut = self.pending.pop(mid)
                if not fut.done():
                    fut.set_result(msg)

    async def call(self, mid, method, params=None, timeout=15.0):
        fut = asyncio.get_event_loop().create_future()
        self.pending[mid] = fut
        await self.ws.send(json.dumps(
            {"v": 1, "id": mid, "method": method, "params": params or {}}))
        msg = await asyncio.wait_for(fut, timeout=timeout)
        if not msg.get("ok"):
            err = msg.get("error", {})
            raise RuntimeError(
                f"{method} failed: {err.get('code')}: {err.get('message')}")
        return msg.get("result", {})

    async def close(self):
        self._stop.set()
        try:
            await self._task
        except Exception:  # noqa: BLE001
            pass


async def run() -> int:
    token = read_token()
    control_url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    device_url = f"ws://{DEVICE_HOST}:{DEVICE_PORT}/device/ws"

    sk = SigningKey.generate()
    device_pub_b64 = b64(bytes(sk.verify_key))
    device_id = None

    try:
        control = await asyncio.wait_for(
            websockets.connect(control_url, max_size=None), timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to control WS: {exc}  (is jarvisd running?)",
              file=sys.stderr)
        return 1

    mux = ControlMux(control)

    try:
        pong = await mux.call(1, "ping")
        assert pong.get("pong") is True, "control ping did not pong"
        print("PASS  control ping")

        # Snapshot the starting paired-device count so the fail-open assertion is
        # only enforced when the daemon really has zero devices.
        listed = await mux.call(2, "devices.list")
        start_count = len(listed.get("devices", []))

        # --- (a) auth.request (current paired state) ----------------------
        req = await mux.call(3, "auth.request", {"origin": "desktop"})
        if start_count == 0:
            assert req.get("paired") is False, \
                f"FAIL-OPEN expected paired=false, got {req}"
            assert req.get("state") == "approved", \
                f"FAIL-OPEN expected state=approved, got {req}"
            print("PASS  auth.request FAIL-OPEN (no device paired -> approved)")
        else:
            assert req.get("paired") is True and req.get("state") == "pending", \
                f"with a paired device, expected pending, got {req}"
            print(f"PASS  auth.request pending (start_count={start_count})")

        # --- (b) pair a synthetic device, then drive the phone leg --------
        async with websockets.connect(device_url, max_size=None) as dev:
            pair = await mux.call(4, "devices.pair_start")
            code = pair.get("code")
            assert code and len(code) == 6, f"bad pair code: {code!r}"
            await dev.send(json.dumps({
                "hello": True, "device_pubkey": device_pub_b64,
                "name": "auth-gate-check", "pair_code": code}))
            ack = json.loads(await asyncio.wait_for(dev.recv(), timeout=10.0))
            assert ack.get("paired") is True, f"pairing not acked: {ack}"
            device_id = ack.get("device_id")
            caps = ack.get("capabilities", {})
            assert caps.get("auth.approve") == "biometric", \
                f"auth.approve should be biometric tier, caps={caps}"
            print(f"PASS  device pair (device_id={device_id}, auth.approve=biometric)")

            # A paired device now exists -> a fresh auth.request is PENDING.
            req2 = await mux.call(5, "auth.request", {"origin": "desktop"})
            assert req2.get("paired") is True, f"expected paired now: {req2}"
            assert req2.get("state") == "pending", f"expected pending: {req2}"
            challenge_id = req2.get("challenge_id")
            assert challenge_id, f"no challenge_id minted: {req2}"
            print(f"PASS  auth.request -> pending challenge {challenge_id}")

            # The phone (already authed over the device WS) approves it. (A real
            # phone clears BiometricPrompt first; here the WS auth is the gate.)
            approved = await call(dev, 200, "auth.approve",
                                  {"challenge_id": challenge_id})
            assert approved.get("ok") is True, f"auth.approve failed: {approved}"
            print("PASS  device auth.approve")

            # --- (c) auth.status flips to approved ------------------------
            status = await mux.call(6, "auth.status",
                                    {"challenge_id": challenge_id})
            assert status.get("state") == "approved", \
                f"auth.status not approved: {status}"
            print("PASS  auth.status == approved")

        # --- (d) the control WS got the auth.event push -------------------
        for _ in range(30):
            if any(e.get("state") == "approved"
                   and e.get("challenge_id") == challenge_id for e in mux.auth_events):
                break
            await asyncio.sleep(0.1)
        assert any(e.get("state") == "approved"
                   and e.get("challenge_id") == challenge_id for e in mux.auth_events), \
            f"no auth.event approved push received: {mux.auth_events}"
        print("PASS  control WS received auth.event approved push")

        print("\nAUTH GATE OK")
        return 0

    except (AssertionError, RuntimeError, asyncio.TimeoutError,
            ConnectionError, OSError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        # Leave the daemon's paired state as we found it.
        if device_id:
            try:
                await mux.call(999, "devices.revoke", {"id": device_id})
            except Exception:  # noqa: BLE001
                pass
        await mux.close()
        await control.close()


def main() -> int:
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
