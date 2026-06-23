#!/usr/bin/env python3
"""JOB 2 — CLEAN visual proof of chat auto-spawn, captured by the per-session
ENGINE's OWN capture (its /video/frame), NOT a manual host grim.

A manual `grim` on the host mis-targets: the nested agent compositor lives in an
isolated XDG_RUNTIME_DIR / wayland-N that the host grim doesn't see, so a host
grab catches the wrong (or empty) display. The per-session engine, by contrast,
is bound to JARVIS_AGENT_* and grabs the nested output natively — so we drive
THAT to settle the "does the GUI result reliably render" question.

Flow per brain (codex, claude):
  1. session.create — PLAIN chat (profile defaults to coder, NO target=agent).
  2. agent_desktop.info — learn the engine port + /video/frame URL.
  3. read the per-session bearer from the daemon-seeded config.yaml.
  4. session.send: open foot + run `echo PROOF_<brain>`.
  5. watch the event stream for computer-use tool_calls/results.
  6. grab the nested desktop via the engine's /video/frame -> /tmp/clean_<brain>.png
     (a couple of retries; the engine capture is the SAME path the model uses).
  7. report tool counts + whether a real (non-trivial) PNG came back.

Usage:
    env -u PYTHONPATH uv run --with websockets --with requests \
        python scripts/clean_autospawn_proof.py <brain>
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

import websockets

TOKEN = open(os.path.expanduser("~/.config/jarvis/control_token")).read().strip()
URL = f"ws://127.0.0.1:8795/control/ws?token={TOKEN}"
AGENT_CFG = os.path.expanduser("~/.local/share/jarvis/agent/cu-{sid}/config.yaml")


def read_bearer(sid: str) -> str | None:
    path = AGENT_CFG.format(sid=sid)
    try:
        for line in open(path):
            if line.startswith("bearer_token:"):
                return line.split(":", 1)[1].strip()
    except OSError:
        return None
    return None


def grab_engine_frame(port: int, bearer: str, out_path: str,
                      width: int = 1280, tries: int = 6) -> int:
    """GET <engine>/video/frame?which=agent (the engine's OWN nested capture).
    Returns the byte count of the saved PNG/JPEG (0 on failure)."""
    url = f"http://127.0.0.1:{port}/video/frame?which=agent&width={width}"
    last = ""
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {bearer}"})
            with urllib.request.urlopen(req, timeout=8) as r:
                data = r.read()
            if data and len(data) > 2000:
                with open(out_path, "wb") as f:
                    f.write(data)
                return len(data)
            last = f"tiny frame ({len(data)} bytes)"
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
        time.sleep(1.5)
    print(f"  [capture] engine frame failed: {last}")
    return 0


async def main():
    brain = sys.argv[1] if len(sys.argv) > 1 else "claude"
    prompt = (
        f"Use the computer_use tools to do this on YOUR desktop: app_launch the "
        f"'foot' terminal, then type the command  echo PROOF_{brain}  and press "
        f"Return. Then take a desktop_screenshot to confirm the terminal and the "
        f"text PROOF_{brain} are visible. Tell me when done."
    )
    rid = 0

    def nextid():
        nonlocal rid
        rid += 1
        return rid

    async with websockets.connect(URL, max_size=64 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"v": 1, "id": nextid(),
                                  "method": "session.create",
                                  "params": {"brain": brain, "title": f"clean-{brain}"}}))
        sid = None
        while sid is None:
            msg = json.loads(await ws.recv())
            if "result" in msg or "error" in msg:
                if msg.get("error"):
                    print(f"[FAIL] session.create error: {msg['error']}")
                    return 2
                res = msg.get("result", {})
                sid = res.get("session_id") or res.get("id")
        print(f"[session] brain={brain} sid={sid}")

        # agent_desktop.info -> engine port + video_frame url
        port = None
        deadline = time.time() + 30
        while time.time() < deadline and port is None:
            await ws.send(json.dumps({"v": 1, "id": nextid(),
                                      "method": "agent_desktop.info",
                                      "params": {"session_id": sid}}))
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            except asyncio.TimeoutError:
                continue
            res = msg.get("result")
            if isinstance(res, dict) and res.get("port"):
                port = res["port"]
                print(f"[agent_desktop] up={res.get('up')} port={port} "
                      f"video_frame={res.get('video_frame')}")
            elif msg.get("error"):
                time.sleep(1.5)  # desktop still spinning up
        if not port:
            print("[FAIL] never learned engine port")
            return 2

        # send the prompt
        await ws.send(json.dumps({"v": 1, "id": nextid(), "method": "session.send",
                                  "params": {"session_id": sid, "text": prompt}}))
        print(f"[send] {prompt[:90]}...")

        tool_calls = tool_ok = tool_err = 0
        got_final = False
        saw_screenshot = False
        deadline = time.time() + 300
        while time.time() < deadline and not got_final:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=300))
            except asyncio.TimeoutError:
                break
            if msg.get("event") != "session.event":
                continue
            ev = msg.get("data", {}).get("ev", {})
            kind = ev.get("kind")
            if kind == "tool_call":
                tool_calls += 1
                nm = ev.get("name", "")
                if "screenshot" in nm:
                    saw_screenshot = True
                print(f"  [tool_call] {nm} {json.dumps(ev.get('args', {}))[:100]}")
            elif kind == "tool_result":
                ok = ev.get("ok")
                out = (ev.get("output") or "")
                if ok is False:
                    tool_err += 1
                    print(f"  [tool_result FAIL] {out[:160]}")
                else:
                    tool_ok += 1
                    print(f"  [tool_result ok] {out[:120]}")
            elif kind == "message":
                t = ev.get("text", "")
                if t:
                    print(f"  [msg] {t[:140]}")
            elif kind == "error":
                print(f"  [error] {str(ev.get('message', ev))[:160]}")
            elif kind == "final":
                got_final = True

        # capture the nested desktop via the ENGINE's own frame
        bearer = read_bearer(sid)
        out_path = f"/tmp/clean_{brain}.png"
        nbytes = 0
        if bearer:
            nbytes = grab_engine_frame(port, bearer, out_path)
        else:
            print("  [capture] could not read per-session bearer")

        print(f"\n[RESULT] brain={brain} sid={sid} port={port} "
              f"tool_calls={tool_calls} tool_ok={tool_ok} tool_err={tool_err} "
              f"final={got_final} saw_screenshot_tool={saw_screenshot} "
              f"engine_capture_bytes={nbytes} -> {out_path}")
        # write a small machine-readable summary for the orchestrator
        open(f"/tmp/clean_{brain}.json", "w").write(json.dumps({
            "brain": brain, "sid": sid, "port": port,
            "tool_calls": tool_calls, "tool_ok": tool_ok, "tool_err": tool_err,
            "final": got_final, "saw_screenshot_tool": saw_screenshot,
            "capture_bytes": nbytes, "png": out_path,
        }))
        ok = tool_ok >= 1 and tool_err == 0 and nbytes > 2000
        print("[PASS]" if ok else "[PARTIAL/FAIL]",
              "clean engine-captured auto-spawn proof")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
