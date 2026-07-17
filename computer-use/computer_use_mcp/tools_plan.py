"""Plan Mode — present a written plan for the user, and self/user-directed entry.

Three tools:
  present_plan     — publish the finished plan and BLOCK for the user's decision
                      (Approve & Build / Request Changes). Required to exit the
                      user's global Settings-driven PLAN mode; optional (but
                      always available) from a self-initiated one.
  enter_plan_mode   — the model goes read-only on its OWN judgment, for just this
                      session, no user approval needed to enter OR exit.
  exit_plan_mode    — leave a self-initiated plan, on the model's own judgment.

Both entry paths are enforced by the SAME gate (policy.py's _plan_mode_gate) via
the daemon's `plan.status`; see ControlServer's plan.enter/plan.exit/plan.status
handlers for the server-side state (SettingsStore's global agent_mode vs. a
per-session in-memory flag).
"""

from __future__ import annotations

import json
import os

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import ask_bus, daemon_client, policy
from computer_use_mcp.tools_todo import write_todos


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    def present_plan(title: str, markdown: str, todos: list | None = None) -> str:
        """Publish your finished PLAN for the user to review, and BLOCK until they
        respond. Call this once research is done and you have a concrete, complete
        plan — not before. If `todos` is given it also calls todo_write with those
        steps (so the checklist card matches the plan doc).

        Returns JSON {"decision": "approve"|"revise"|"timeout", "note": <str>}.

        On "approve": if you're in the user's global PLAN mode (Settings), this
        switches the session to BUILD mode for you — execute immediately after
        this call returns, do not ask again. If you entered plan mode yourself via
        enter_plan_mode, this simply clears that self-imposed restriction (which
        you could also have lifted yourself with exit_plan_mode).
        On "revise": the user's feedback is in `note` — incorporate it and call
        present_plan again when ready; do NOT start executing.
        On "timeout": the user hasn't responded — try again later or keep
        researching; you are still in PLAN mode."""
        try:
            if todos:
                write_todos(todos)
            res = ask_bus.ask(
                f"# {title}\n\n{markdown}",
                ["Approve & Build", "Request Changes"],
                timeout=float(os.environ.get("JARVIS_PLAN_ASK_TIMEOUT", "86400")),
            )
            sid = daemon_client.current_session_id()
            answer = str((res or {}).get("answer", "")).strip().lower()
            if answer == "approve & build":
                try:
                    daemon_client.call("plan.exit", {"session_id": sid})
                except Exception:
                    pass
                try:
                    cur = daemon_client.call("settings.get")
                    if cur.get("agent_mode") == "plan":
                        daemon_client.call("settings.set", {"patch": {"agent_mode": "build"}})
                except Exception:
                    pass
                policy.bust_plan_cache(sid)
                return json.dumps({"decision": "approve", "note": ""})
            if res.get("timed_out"):
                return json.dumps({"decision": "timeout", "note": ""})
            return json.dumps({"decision": "revise", "note": res.get("answer", "")})
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def enter_plan_mode(reason: str) -> str:
        """Voluntarily go READ-ONLY to research before touching anything — the same
        judgment call Claude Code's own plan mode makes. Use when a task is risky
        or unclear enough that you want to investigate before acting, even though
        the user hasn't put you in PLAN mode via Settings. Blocks write/execute
        tools for THIS session only, until you call exit_plan_mode or present_plan.
        Does not require user approval to exit (that's on you), unlike the
        Settings-driven global PLAN mode, which only present_plan's Approve &
        Build can clear."""
        try:
            sid = daemon_client.current_session_id()
            daemon_client.call("plan.enter", {"session_id": sid})
            policy.bust_plan_cache(sid)
            return json.dumps({"ok": True, "reason": reason})
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def exit_plan_mode(summary: str = "") -> str:
        """Leave the SELF-INITIATED read-only state you entered with
        enter_plan_mode, on your own judgment — no user approval needed. If the
        user put you in PLAN mode via Settings, this has NO effect on that (it can
        only be lifted by present_plan's Approve & Build) — it only clears a
        restriction you imposed on yourself."""
        try:
            sid = daemon_client.current_session_id()
            daemon_client.call("plan.exit", {"session_id": sid})
            policy.bust_plan_cache(sid)
            return json.dumps({"ok": True, "summary": summary})
        except Exception as exc:  # noqa: BLE001
            return _err(exc)
