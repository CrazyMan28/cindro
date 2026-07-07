"""Per-VM tuning state (config.STATE_FILE): cores/memory_mb Proxmox is
CURRENTLY configured to, pending_restart, and the cooldown timestamp. Small
enough that plain read-modify-write with an atomic rename is sufficient —
this daemon is the only writer, single process, one tick at a time."""

from __future__ import annotations

import json
import os
from pathlib import Path


def load(state_file: Path) -> dict:
    try:
        return json.loads(state_file.read_text())
    except (OSError, ValueError):
        return {"vms": {}}


def save(state_file: Path, state: dict) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, state_file)  # atomic on the same filesystem


def vm_entry(state: dict, vmid: int) -> dict:
    return state.setdefault("vms", {}).setdefault(str(vmid), {
        "pending_restart": False,
        "last_action": "",
        "last_action_at": None,
    })


def load_blocklist(blocklist_file: Path) -> set[int]:
    try:
        data = json.loads(blocklist_file.read_text())
    except (OSError, ValueError):
        # Missing file / not valid JSON at all — no blocklist configured yet,
        # matches the documented "empty by default" behavior.
        return set()
    # A single malformed ENTRY must not silently drop every other VM's
    # protection — that would re-expose an already-blocklisted VM (e.g. a CI
    # runner) to auto-tuning with no error surfaced anywhere. Keep whatever
    # parses, skip the rest.
    result: set[int] = set()
    for v in data.get("vmids", []):
        try:
            result.add(int(v))
        except (ValueError, TypeError):
            continue
    return result


def save_blocklist(blocklist_file: Path, vmids: list[int]) -> None:
    blocklist_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = blocklist_file.with_suffix(".tmp")
    tmp.write_text(json.dumps({"vmids": sorted(set(int(v) for v in vmids))}, indent=2))
    os.replace(tmp, blocklist_file)
