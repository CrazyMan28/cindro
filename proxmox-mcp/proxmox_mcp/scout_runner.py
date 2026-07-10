"""`proxmox-scout` — the fleet scout CLI.

Launched detached (setsid … &) by the daemon's proxmox.scout RPC and by
proxmox_scout(full=True), because a fleet scan can take minutes and the
outpost exec path has a hard 60s wall — progress is streamed to
scout_status.json instead of stdout, which is what the Outpost UIs poll.

Every guest is wrapped in its own try/except: one wedged guest agent must
never kill the rest of the fleet run. All the interesting paths are
parameters (tests pass tmp dirs); the CLI entry point wires in the real
config paths."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from proxmox_mcp import config, profile_store, proxmox_ops, scout, scout_status
from proxmox_mcp.memory_store import MemoryStore

VALID_TRIGGERS = ("install", "chat", "agent", "manual")


def _targets(vmids: list[int] | None) -> list[dict]:
    """Running QEMU VMs + running LXC CTs, each {vmid, name, kind}; filtered
    to `vmids` when given. Enumeration errors of one kind never hide the
    other (a host with no LXC at all just contributes nothing)."""
    targets = []
    try:
        for row in proxmox_ops.qm_list():
            if row.get("status") == "running":
                targets.append({"vmid": row["vmid"], "name": row["name"], "kind": "qemu"})
    except Exception:  # noqa: BLE001 - qm missing/failing is recorded via empty set
        pass
    try:
        for row in scout.pct_list():
            if row.get("status") == "running":
                targets.append({"vmid": row["vmid"], "name": row["name"], "kind": "lxc"})
    except Exception:  # noqa: BLE001
        pass
    if vmids:
        wanted = {int(v) for v in vmids}
        targets = [t for t in targets if t["vmid"] in wanted]
    return targets


def run_scout(vmids: list[int] | None, trigger: str, *,
              profiles_dir: Path | None = None,
              status_file: Path | None = None,
              memory_db: Path | None = None) -> dict:
    profiles_dir = profiles_dir or (config.STATE_DIR / "vms")
    status_file = status_file or (config.STATE_DIR / "scout_status.json")
    memory_db = memory_db or config.MEMORY_DB

    now_ms = int(time.time() * 1000)
    current = scout_status.read(status_file)
    if scout_status.is_running(current, now_ms):
        return {"ok": False, "error": "scout already running", "status": current}

    targets = _targets(vmids)
    status = {"state": "running", "trigger": trigger, "pid": os.getpid(),
              "started_at": now_ms, "finished_at": None,
              "total": len(targets), "done": 0,
              "current_vmid": None, "current_name": "", "results": []}
    scout_status.write(status_file, status)

    agent_responsive = 0
    for target in targets:
        status["current_vmid"] = target["vmid"]
        status["current_name"] = target["name"]
        scout_status.write(status_file, status)
        result = {"vmid": target["vmid"], "name": target["name"],
                  "kind": target["kind"], "ok": False, "os_family": "",
                  "agent": None, "summary": "", "error": ""}
        try:
            res = (scout.scout_qemu(target["vmid"]) if target["kind"] == "qemu"
                   else scout.scout_lxc(target["vmid"]))
            result["ok"] = bool(res.get("ok"))
            result["os_family"] = res.get("os_family", "")
            result["agent"] = res.get("agent")
            if res.get("agent"):
                agent_responsive += 1
            if res.get("ok"):
                observed = res.get("observed") or {}
                profile_store.update_observed(
                    profiles_dir, target["vmid"], target["name"], target["kind"],
                    res.get("os_family", ""), observed, res.get("agent"),
                    int(time.time() * 1000))
                result["summary"] = scout.summarize(observed)
            else:
                result["error"] = res.get("error", "scout failed")
        except Exception as exc:  # noqa: BLE001 - one bad guest can't kill the run
            result["error"] = str(exc)
        status["results"].append(result)
        status["done"] += 1
        scout_status.write(status_file, status)

    status["state"] = "done"
    status["finished_at"] = int(time.time() * 1000)
    status["current_vmid"] = None
    status["current_name"] = ""
    scout_status.write(status_file, status)

    ok_count = sum(1 for r in status["results"] if r["ok"])
    try:
        MemoryStore(memory_db).remember(
            f"scout({trigger}): scanned {len(targets)} guests, {ok_count} profiled, "
            f"{agent_responsive} with responsive guest agent",
            tags="scout")
    except Exception:  # noqa: BLE001 - memory failure shouldn't fail the scout
        pass
    return {"ok": True, "status": status}


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan running VMs/CTs and update JARVIS.md profiles")
    parser.add_argument("--vmids", default="",
                        help="comma-separated vmids (default: whole fleet)")
    parser.add_argument("--trigger", default="manual", choices=VALID_TRIGGERS)
    args = parser.parse_args()
    vmids = [int(v) for v in args.vmids.split(",") if v.strip()] if args.vmids else None
    result = run_scout(vmids, args.trigger)
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
