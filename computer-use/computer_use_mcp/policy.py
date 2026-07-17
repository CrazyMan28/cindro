"""Trust-policy gate — the permission engine between the model and EVERY tool call.

jarvis#71: granular, per-tool / per-app trust rules ("always ask for browser
payments", "never allow local file reads", "auto-approve todo writes"). The
daemon owns the rules (Contract A `policy.*`, edited in Settings → Permissions
on desktop/phone) and persists them to a plain JSON file; this module is the
ENFORCEMENT point: it wraps FastMCP's ToolManager.call_tool so every tool the
brain invokes passes through `evaluate()` first.

  rules file: ~/.config/jarvis/trust_policies.json   (JARVIS_TRUST_POLICIES_FILE
              overrides — used by tests and the Windows edition)
  format:     {"version": 1, "default": "allow",
               "rules": [{"id": "...", "tool": "browser_*", "app": "*",
                          "action": "allow"|"ask"|"deny", "note": "..."}]}

Matching: `tool` and `app` are fnmatch globs. The MOST SPECIFIC rule wins
(highest count of non-wildcard characters across both patterns); ties go to the
EARLIEST rule in the list. `app` is matched against the focused window's
"class|title" on the agent's display — computed lazily, only when at least one
rule actually discriminates by app, and never fatal (unknown app matches only
"*" rules).

Actions:
  allow -> run the tool.
  deny  -> raise, so the model sees "blocked by trust policy ..." and re-plans.
  ask   -> post a question on the ask-bus (rendered by desktop AND phone) and
           block; anything but an explicit Allow (incl. timeout) is a deny.
           `ask_user`/`notify_user` themselves are exempt from ASK (a question
           gated behind a question would deadlock) but NOT from deny.

Every decision that isn't a default-allow is appended to
~/.local/share/jarvis/policy_log.jsonl for the Activity page / audit.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

from . import ask_bus, cmd_scan, daemon_client

_DEFAULT_FILE = Path(
    os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
) / "jarvis" / "trust_policies.json"

_LOG_FILE = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "jarvis" / "policy_log.jsonl"

# ASK on these would deadlock (the question tool gated behind a question) or
# gate pure introspection. They can still be DENIED by an explicit rule.
_ASK_EXEMPT = {"ask_user", "notify_user", "todo_read", "bg_status", "bg_logs"}

_ASK_TIMEOUT = float(os.environ.get("JARVIS_POLICY_ASK_TIMEOUT", "120"))

_cache: dict[str, Any] = {"mtime": None, "path": None, "doc": None}


def policies_file() -> Path:
    override = os.environ.get("JARVIS_TRUST_POLICIES_FILE")
    return Path(override) if override else _DEFAULT_FILE


def _load() -> dict:
    """Load + cache the rules doc by mtime. Missing/broken file = no rules."""
    path = policies_file()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {"default": "allow", "rules": []}
    if _cache["doc"] is not None and _cache["mtime"] == mtime \
            and _cache["path"] == str(path):
        return _cache["doc"]
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(doc, dict) or not isinstance(doc.get("rules"), list):
            raise ValueError("bad shape")
    except Exception:
        # A corrupt policies file must never brick the agent — treat as empty
        # but do not cache, so a fixed file is picked up immediately.
        return {"default": "allow", "rules": []}
    _cache.update(mtime=mtime, path=str(path), doc=doc)
    return doc


def _specificity(rule: dict) -> int:
    s = 0
    for key in ("tool", "app"):
        pat = str(rule.get(key, "*") or "*")
        s += sum(1 for ch in pat if ch not in "*?[]")
    return s


def _needs_app(doc: dict) -> bool:
    return any(str(r.get("app", "*") or "*") != "*" for r in doc.get("rules", []))


def _current_app() -> str:
    """Focused window on the agent's display as 'app|title'. Never fatal."""
    try:
        from . import windows as _win  # late import: compositor deps
        for w in _win.list_windows():
            if w.get("active"):
                return f"{w.get('app') or ''}|{w.get('title') or ''}"
    except Exception:
        pass
    return ""


