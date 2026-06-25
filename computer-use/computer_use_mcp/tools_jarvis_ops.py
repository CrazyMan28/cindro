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
    def invoke_skill(name: str, args: str = "") -> str:
        """Invoke a saved skill by name (loads its procedure for the next step)."""
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
