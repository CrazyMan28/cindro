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

_TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")
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
