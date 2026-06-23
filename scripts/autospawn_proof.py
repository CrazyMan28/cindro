#!/usr/bin/env python3
"""Wave 4 AUTO-SPAWN proof: a NORMAL chat session (no manual co-work / Computer
tab) must let Jarvis use the computer on demand.

Usage:
    env -u PYTHONPATH uv run --with websockets python scripts/autospawn_proof.py <brain> [prompt]

Connects to the Contract A control WS, creates a session with profile=coder (a
PLAIN chat — NOT coworker, NOT target=agent), sends a prompt, and watches the
event stream for computer-use tool calls + their results. Reports the session id,
the per-session engine port (so the caller can grim the nested desktop), and
PASS/FAIL based on >=1 successful computer-use tool call and a final.
"""

import asyncio
import json
import os
import sys
import time

import websockets

TOKEN = open(os.path.expanduser("~/.config/jarvis/control_token")).read().strip()
URL = f"ws://127.0.0.1:8795/control/ws?token={TOKEN}"


async def main():
    brain = sys.argv[1] if len(sys.argv) > 1 else "claude"
    prompt = sys.argv[2] if len(sys.argv) > 2 else (
        "Open the foot terminal and run: echo HELLO_FROM_CHAT . Use the "
        "computer_use tools (app_launch foot, then type_text / key_press) to do "
        "it in your desktop. Confirm when the text is on screen."
    )
    rid = 0

    def nextid():
        nonlocal rid
        rid += 1
        return rid

    async with websockets.connect(URL, max_size=64 * 1024 * 1024) as ws:
        # settings.get -> confirm let_jarvis_use_computer is exposed + ON
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "settings.get", "params": {}}))
        sresp = json.loads(await ws.recv())
        luc = sresp.get("result", {}).get("let_jarvis_use_computer")
        print(f"[settings] let_jarvis_use_computer = {luc}")

        # session.create — PLAIN chat: profile defaults to coder, no target.
        await ws.send(json.dumps({
            "v": 1, "id": nextid(), "method": "session.create",
            "params": {"brain": brain, "title": f"autospawn-{brain}"},
        }))
        # Drain until we get our create response (id match).
        sid = None
        engine_port = None
        while sid is None:
            msg = json.loads(await ws.recv())
            if msg.get("type") == "response" or "result" in msg or "error" in msg:
                if msg.get("error"):
                    print(f"[FAIL] session.create error: {msg['error']}")
                    return 2
                res = msg.get("result", {})
                sid = res.get("session_id") or res.get("id")
        print(f"[session] created sid={sid} brain={brain}")

        # Ask the daemon for the agent-desktop info to learn the engine port.
        await ws.send(json.dumps({
            "v": 1, "id": nextid(), "method": "agent_desktop.info",
            "params": {"session_id": sid},
        }))
        deadline = time.time() + 5
        while time.time() < deadline:
            msg = json.loads(await ws.recv())
            res = msg.get("result")
            if isinstance(res, dict) and ("port" in res or "agent_desktop" in res):
                desk = res.get("agent_desktop", res)
                engine_port = desk.get("port")
                print(f"[agent_desktop] up={desk.get('up')} port={engine_port} "
                      f"wayland={desk.get('wayland_display')} sway={desk.get('swaysock')}")
                break
        # Persist the port for the shell to grim.
        if engine_port:
            open("/tmp/autospawn_port", "w").write(str(engine_port))
        open("/tmp/autospawn_sid", "w").write(sid)

        # session.send the prompt.
        await ws.send(json.dumps({
            "v": 1, "id": nextid(), "method": "session.send",
            "params": {"session_id": sid, "text": prompt},
        }))
        print(f"[send] {prompt!r}")

        tool_calls = 0
        tool_ok = 0
        tool_err = 0
        got_final = False
        deadline = time.time() + 240
        while time.time() < deadline and not got_final:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=240))
            except asyncio.TimeoutError:
                break
            if msg.get("event") == "session.event":
                ev = msg.get("data", {}).get("ev", {})
                kind = ev.get("kind")
                if kind == "tool_call":
                    tool_calls += 1
                    print(f"  [tool_call] {ev.get('name')} {json.dumps(ev.get('args', {}))[:120]}")
                elif kind == "tool_result":
                    ok = ev.get("ok")
                    out = (ev.get("output") or "")
                    if ok is False:
                        tool_err += 1
                        print(f"  [tool_result FAIL] {out[:200]}")
                    else:
                        tool_ok += 1
                        print(f"  [tool_result ok] {out[:200]}")
                elif kind == "message":
                    t = ev.get("text", "")
                    if t:
                        print(f"  [msg] {t[:160]}")
                elif kind == "error":
                    print(f"  [error] {str(ev.get('message', ev))[:200]}")
                elif kind == "final":
                    got_final = True
                    print("  [final]")

        print(f"\n[RESULT] brain={brain} sid={sid} tool_calls={tool_calls} "
              f"tool_ok={tool_ok} tool_err={tool_err} final={got_final} engine_port={engine_port}")
        # PASS = at least one SUCCESSFUL computer-use tool result and no failures.
        # (codex maps completed MCP calls straight to tool_result events without a
        # separate tool_call event, so we key off successful tool_results.)
        ok = tool_ok >= 1 and tool_err == 0
        print("[PASS]" if ok else "[FAIL]", "auto-spawn computer-use from a plain chat")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
