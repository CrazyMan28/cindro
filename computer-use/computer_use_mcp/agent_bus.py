"""Agent-pointer event bus.

When the co-worker brain drives the nested "agent" desktop, every pointer op
(move/click/drag) publishes its *intended* pointer position so overlays can draw
a distinct cursor that tracks the agent (BUILD_SPEC Wave 5: "distinct cursor
overlay"). Two sinks, both best-effort and non-fatal:

  1. A durable JSONL append at ~/.local/share/jarvis/agent_pointer.jsonl — a
     simple tail-able log for the desktop sidebar / debugging.
  2. In-process async subscribers (asyncio.Queue registry) — server.py drains
     these to multiplex pointer events into the /video/stream websocket.

Publishing NEVER raises into the input path: a broken sink must not break a
click. Events are plain dicts: {x, y, button, kind, session, t}.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from pathlib import Path

# ~/.local/share/jarvis/agent_pointer.jsonl (override for tests via env).
_DEFAULT_BUS_PATH = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "jarvis" / "agent_pointer.jsonl"


def bus_path() -> Path:
    """Resolved at call time so tests can point JARVIS_AGENT_POINTER_LOG at a tmp
    file without re-importing the module."""
    override = os.environ.get("JARVIS_AGENT_POINTER_LOG")
    return Path(override) if override else _DEFAULT_BUS_PATH


# In-process async subscribers. server.py registers a Queue; publish() fans out.
_subscribers: set[asyncio.Queue] = set()
_sub_lock = threading.Lock()
_file_lock = threading.Lock()
# Cap the JSONL so a long-running session can't grow it without bound.
_MAX_BYTES = 4 * 1024 * 1024


def subscribe() -> asyncio.Queue:
    """Register and return a queue that receives every future pointer event."""
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    with _sub_lock:
        _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    with _sub_lock:
        _subscribers.discard(q)


def _append_jsonl(event: dict) -> None:
    path = bus_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _file_lock:
            # Truncate-and-keep-tail if the log got large; cheap and bounded.
            try:
                if path.stat().st_size > _MAX_BYTES:
                    tail = path.read_bytes()[-_MAX_BYTES // 2:]
                    # drop a partial leading line
                    nl = tail.find(b"\n")
                    path.write_bytes(tail[nl + 1:] if nl >= 0 else b"")
            except OSError:
                pass
            with open(path, "a") as f:
                f.write(json.dumps(event) + "\n")
    except OSError:
        pass  # never break input on a logging failure


def _fan_out(event: dict) -> None:
    with _sub_lock:
        subs = list(_subscribers)
    for q in subs:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # Slow consumer: drop the oldest, then enqueue the newest.
            try:
                q.get_nowait()
                q.put_nowait(event)
            except Exception:
                pass
        except Exception:
            pass


def publish(x: float, y: float, *, button: str | None = None,
            kind: str = "move", session: str = "agent") -> dict:
    """Record an agent pointer event to both sinks. Returns the event dict."""
    event = {
        "x": round(float(x)),
        "y": round(float(y)),
        "button": button,
        "kind": kind,        # move | click | drag | scroll | down | up
        "session": session,
        "t": round(time.time(), 3),
    }
    _append_jsonl(event)
    _fan_out(event)
    return event
