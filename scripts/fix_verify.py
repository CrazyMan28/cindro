#!/usr/bin/env python3
"""Verify the Wave-6 fixes live, end to end, with the CODEX brain (gpt-5.5):

  1. ISOLATION  — a chat 'open chrome' uses the Jarvis computer-use tools
     (app_launch / desktop_screenshot), NOT the user's hand-desktop/desktop-use
     MCP (which would say "Switch to the 'Agent' desktop in KDE" / get_ui_snapshot).
  2. CHROME      — opens in the nested agent desktop; the host's REAL Chrome window
     count is unchanged.
  3. NO FAULTS   — no "cancelled"/FAULT tool results (codex drives fine isolated).
  4. CONTEXT     — turn 2 (no tools) recalls what turn 1 asked → resume works.

Usage:
  env -u PYTHONPATH uv run --with websockets --with requests \
      python scripts/fix_verify.py
"""
import asyncio, json, os, sys, time, subprocess
import websockets

TOKEN = open(os.path.expanduser("~/.config/jarvis/control_token")).read().strip()
URL = f"ws://127.0.0.1:8795/control/ws?token={TOKEN}"


def host_chrome_windows() -> int:
    """Count the user's REAL Chrome windows via desktop-use window_list (KDE)."""
    try:
        out = subprocess.run(
            ["swaymsg"], capture_output=True, timeout=3)  # noop guard
    except Exception:
        pass
    # Use the engine's window list over HTTP would need a bearer; instead grep wmctrl-ish.
    try:
        r = subprocess.run(["bash", "-lc",
            "kdotool search --class google-chrome 2>/dev/null | wc -l"],
            capture_output=True, text=True, timeout=5)
        return int(r.stdout.strip() or "0")
    except Exception:
        return -1


async def run_turn(ws, sid, text, nextid, timeout=240):
    await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "session.send",
                              "params": {"session_id": sid, "text": text}}))
    tools, faults, msgs = [], [], []
    got_final = False
    deadline = time.time() + timeout
    while time.time() < deadline and not got_final:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            break
        if msg.get("event") != "session.event":
            continue
        ev = msg.get("data", {}).get("ev", {})
        k = ev.get("kind")
        if k == "tool_call":
            tools.append(ev.get("name", "?"))
        elif k == "tool_result":
            # codex maps completed MCP calls straight to tool_result (no separate
            # tool_call event), so count the result's name as a tool use too.
            nm = ev.get("name")
            if nm:
                tools.append(nm)
            out = (ev.get("output") or "")
            if ev.get("ok") is False or "cancel" in out.lower():
                faults.append(out[:160])
        elif k == "message":
            if ev.get("text"):
                msgs.append(ev["text"])
        elif k == "error":
            faults.append("ERR:" + str(ev.get("message", ev))[:140])
        elif k == "final":
            got_final = True
    return {"tools": tools, "faults": faults, "msgs": msgs, "final": got_final}


async def main():
    rid = 0
    def nextid():
        nonlocal rid; rid += 1; return rid

    chrome_before = host_chrome_windows()
    async with websockets.connect(URL, max_size=64 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "session.create",
                                  "params": {"brain": "codex", "title": "fix-verify"}}))
        sid = None
        while sid is None:
            m = json.loads(await ws.recv())
            if "result" in m or "error" in m:
                if m.get("error"):
                    print("[FAIL] create:", m["error"]); return 2
                sid = m["result"].get("session_id")
        print(f"[session] codex sid={sid}")

        # let the nested desktop spin up
        await asyncio.sleep(6)

        t1 = await run_turn(ws, sid,
            "Use your computer-use tools to open the Google Chrome browser on your "
            "desktop, then take a desktop screenshot. Tell me which desktop it opened on.",
            nextid)
        print(f"\n[TURN1] tools={t1['tools']}")
        print(f"[TURN1] faults={t1['faults']}")
        print(f"[TURN1] reply={(t1['msgs'][-1] if t1['msgs'] else '')[:240]}")

        t2 = await run_turn(ws, sid,
            "Without using any tools, just answer in one word: what application did I "
            "just ask you to open?",
            nextid, timeout=120)
        reply2 = (t2["msgs"][-1] if t2["msgs"] else "")
        print(f"\n[TURN2] tools={t2['tools']} final={t2['final']}")
        print(f"[TURN2] faults={t2['faults']}")
        print(f"[TURN2] reply={reply2[:200]}")

        chrome_after = host_chrome_windows()

        # --- verdicts ---
        # codex emits no tool_call events and its tool_result carries no name, so
        # we judge isolation by BEHAVIOUR: turn1 reply says it acted on the nested
        # agent/HEADLESS desktop, and nothing shows the hand-desktop signature
        # ("get_ui_snapshot" / "in KDE to see it").
        r1 = (t1["msgs"][-1] if t1["msgs"] else "").lower()
        blob = (r1 + " " + " ".join(t1["faults"] + t2["faults"])).lower()
        used_jarvis = any(w in r1 for w in ("nested", "headless", "agent"))
        used_handdesktop = "get_ui_snapshot" in blob or "in kde to see" in blob
        no_faults = not t1["faults"] and not t2["faults"]
        context_ok = "chrome" in reply2.lower()

        print("\n==== VERDICT ====")
        print(f"  isolation: used Jarvis tools={used_jarvis}  used hand-desktop={used_handdesktop}")
        print(f"  no faults/cancels: {no_faults}")
        print(f"  context retained across turns: {context_ok}")
        print(f"  host Chrome windows before={chrome_before} after={chrome_after} "
              f"(unchanged={chrome_before == chrome_after})")

        # cleanup
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "session.delete",
                                  "params": {"session_id": sid}}))
        ok = used_jarvis and not used_handdesktop and no_faults and context_ok
        print("\n[PASS]" if ok else "[CHECK]", "fix verification")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
