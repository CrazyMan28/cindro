"""The proxmox_* MCP tools exposed to the scheduled ApiBrain/Mistral loop.

Deliberately NO restart/stop/start tool is registered anywhere in this
module — that is the structural half of the "never restarts a VM on its
own" invariant (the other half is that the local daemon's
proxmox.restart_vm RPC, the only code path that calls qm_reboot, is only
reachable from a UI-triggered request, never from this tool catalog)."""

import json
import time
from typing import Any

from mcp.server.fastmcp import FastMCP

from proxmox_mcp import config, proxmox_ops, state_store, tracker_client
from proxmox_mcp.memory_store import MemoryStore


def register(mcp: FastMCP) -> list[str]:
    memory = MemoryStore(config.MEMORY_DB)

    @mcp.tool()
    async def proxmox_status() -> dict[str, Any]:
        """Current Proxmox host + VM inventory: host cpu/mem headroom, and
        per-VM {vmid,name,status,cores,memory_mb,cpu_pct,mem_pct,hotplug,
        blocklisted,pending_restart,last_action,last_action_at}. Call this
        FIRST each tick to see what (if anything) is congested."""
        cfg = config.settings()
        node = cfg["node"]
        blocklist = state_store.load_blocklist(config.BLOCKLIST_FILE)
        state = state_store.load(config.STATE_FILE)

        host = proxmox_ops.host_status(node)
        node_cores = int(host.get("cpuinfo", {}).get("cpus", 0))
        node_mem_mb = int(host.get("memory", {}).get("total", 0)) // (1024 * 1024)

        vms = []
        for row in proxmox_ops.qm_list():
            vmid = row["vmid"]
            vm_cfg = proxmox_ops.qm_config(vmid)
            cpu_pct = mem_pct = 0.0
            if row["status"] == "running":
                try:
                    live = proxmox_ops.vm_status(node, vmid)
                    cpu_pct = float(live.get("cpu", 0.0)) * 100.0
                    maxmem = float(live.get("maxmem", 0) or 0)
                    if maxmem > 0:
                        mem_pct = float(live.get("mem", 0)) / maxmem * 100.0
                except proxmox_ops.CommandError:
                    pass
            entry = state_store.vm_entry(state, vmid)
            vms.append({
                "vmid": vmid, "name": row["name"], "status": row["status"],
                "cores": vm_cfg["cores"], "memory_mb": vm_cfg["memory"],
                "cpu_pct": round(cpu_pct, 1), "mem_pct": round(mem_pct, 1),
                "hotplug": sorted(vm_cfg["hotplug"]),
                "blocklisted": vmid in blocklist,
                "pending_restart": entry["pending_restart"],
                "last_action": entry["last_action"],
                "last_action_at": entry["last_action_at"],
            })
        return {
            "node": node,
            "host": {"cores": node_cores, "mem_mb": node_mem_mb,
                     "reserve_cores": cfg["reserve_cores"], "reserve_mem_mb": cfg["reserve_mem_mb"]},
            "vms": vms,
            "thresholds": {"cpu_congested_pct": cfg["cpu_congested_pct"],
                          "mem_congested_pct": cfg["mem_congested_pct"]},
        }

    @mcp.tool()
    async def proxmox_tune(vmid: int, cores: int = 0, memory_mb: int = 0,
                           reason: str = "") -> dict[str, Any]:
        """Bump a VM's cores and/or memory_mb (pass 0 to leave a dimension
        alone). Enforced safety rails (may reduce or reject what you asked
        for): not blocklisted, per-VM cooldown, host headroom, per-tick bump
        cap, per-VM max cap. Applies LIVE via hotplug when the VM supports
        it; otherwise the config change is written but only takes effect on
        a restart (pending_restart=true in the result and in proxmox_status
        from then on) — THIS TOOL NEVER RESTARTS, STOPS, OR STARTS A VM.
        Returns {ok, reason, applied_live_cores, applied_live_memory,
        pending_restart, cores, memory_mb}."""
        cfg = config.settings()
        node = cfg["node"]
        blocklist = state_store.load_blocklist(config.BLOCKLIST_FILE)
        state = state_store.load(config.STATE_FILE)
        entry = state_store.vm_entry(state, vmid)

        vm_cfg = proxmox_ops.qm_config(vmid)
        all_vm_configs = [proxmox_ops.qm_config(r["vmid"]) for r in proxmox_ops.qm_list()]
        host = proxmox_ops.host_status(node)
        node_cores = int(host.get("cpuinfo", {}).get("cpus", 0))
        node_mem_mb = int(host.get("memory", {}).get("total", 0)) // (1024 * 1024)
        now_ms = int(time.time() * 1000)

        decision = proxmox_ops.decide_tune(
            vmid=vmid, blocklist=blocklist,
            requested_cores=cores or None, requested_memory_mb=memory_mb or None,
            current_cores=vm_cfg["cores"], current_memory_mb=vm_cfg["memory"],
            hotplug=vm_cfg["hotplug"], all_vm_configs=all_vm_configs,
            node_cores=node_cores, node_mem_mb=node_mem_mb, cfg=cfg,
            last_action_at_ms=entry["last_action_at"], now_ms=now_ms,
        )
        if not decision["ok"]:
            return {"ok": False, "reason": decision["reason"]}

        proxmox_ops.qm_set(vmid, cores=decision["cores"], memory_mb=decision["memory_mb"])

        pending_restart = entry["pending_restart"]
        if decision["cores"] is not None and not decision["applied_live_cores"]:
            pending_restart = True
        if decision["memory_mb"] is not None and not decision["applied_live_memory"]:
            pending_restart = True

        entry["pending_restart"] = pending_restart
        entry["last_action"] = (
            f"tuned cores={decision['cores']} memory_mb={decision['memory_mb']} "
            f"({reason or 'no reason given'})"
        )
        entry["last_action_at"] = now_ms
        state_store.save(config.STATE_FILE, state)

        return {
            "ok": True,
            "cores": decision["cores"],
            "memory_mb": decision["memory_mb"],
            "applied_live_cores": decision["applied_live_cores"],
            "applied_live_memory": decision["applied_live_memory"],
            "pending_restart": pending_restart,
        }

    @mcp.tool()
    async def proxmox_guest_exec(vmid: int, argv: list[str],
                                 timeout_sec: float = 30.0) -> dict[str, Any]:
        """Run a read-only diagnostic command INSIDE vmid's guest OS via the
        QEMU Guest Agent (e.g. argv=["ps","aux","--sort=-%cpu"]) — useful to
        see WHAT is actually consuming resources before deciding how to tune.
        Requires the guest agent running in that VM. Returns {ok, exit_code,
        out, err}. This is diagnostic only — it has no more power to change
        the VM's own OS state than any command you choose to pass, but it is
        NOT a substitute for proxmox_tune/qm; it never touches VM config."""
        return proxmox_ops.guest_exec(vmid, argv, timeout_sec)

    @mcp.tool()
    async def proxmox_get_directives() -> dict[str, Any]:
        """Fetch and CONSUME any pending user directives (free-text
        instructions queued via the local daemon's proxmox.send_directive,
        e.g. "prioritize the CI runners" or "don't touch VM 106 today").
        Call this at the start of every tick, before proxmox_status. Acting
        on a directive still goes through your normal tools (proxmox_tune,
        proxmox.set_blocklist, the daemon RPC a human UI calls) — a directive is guidance, not a bypass of
        the blocklist/cooldown/headroom/hotplug safety rails, and NEVER a
        way to restart a VM (you have no tool for that regardless of what a
        directive asks). Returns {directives: [{text, at}]} — empty once
        drained."""
        directives_file = config.STATE_DIR / "directives.jsonl"
        try:
            lines = directives_file.read_text().splitlines()
        except OSError:
            return {"directives": []}
        directives = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                directives.append(json.loads(line))
            except ValueError:
                continue
        try:
            directives_file.unlink()
        except OSError:
            pass
        return {"directives": directives}

    @mcp.tool()
    async def proxmox_get_blocklist() -> dict[str, Any]:
        """Current auto-tune blocklist: {vmids:[...]}."""
        return {"vmids": sorted(state_store.load_blocklist(config.BLOCKLIST_FILE))}

    @mcp.tool()
    async def proxmox_add_to_blocklist(vmids: list[int], reason: str = "") -> dict[str, Any]:
        """ADD vmids to the auto-tune blocklist (union with whatever's already
        there) — e.g. if you notice a VM that looks risky to keep tuning.
        Deliberately ADDITIVE ONLY: this tool can never remove a VM the user
        (or a previous tick) put on the blocklist — the blocklist is the
        user's safety rail on YOU, and you don't get to unilaterally lift it.
        To remove a VM from the blocklist, that's a human action via the
        desktop/TUI/web UI (proxmox.set_blocklist), not something you call."""
        current = state_store.load_blocklist(config.BLOCKLIST_FILE)
        updated = current | set(vmids)
        state_store.save_blocklist(config.BLOCKLIST_FILE, sorted(updated))
        return {"ok": True, "vmids": sorted(state_store.load_blocklist(config.BLOCKLIST_FILE))}

    @mcp.tool()
    async def remember(text: str, tags: str = "") -> dict[str, Any]:
        """Log a decision/observation to this agent's own durable memory
        (survives the user's laptop being off). Call this after every
        proxmox_tune, and whenever you skip a congested VM, with your
        reasoning."""
        rid = memory.remember(text, tags)
        return {"id": rid}

    @mcp.tool()
    async def recall(query: str = "", limit: int = 20) -> dict[str, Any]:
        """Search this agent's own memory (full-text if `query` given, else
        most recent first)."""
        return {"memories": memory.recall(query, limit)}

    @mcp.tool()
    async def project_tracker_checkin(status: str = "idle") -> dict[str, Any]:
        """Check in with Project Tracker so the user's local Jarvis can see
        this agent is alive. status: idle|working|paused. Call once per
        tick, at the start."""
        cfg = config.settings()
        token = config.project_tracker_token()
        name = cfg["project_tracker_agent_name"]
        url = cfg["project_tracker_url"]
        try:
            tracker_client.agent_checkin(url, token, name, cfg["project_tracker_project_id"])
            return tracker_client.agent_update_status(url, token, name, status)
        except Exception as exc:  # noqa: BLE001 - report, don't crash the tick
            return {"ok": False, "error": str(exc)}

    @mcp.tool()
    async def project_tracker_report(summary: str) -> dict[str, Any]:
        """Post a short notable-events summary to Project Tracker (only call
        this when you actually did something worth surfacing this tick)."""
        cfg = config.settings()
        token = config.project_tracker_token()
        name = cfg["project_tracker_agent_name"]
        url = cfg["project_tracker_url"]
        try:
            return tracker_client.agent_update_status(url, token, name, f"working: {summary}")
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    return [
        "proxmox_status", "proxmox_tune", "proxmox_guest_exec", "proxmox_get_directives",
        "proxmox_get_blocklist", "proxmox_add_to_blocklist",
        "remember", "recall", "project_tracker_checkin", "project_tracker_report",
    ]
