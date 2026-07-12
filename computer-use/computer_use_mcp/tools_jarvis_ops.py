"""Jarvis self-management MCP tools — schedule, memory, skills.

Exposed ON the computer-use engine (the SAME isolated MCP server the co-work brain
already drives for the hands) so the model can schedule its own tasks, write its
own long-term memory, and author its own skills — all through MCP, with NO access
to the user's other MCP servers. Each tool proxies to jarvisd over the Contract-A
control WebSocket (daemon_client). Failures return a JSON {"error": ...}.
"""

from __future__ import annotations

import json
import os

from pathlib import Path

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client, project_tracker_client


def _project_tracker_url() -> str:
    """Project Tracker MCP base URL. JARVIS_PROJECT_TRACKER_URL wins; else the
    same tailnet default proxmox_agent_checkin has always used — matches the
    package's other overridable-with-a-zero-config-default conventions
    (JARVIS_WEBHOOK_BASE, JARVIS_CONTROL_HOST, ...)."""
    return os.environ.get("JARVIS_PROJECT_TRACKER_URL") or "http://100.114.201.41:8790/mcp"


def _project_tracker_bearer() -> str:
    """~/.project-tracker/config.yaml -> bearer_token (best-effort)."""
    try:
        text = (Path.home() / ".project-tracker" / "config.yaml").read_text()
    except OSError:
        return ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("bearer_token"):
            continue
        _, _, val = line.partition(":")
        return val.strip().strip("'\"")
    return ""


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def remember(text: str, tags: list[str] | None = None, agent: str = "") -> str:
    """Save a fact to Cindro's long-term memory so it persists across sessions
    (preferences, project facts, decisions). Pass `agent` (an agent name or a
    paired-machine id, e.g. "ci-runner-104") to scope the fact to THAT agent so
    it is only recalled with recall(agent=...); omit it for global memory.
    Returns {id}."""
    try:
        params: dict = {"text": text, "tags": tags or []}
        if agent:
            params["agent"] = agent
        return json.dumps(daemon_client.call("memory.add", params))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def recall(query: str = "", agent: str = "", limit: int = 20) -> str:
    """Full-text search Cindro's long-term memory for relevant facts. Pass
    `agent` (an agent name / paired-machine id) to recall ONLY that agent's
    scoped memories (empty `query` + `agent` returns that agent's recent
    state — the condition-polling pattern). Omit `agent` for global recall."""
    try:
        params: dict = {"q": query, "limit": limit}
        if agent:
            params["agent"] = agent
        return json.dumps(daemon_client.call("memory.search", params))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_check_status(machine: str) -> str:
    """VM inventory + congestion for an enrolled Proxmox workload-manager
    agent (host/vm cpu/mem, cores, pending_restart, blocklisted). Use this
    when the user asks something like "check up on proxmox" — pair with
    proxmox_get_report for what the agent has actually DONE recently.
    `machine` is the paired Outpost machine name/id running the agent."""
    try:
        return json.dumps(daemon_client.call("proxmox.status", {"machine": machine}))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_get_report(machine: str) -> str:
    """Recent decision history from an enrolled Proxmox workload-manager
    agent — what it tuned, what it skipped and why, sourced from its own
    durable memory (survives the agent's host being checked while your
    laptop was off). Pair with proxmox_check_status for current state."""
    try:
        return json.dumps(daemon_client.call("proxmox.report", {"machine": machine}))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_give_direction(machine: str, text: str) -> str:
    """Queue a free-text instruction for an enrolled Proxmox workload-manager
    agent to read and act on at the START of its next tick (e.g. "prioritize
    the CI runners today", "go easy on VM 106 this week"). This is guidance,
    NOT a bypass: the agent still enforces its own blocklist/cooldown/
    headroom/hotplug rules and still has no tool that can restart a VM,
    regardless of what the directive asks for."""
    try:
        return json.dumps(daemon_client.call(
            "proxmox.send_directive", {"machine": machine, "text": text}))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_agent_checkin() -> str:
    """Check whether an enrolled Proxmox workload-manager agent is alive, via
    Project Tracker's agent_list_active (the same directory any other active
    Cindro agent shows up in) — filtered to agent names starting with
    "proxmox-". Returns {agents:[{name,status,last_seen,...}]} or
    {"error":...} if Project Tracker is unreachable or no token is configured."""
    try:
        result = project_tracker_client.agent_list_active(
            _project_tracker_url(), _project_tracker_bearer())
        agents = [a for a in result.get("agents", [])
                 if str(a.get("name", "")).startswith("proxmox-")]
        return json.dumps({"agents": agents})
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_scout(machine: str, vmids: list[int] | None = None) -> str:
    """Scan what's running INSIDE the VMs/containers on a Proxmox host —
    agentless (QEMU guest agent / pct exec), no per-VM install. Use when the
    user says "scan my VMs" / "what's running on pve". Starts a detached
    fleet scan (or just `vmids` when given) that refreshes each guest's
    JARVIS.md profile; poll proxmox_scout_status for live progress and
    per-VM summaries. The scan also shows live on the Outpost page."""
    try:
        params: dict = {"machine": machine}
        if vmids:
            params["vmids"] = [int(v) for v in vmids]
        return json.dumps(daemon_client.call("proxmox.scout", params, timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_scout_status(machine: str) -> str:
    """Progress of the current/last VM scout on a Proxmox host:
    {scout:{state, done, total, current_vmid, results:[{vmid,name,ok,
    summary}]}}. Poll this after proxmox_scout until state is done, then
    relay the per-VM summaries to the user."""
    try:
        return json.dumps(daemon_client.call("proxmox.scout_status",
                                             {"machine": machine}, timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_vm_profile(machine: str, vmid: int) -> str:
    """Read one VM/CT's JARVIS.md profile from a Proxmox host — its Purpose,
    the user's Preferences, and what the scout Observed running inside
    (services, ports, containers, disk, top processes). The per-VM answer to
    "what is VM 104 and what's on it?"."""
    try:
        return json.dumps(daemon_client.call(
            "proxmox.vm_profile", {"machine": machine, "vmid": int(vmid)}, timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_list_questions(machine: str) -> str:
    """Pending interview questions the headless Proxmox agent is asking the
    user (e.g. "What is VM 104 for?"). Returns {questions:[{qid,vmid,
    question,options}]}. Relay them to the user and send each answer back
    with proxmox_answer_question."""
    try:
        return json.dumps(daemon_client.call("proxmox.questions",
                                             {"machine": machine}, timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_answer_question(machine: str, qid: str, answer: str) -> str:
    """Answer one of the headless Proxmox agent's pending questions (qid from
    proxmox_list_questions). The agent consumes the answer on its next tick
    and writes it into that VM's JARVIS.md profile."""
    try:
        return json.dumps(daemon_client.call(
            "proxmox.answer", {"machine": machine, "qid": qid, "answer": answer},
            timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_ask_agent(machine: str, text: str, kind: str = "ask",
                      wait_sec: int = 90) -> str:
    """Talk DIRECTLY to the always-on Proxmox workload-manager agent: ask it
    a question ("what's hogging CPU right now?") or hand it a task ("check
    the runner service on VM 104 and fix it if it's stuck"). kind: ask|task.
    The daemon queues it AND kicks the agent to run immediately, then this
    call polls for the reply up to wait_sec. On timeout you get
    {pending:true, rid} — the reply lands within ~5 minutes; re-check by
    calling this tool's sibling RPC later or just tell the user it's in
    progress. The agent keeps ALL its safety rails for tasks (blocklist,
    cooldown, no VM restarts — it can only heal services inside guests)."""
    import time as _time
    try:
        asked = daemon_client.call(
            "proxmox.ask_agent", {"machine": machine, "text": text, "kind": kind},
            timeout=30)
        rid = asked.get("rid", "")
        if not rid:
            return json.dumps(asked)
        deadline = _time.time() + max(5, min(int(wait_sec or 90), 600))
        while _time.time() < deadline:
            _time.sleep(5)
            reply = daemon_client.call(
                "proxmox.agent_reply", {"machine": machine, "rid": rid}, timeout=30)
            if not reply.get("pending", True):
                return json.dumps({"ok": True, "rid": rid,
                                   "reply": reply.get("reply", ""),
                                   "replied_at": reply.get("replied_at")})
        return json.dumps({"ok": True, "pending": True, "rid": rid,
                           "note": "no reply yet — the agent picks tasks up within "
                                   "~5 minutes; check back or tell the user it's queued"})
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_pinged_list(machine: str) -> str:
    """List the Pinged watch rules on a Proxmox host (condition rules the
    agent judges every tick + daily schedule rules) and the recent fired
    events. Returns {rules:[...], events:[...]}."""
    try:
        return json.dumps(daemon_client.call("proxmox.pinged_list",
                                             {"machine": machine}, timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_pinged_add(machine: str, name: str, action: str, vmid: int = 0,
                       condition: str = "", time_of_day: str = "") -> str:
    """Create a Pinged watch rule for the headless Proxmox agent. Give
    EXACTLY ONE trigger: `condition` (free text the agent judges each tick,
    e.g. "the CI runner on VM 104 looks stuck") OR `time_of_day` ("HH:MM"
    daily). `action` says what to do when it fires ("check up on it and fix
    it, don't break anything"). vmid=0 means the whole fleet. Fired rules
    ping the user's inbox with what was done."""
    try:
        return json.dumps(daemon_client.call("proxmox.pinged_add", {
            "machine": machine, "name": name, "action": action,
            "vmid": int(vmid), "condition": condition, "time": time_of_day,
        }, timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def proxmox_pinged_remove(machine: str, rule_id: str) -> str:
    """Remove a Pinged watch rule by id (from proxmox_pinged_list)."""
    try:
        return json.dumps(daemon_client.call(
            "proxmox.pinged_remove", {"machine": machine, "rule_id": rule_id},
            timeout=30))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def register(mcp: FastMCP) -> None:
    # ---- SEND A FILE TO THE USER -------------------------------------------
    @mcp.tool()
    def send_file(path: str = "", b64: str = "", name: str = "") -> str:
        """Send a file from THIS computer straight into the user's Cindro chat
        (phone + desktop) so they can view it and download it with one tap.

        Use this WHENEVER the user asks you to send / share / "give me" / download a
        file, image, photo, slide, screenshot, PDF, log, zip — ANYTHING. Provide an
        on-disk `path` (a full path is fine; the daemon reads it) OR base64 `b64`,
        plus a `name` with the correct extension. Images render inline; any other
        type shows a Download button in the app.

        DO NOT upload to Google Drive, paste a local file path, or return a markdown
        image link — none of those work on the user's phone. Always use this tool.
        Returns the delivered file descriptor."""
        try:
            if not path and not b64:
                return _err(ValueError("provide `path` or `b64`"))
            params: dict = {}
            if path:
                params["path"] = path
            if b64:
                params["b64"] = b64
            if name:
                params["name"] = name
            # Scope the delivery to this session's chat when the engine knows it.
            sid = os.environ.get("JARVIS_AGENT_SESSION")
            if sid:
                params["session_id"] = sid
            return json.dumps(daemon_client.call("file.push", params, timeout=60))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- SCHEDULE -----------------------------------------------------------
    @mcp.tool()
    def schedule_task(prompt: str, when: str = "", cron: str = "",
                      name: str = "", brain: str = "", model: str = "") -> str:
        """Schedule Cindro to run a task LATER / on a cadence (self-waking). `when`
        accepts 'every 30m', 'every 2h', 'at 09:00', or a 5-field cron; `cron` is an
        explicit 5-field cron. The task fires as a new Cindro session with `prompt`.
        Use this to set reminders, recurring jobs, or follow-ups. Returns {id}."""
        try:
            return json.dumps(daemon_client.call("schedule.create", {
                "name": name or prompt[:40], "when": when, "cron": cron,
                "prompt": prompt, "brain": brain, "model": model, "enabled": True,
            }))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def list_schedules() -> str:
        """List Cindro's scheduled tasks (id, name, cadence, next run)."""
        try:
            return json.dumps(daemon_client.call("schedule.list"))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def cancel_schedule(id: str) -> str:
        """Remove a scheduled task by id (from list_schedules)."""
        try:
            return json.dumps(daemon_client.call("schedule.remove", {"id": id}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- MEMORY -------------------------------------------------------------
    mcp.tool()(remember)
    mcp.tool()(recall)
    mcp.tool()(proxmox_agent_checkin)
    mcp.tool()(proxmox_check_status)
    mcp.tool()(proxmox_get_report)
    mcp.tool()(proxmox_give_direction)
    mcp.tool()(proxmox_scout)
    mcp.tool()(proxmox_scout_status)
    mcp.tool()(proxmox_vm_profile)
    mcp.tool()(proxmox_list_questions)
    mcp.tool()(proxmox_answer_question)
    mcp.tool()(proxmox_ask_agent)
    mcp.tool()(proxmox_pinged_list)
    mcp.tool()(proxmox_pinged_add)
    mcp.tool()(proxmox_pinged_remove)

    @mcp.tool()
    def session_search(query: str, limit: int = 20, context_window: int = 2,
                       session_id: str = "") -> str:
        """Full-text search across ALL past session transcripts and tool
        outputs (not just saved memories). Use when the user asks about
        something done or discussed in an earlier conversation ("what did we
        do last Tuesday", "find that pg_dump command"). Returns ranked hits
        with +/- context_window surrounding events each so you can read the
        exchange around the match. Pass session_id to search one session."""
        try:
            params: dict = {"q": query, "limit": limit,
                            "context_window": context_window}
            if session_id:
                params["session_id"] = session_id
            return json.dumps(daemon_client.call("session.search", params))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def forget(id: str) -> str:
        """Delete a memory by id (from recall / list_memories)."""
        try:
            return json.dumps(daemon_client.call("memory.remove", {"id": id}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def list_memories(limit: int = 50) -> str:
        """List ALL of Cindro's long-term memories (newest first: id, text, tags)."""
        try:
            return json.dumps(daemon_client.call("memory.list", {"limit": limit}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def edit_memory(id: str, text: str, tags: list[str] | None = None) -> str:
        """Replace the text (and tags) of an existing memory by id. Keep it a concise
        fact — oversized writes are rejected."""
        try:
            return json.dumps(daemon_client.call(
                "memory.edit", {"id": id, "text": text, "tags": tags or []}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- SKILLS (self-authoring) -------------------------------------------
    @mcp.tool()
    def create_skill(name: str, description: str, body: str,
                     group: str = "", tags: list[str] | None = None) -> str:
        """Author a NEW reusable skill (a Markdown procedure Cindro can invoke later
        with /name). Use this to teach yourself a repeatable task once and keep it.
        `body` is the skill's Markdown content. Returns the created skill."""
        try:
            return json.dumps(daemon_client.call("skills.create", {
                "name": name, "description": description, "body": body,
                "group": group, "tags": tags or [],
            }))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def list_skills() -> str:
        """List Cindro's self-authored + bundled skills (name, description)."""
        try:
            return json.dumps(daemon_client.call("skills.list"))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def skill_load(name: str, args: str = "") -> str:
        """LOAD a saved skill by name and get its full content to follow. Call this
        whenever the user invokes a skill (a message like "/skill-name") or asks you
        to use one — it returns the skill's instructions; then read them in full and
        actually apply/do what they say. `args` passes any arguments the skill uses."""
        try:
            return json.dumps(daemon_client.call("skills.invoke",
                                                 {"name": name, "args": args}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def get_skill(name: str) -> str:
        """Read one skill's full Markdown body + metadata by name (to edit/inspect it)."""
        try:
            return json.dumps(daemon_client.call("skills.get", {"name": name}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def pin_skill(name: str, pinned: bool = True) -> str:
        """Pin (or unpin) a skill. Pinned skills are exempt from the automatic
        stale-skill archive sweep — pin anything the user wants kept forever."""
        try:
            return json.dumps(daemon_client.call("skills.pin",
                                                 {"name": name, "pinned": pinned}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def list_archived_skills() -> str:
        """List skills that were auto-archived after long inactivity (they are
        never deleted). Restore one with unarchive_skill."""
        try:
            return json.dumps(daemon_client.call("skills.list_archived"))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def unarchive_skill(name: str) -> str:
        """Restore an archived skill back into the live library (and the CLI
        mirrors) so it can be invoked again."""
        try:
            return json.dumps(daemon_client.call("skills.unarchive", {"name": name}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def set_goal(goals: str, session_id: str = "") -> str:
        """Set (or clear with "") THIS session's persistent goal. While a goal
        is set and the user enabled auto-continue, Cindro re-wakes the session
        after each turn until you report the goal complete and clear it. Use
        for long multi-step objectives ("migrate all 12 services"); clear it
        the moment the objective is done."""
        try:
            sid = session_id or os.environ.get("JARVIS_AGENT_SESSION", "")
            if not sid:
                return _err(RuntimeError("no session id (pass session_id)"))
            return json.dumps(daemon_client.call(
                "session.set_goals", {"session_id": sid, "goals": goals}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- WORK QUEUE (durable kanban backlog) ---------------------------------
    @mcp.tool()
    def queue_add(prompt: str, title: str = "", priority: int = 0,
                  brain: str = "", model: str = "", tags: str = "") -> str:
        """Enqueue a DURABLE work item on Cindro's kanban backlog. Unlike
        agent_start (fire-and-wait), queued items survive restarts: the daemon
        runs them one after another in their own sessions and stores each
        result. Use for big multi-part jobs ("do these 10 things overnight") —
        enqueue each part, then check queue_list later. Higher priority runs
        first."""
        try:
            params = {"prompt": prompt, "title": title, "priority": priority,
                      "brain": brain, "model": model, "tags": tags}
            return json.dumps(daemon_client.call("queue.add", params))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def queue_list(status: str = "") -> str:
        """List work-queue items (status filter: pending|running|done|error|
        cancelled; empty = all). Each item carries its result summary once
        finished."""
        try:
            return json.dumps(daemon_client.call("queue.list", {"status": status}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def queue_cancel(id: str) -> str:
        """Cancel a pending or running work-queue item (a running worker
        session is stopped)."""
        try:
            return json.dumps(daemon_client.call("queue.cancel", {"id": id}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def edit_skill(name: str, description: str, body: str,
                   group: str = "", tags: list[str] | None = None) -> str:
        """Edit an existing skill — re-create it with the same name to overwrite its
        body/description (create_skill on an existing name = edit)."""
        try:
            return json.dumps(daemon_client.call("skills.create", {
                "name": name, "description": description, "body": body,
                "group": group, "tags": tags or [],
            }))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def remove_skill(name: str) -> str:
        """Delete a self-authored skill by name."""
        try:
            return json.dumps(daemon_client.call("skills.remove", {"name": name}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- AGENTS (subagents — define + dispatch your own helpers) -------------
    @mcp.tool()
    def agent_create(name: str, description: str, when_to_use: str,
                     system_prompt: str, brain: str = "", model: str = "",
                     profile: str = "", tools: list[str] | None = None,
                     color: str = "") -> str:
        """Define a NEW custom agent (a reusable specialist you can dispatch tasks
        to). Give it a `name`, a `description` of what it does, a `when_to_use`
        line describing WHEN to call it, and a `system_prompt` (its role/behavior).
        Optionally pin a `brain` (codex|claude|api), `model`, `profile`
        (coder|coworker), an allowed-`tools` hint, and a UI `color`. Re-creating
        with the same name OVERWRITES (= edit). Returns the created agent.

        Build agents proactively: when you find yourself doing a distinct kind of
        sub-task repeatedly (research, code review, summarizing), make an agent for
        it, then dispatch to it with agent_start."""
        try:
            return json.dumps(daemon_client.call("agents.create", {
                "name": name, "description": description,
                "when_to_use": when_to_use, "system_prompt": system_prompt,
                "brain": brain, "model": model, "profile": profile,
                "tools": tools or [], "color": color,
            }))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_list() -> str:
        """List your custom agents WITH each one's `when_to_use` — read this to
        decide which agent (if any) fits the sub-task at hand before dispatching."""
        try:
            return json.dumps(daemon_client.call("agents.list"))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_get(name: str) -> str:
        """Read one agent's full definition (system prompt + metadata) by name."""
        try:
            return json.dumps(daemon_client.call("agents.get", {"name": name}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_remove(name: str) -> str:
        """Delete a custom agent definition by name."""
        try:
            return json.dumps(daemon_client.call("agents.remove", {"name": name}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_start(name: str, task: str, brain: str = "", model: str = "",
                    system_prompt: str = "") -> str:
        """DISPATCH a sub-task to a SUBAGENT — spawns a child session that runs the
        `task` on its own and reports back (shows under this session in the
        sub-agent tree). Returns {session_id} — pass it to agent_stop to cancel.

        If the task is something YOU can do directly with a single tool call —
        run a command on a paired machine (outpost_exec), take a screenshot
        (outpost_screenshot), save or look up a fact (remember/recall), check a
        schedule, etc. — just call that tool yourself. Do NOT spin up a subagent
        for work you could do in one or two tool calls; that only adds latency
        and an extra point of failure. Reserve agent_start for work that's
        genuinely separable: a distinct kind of sub-task you'll repeat (see
        agent_create), something you want running in parallel while you keep
        working, or a long enough job that you don't want to block your own
        turn on it.

        `name` can be one of your DEFINED agents (see agent_list) OR any new label
        for an AD-HOC subagent (you do NOT need to pre-create an agent to delegate
        genuinely separable work). You may choose the `brain` (codex|claude|api)
        and `model` it runs on, and give it a one-off `system_prompt` (its
        role/instructions for the task). Don't just narrate that you delegated;
        call this tool. A stored agent's def fills any of these
        you leave blank."""
        try:
            params = {"agent": name, "task": task}
            if brain:
                params["brain"] = brain
            if model:
                params["model"] = model
            if system_prompt:
                params["system_prompt"] = system_prompt
            parent = os.environ.get("JARVIS_AGENT_SESSION")
            if parent:
                params["parent_session_id"] = parent
            return json.dumps(daemon_client.call("agents.dispatch", params,
                                                 timeout=30))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_status() -> str:
        """List the agent (child) sessions and whether each is still running — use
        this to see what you've dispatched and what has finished."""
        try:
            return json.dumps(daemon_client.call("agents.running"))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_result(session_id: str) -> str:
        """Get a finished subagent's RESULT — its summary, status, and whether it's
        still running — by the session_id agent_start returned. You're also woken
        automatically with this summary the moment a subagent finishes, but call this
        any time to (re)check what a subagent produced before continuing."""
        try:
            return json.dumps(daemon_client.call("agents.result",
                                                 {"session_id": session_id}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_wait(session_id: str, timeout_sec: int = 7200) -> str:
        """WAIT (block) until a subagent finishes, then return its summary + status.
        Returns the INSTANT the subagent is done (it checks the session STATE, not
        whether a brain object lingers), so for quick tasks it comes back in a few
        seconds. Call agent_start(...) then agent_wait(session_id) to get the result
        in-line. Default wait up to 2 HOURS (timeout_sec); on timeout it returns the
        latest status with timed_out=true (then just call agent_result, or you'll be
        auto-pinged when it finishes)."""
        import time
        try:
            end = time.time() + max(5, min(int(timeout_sec or 7200), 14400))
            last: dict = {}
            while time.time() < end:
                last = daemon_client.call("agents.result", {"session_id": session_id})
                if not last.get("running", False):
                    return json.dumps(last)
                time.sleep(1.5)
            last["timed_out"] = True
            return json.dumps(last)
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_stop(session_id: str) -> str:
        """Stop a running agent (child session) by its session_id (from
        agent_start / agent_status)."""
        try:
            return json.dumps(daemon_client.call("session.cancel",
                                                 {"session_id": session_id}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_committee(task: str, strategies: list[str],
                        brain: str = "", model: str = "",
                        judge: bool = True, timeout_sec: int = 3600) -> str:
        """COMMITTEE MODE (jarvis#69): solve ONE task with several subagents in
        PARALLEL, each taking a DIFFERENT strategy, then (optionally) a JUDGE
        subagent picks or merges the best answer.

        `strategies` is a list of angle descriptions — one subagent per entry,
        all dispatched at once with the SAME `task` but that strategy injected as
        its role (e.g. ["MVP-first: simplest thing that works", "risk-first:
        find what breaks", "user-first: best UX"]). 2-6 works best.

        Returns JSON {task, members:[{strategy, session_id, status, summary}],
        verdict?}. With judge=true a final subagent reads every member's result
        and returns a chosen/merged answer in `verdict` — otherwise YOU compare
        the members yourself. Blocks until members (and the judge) finish or
        timeout_sec elapses.

        Use for high-stakes / wide-solution-space work where one attempt is
        risky. For a single delegation use agent_start."""
        import time
        try:
            strategies = [s for s in (strategies or []) if str(s).strip()][:6]
            if len(strategies) < 2:
                return _err(ValueError("committee needs >=2 strategies"))
            parent = os.environ.get("JARVIS_AGENT_SESSION")
            members: list[dict] = []
            for i, strat in enumerate(strategies):
                sp = ("You are committee member %d of %d solving a shared task. "
                      "Your ASSIGNED STRATEGY: %s\nCommit fully to this angle — "
                      "do not hedge toward the others. End with a concise SUMMARY "
                      "of your solution and why it fits your strategy."
                      % (i + 1, len(strategies), strat))
                params = {"agent": "committee-%d" % (i + 1), "task": task,
                          "system_prompt": sp}
                if brain:
                    params["brain"] = brain
                if model:
                    params["model"] = model
                if parent:
                    params["parent_session_id"] = parent
                r = daemon_client.call("agents.dispatch", params, timeout=30)
                members.append({"strategy": strat,
                                "session_id": r.get("session_id", ""),
                                "status": "running", "summary": ""})

            end = time.time() + max(30, min(int(timeout_sec or 3600), 14400))
            for m in members:
                sid = m["session_id"]
                if not sid:
                    m["status"] = "error"
                    continue
                while time.time() < end:
                    res = daemon_client.call("agents.result", {"session_id": sid})
                    if not res.get("running", False):
                        m["status"] = res.get("status", "done")
                        m["summary"] = res.get("summary", "")
                        break
                    time.sleep(1.5)
                else:
                    m["status"] = "timeout"

            out: dict = {"task": task, "members": members}
            if judge:
                done = [m for m in members if m["summary"].strip()]
                if done:
                    lines = "\n\n".join(
                        "### Member %d — strategy: %s\n%s"
                        % (i + 1, m["strategy"], m["summary"])
                        for i, m in enumerate(members))
                    jtask = (
                        "You are the JUDGE of a committee that solved this task:\n"
                        "%s\n\nHere is each member's solution:\n\n%s\n\n"
                        "Pick the single best solution OR merge the strongest "
                        "ideas into one. Justify briefly, then give the final "
                        "answer. End with a SUMMARY containing that final answer."
                        % (task, lines))
                    jp = {"agent": "committee-judge", "task": jtask,
                          "system_prompt": "You are an impartial judge selecting "
                          "or synthesizing the best of several solutions."}
                    if brain:
                        jp["brain"] = brain
                    if model:
                        jp["model"] = model
                    if parent:
                        jp["parent_session_id"] = parent
                    jr = daemon_client.call("agents.dispatch", jp, timeout=30)
                    jsid = jr.get("session_id", "")
                    verdict = {"session_id": jsid, "status": "running", "summary": ""}
                    while jsid and time.time() < end:
                        res = daemon_client.call("agents.result", {"session_id": jsid})
                        if not res.get("running", False):
                            verdict["status"] = res.get("status", "done")
                            verdict["summary"] = res.get("summary", "")
                            break
                        time.sleep(1.5)
                    else:
                        if jsid:
                            verdict["status"] = "timeout"
                    out["verdict"] = verdict
                else:
                    out["verdict"] = {"status": "error",
                                      "summary": "no member produced a result to judge"}
            return json.dumps(out)
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def agent_moa(prompt: str, advisors: list[dict] | None = None,
                  timeout_sec: int = 1800) -> str:
        """MIXTURE-OF-AGENTS (jarvis#76 item 10): fan ONE hard question out to
        several DIFFERENT brains/models in parallel and get their independent
        answers back as ADVISORY context — you stay the decision maker (unlike
        agent_committee, no judge decides for you).

        `advisors` is a list of {brain?, model?, role?} dicts — e.g.
        [{"brain":"codex"}, {"brain":"claude","model":"opus"},
         {"brain":"api","model":"mistral-large-latest"}]. Empty/omitted uses
        that trio of defaults (only advisors whose brain is available run).
        2-4 advisors is the sweet spot.

        Returns {prompt, advisors:[{brain, model, role, status, answer}]}.
        Read every answer, weigh where they agree/disagree, then produce YOUR
        final answer. Use for high-stakes reasoning (architecture choices,
        tricky debugging theories, irreversible decisions)."""
        import time
        try:
            plans = [a for a in (advisors or []) if isinstance(a, dict)][:4]
            if not plans:
                plans = [{"brain": "codex"}, {"brain": "claude"},
                         {"brain": "api", "model": "mistral-large-latest"}]
            parent = os.environ.get("JARVIS_AGENT_SESSION")
            members: list[dict] = []
            for i, plan in enumerate(plans):
                role = str(plan.get("role", "")).strip() or (
                    "an independent expert advisor: answer the question "
                    "directly and thoroughly on your own")
                sp = ("You are advisor %d of %d in a mixture-of-agents panel — "
                      "%s. Do NOT hedge toward what others might say; give YOUR "
                      "best independent answer. End with a concise SUMMARY "
                      "containing your answer." % (i + 1, len(plans), role))
                params = {"agent": "moa-advisor-%d" % (i + 1), "task": prompt,
                          "system_prompt": sp}
                if plan.get("brain"):
                    params["brain"] = str(plan["brain"])
                if plan.get("model"):
                    params["model"] = str(plan["model"])
                if parent:
                    params["parent_session_id"] = parent
                m = {"brain": str(plan.get("brain", "")),
                     "model": str(plan.get("model", "")),
                     "role": role, "status": "running", "answer": "",
                     "session_id": ""}
                try:
                    r = daemon_client.call("agents.dispatch", params, timeout=30)
                    m["session_id"] = r.get("session_id", "")
                except Exception as dexc:  # noqa: BLE001
                    m["status"] = "error"
                    m["answer"] = str(dexc)
                members.append(m)

            end = time.time() + max(30, min(int(timeout_sec or 1800), 14400))
            for m in members:
                sid = m["session_id"]
                if not sid:
                    if m["status"] != "error":
                        m["status"] = "error"
                    continue
                while time.time() < end:
                    res = daemon_client.call("agents.result", {"session_id": sid})
                    if not res.get("running", False):
                        m["status"] = res.get("status", "done")
                        m["answer"] = res.get("summary", "")
                        break
                    time.sleep(1.5)
                else:
                    m["status"] = "timeout"
            return json.dumps({"prompt": prompt, "advisors": members})
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- Claude-Code-style lifecycle hooks --------------------------------
    @mcp.tool()
    def hooks_list() -> str:
        """List configured Claude-Code-style lifecycle hooks + the available event
        names. Hooks are shell commands that fire at session/turn/tool events;
        config lives in ~/.config/jarvis/hooks.json (same schema as Claude Code)."""
        try:
            return json.dumps(daemon_client.call("hooks.list"))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def hooks_add(event: str, command: str, matcher: str = "",
                  timeout: int = 60) -> str:
        """Add a hook: run `command` (a shell command) on `event`. Events:
        PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop,
        SessionStart, SessionEnd, PreCompact. `matcher` (regex) filters by tool name
        (Pre/PostToolUse) / source / agent type; empty = always. The command gets a
        JSON event on stdin; exit 2 — or stdout {"decision":"block","reason":...} —
        BLOCKS where supported (UserPromptSubmit), and {"additionalContext":"..."}
        (or plain non-JSON stdout) injects context into the turn."""
        try:
            return json.dumps(daemon_client.call("hooks.add", {
                "event": event, "command": command,
                "matcher": matcher, "timeout": int(timeout)}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def hooks_remove(event: str, index: int) -> str:
        """Remove the hook group at `index` under `event` (indices from hooks_list)."""
        try:
            return json.dumps(daemon_client.call("hooks.remove",
                                                 {"event": event, "index": int(index)}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def hooks_test(event: str, match_key: str = "", input: dict | None = None) -> str:
        """Fire the hooks for `event` NOW with a test payload and return what they
        did: ran_any, blocked, block_reason, injected_context, notes. Use to verify a
        hook before relying on it."""
        try:
            return json.dumps(daemon_client.call("hooks.test", {
                "event": event, "match_key": match_key, "input": input or {}}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)
