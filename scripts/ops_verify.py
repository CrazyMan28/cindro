#!/usr/bin/env python3
"""Verify the co-work BRAIN (codex) can self-manage via MCP: memory + schedule +
skills tools reach it and actually write to jarvisd.

  env -u PYTHONPATH uv run --with websockets python scripts/ops_verify.py
"""
import asyncio, json, os, sys, time
import websockets

TOKEN = open(os.path.expanduser("~/.config/jarvis/control_token")).read().strip()
URL = f"ws://127.0.0.1:8795/control/ws?token={TOKEN}"
SENTINEL = "ZephyrQuartz"  # unique so we can find it in memory afterwards


async def main():
    rid = 0
    def nextid():
        nonlocal rid; rid += 1; return rid

    async with websockets.connect(URL, max_size=64 * 1024 * 1024) as ws:
        async def call(method, params):
            i = nextid()
            await ws.send(json.dumps({"v": 1, "id": i, "method": method, "params": params}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                if m.get("id") == i:
                    return m

        r = await call("session.create", {"brain": "codex", "title": "ops-verify"})
        sid = r["result"]["session_id"]
        print(f"[session] {sid}")
        await asyncio.sleep(6)

        prompt = (
            f"Do BOTH using your Jarvis tools, then confirm:\n"
            f"1) Use the `remember` tool to save this exact fact: "
            f"'My project codename is {SENTINEL}.'\n"
            f"2) Use the `schedule_task` tool to schedule prompt 'water the plants' "
            f"with when='every 12h'.\n"
            f"Reply DONE when both tool calls succeeded."
        )
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "session.send",
                                  "params": {"session_id": sid, "text": prompt}}))
        deadline = time.time() + 240
        got_final = False
        while time.time() < deadline and not got_final:
            try:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=240))
            except asyncio.TimeoutError:
                break
            if m.get("event") != "session.event":
                continue
            ev = m.get("data", {}).get("ev", {})
            if ev.get("kind") == "final":
                got_final = True
            elif ev.get("kind") == "message" and ev.get("text"):
                print("  [msg]", ev["text"][:120])

        # verify in the daemon stores
        mem = await call("memory.search", {"q": SENTINEL, "limit": 5})
        sched = await call("schedule.list", {})
        mem_hit = any(SENTINEL in x.get("text", "")
                      for x in mem.get("result", {}).get("memories", []))
        sched_hit = any("water" in x.get("prompt", "").lower()
                        for x in sched.get("result", {}).get("schedules", []))
        print(f"\n[VERDICT] memory written by model={mem_hit}  schedule written by model={sched_hit}")

        # cleanup
        for x in mem.get("result", {}).get("memories", []):
            if SENTINEL in x.get("text", ""):
                await call("memory.remove", {"id": x["id"]})
        for x in sched.get("result", {}).get("schedules", []):
            if "water" in x.get("prompt", "").lower():
                await call("schedule.remove", {"id": x["id"]})
        await call("session.delete", {"session_id": sid})
        ok = mem_hit and sched_hit
        print("[PASS]" if ok else "[FAIL]", "brain self-management via MCP")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