def evaluate(tool: str, app: str | None = None) -> tuple[str, dict | None]:
    """-> (action, matched_rule|None). action in allow/ask/deny."""
    doc = _load()
    rules = [r for r in doc.get("rules", []) if isinstance(r, dict)]
    if app is None:
        app = _current_app() if _needs_app(doc) else ""
    best: dict | None = None
    best_spec = -1
    for idx, r in enumerate(rules):
        tpat = str(r.get("tool", "*") or "*")
        apat = str(r.get("app", "*") or "*")
        if not fnmatchcase(tool, tpat):
            continue
        # App/window matching is case-insensitive: rules like "*bank*" must hit
        # "My Bank — login" (tool names are fixed lowercase, apps aren't).
        if apat != "*" and not fnmatchcase((app or "").lower(), apat.lower()):
            continue
        spec = _specificity(r)
        if spec > best_spec:  # ties keep the EARLIEST rule (list order)
            best, best_spec = r, spec
    if best is None:
        default = str(doc.get("default", "allow"))
        return (default if default in ("allow", "ask", "deny") else "allow", None)
    action = str(best.get("action", "allow"))
    return (action if action in ("allow", "ask", "deny") else "allow", best)


def _log(tool: str, app: str, action: str, rule: dict | None, allowed: bool) -> None:
    try:
        _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": int(time.time() * 1000),
                "session": os.environ.get("JARVIS_AGENT_SESSION", ""),
                "tool": tool, "app": app, "action": action,
                "rule": (rule or {}).get("id", ""), "allowed": allowed,
            }) + "\n")
    except Exception:
        pass  # audit must never break the tool path


def gate(tool: str) -> None:
    """Raise if `tool` may not run right now (deny, or ask answered no)."""
    doc = _load()
    if not doc.get("rules") and str(doc.get("default", "allow")) == "allow":
        return  # fast path: no policies configured
    app = _current_app() if _needs_app(doc) else ""
    action, rule = evaluate(tool, app)
    if action == "allow":
        return
    if action == "ask" and tool in _ASK_EXEMPT:
        return
    note = str((rule or {}).get("note", "") or "").strip()
    rid = str((rule or {}).get("id", "") or "policy")
    if action == "deny":
        _log(tool, app, "deny", rule, False)
        raise PermissionError(
            f"Blocked by trust policy '{rid}'"
            + (f" ({note})" if note else "")
            + f": the user has denied '{tool}'"
            + (f" for app '{app}'" if app else "")
            + ". Do not retry this tool; explain what you wanted to do and, if"
              " it matters, suggest the user relax the policy in Settings →"
              " Permissions."
        )
    # ask
    q = f"Cindro wants to run tool '{tool}'"
    if app:
        q += f" on {app.split('|')[0] or app}"
    if note:
        q += f" — {note}"
    q += ". Allow it?"
    try:
        res = ask_bus.ask(q, ["Allow", "Deny"], timeout=_ASK_TIMEOUT)
        answer = str((res or {}).get("answer", "")).strip().lower()
    except Exception:
        answer = ""
    if answer == "allow":
        _log(tool, app, "ask", rule, True)
        return
    _log(tool, app, "ask", rule, False)
    raise PermissionError(
        f"Trust policy '{rid}' required user approval for '{tool}' and the"
        f" user {'denied it' if answer == 'deny' else 'did not approve in time'}."
        " Do not retry; continue without it or ask the user in chat."
    )


# --- phone permissions gate (Phone → Permissions) ---------------------------
# PhonePolicyStore (~/.config/jarvis/phone_policy.json) restricts what Cindro may
# do over the phone. The daemon HARD-denies gated phone MCP tools at its phone.mcp
# choke point for EVERY surface (incl. the brain, whose tools_phone.py forwards
# through phone.mcp). Here — the ONLY layer with an ask-bus — we enforce the
# interactive "ask" for the brain and fail fast on "deny".
#
# The tool->capability map + defaults MUST match core/src/PhonePolicyStore.cpp
# (buildToolMap + the catalog defaults). Only the tri-state, tool-gated
# capabilities appear (answer_calls is config-driven, not a tool gate).
# Mirror the daemon's Config::configDir() (JARVIS_CONFIG_DIR profile-aware, and
# deliberately NOT XDG-overridable — see core/src/TrustPolicyStore.cpp) exactly
# as daemon_client.py does. Using XDG_CONFIG_HOME here instead would make the
# daemon write one phone_policy.json while this engine-side 'ask' gate reads
# another under a profile/XDG override — silently failing 'ask' OPEN (deny is
# still caught daemon-side, but the interactive ask is only enforced HERE).
_PHONE_POLICY_DEFAULT_FILE = Path(
    os.environ.get("JARVIS_CONFIG_DIR") or os.path.expanduser("~/.config/jarvis")
) / "phone_policy.json"

