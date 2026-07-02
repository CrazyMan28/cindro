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

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def register(mcp: FastMCP) -> None:
    # ---- SEND A FILE TO THE USER -------------------------------------------
    @mcp.tool()
    def send_file(path: str = "", b64: str = "", name: str = "") -> str:
        """Send a file from THIS computer straight into the user's Jarvis chat
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
        """Schedule Jarvis to run a task LATER / on a cadence (self-waking). `when`
        accepts 'every 30m', 'every 2h', 'at 09:00', or a 5-field cron; `cron` is an
        explicit 5-field cron. The task fires as a new Jarvis session with `prompt`.
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
        """List Jarvis's scheduled tasks (id, name, cadence, next run)."""
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
    @mcp.tool()
    def remember(text: str, tags: list[str] | None = None) -> str:
        """Save a fact to Jarvis's long-term memory so it persists across sessions
        (preferences, project facts, decisions). Returns {id}."""
        try:
            return json.dumps(daemon_client.call("memory.add",
                                                 {"text": text, "tags": tags or []}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def recall(query: str, limit: int = 20) -> str:
        """Full-text search Jarvis's long-term memory for relevant facts."""
        try:
            return json.dumps(daemon_client.call("memory.search",
                                                 {"q": query, "limit": limit}))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

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
        """List ALL of Jarvis's long-term memories (newest first: id, text, tags)."""
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
        """Author a NEW reusable skill (a Markdown procedure Jarvis can invoke later
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
        """List Jarvis's self-authored + bundled skills (name, description)."""
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
        is set and the user enabled auto-continue, Jarvis re-wakes the session
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
        """Enqueue a DURABLE work item on Jarvis's kanban backlog. Unlike
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

        `name` can be one of your DEFINED agents (see agent_list) OR any new label
        for an AD-HOC subagent (you do NOT need to pre-create an agent to delegate).
        You may choose the `brain` (codex|claude|api) and `model` it runs on, and
        give it a one-off `system_prompt` (its role/instructions for the task).
        A stored agent's def fills any of these you leave blank.

        Use this to actually OFFLOAD work — e.g. agent_start("file-writer", "write
        /tmp/x.py as hello world", model="gpt-5.5"). Don't just narrate that you
        delegated; call this tool."""
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
