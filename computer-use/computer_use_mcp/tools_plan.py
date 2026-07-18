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
handlers for the server-side state (SettingsStore's global agent_mode, a
per-session self-initiated flag, and a per-session approved-override set that
present_plan's "Approve & Build" grants — SCOPED to the approving session only,
never by flipping the shared global setting, so approving one session's plan
never silently unblocks a different concurrently-running plan-restricted one).
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

        On "approve": you're unblocked to execute immediately after this call
        returns, do not ask again — whether you were in the user's global PLAN
        mode (Settings) or self-initiated via enter_plan_mode. This unblocks
        THIS session specifically; it does NOT change the global Settings mode
        (so a concurrently-running, separately plan-restricted session isn't
        silently unblocked by your approval — its own plan still needs its own
        present_plan/approval). If you want the global mode itself changed,
        tell the user to do that in Settings.
        On "revise": the user's feedback is in `note` — incorporate it and call
        present_plan again when ready; do NOT start executing. There is NO
        separate "edit plan" or "update plan" tool — present_plan IS how you
        both publish a plan and receive revision feedback; do not search for
        another tool. If `note` is empty or unhelpful (e.g. the user just
        tapped "Request Changes" with no detail — the UI now nudges them to
        type something, but they can still send nothing), do NOT re-call
        present_plan blindly: ask a specific clarifying question about what to
        change (ask_user, or just reply in chat) and wait for their next
        message before revising.
        On "timeout": the user hasn't responded — try again later or keep
        researching; you are still in PLAN mode."""
        try:
            if todos:
                write_todos(todos)
            # Codex review (PR #130): this used to resolve `sid` AFTER the
            # blocking ask_bus.ask() call returned. On the shared global engine,
            # current_session_id() only resolves reliably while THIS is the
            # sole running session — but the ask can block for up to a day, so
            # by the time the user answers, another session may well be
            # running too, making this resolve empty. plan.exit/plan.approve
            # would then both silently fail (swallowed below) while
            # present_plan still reported "approve", leaving writes blocked.
            # Capture it BEFORE the blocking wait instead.
            sid = daemon_client.current_session_id()
            res = ask_bus.ask(
                f"# {title}\n\n{markdown}",
                ["Approve & Build", "Request Changes"],
                timeout=float(os.environ.get("JARVIS_PLAN_ASK_TIMEOUT", "86400")),
            )
            answer = str((res or {}).get("answer", "")).strip().lower()
            if ask_bus.is_affirmative(answer, "approve & build"):
                try:
                    daemon_client.call("plan.exit", {"session_id": sid})
                except Exception:
                    pass
                try:
                    # Codex review (PR #130): this used to flip the GLOBAL
                    # Settings agent_mode from "plan" to "build" here, which
                    # un-restricted EVERY session under global Plan Mode, not
                    # just the one whose plan was actually approved. plan.approve
                    # exempts only THIS session (per-session, in-memory) without
                    # touching the global setting or any other session.
                    daemon_client.call("plan.approve", {"session_id": sid})
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
        restriction you imposed on yourself.

        Returns JSON {"ok": true, "still_restricted": bool, "restriction_source":
        str}. ALWAYS check `still_restricted` before telling the user you can
        write/execute again. If it's true (restriction_source will be
        "settings"), the user's Settings-driven PLAN mode is STILL fully in
        effect — this call did NOTHING to lift it, and your very next write
        attempt will be denied. Do NOT say you've exited plan mode or that
        tools are free again; call present_plan instead and wait for the
        user's Approve & Build."""
        try:
            sid = daemon_client.current_session_id()
            daemon_client.call("plan.exit", {"session_id": sid})
            policy.bust_plan_cache(sid)
            still_restricted, source = policy._plan_status()
            return json.dumps({
                "ok": True,
                "summary": summary,
                "still_restricted": still_restricted,
                "restriction_source": source,
            })
        except Exception as exc:  # noqa: BLE001
            return _err(exc)
