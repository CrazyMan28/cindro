"""Generative-widget bus.

The model can pop up CUSTOM UI in the Jarvis desktop app by emitting a small,
safe JSON widget spec (a DSL — never code). The `render_widget` MCP tool appends
one compact JSON line per widget to:

    ~/.local/share/jarvis/widgets.jsonl     {"ts": <int ms>, "title": <str>, "id": <str>, "spec": <spec>}

The desktop app (Bridge) polls that file and renders each `spec` declaratively on
its CANVAS page. Appending is best-effort and NEVER raises into the tool path: a
broken sink must not break a tool call. The path is resolved at call time so tests
can redirect it via JARVIS_WIDGETS_LOG, mirroring agent_bus' JARVIS_AGENT_POINTER_LOG.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

# ~/.local/share/jarvis/widgets.jsonl (override for tests via env).
_DEFAULT_BUS_PATH = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "jarvis" / "widgets.jsonl"

_file_lock = threading.Lock()
# Cap the JSONL so a long-running session can't grow it without bound.
_MAX_BYTES = 4 * 1024 * 1024


def bus_path() -> Path:
    """Resolved at call time so tests can point JARVIS_WIDGETS_LOG at a tmp file
    without re-importing the module."""
    override = os.environ.get("JARVIS_WIDGETS_LOG")
    return Path(override) if override else _DEFAULT_BUS_PATH


def append_widget(spec, title: str = "", widget_id: str = "",
                  target: str = "canvas") -> dict:
    """Append one widget record to the bus. Best-effort; never raises.

    Each record is {ts, title, id, spec, target}. `widget_id` lets the model
    address a widget so a later append with the SAME id is an UPDATE the desktop
    replaces in place; the bus itself stays append-only (no rewrite of old lines)
    so the offset-tail poller is untouched. When `widget_id` is empty a stable
    fallback id ("w<ts>") is derived so every record always carries an id.

    `target` gates WHERE it surfaces: "canvas" (default) lives only on the Canvas
    tab; "chat" also drops inline into the live conversation; "voice" pops near
    the voice orb; "both" = chat + canvas. The desktop honors this so widgets only
    appear in chat/voice when the model asked them to.

    Returns the record dict that was (attempted to be) written.
    """
    ts = int(time.time() * 1000)
    wid = str(widget_id or "").strip() or f"w{ts}"
    tgt = str(target or "canvas").strip().lower()
    if tgt not in ("canvas", "chat", "voice", "both"):
        tgt = "canvas"
    record = {
        "ts": ts,
        "title": str(title or ""),
        "id": wid,
        "spec": spec,
        "target": tgt,
        # Stamp the originating session so the desktop can scope a widget to its
        # chat and REPLAY it when that session is reopened (instead of a global
        # bus that leaks across sessions and vanishes on reload).
        "session_id": os.environ.get("JARVIS_AGENT_SESSION", ""),
    }
    _append_record(record)
    return record


def append_op(op: str, widget_id: str = "") -> dict:
    """Append a control record to the bus so the desktop can REMOVE or CLEAR
    canvases live (the bus is append-only, so deletes are expressed as markers
    the desktop replays). op="remove" needs widget_id; op="clear" drops all.
    """
    record = {"ts": int(time.time() * 1000), "op": str(op), "id": str(widget_id or "")}
    _append_record(record)
    return record


def _append_record(record: dict) -> None:
    path = bus_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
        with _file_lock:
            # Truncate-and-keep-tail if the log got large; cheap and bounded.
            try:
                if path.stat().st_size > _MAX_BYTES:
                    tail = path.read_bytes()[-_MAX_BYTES // 2:]
                    nl = tail.find(b"\n")  # drop a partial leading line
                    path.write_bytes(tail[nl + 1:] if nl >= 0 else b"")
            except OSError:
                pass
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except (OSError, TypeError, ValueError):
        pass  # never break the tool path on a logging/serialization failure


def list_canvases() -> list:
    """Replay the bus into the CURRENT set of canvases (apply id-updates and
    remove/clear markers), newest first. Returns [{id, title, spec, ts, target}].
    Lets the model see what's on the Canvas before editing/deleting it.
    """
    path = bus_path()
    order: list = []
    byid: dict = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except ValueError:
                    continue
                op = rec.get("op")
                if op == "clear":
                    order.clear()
                    byid.clear()
                    continue
                if op == "remove":
                    rid = str(rec.get("id") or "")
                    if rid in byid:
                        byid.pop(rid, None)
                        order[:] = [x for x in order if x != rid]
                    continue
                if "spec" not in rec:
                    continue
                rid = str(rec.get("id") or "")
                if not rid:
                    continue
                if rid not in byid:
                    order.append(rid)
                byid[rid] = {
                    "id": rid,
                    "title": rec.get("title", ""),
                    "spec": rec.get("spec"),
                    "ts": rec.get("ts", 0),
                    "target": rec.get("target", "canvas"),
                }
    except OSError:
        return []
    return [byid[i] for i in reversed(order)]
