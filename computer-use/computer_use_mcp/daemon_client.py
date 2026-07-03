"""Tiny synchronous client for the jarvisd control WebSocket (Contract A).

Lets the computer-use engine expose Jarvis-level self-management tools — schedule,
memory, skills — to the co-work brain WITHOUT giving it the user's other MCP
servers. Each call is one short-lived round-trip (connect → request → matching
response → close), so there is no long-lived socket to manage from the engine's
synchronous tool handlers.

  Request:  {"v":1,"id":<int>,"method":"<m>","params":{...}}
  Response: {"v":1,"id":<int>,"ok":true,"result":{...}} | {"ok":false,"error":{...}}
"""

from __future__ import annotations

import json
import os
import threading

from websockets.sync.client import connect

# JARVIS_CONFIG_DIR points a second isolated profile at its own config root
# (jarvis#76 item 15); unset resolves to today's ~/.config/jarvis.
_CONFIG_DIR = os.environ.get("JARVIS_CONFIG_DIR") or os.path.expanduser("~/.config/jarvis")
_TOKEN_PATH = os.path.join(_CONFIG_DIR, "control_token")
_lock = threading.Lock()
_counter = 0


def _url() -> str:
    token = ""
    try:
        with open(_TOKEN_PATH) as f:
            token = f.read().strip()
    except OSError as exc:
        raise RuntimeError(
            f"jarvisd control token not found at {_TOKEN_PATH}: {exc}") from exc
    host = os.environ.get("JARVIS_CONTROL_HOST", "127.0.0.1")
    port = os.environ.get("JARVIS_CONTROL_PORT", "8795")
    return f"ws://{host}:{port}/control/ws?token={token}"


def call(method: str, params: dict | None = None, timeout: float = 15.0) -> dict:
    """One Contract-A request → result dict. Raises RuntimeError on error/timeout."""
    global _counter
    with _lock:
        _counter += 1
        rid = _counter
    try:
        with connect(_url(), open_timeout=6, max_size=32 * 1024 * 1024) as ws:
            ws.send(json.dumps({"v": 1, "id": rid, "method": method,
                                "params": params or {}}))
            # Drain until our id comes back (skip unsolicited events).
            while True:
                msg = json.loads(ws.recv(timeout=timeout))
                if msg.get("id") != rid:
                    continue
                if msg.get("ok") is False:
                    err = msg.get("error", {})
                    raise RuntimeError(err.get("message") or err.get("code")
                                       or "control error")
                return msg.get("result", {}) or {}
    except RuntimeError:
        raise
    except Exception as exc:  # noqa: BLE001 — connection/timeout/etc.
        raise RuntimeError(f"jarvisd control call {method} failed: {exc}") from exc


# --- current-session resolution (jarvis: Windows todo/widget session link) ---
# Per-session engines carry JARVIS_AGENT_SESSION in their env. The SHARED
# global engine (Windows v1 real-screen, Linux global :8794) does NOT — so
# todos/widgets used to be stamped with an EMPTY session id and bled into
# whatever chat was open. When the env var is missing, ask the daemon which
# single session is mid-turn right now (state == "running"): a tool call only
# executes while a turn is in flight, so the unique running session IS the
# caller. Ambiguous answers (none or several running) resolve to `default`.
_SID_CACHE = {"ts": 0.0, "sid": ""}


def current_session_id(default: str = "") -> str:
    sid = os.environ.get("JARVIS_AGENT_SESSION", "")
    if sid:
        return sid
    if os.environ.get("JARVIS_SESSION_RESOLVE", "1") == "0":
        return default  # tests: stay hermetic even with a live daemon on the box
    import time as _time

    now = _time.monotonic()
    if now - _SID_CACHE["ts"] < 2.0:  # burst cache: one query per tool volley
        return _SID_CACHE["sid"] or default
    resolved = ""
    try:
        rows = call("session.list", {}, timeout=5).get("sessions", [])
        running = [r for r in rows if r.get("state") == "running"]
        if len(running) == 1:
            resolved = str(running[0].get("id", "") or "")
    except Exception:  # daemon down/unreachable -> keep the old behavior
        resolved = ""
    _SID_CACHE["ts"] = now
    _SID_CACHE["sid"] = resolved
    return resolved or default