_PHONE_TOOL_CAPS = {
    "twilio_sms": ("send_sms", "spend_money"),
    "device_sms": ("send_sms",),
    "twilio_call_and_wait": ("outbound_calls", "spend_money"),
    "call_user": ("outbound_calls",),
    "call_user_and_wait": ("outbound_calls",),
    "call_extension": ("outbound_calls",),
    "store_memory": ("access_memory",),
    "search_memory": ("access_memory",),
}
_PHONE_CAP_DEFAULTS = {
    "send_sms": "ask", "outbound_calls": "allow", "spend_money": "ask",
    "access_memory": "allow",
}
_PHONE_STRICT = {"allow": 0, "ask": 1, "deny": 2}


def phone_policy_file() -> Path:
    override = os.environ.get("JARVIS_PHONE_POLICY_FILE")
    return Path(override) if override else _PHONE_POLICY_DEFAULT_FILE


def _phone_values() -> dict:
    """Load the phone_policy.json capability map. Missing/corrupt => all defaults."""
    try:
        doc = json.loads(phone_policy_file().read_text(encoding="utf-8"))
        caps = doc.get("capabilities")
        return caps if isinstance(caps, dict) else {}
    except Exception:
        return {}


def _phone_inner_name(tool: str, arguments: Any) -> str:
    """Resolve the real phone tool name, unwrapping the phone_tool(tool=...) hatch."""
    if tool == "phone_tool" and isinstance(arguments, dict):
        inner = arguments.get("tool")  # phone_tool's arg key is `tool`, not `name`
        if isinstance(inner, str) and inner.strip():
            return inner.strip()
    return tool


def _phone_escalates(tool: str, arguments: Any) -> bool:
    """True if a call_user_and_wait opts into the billable Twilio escalation
    (escalate_to_twilio) — whether called directly or via the phone_tool hatch."""
    if not isinstance(arguments, dict):
        return False
    if tool == "phone_tool":
        try:
            inner = json.loads(arguments.get("arguments_json") or "{}")
        except Exception:
            return False
        return bool(isinstance(inner, dict) and inner.get("escalate_to_twilio"))
    return bool(arguments.get("escalate_to_twilio"))


def _phone_decision(tool: str, arguments: Any) -> str:
    """-> allow|ask|deny for a phone tool (strictest of its gating capabilities).

    Mirrors core/src/PhonePolicyStore.cpp decisionForTool(), incl. the two
    argument-dependent cases: screening tools gated against answer_calls, and
    call_user_and_wait's escalate_to_twilio folding in spend_money."""
    name = _phone_inner_name(tool, arguments)
    values = _phone_values()
    # Screening tools gated against answer_calls so the brain can't desync the
    # policy by flipping screening directly (deny the CONTRADICTING tool only).
    ac = str(values.get("answer_calls", "screen_unknown"))
    if name == "twilio_screening_disable" and ac == "screen_unknown":
        return "deny"
    if name == "twilio_screening_enable" and ac == "allowed_only":
        return "deny"
    caps = list(_PHONE_TOOL_CAPS.get(name, ()))
    if name == "call_user_and_wait" and _phone_escalates(tool, arguments) \
            and "spend_money" not in caps:
        caps.append("spend_money")
    if not caps:
        return "allow"
    worst = "allow"
    for cap in caps:
        v = str(values.get(cap, _PHONE_CAP_DEFAULTS.get(cap, "allow")))
        if v not in _PHONE_STRICT:
            v = "allow"
        if _PHONE_STRICT[v] > _PHONE_STRICT[worst]:
            worst = v
    return worst


def _phone_gate(tool: str, arguments: Any) -> None:
    """Enforce Phone → Permissions for the brain's phone tools (deny + ask).

    The daemon already hard-denies at phone.mcp; this fails fast on deny AND is
    the only place the interactive 'ask' is enforced for the brain (the daemon
    has no ask-bus). Ungated tools return immediately.
    """
    decision = _phone_decision(tool, arguments)
    if decision == "allow":
        return
    inner = _phone_inner_name(tool, arguments)
    if decision == "deny":
        _log(inner, "phone", "deny", {"id": "phone_policy"}, False)
        raise PermissionError(
            f"Blocked by Phone Permissions: '{inner}' is set to Deny. Do not"
            " retry; tell the user it's disabled in Phone → Permissions."
        )
    # ask
    q = f"Cindro wants to use the phone tool '{inner}'. Allow it?"
    try:
        res = ask_bus.ask(q, ["Allow", "Deny"], timeout=_ASK_TIMEOUT)
        answer = str((res or {}).get("answer", "")).strip().lower()
    except Exception:
        answer = ""
    if answer == "allow":
        _log(inner, "phone", "ask", {"id": "phone_policy"}, True)
        return
    _log(inner, "phone", "ask", {"id": "phone_policy"}, False)
    raise PermissionError(
        f"Phone Permissions required approval for '{inner}' and the user"
        f" {'denied it' if answer == 'deny' else 'did not approve in time'}."
        " Do not retry."
    )


