#!/usr/bin/env python3
"""Seed the Proxmox workload-manager schedule row on the host's own jarvisd.

This is the one manual step after `outpost.install_workload` (the KNOWN GAP in
docs/PROXMOX_WORKLOAD_MANAGER.md): jarvisd's control API is loopback-only by
design, so the row must be created ON the Proxmox host:

    /opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/pip install -q websockets
    /opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/python3 seed_schedule.py

Idempotent — exits without changes if a proxmox-* schedule already exists.
"""
import asyncio
import json
import socket

import websockets

TOKEN = open("/etc/jarvis-proxmox-agent/jarvisd/control_token").read().strip()
URL = f"ws://127.0.0.1:8795/control/ws?token={TOKEN}"
TARGET = f"proxmox-{socket.gethostname()}"

PROMPT = (
    f"You are the always-on Proxmox workload manager on host {socket.gethostname()}. "
    "Each tick, in order: "
    "1) call proxmox_get_directives and follow any user directives; "
    "2) call proxmox_status; "
    "3) for any VM over the CPU/memory congestion thresholds, bump its cores/RAM with "
    "proxmox_tune (small steps, within the configured limits; skip blocklisted VMs and "
    "VMs in cooldown); "
    "4) use remember to record every decision you make and recall to check history "
    "before acting; "
    "5) call project_tracker_checkin (status 'working' if you changed anything, else "
    "'idle') and, when you acted, project_tracker_report with a one-line summary. "
    "You must NEVER restart, stop, or start a VM — you have no tool for it; if a tune "
    "can only apply after a restart, record pending_restart in memory and move on."
)


async def main():
    rid = 0

    async with websockets.connect(URL, max_size=16 * 1024 * 1024) as ws:
        async def call(method, params):
            nonlocal rid
            rid += 1
            i = rid
            await ws.send(json.dumps({"v": 1, "id": i, "method": method, "params": params}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                if m.get("id") == i:
                    return m

        lst = await call("schedule.list", {})
        rows = lst.get("result", {}).get("schedules", [])
        existing = [r for r in rows
                    if r.get("target", r.get("targetRef", "")).startswith("proxmox-")
                    or r.get("name") == "proxmox-workload-manager"]
        if existing:
            print("already seeded:", json.dumps(existing, indent=2)[:400])
            return
        r = await call("schedule.create", {
            "name": "proxmox-workload-manager",
            "cron": "every 5m",
            "prompt": PROMPT,
            "brain": "api",
            "model": "mistral-large-latest",
            "target": TARGET,
        })
        print("create:", json.dumps(r))
        lst = await call("schedule.list", {})
        print("schedules:", json.dumps(lst.get("result", {}), indent=2)[:600])


asyncio.run(main())
