"""The proxmox_* MCP tools exposed to the scheduled ApiBrain/Mistral loop.

Deliberately NO restart/stop/start tool is registered anywhere in this
module — that is the structural half of the "never restarts a VM on its
own" invariant (the other half is that the local daemon's
proxmox.restart_vm RPC, the only code path that calls qm_reboot, is only
reachable from a UI-triggered request, never from this tool catalog).
proxmox_guest_service is NOT an exception to that: it can start/restart a
service INSIDE a guest (closed verb set, validated name, no stop verb) but
has no path to VM power whatsoever."""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from proxmox_mcp import (config, mailbox, pinged_store, profile_store, proxmox_ops,
                         scout, scout_runner, scout_status, state_store,
                         tracker_client)
from proxmox_mcp.memory_store import MemoryStore

_REPLIED_TASK_TTL_MS = 24 * 3600 * 1000


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

    # --- scouting + JARVIS.md profiles ------------------------------------

    @mcp.tool()
    async def proxmox_scout(vmids: list[int] = [], full: bool = False) -> dict[str, Any]:
        """Scan what's RUNNING INSIDE VMs/CTs (agentless: QEMU guest agent /
        pct exec) and refresh their JARVIS.md profiles. 1-3 vmids: runs
        synchronously and returns the results. full=True or no vmids: the
        whole fleet is scanned by a detached runner — returns immediately,
        poll proxmox_scout_status for progress. Re-scout a VM when its
        profile is stale (proxmox_list_vm_profiles) or its workload no
        longer matches what proxmox_status shows."""
        if not full and vmids and len(vmids) <= 3:
            return scout_runner.run_scout([int(v) for v in vmids], "agent")
        exe = Path(sys.executable).parent / "proxmox-scout"
        if not exe.exists():
            which = shutil.which("proxmox-scout")
            if not which:
                return {"ok": False, "error": "proxmox-scout entry point not found"}
            exe = Path(which)
        args = [str(exe), "--trigger", "agent"]
        if vmids:
            args += ["--vmids", ",".join(str(int(v)) for v in vmids)]
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        return {"ok": True, "detached": True,
                "note": "fleet scout started; poll proxmox_scout_status"}

    @mcp.tool()
    async def proxmox_scout_status() -> dict[str, Any]:
        """Progress of the current/last scout run: {state: idle|running|done|
        error, total, done, current_vmid, results:[{vmid,name,ok,summary}]}."""
        return {"scout": scout_status.read(config.SCOUT_STATUS_FILE)}

    @mcp.tool()
    async def proxmox_get_vm_profile(vmid: int) -> dict[str, Any]:
        """This VM/CT's JARVIS.md profile — its Purpose, the user's
        Preferences, and what the scout Observed running inside. READ THIS
        BEFORE TUNING OR OTHERWISE WORKING ON A VM and respect Purpose/
        Preferences in your decision."""
        text = profile_store.load(config.PROFILES_DIR, int(vmid))
        return {"vmid": int(vmid), "exists": bool(text), "profile": text,
                "meta": profile_store.read_meta(text)}

    @mcp.tool()
    async def proxmox_update_vm_profile(vmid: int, section: str, text: str) -> dict[str, Any]:
        """Write a USER-owned profile section: Purpose | Preferences | Notes.
        Use it to record the user's interview answers verbatim (Purpose/
        Preferences) or your own durable observations (Notes). The Observed
        section is scout-owned and refused here."""
        return profile_store.set_user_section(config.PROFILES_DIR, int(vmid),
                                              section, text, int(time.time() * 1000))

    @mcp.tool()
    async def proxmox_list_vm_profiles() -> dict[str, Any]:
        """All profiles with staleness + interview state:
        [{vmid,name,kind,observed_at,has_purpose,stale}]. A running guest
        with NO profile, or stale=true, is a re-scout candidate; a profile
        with has_purpose=false is an interview candidate (proxmox_ask_user)."""
        cfg = config.settings()
        return {"profiles": profile_store.list_profiles(
            config.PROFILES_DIR, int(time.time() * 1000),
            int(cfg["profile_stale_days"]))}

    # --- interview questions (agent -> user, non-blocking) -----------------

    @mcp.tool()
    async def proxmox_ask_user(question: str, vmid: int = 0,
                               options: list[str] = []) -> dict[str, Any]:
        """Queue a question for the user (e.g. "What is VM 104 (ci-runner)
        for?" or "How should I handle X?"). NON-BLOCKING: ask, then move on
        with your tick — the user answers from the Outpost page and you
        collect it via proxmox_get_answers next tick. The queue is small and
        deduped; when it's full, wait for answers instead of re-asking."""
        cfg = config.settings()
        mb = mailbox.questions_mailbox(config.STATE_DIR)
        return mb.add_request(
            {"vmid": int(vmid), "question": (question or "").strip(),
             "options": [str(o) for o in options]},
            int(time.time() * 1000), id_suffix=str(int(vmid)),
            max_pending=int(cfg["max_pending_questions"]),
            dedupe_fields=("vmid", "question"))

    @mcp.tool()
    async def proxmox_get_answers() -> dict[str, Any]:
        """Collect (and consume) the user's answers to your questions. CALL
        AT THE START OF EVERY TICK. For each answer: write it into the VM's
        profile (proxmox_update_vm_profile, section Purpose or Preferences)
        and remember it. Returns {answers:[{qid,vmid,question,answer,...}]}."""
        return {"answers": mailbox.questions_mailbox(config.STATE_DIR).consume()}

    # --- tasks (user's main Jarvis -> this agent, with replies) ------------

    @mcp.tool()
    async def proxmox_get_tasks() -> dict[str, Any]:
        """Pending asks/tasks from the user's main Jarvis (via
        proxmox.ask_agent). CALL AT THE START OF EVERY TICK — a run_now kick
        usually means one of these is waiting. Answer questions / do tasks
        (normal safety rails apply), then proxmox_reply(rid, ...) EACH one —
        the user's chat is polling for that reply."""
        mb = mailbox.tasks_mailbox(config.STATE_DIR)
        now_ms = int(time.time() * 1000)
        mb.prune_replied(now_ms, _REPLIED_TASK_TTL_MS)
        return {"tasks": mb.pending()}

    @mcp.tool()
    async def proxmox_reply(rid: str, text: str) -> dict[str, Any]:
        """Reply to one task/ask from proxmox_get_tasks. Keep it short and
        concrete — this lands directly in the user's chat."""
        mb = mailbox.tasks_mailbox(config.STATE_DIR)
        if not mb.has_request(rid):
            return {"ok": False, "error": f"no task with rid {rid!r}"}
        return mb.add_reply(rid, {"reply": (text or "").strip()},
                            int(time.time() * 1000))

    # --- pinged watch rules -------------------------------------------------

    @mcp.tool()
    async def proxmox_get_due_pinged() -> dict[str, Any]:
        """Watch rules to handle THIS tick: every enabled condition rule
        (judge its free-text condition against proxmox_status / the VM's
        profile / a quick proxmox_guest_exec — investigate at most 2 deeply
        per tick) plus any schedule rule whose time has come today. For each
        rule you handle, act per its action text if it fired, then ALWAYS
        proxmox_record_pinged — recording not-fired is what keeps a due
        schedule rule from re-firing all day and shows the user liveness."""
        return {"rules": pinged_store.due_rules(config.PINGED_FILE,
                                                int(time.time() * 1000))}

    @mcp.tool()
    async def proxmox_record_pinged(rule_id: str, fired: bool,
                                    result: str = "") -> dict[str, Any]:
        """Record the outcome of handling a pinged rule. fired=True appends
        a visible event (the user gets an inbox ping) — set it only when the
        condition actually held / the scheduled check found something worth
        saying; `result` is the one-liner the user reads."""
        return pinged_store.record(config.PINGED_FILE, config.PINGED_EVENTS_FILE,
                                   rule_id, bool(fired), result,
                                   int(time.time() * 1000))

    # --- sanctioned in-guest service control --------------------------------

    @mcp.tool()
    async def proxmox_guest_service(vmid: int, service: str, verb: str) -> dict[str, Any]:
        """start | restart | status a service INSIDE a guest (systemctl /
        PowerShell via the guest agent, pct exec for CTs). This is your ONLY
        way to fix things in-guest: heal a stuck service per a pinged rule
        or user task. Deliberately NO stop verb and NO VM power — heal,
        don't kill. Refused for blocklisted VMs (except status)."""
        vmid = int(vmid)
        blocklist = state_store.load_blocklist(config.BLOCKLIST_FILE)
        kind, os_family = "qemu", ""
        meta = profile_store.read_meta(profile_store.load(config.PROFILES_DIR, vmid))
        if meta:
            kind = meta.get("kind", "qemu")
            os_family = meta.get("os_family") or ""
        else:
            try:
                if vmid not in {r["vmid"] for r in proxmox_ops.qm_list()} and \
                        vmid in {r["vmid"] for r in scout.pct_list()}:
                    kind = "lxc"
            except proxmox_ops.CommandError:
                pass
        if kind == "lxc":
            os_family = "linux"
        elif not os_family:
            os_family = scout.guest_os_family(vmid)
        return scout.guest_service(vmid, service, verb, kind=kind,
                                   os_family=os_family, blocklist=blocklist)

    return [
        "proxmox_status", "proxmox_tune", "proxmox_guest_exec", "proxmox_get_directives",
        "proxmox_get_blocklist", "proxmox_add_to_blocklist",
        "remember", "recall", "project_tracker_checkin", "project_tracker_report",
        "proxmox_scout", "proxmox_scout_status", "proxmox_get_vm_profile",
        "proxmox_update_vm_profile", "proxmox_list_vm_profiles",
        "proxmox_ask_user", "proxmox_get_answers",
        "proxmox_get_tasks", "proxmox_reply",
        "proxmox_get_due_pinged", "proxmox_record_pinged",
        "proxmox_guest_service",
    ]