# --- pre-exec command scanner (jarvis#76 feature 12) ------------------------
# The free-form command tools run their `command` arg via subprocess(shell=True)
# in a DETACHED runner — this call_tool wrapper is the ONLY window to inspect it.
_CMD_TOOLS = {"bg_start", "monitor", "watch", "widget_live", "app_launch"}


def _log_cmd(tool: str, cmd: str, hit: "cmd_scan.Result",
             decision: str, allowed: bool) -> None:
    """Audit a command-scan decision to the same policy log (never fatal)."""
    try:
        _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(cmd.encode("utf-8", "replace")).hexdigest()[:12]
        with _LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": int(time.time() * 1000),
                "session": os.environ.get("JARVIS_AGENT_SESSION", ""),
                "tool": tool, "kind": "cmd_scan",
                "cmd_prefix": cmd[:60], "cmd_hash": digest,
                "reason": hit.reason, "severity": hit.severity,
                "cues": hit.cues, "decision": decision, "allowed": allowed,
            }) + "\n")
    except Exception:
        pass  # audit must never break the tool path


def _scan_command(tool: str, arguments: Any) -> None:
    """Scan bg_start/monitor/watch/widget_live shell `command` args.

    Runs inside the call_tool gate AFTER the trust-policy gate. A risky command
    routes to the SAME ask-bus flow as an `ask` policy (Allow / Deny); anything
    but an explicit Allow raises PermissionError, blocking the detached shell
    runner before it spawns. Disable entirely with env ``JARVIS_CMD_SCAN=0``.
    """
    if os.environ.get("JARVIS_CMD_SCAN", "1") == "0":
        return
    if tool not in _CMD_TOOLS or not isinstance(arguments, dict):
        return
    # All four command tools take a top-level `command`; widget_live MAY
    # additionally carry a nested `spec.command` — scan both if present.
    # app_launch's raw-command capability uses a different arg key ('app')
    # and must be scanned unconditionally (it defaults to the real host seat).
    candidates: list[str] = []
    top = arguments.get("command")
    if isinstance(top, str) and top.strip():
        candidates.append(top)
    spec = arguments.get("spec")
    if isinstance(spec, dict):
        sc = spec.get("command")
        if isinstance(sc, str) and sc.strip() and sc not in candidates:
            candidates.append(sc)
    if tool == "app_launch":
        app_arg = arguments.get("app")
        if isinstance(app_arg, str) and app_arg.strip() and app_arg not in candidates:
            candidates.append(app_arg)

    for cmd in candidates:
        hit = cmd_scan.scan(cmd)
        if not hit.risky:
            continue
        q = f"Command flagged ({hit.reason}): {cmd[:120]}. Allow?"
        try:
            res = ask_bus.ask(q, ["Allow", "Deny"], timeout=_ASK_TIMEOUT)
            answer = str((res or {}).get("answer", "")).strip().lower()
        except Exception:
            answer = ""
        if answer == "allow":
            _log_cmd(tool, cmd, hit, "allow", True)
            continue
        _log_cmd(tool, cmd, hit, "deny", False)
        raise PermissionError(f"command blocked by scanner: {hit.reason}")


# --- TUI custom "log" page approval gate -------------------------------------
# tui_add_page/tui_edit_page (cli/jarvis_cli) let the model make the terminal
# client auto-display and live-tail an arbitrary local file (kind == "log").
# Arbitrary paths are the intended feature (no allow-list) but disclosing a
# file's contents to the model needs the same explicit-approval gate as any
# other filesystem read outside the sandbox. Ask once per path; a path the
# user already approved (via add or a prior edit) is not re-asked.
_TUI_LOG_TOOLS = {"tui_add_page", "tui_edit_page"}
_approved_log_paths: set[str] = set()


def _tui_log_path(arguments: dict) -> str | None:
    config = arguments.get("config")
    if isinstance(config, str):
        try:
            config = json.loads(config) if config.strip() else {}
        except Exception:
            return None
    if not isinstance(config, dict):
        return None
    path = config.get("path")
    return path if isinstance(path, str) and path.strip() else None


