"""scout_status.json: live progress of a fleet scout, and the concurrency
lock that keeps two scouts (agent tick vs chat-triggered) from interleaving.

"Running" is only believed when all three hold: state=="running", started
less than 30 minutes ago, and the recorded pid is still alive — so a killed
runner never wedges scouting forever, and a recycled pid can't fake a live
run past the staleness window."""

from __future__ import annotations

import json
import os
from pathlib import Path

_STALE_MS = 30 * 60 * 1000

IDLE = {"state": "idle"}


def read(status_file: Path) -> dict:
    try:
        data = json.loads(status_file.read_text())
    except (OSError, ValueError):
        return dict(IDLE)
    return data if isinstance(data, dict) else dict(IDLE)


def write(status_file: Path, status: dict) -> None:
    status_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = status_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(status, indent=2))
    os.replace(tmp, status_file)


def _pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def is_running(status: dict, now_ms: int) -> bool:
    if status.get("state") != "running":
        return False
    started = status.get("started_at") or 0
    if now_ms - started > _STALE_MS:
        return False
    return _pid_alive(int(status.get("pid") or 0))
