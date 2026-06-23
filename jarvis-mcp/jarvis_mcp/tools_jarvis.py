"""The jarvis_* orchestration tools — thin MCP wrappers over Contract A.

Each tool turns a Contract-A method (jarvisd control WS) into an MCP tool an
external agent (Claude Code / Codex) can call, so the agent can drive Jarvis:
start/steer sessions, queue scheduled work, search/add long-term memory, list
and invoke self-authored skills, and read the daily digest.

Contract-A errors surface as a structured {"error","code","message"} payload
rather than raising, so the calling agent gets a usable result instead of an
opaque tool fault.
"""

from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from jarvis_mcp.control_client import ControlError, client


async def _call(method: str, params: Optional[dict[str, Any]] = None,
                timeout: float = 60.0) -> dict[str, Any]:
    try:
        return await client.call(method, params or {}, timeout=timeout)
    except ControlError as exc:
        return {"error": "control_error", "code": exc.code, "message": exc.message}
    except ConnectionError as exc:
        return {"error": "daemon_unreachable", "message": str(exc)}
    except TimeoutError as exc:
        return {"error": "timeout", "message": str(exc)}


def register(mcp: FastMCP) -> list[str]:
    """Register every jarvis_* tool; return their names."""

    @mcp.tool()
    async def jarvis_ping() -> dict[str, Any]:
        """Health-check the jarvisd control connection (Contract A ping)."""
        return await _call("ping", timeout=10)

    @mcp.tool()
    async def jarvis_start_session(
        profile: str = "coworker",
        brain: str = "",
        model: str = "",
        target: str = "",
        cwd: str = "",
        title: str = "",
    ) -> dict[str, Any]:
        """Start a new Jarvis session and return its session_id.

        profile: "coder" or "coworker" (default coworker). brain: "codex" |
        "claude" | "api" (blank = daemon default). model: blank = the brain's
        default. target: "agent" (nested isolated desktop, the coworker default)
        or "real" (drive the user's actual screen). cwd/title optional.
        """
        params: dict[str, Any] = {"profile": profile or "coworker"}
        if brain:
            params["brain"] = brain
        if model:
            params["model"] = model
        if target:
            params["target"] = target
        if cwd:
            params["cwd"] = cwd
        if title:
            params["title"] = title
        return await _call("session.create", params, timeout=120)

    @mcp.tool()
    async def jarvis_send(session_id: str, text: str,
                          images: Optional[list[str]] = None) -> dict[str, Any]:
        """Send a user turn to a session. The brain streams events
        asynchronously; poll jarvis_session_history or jarvis_session_events for
        output. images: optional list of base64 data (passed through to the brain)."""
        params: dict[str, Any] = {"session_id": session_id, "text": text}
        if images:
            params["images"] = images
        return await _call("session.send", params)

    @mcp.tool()
    async def jarvis_cancel_session(session_id: str) -> dict[str, Any]:
        """Cancel the current turn (and release a coworker+agent nested desktop)."""
        return await _call("session.cancel", {"session_id": session_id})

    @mcp.tool()
    async def jarvis_list_sessions() -> dict[str, Any]:
        """List all Jarvis sessions (id, brain, profile, model, state, title)."""
        return await _call("session.list", timeout=20)

    @mcp.tool()
    async def jarvis_session_history(session_id: str, limit: int = 100) -> dict[str, Any]:
        """Full event history for a session: the stored NormalizedBrainEvents
        (messages, tool calls/results, diffs, approvals, usage, final)."""
        return await _call("session.history",
                           {"session_id": session_id, "limit": limit})

    @mcp.tool()
    async def jarvis_session_events(limit: int = 100) -> dict[str, Any]:
        """Drain buffered unsolicited session.event frames pushed by the daemon
        since the last drain (live streaming output across all sessions). Use
        jarvis_session_history for the durable per-session record."""
        return {"events": client.drain_events(limit)}

    @mcp.tool()
    async def jarvis_approval_respond(session_id: str, approval_id: str,
                                      decision: str) -> dict[str, Any]:
        """Answer an approval the brain raised (decision: "allow"|"deny"|"always").
        Also flips take-over (approval_id "takeover-*") and injection gates
        ("inject-*")."""
        return await _call("approval.respond",
                           {"session_id": session_id,
                            "approval_id": approval_id, "decision": decision})

    @mcp.tool()
    async def jarvis_queue_task(text: str, when: str = "",
                                name: str = "", brain: str = "",
                                model: str = "", profile: str = "") -> dict[str, Any]:
        """Queue work for Jarvis to run on a schedule (Contract A schedule.create).

        text: the prompt. when: a cron expr ("0 9 * * *"), "every 30m", or
        "at 14:30"; blank schedules it as soon as the scheduler ticks. name/
        brain/model/profile optional overrides."""
        params: dict[str, Any] = {"prompt": text}
        if when:
            params["when"] = when
        if name:
            params["name"] = name
        if brain:
            params["brain"] = brain
        if model:
            params["model"] = model
        if profile:
            params["profile"] = profile
        return await _call("schedule.create", params)

    @mcp.tool()
    async def jarvis_list_tasks() -> dict[str, Any]:
        """List queued/scheduled Jarvis jobs (Contract A schedule.list)."""
        return await _call("schedule.list", timeout=20)

    @mcp.tool()
    async def jarvis_memory_search(q: str, limit: int = 20) -> dict[str, Any]:
        """Search Jarvis long-term memory (SQLite FTS5). Empty q returns recent."""
        return await _call("memory.search", {"q": q, "limit": limit})

    @mcp.tool()
    async def jarvis_memory_add(text: str,
                                tags: Optional[list[str]] = None) -> dict[str, Any]:
        """Add a fact to Jarvis long-term memory. tags: optional labels."""
        params: dict[str, Any] = {"text": text}
        if tags:
            params["tags"] = tags
        return await _call("memory.add", params)

    @mcp.tool()
    async def jarvis_skill_list() -> dict[str, Any]:
        """List Jarvis self-authored skills (name + description)."""
        return await _call("skills.list", timeout=20)

    @mcp.tool()
    async def jarvis_skill_invoke(name: str,
                                  args: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Invoke a Jarvis skill by name; returns its rendered message. args:
        optional key/values the skill template consumes."""
        params: dict[str, Any] = {"name": name}
        if args:
            params["args"] = args
        return await _call("skills.invoke", params)

    @mcp.tool()
    async def jarvis_today() -> dict[str, Any]:
        """Jarvis's daily digest: recent sessions, memory, and available skills."""
        return await _call("skills.today", timeout=20)

    return [
        "jarvis_ping", "jarvis_start_session", "jarvis_send",
        "jarvis_cancel_session", "jarvis_list_sessions", "jarvis_session_history",
        "jarvis_session_events", "jarvis_approval_respond", "jarvis_queue_task",
        "jarvis_list_tasks", "jarvis_memory_search", "jarvis_memory_add",
        "jarvis_skill_list", "jarvis_skill_invoke", "jarvis_today",
    ]