def _scan_tui_layout(tool: str, arguments: Any) -> None:
    """Gate a custom TUI 'log' page's file path behind an explicit Allow.

    tui_add_page carries `kind` directly, so it only gates when kind=='log'.
    tui_edit_page only replaces `config` (kind is fixed at creation and not
    resent), so a non-empty config.path there is treated as a log-page path
    too — every OTHER kind's config shape (table/markdown/widget/list) is
    documented without a `path` key. Disable with env ``JARVIS_CMD_SCAN=0``
    (same escape hatch as the command scanner; both gate model-supplied
    filesystem/process access before the daemon call).
    """
    if os.environ.get("JARVIS_CMD_SCAN", "1") == "0":
        return
    if tool not in _TUI_LOG_TOOLS or not isinstance(arguments, dict):
        return
    if tool == "tui_add_page" and str(arguments.get("kind") or "") != "log":
        return
    path = _tui_log_path(arguments)
    if not path or path in _approved_log_paths:
        return
    q = f"Cindro wants to add/edit a TUI page that tails local file: {path}. Allow?"
    try:
        res = ask_bus.ask(q, ["Allow", "Deny"], timeout=_ASK_TIMEOUT)
        answer = str((res or {}).get("answer", "")).strip().lower()
    except Exception:
        answer = ""
    if answer == "allow":
        _approved_log_paths.add(path)
        return
    raise PermissionError(
        f"tui '{tool}' blocked: log page path {path!r} was not approved by the user."
    )


# --- PLAN MODE gate ----------------------------------------------------------
# Cindro's own "Plan Mode" (see tools_plan.py): while active, every tool call
# EXCEPT a small read/plan-safe allowlist is hard-denied — not just
# discouraged in the system prompt, but actually blocked here, the one choke
# point every brain's tool call already passes through. Two ways a session
# ends up restricted (daemon-side, `plan.status`):
#   "settings" — the user's global PLAN agent_mode (Settings). Only present_plan's
#                Approve & Build can lift this.
#   "self"     — the model called enter_plan_mode() on its own judgment for THIS
#                session only. The model can lift it itself with exit_plan_mode().
# Session-scoped (the shared global :8794 engine serves multiple concurrent
# sessions — see daemon_client.current_session_id()'s own docstring for the
# same concern) with a short TTL cache so this doesn't add a daemon round-trip
# to every single tool call.
_PLAN_CACHE: dict[str, dict] = {}
_PLAN_CACHE_TTL = float(os.environ.get("JARVIS_PLAN_GATE_TTL", "2.0"))

_PLAN_SAFE_TOOLS = frozenset({
    # Plan output / control
    "present_plan", "enter_plan_mode", "exit_plan_mode",
    # Checklist — the plan IS a todo list
    "todo_write", "todo_read", "todo_add", "todo_edit", "todo_done", "todo_del", "todo_clear",
    # Ask/notify
    "ask_user", "notify_user",
    # Read-only desktop/window introspection
    "session_info", "desktop_screenshot", "window_list", "workspace_list",
    "app_list", "clipboard_get",
    # Read-only browser introspection — NOT navigate/click/type/select/scroll/
    # eval/cdp/tab_new/tab_close/tab_activate
    "browser_status", "browser_tabs", "browser_snapshot", "browser_screenshot",
    "browser_console",
    # Subagent research fan-out — planning is explicitly allowed to delegate
    "agent_create", "agent_list", "agent_get", "agent_start", "agent_wait",
    "agent_status", "agent_result", "agent_stop", "agent_send",
    "agent_committee", "agent_moa",
    # Read-only self-management
    "list_skills", "get_skill", "skill_load", "list_schedules", "queue_list",
    "session_search", "list_memories", "hooks_list",
    # Read-only background-job / LSP introspection
    "bg_status", "bg_logs", "bg_list", "bg_wait", "lsp_diagnostics", "lsp_server_status",
    # Read-only TUI/command introspection
    "tui_list_pages", "list_slash_commands", "workflow_list",
    # Video analysis (consumption only, no external side effect). Codex review
    # (PR #130/#132): video_setup/video_configure/video_watch were WRONGLY
    # here — video_setup(prewarm=true) downloads/loads a multi-GB whisper
    # model, video_configure writes persistent settings and can wipe the
    # cached-frame store (clear_sessions=true), and video_watch downloads
    # remote videos, populates caches, and can invoke cloud transcription.
    # Only the read-only inspection tools belong in a Plan-Mode allowlist
    # (allowlisted tools skip _plan_status() entirely).
    "video_info", "video_analyze", "video_detail",
})


