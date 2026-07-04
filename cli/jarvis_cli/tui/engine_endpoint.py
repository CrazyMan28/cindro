"""Resolves a session's per-session computer-use engine (port, bearer) —
the SAME agent_desktop.info round-trip Bridge.cpp uses (Bridge.cpp:3748-
3757) — shared by BrowserPane and ComputerPane so the lookup lives in
exactly one place."""

from __future__ import annotations


async def resolve_engine_endpoint(client, session_id: str) -> tuple[str, str]:
    """Returns (port, bearer) for session_id's per-session engine."""
    res = await client.call("agent_desktop.info", {"session_id": session_id})
    return str(res.get("port", "8810")), str(res.get("bearer", ""))
