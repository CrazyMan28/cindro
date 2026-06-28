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
    def agent_wait(session_id: str, timeout_sec: int = 300) -> str:
        """WAIT (block) until a subagent finishes, then return its summary + status.
        This is the simplest way to use a subagent: call agent_start(...), then
        agent_wait(session_id) — it returns ONLY once the subagent is done, so you can
        act on its result immediately (no polling, no guessing). Waits up to
        timeout_sec (default 5 min); returns the latest status if it times out."""
        import time
        try:
            end = time.time() + max(5, min(int(timeout_sec or 300), 1800))
            last: dict = {}
            while time.time() < end:
                last = daemon_client.call("agents.result", {"session_id": session_id})
                if not last.get("running", False):
                    return json.dumps(last)
                time.sleep(2.0)
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
