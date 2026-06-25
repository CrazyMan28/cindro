"""Saved-widget library — REUSABLE widget specs.

A "canvas" is an ad-hoc thing the model draws once (the append-only widgets bus).
A "widget" is a saved, named, REUSABLE spec the model (or the user, by tapping
"Save as widget" on a canvas) keeps in a library to render again later. They live
in a single JSON file the desktop's Widgets tab reads:

    ~/.local/share/jarvis/saved_widgets.json     {"widgets": [{id,name,spec,created,updated}, ...]}

All writes are atomic (temp + replace) and best-effort. Resolved at call time so
tests can redirect via JARVIS_SAVED_WIDGETS.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

_DEFAULT_PATH = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "jarvis" / "saved_widgets.json"

_lock = threading.Lock()


def store_path() -> Path:
    override = os.environ.get("JARVIS_SAVED_WIDGETS")
    return Path(override) if override else _DEFAULT_PATH


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(name or "").strip().lower()).strip("-")
    return s or f"w{int(time.time() * 1000)}"


def _read() -> list:
    try:
        with open(store_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("widgets") if isinstance(data, dict) else data
        return items if isinstance(items, list) else []
    except (OSError, ValueError):
        return []


def _write(items: list) -> None:
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"widgets": items}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def list_widgets() -> list:
    """All saved widgets, newest-updated first."""
    items = _read()
    return sorted(items, key=lambda w: w.get("updated", 0), reverse=True)


def get_widget(widget_id: str) -> dict | None:
    wid = str(widget_id or "").strip()
    for w in _read():
        if w.get("id") == wid or w.get("name") == wid:
            return w
    return None


def save_widget(name: str, spec, widget_id: str = "") -> dict:
    """Create or UPDATE a saved widget. If widget_id (or a matching name) already
    exists, its spec/name are updated in place; otherwise a new one is created
    with an id derived from the name. Returns the saved record.
    """
    now = int(time.time() * 1000)
    wid = str(widget_id or "").strip()
    with _lock:
        items = _read()
        # Match by id first, else by name.
        idx = -1
        for i, w in enumerate(items):
            if (wid and w.get("id") == wid) or (not wid and w.get("name") == name):
                idx = i
                break
        if idx >= 0:
            rec = items[idx]
            rec["name"] = str(name or rec.get("name", ""))
            rec["spec"] = spec
            rec["updated"] = now
        else:
            rec = {
                "id": wid or _slug(name),
                "name": str(name or ""),
                "spec": spec,
                "created": now,
                "updated": now,
            }
            items.append(rec)
        _write(items)
        return rec


def remove_widget(widget_id: str) -> bool:
    wid = str(widget_id or "").strip()
    with _lock:
        items = _read()
        kept = [w for w in items if w.get("id") != wid and w.get("name") != wid]
        if len(kept) == len(items):
            return False
        _write(kept)
        return True
