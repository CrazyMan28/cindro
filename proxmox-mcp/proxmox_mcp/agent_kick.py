"""`proxmox-agent-kick` — fire the workload-manager schedule NOW.

Called (detached, best-effort) by the daemon's proxmox.ask_agent RPC right
after it appends a task/question to agent_tasks.jsonl, so the user's "ask
the pve agent something" gets processed in seconds instead of waiting for
the next 5-minute tick. If this fails for any reason the ask still lands —
the agent consumes the mailbox at the start of every tick regardless."""

from __future__ import annotations

import asyncio
import json
import sys

from proxmox_mcp import jarvisd_client


async def kick() -> dict:
    try:
        (lst,) = await jarvisd_client.call_many([("schedule.list", {})])
    except Exception as exc:  # noqa: BLE001 - report as data, exit code carries it
        return {"ok": False, "error": f"control connect/list failed: {exc}"}
    rows = lst.get("result", {}).get("schedules", [])
    row = jarvisd_client.find_proxmox_schedule(rows)
    if not row:
        return {"ok": False, "error": "no proxmox-* schedule row found (run seed_schedule.py)"}
    try:
        (resp,) = await jarvisd_client.call_many(
            [("schedule.run_now", {"id": row.get("id", "")})])
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"schedule.run_now failed: {exc}"}
    if resp.get("error"):
        return {"ok": False, "error": str(resp["error"])}
    return {"ok": True, "schedule_id": row.get("id", ""),
            "result": resp.get("result", {})}


def main() -> None:
    result = asyncio.run(kick())
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
