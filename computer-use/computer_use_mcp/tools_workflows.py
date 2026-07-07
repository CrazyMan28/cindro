"""Workflows — first-class, nameable recurring / conditional / webhook jobs
built on Jarvis's existing Scheduler (the schedule.* Contract-A verbs). A
Workflow bundles a trigger (a 5-field cron / "every Nm" / "at HH:MM" / the
literal "webhook"), a prompt, an optional brain+model, a free-text `target`
reference (an agent name or paired-machine id), and an inbox `report_thread`
(default "Workflows").

Condition-polling ("check X, only report if it changed") needs NO new schema:
author a tight-cadence Workflow whose prompt tells the fired session to
recall(agent=<target>) for last-known state, compare, and only escalate on a
change. See docs/WORKFLOWS.md.

Tool functions are module-level (tools_tui_ops.py style) so they are directly
importable/testable; register() wires them into FastMCP.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import secrets

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client
from computer_use_mcp.config import load_config
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

DEFAULT_REPORT_THREAD = "Workflows"
_WEBHOOK_PREFIX = "/workflows/webhook/"
# Exactly one non-empty, slash-free segment after the prefix — see
# is_webhook_path() for why this must be a strict fullmatch.
_WEBHOOK_ID_RE = re.compile(re.escape(_WEBHOOK_PREFIX) + r"([^/]+)")


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def _webhook_base() -> str:
    """Base URL the minted webhook_url is built on. JARVIS_WEBHOOK_BASE wins;
    else the computer-use server's advertise_host:port (set advertise_host to a
    tailnet-reachable name/IP for external callers)."""
    cfg = load_config()
    return os.environ.get("JARVIS_WEBHOOK_BASE") or \
        f"http://{cfg['advertise_host']}:{cfg['port']}"


def workflow_create(name: str, trigger: str, prompt: str, brain: str = "",
                    model: str = "", target: str = "", report_thread: str = "") -> str:
    """Create a nameable Workflow (a managed recurring / webhook job). `trigger`
    is a cron ("0 2 * * *"), an interval ("every 30m"), a clock time ("at 09:00"),
    OR the literal "webhook". `target` is a free-text agent name / paired-machine
    id the prompt refers to (e.g. recall(agent=<target>) or outpost_exec on it).
    `report_thread` is the in-app inbox thread the fired session posts its report
    to (default "Workflows"). For trigger="webhook" this mints a per-workflow
    bearer token and returns {id, webhook_url, token}; otherwise returns {id}."""
    try:
        if not name.strip():
            return _err(ValueError("name is required"))
        if not trigger.strip():
            return _err(ValueError("trigger is required"))
        if not prompt.strip():
            return _err(ValueError("prompt is required"))
        thread = report_thread or DEFAULT_REPORT_THREAD
        is_webhook = trigger.strip().lower() == "webhook"
        params: dict = {"name": name, "prompt": prompt, "brain": brain,
                        "model": model, "target": target,
                        "report_thread": thread, "enabled": True}
        token = ""
        if is_webhook:
            token = secrets.token_urlsafe(32)
            params["cron"] = "webhook"
            params["token"] = token
        else:
            params["cron"] = trigger
        res = daemon_client.call("schedule.create", params)
        wid = res.get("id", "")
        out: dict = {"id": wid}
        if is_webhook and wid:
            out["webhook_url"] = f"{_webhook_base()}{_WEBHOOK_PREFIX}{wid}"
            out["token"] = token
        return json.dumps(out)
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def workflow_list() -> str:
    """List all Workflows (id, name, trigger, target, report_thread, brain,
    model, next_run, last_run, enabled)."""
    try:
        res = daemon_client.call("schedule.list")
        workflows = [{
            "id": r.get("id", ""),
            "name": r.get("name", ""),
            "trigger": r.get("cron", ""),
            "target": r.get("target", ""),
            "report_thread": r.get("report_thread", ""),
            "brain": r.get("brain", ""),
            "model": r.get("model", ""),
            "next_run": r.get("next_run", 0),
            "last_run": r.get("last_run", 0),
            "enabled": r.get("enabled", True),
        } for r in res.get("schedules", [])]
        return json.dumps({"workflows": workflows})
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def workflow_delete(id: str) -> str:
    """Delete a Workflow by id (from workflow_list). Returns {ok, deleted}."""
    try:
        res = daemon_client.call("schedule.remove", {"id": id})
        ok = bool(res.get("ok", False))
        return json.dumps({"ok": ok, "deleted": ok})
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def is_webhook_path(path: str) -> bool:
    """True for the webhook ingestion path — exempted from the bearer middleware
    (it authenticates with the per-workflow token instead).

    Strict, single-segment match: the ENTIRE remainder of the path after the
    fixed prefix must be exactly one non-empty, slash-free workflow-id
    segment. A naive `path.startswith(_WEBHOOK_PREFIX)` check on the
    *unnormalized* request path would also exempt path-confusion payloads
    like "/workflows/webhook/x/../../mcp/secret" from the bearer-auth
    middleware (its raw string does start with the prefix) even though it is
    not a genuine webhook call. `[^/]+` can never contain a "/", so
    `fullmatch()` forces the entire remainder to collapse to exactly one
    segment and rejects any embedded "/" — and therefore any "../"
    traversal attempt — beyond the workflow id. A literal ".." id is also
    rejected outright since it can never be a real workflow id (ids are
    daemon-assigned / secrets.token_urlsafe-style tokens with no slashes)."""
    m = _WEBHOOK_ID_RE.fullmatch(path)
    return bool(m) and m.group(1) != ".."


def fire_webhook(workflow_id: str, presented_token: str):
    """Verify the presented bearer against the workflow's stored per-workflow
    token (hmac-safe), confirm the workflow is enabled, and on success fire it
    through the SAME code path the cron scheduler uses (schedule.run_now ->
    Scheduler::runNow -> fireScheduledJob).

    Scheduler::runNow() intentionally fires regardless of `enabled` (it backs
    the GUI/TUI's manual "Run Now" button, where pressing Run IS the
    approval) — so the enabled-check for externally-triggered webhooks has to
    live here, not in the scheduler. Without it, disabling a webhook workflow
    via schedule.set_enabled would have zero effect on whether external POSTs
    to its webhook URL keep firing it. Returns (http_status:int, body:dict)."""
    if not presented_token:
        return 401, {"error": "missing bearer token"}
    try:
        info = daemon_client.call("schedule.webhook_token", {"id": workflow_id})
    except Exception as exc:  # noqa: BLE001
        return 502, {"error": str(exc)}
    stored = str(info.get("token") or "")
    if not stored:
        return 404, {"error": "no such webhook workflow"}
    if not hmac.compare_digest(presented_token, stored):
        return 401, {"error": "invalid token"}
    # Fail CLOSED: a missing or malformed `enabled` field must be treated the
    # same as disabled, not the same as enabled. Only an explicit truthy
    # `enabled` lets the webhook fire.
    if not info.get("enabled", False):
        return 403, {"error": "workflow_disabled"}
    try:
        res = daemon_client.call("schedule.run_now", {"id": workflow_id})
    except Exception as exc:  # noqa: BLE001
        return 502, {"error": str(exc)}
    return 200, {"ok": bool(res.get("ok", True)), "fired": True,
                 "session_id": res.get("session_id", "")}


def register_webhook_route(app: FastAPI) -> None:
    """Mount POST /workflows/webhook/<workflow_id> on the given FastAPI app."""

    @app.post(_WEBHOOK_PREFIX + "{workflow_id}")
    async def workflow_webhook(workflow_id: str, request: Request):  # noqa: ANN202
        auth_header = request.headers.get("Authorization") or ""
        token = ""
        parts = auth_header.split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1]
        if not token:
            token = request.query_params.get("token", "")
        status, body = await asyncio.to_thread(fire_webhook, workflow_id, token)
        return JSONResponse(status_code=status, content=body)


def register(mcp: FastMCP) -> None:
    mcp.tool()(workflow_create)
    mcp.tool()(workflow_list)
    mcp.tool()(workflow_delete)
