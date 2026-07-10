"""Tiny client for the CO-LOCATED jarvisd's loopback control WebSocket.

jarvisd's control API is loopback-only by design, which is exactly why the
schedule seed (packaging/seed_schedule.py) and the run-now kick
(proxmox-agent-kick) must run ON the Proxmox host — this module is their
shared plumbing. The control token lives where the installer put it:
$PROXMOX_AGENT_CONFIG_DIR/jarvisd/control_token."""

from __future__ import annotations

import asyncio
import json

from proxmox_mcp import config

CONTROL_PORT = 8795


def control_token() -> str:
    return (config.CONFIG_DIR / "jarvisd" / "control_token").read_text().strip()


def control_url() -> str:
    return f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={control_token()}"


async def call_many(methods: list[tuple[str, dict]]) -> list[dict]:
    """Open one control connection, run the calls in order, return the
    response frames. Import websockets lazily so merely importing this
    module never requires it (only the two CLIs do)."""
    import websockets  # deferred: only the seed/kick CLIs need it

    results = []
    async with websockets.connect(control_url(), max_size=16 * 1024 * 1024) as ws:
        rid = 0
        for method, params in methods:
            rid += 1
            await ws.send(json.dumps({"v": 1, "id": rid, "method": method,
                                      "params": params}))
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                if frame.get("id") == rid:
                    results.append(frame)
                    break
    return results


def find_proxmox_schedule(schedules: list[dict]) -> dict | None:
    """The workload-manager row: target(prefix proxmox-) or the seeded name."""
    for row in schedules:
        target = row.get("target", row.get("targetRef", "")) or ""
        if target.startswith("proxmox-") or row.get("name") == "proxmox-workload-manager":
            return row
    return None