def _plan_status() -> tuple[bool, str]:
    """-> (restricted, source in {"settings","self","approved","","unreachable",
    "ambiguous_session"}). Session-scoped, TTL-cached.

    A cache MISS runs a synchronous, blocking daemon round-trip on the calling
    coroutine (same tradeoff gate()'s ask-bus flow already accepts elsewhere in
    this file) — acceptable at a ~2s TTL. current_session_id() is itself
    uncached and can fall back to an extra "session.list" round-trip on the
    shared global engine (no JARVIS_AGENT_SESSION); when it can't disambiguate
    (2+ concurrent sessions, no way to tell which is calling) this fails
    CLOSED ("ambiguous_session") rather than querying plan.status with an
    empty id, which would ask the wrong question and could leak another
    session's status into this one's cache entry."""
    try:
        sid = daemon_client.current_session_id()
    except Exception:
        sid = ""
    if not sid:
        # Codex review (PR #130): an empty sid means the shared global engine
        # couldn't tell which of its concurrent sessions is calling (see
        # current_session_id()'s docstring). Querying plan.status with "" asks
        # the WRONG question — if some OTHER session happens to be unrestricted,
        # or "" was never marked restricted, this reports unrestricted and the
        # cache then lets THIS call's write tools through for up to the TTL,
        # defeating session-scoped enforcement in exactly the concurrent case
        # this module calls out. Fail closed instead of guessing, same
        # deliberate deviation as the "unreachable" branch below.
        return True, "ambiguous_session"
    now = time.time()
    cached = _PLAN_CACHE.get(sid)
    if cached and now - cached["ts"] < _PLAN_CACHE_TTL:
        return cached["restricted"], cached["source"]
    try:
        res = daemon_client.call("plan.status", {"session_id": sid}, timeout=5)
        restricted, source = bool(res.get("restricted", False)), str(res.get("source", ""))
    except Exception:
        # Deliberate deviation from this file's usual fail-OPEN convention: plan
        # mode's whole contract is a safety guarantee, so an unreachable daemon
        # must not silently grant full write access. Mirrors gate()'s ask flow,
        # which already fails CLOSED (a timed-out ask is a deny).
        restricted, source = True, "unreachable"
    _PLAN_CACHE[sid] = {"ts": now, "restricted": restricted, "source": source}
    return restricted, source


def bust_plan_cache(session_id: str = "") -> None:
    """Force the next _plan_status() call to re-fetch. Call this right after
    present_plan/enter_plan_mode/exit_plan_mode change server-side state, so the
    SAME turn doesn't spuriously stay gated for up to _PLAN_CACHE_TTL."""
    sid = session_id or daemon_client.current_session_id()
    _PLAN_CACHE.pop(sid, None)


def _plan_mode_gate(tool: str, arguments: Any) -> None:
    if tool in _PLAN_SAFE_TOOLS:
        return
    restricted, source = _plan_status()
    if not restricted:
        return
    _log(tool, "", "deny", {"id": "plan_mode"}, False)
    raise PermissionError(
        f"Blocked: PLAN mode is active ({source}) — '{tool}' is a write/execute "
        "action and is not allowed while planning. Keep researching (read-only "
        "tools, agent_start/agent_wait for subagent research, todo_write for "
        "your checklist) and call present_plan when the plan is ready."
    )


def install(mcp) -> None:
    """Wrap FastMCP's ToolManager.call_tool so EVERY tool passes the gate."""
    mgr = mcp._tool_manager
    if getattr(mgr, "_jarvis_policy_gated", False):
        return
    orig = mgr.call_tool

    async def gated_call_tool(name: str, arguments: dict, *args, **kwargs):
        _plan_mode_gate(name, arguments)  # PLAN mode: hard deny, no ask-bus escalation
        gate(name)  # trust policy: raises to reject; FastMCP turns it into an error
        _phone_gate(name, arguments)  # phone permissions: deny + interactive ask
        _scan_command(name, arguments)  # command scanner: raises to reject
        _scan_tui_layout(name, arguments)  # tui log-page path approval: raises to reject
        return await orig(name, arguments, *args, **kwargs)

    mgr.call_tool = gated_call_tool
    mgr._jarvis_policy_gated = True
