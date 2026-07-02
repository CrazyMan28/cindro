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

import json
import os
import time
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

from . import ask_bus

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
    q = f"Jarvis wants to run tool '{tool}'"
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


def install(mcp) -> None:
    """Wrap FastMCP's ToolManager.call_tool so EVERY tool passes the gate."""
    mgr = mcp._tool_manager
    if getattr(mgr, "_jarvis_policy_gated", False):
        return
    orig = mgr.call_tool

    async def gated_call_tool(name: str, arguments: dict, *args, **kwargs):
        gate(name)  # raises to reject; FastMCP turns it into a tool error
        return await orig(name, arguments, *args, **kwargs)

    mgr.call_tool = gated_call_tool
    mgr._jarvis_policy_gated = True
