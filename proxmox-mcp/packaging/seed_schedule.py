#!/usr/bin/env python3
"""Seed OR UPDATE the Proxmox workload-manager schedule row on the host's own
jarvisd.

This is the one manual step after `outpost.install_workload` (the KNOWN GAP in
docs/PROXMOX_WORKLOAD_MANAGER.md): jarvisd's control API is loopback-only by
design, so the row must be created ON the Proxmox host:

    /opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/python3 seed_schedule.py

(websockets is a normal proxmox-mcp dependency now — no separate pip step.)

UPSERT semantics: if a proxmox-* schedule already exists but its prompt
differs from the one below, the prompt is updated in place (schedule.update)
— re-running this script after upgrading proxmox-mcp is the documented way
to roll the tick prompt forward on an existing install.
"""
import asyncio
import json
import socket

from proxmox_mcp import jarvisd_client

TARGET = f"proxmox-{socket.gethostname()}"

PROMPT = (
    f"You are the always-on Proxmox workload manager on host {socket.gethostname()}. "
    "Each tick, in order: "
    "1) call project_tracker_checkin; "
    "2) call proxmox_get_tasks — these are questions/tasks from the user's main Jarvis "
    "(a run_now kick usually means one is waiting). Answer/do each within your normal "
    "safety rails, then proxmox_reply(rid, ...) with a short concrete reply; "
    "3) call proxmox_get_answers — for each interview answer, write it into that VM's "
    "profile (proxmox_update_vm_profile, section Purpose or Preferences) and remember it; "
    "4) call proxmox_get_directives and follow any user directives; "
    "5) call proxmox_status; "
    "6) call proxmox_get_due_pinged and handle every returned watch rule: judge condition "
    "rules against proxmox_status, the VM's profile, and (for at most 2 rules per tick) a "
    "deeper look via proxmox_guest_exec; run due schedule rules. When a rule fires, act "
    "per its action text — fixing means healing, e.g. proxmox_guest_service start/restart "
    "on a stuck service, never anything destructive. ALWAYS proxmox_record_pinged for "
    "every rule you handled, fired or not; "
    "7) BEFORE tuning or otherwise working on any VM, call proxmox_get_vm_profile and "
    "respect its Purpose and Preferences (e.g. a build server bursting CPU is normal, "
    "not congestion); "
    "8) for any VM over the CPU/memory congestion thresholds, bump its cores/RAM with "
    "proxmox_tune (small steps, within the configured limits; skip blocklisted VMs and "
    "VMs in cooldown); "
    "9) re-scout judgment: check proxmox_list_vm_profiles — if a running guest has no "
    "profile, its profile is stale, or its observed workload no longer matches what "
    "proxmox_status shows, call proxmox_scout with those vmids (up to 2 synchronously; "
    "use full=true for a fleet refresh — it runs detached); "
    "10) interview: if a VM's profile has has_purpose=false, call proxmox_ask_user asking "
    "what that VM is for (mention vmid and name; offer options when you can guess) — it "
    "refuses on its own once the question queue is full, so don't bother pre-checking. "
    "Do NOT wait for the answer — it arrives via "
    "proxmox_get_answers on a later tick; "
    "11) use remember to record every decision and recall to check history before "
    "acting; call project_tracker_checkin (status 'working' if you changed anything, "
    "else 'idle') and, when you acted, project_tracker_report with a one-line summary. "
    "You must NEVER restart, stop, or start a VM — you have no tool for it; if a tune "
    "can only apply after a restart, record pending_restart in memory and move on. "
    "proxmox_guest_service manages services INSIDE guests (start/restart/status only, "
    "no stop) and is not a way around that rule."
)


async def main():
    (lst,) = await jarvisd_client.call_many([("schedule.list", {})])
    rows = lst.get("result", {}).get("schedules", [])
    existing = jarvisd_client.find_proxmox_schedule(rows)
    if existing:
        if existing.get("prompt") == PROMPT:
            print("already seeded with the current prompt:",
                  json.dumps({k: existing.get(k) for k in ("id", "name", "cron")}))
            return
        (resp,) = await jarvisd_client.call_many([
            ("schedule.update", {"id": existing.get("id", ""), "prompt": PROMPT})])
        print("prompt updated:", json.dumps(resp))
        return
    (resp,) = await jarvisd_client.call_many([("schedule.create", {
        "name": "proxmox-workload-manager",
        "cron": "every 5m",
        "prompt": PROMPT,
        "brain": "api",
        "model": "mistral-large-latest",
        "target": TARGET,
    })])
    print("create:", json.dumps(resp))


asyncio.run(main())
