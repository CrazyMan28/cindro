#!/usr/bin/env python3
"""Drive a REAL-screen take-over through the control WS and hold it active.

Flow:
  1. session.create  target="real"  (brain=claude; we are only testing the overlay,
     not asking the brain to do anything — no session.send).
  2. take_over.request -> expect {pending_approval:true, approval_id:"takeover-<sid>"}.
  3. approval.respond allow -> daemon setTakeOverActive(true) -> agentDrivingChanged
     -> the running sidebar's Bridge.driving flips true -> Instantiator spawns one
     layer-shell OVERLAY per monitor.
  4. Hold for HOLD seconds (default 20) so the overlay log + window_list can be read.
  5. approval.respond deny (release) + session.delete -> overlay drops.

Usage:
  env -u PYTHONPATH uv run --with websockets python scripts/takeover_drive.py [hold_secs]
"""
import asyncio, json, os, sys, time
import websockets

TOKEN = open(os.path.expanduser("~/.config/jarvis/control_token")).read().strip()
URL = f"ws://127.0.0.1:8795/control/ws?token={TOKEN}"
HOLD = int(sys.argv[1]) if len(sys.argv) > 1 else 20


async def main():
    rid = 0
    def nextid():
        nonlocal rid; rid += 1; return rid

    async with websockets.connect(URL, max_size=64 * 1024 * 1024) as ws:
        # 1. create a target=real session
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "session.create",
                                  "params": {"brain": "claude", "title": "takeover-overlay-test",
                                             "target": "real"}}))
        sid = None
        while sid is None:
            msg = json.loads(await ws.recv())
            if "result" in msg or "error" in msg:
                if msg.get("error"):
                    print(f"[FAIL] session.create: {msg['error']}"); return 2
                res = msg.get("result", {})
                sid = res.get("session_id") or res.get("id")
        print(f"[session] target=real sid={sid}")

        # 2. request take-over
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "take_over.request",
                                  "params": {"session_id": sid}}))
        approval_id = None
        deadline = time.time() + 10
        while time.time() < deadline and approval_id is None:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if "result" in msg and isinstance(msg["result"], dict) and msg["result"].get("approval_id"):
                approval_id = msg["result"]["approval_id"]
                print(f"[take_over] pending_approval approval_id={approval_id}")
            elif msg.get("error"):
                print(f"[FAIL] take_over.request: {msg['error']}"); return 2
        if not approval_id:
            approval_id = f"takeover-{sid}"
            print(f"[take_over] (no explicit reply; assuming {approval_id})")

        # 3. approve -> overlay goes live
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "approval.respond",
                                  "params": {"session_id": sid, "approval_id": approval_id,
                                             "decision": "allow"}}))
        print(f"[approve] allow -> take-over ACTIVE; holding {HOLD}s (overlay should be up)")

        # drain events (look for driving.state) while holding
        t_end = time.time() + HOLD
        while time.time() < t_end:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
                ev = msg.get("event") or msg.get("method")
                if ev and "driv" in json.dumps(msg).lower():
                    print(f"  [evt] {json.dumps(msg)[:200]}")
            except asyncio.TimeoutError:
                pass

        # 4. release
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "approval.respond",
                                  "params": {"session_id": sid, "approval_id": approval_id,
                                             "decision": "deny"}}))
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "session.delete",
                                  "params": {"session_id": sid}}))
        print(f"[release] deny + session.delete sid={sid} -> overlay should drop")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
