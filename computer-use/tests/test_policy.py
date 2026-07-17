"""Trust-policy gate (jarvis#71): evaluation precedence, gating, ask flow."""

import json
import threading
import time
from pathlib import Path

import pytest

from computer_use_mcp import policy


@pytest.fixture(autouse=True)
def _default_plan_mode_unrestricted(monkeypatch):
    """This file is about the trust-policy/phone/cmd-scan gates, not PLAN mode
    — default _plan_status() to unrestricted (via a fake daemon_client) so
    every pre-existing test here stays decoupled from a real daemon. The
    PLAN-MODE-specific tests below re-monkeypatch daemon_client.call/
    current_session_id themselves, which simply overrides this default for
    the remainder of that test."""
    from computer_use_mcp import daemon_client

    policy._PLAN_CACHE.clear()
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "autouse-session")
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0: {"restricted": False, "source": ""})
    yield
    policy._PLAN_CACHE.clear()


def write_rules(tmp_path, monkeypatch, rules, default="allow"):
    f = tmp_path / "trust_policies.json"
    f.write_text(json.dumps({"version": 1, "default": default, "rules": rules}))
    monkeypatch.setenv("JARVIS_TRUST_POLICIES_FILE", str(f))
    policy._cache.update(mtime=None, path=None, doc=None)
    return f


def test_no_rules_allows_everything(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [])
    assert policy.evaluate("mouse_click", "")[0] == "allow"
    policy.gate("mouse_click")  # must not raise


def test_missing_file_allows(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_TRUST_POLICIES_FILE", str(tmp_path / "nope.json"))
    policy._cache.update(mtime=None, path=None, doc=None)
    assert policy.evaluate("anything", "")[0] == "allow"


def test_corrupt_file_allows_and_recovers(tmp_path, monkeypatch):
    f = tmp_path / "trust_policies.json"
    f.write_text("{not json")
    monkeypatch.setenv("JARVIS_TRUST_POLICIES_FILE", str(f))
    policy._cache.update(mtime=None, path=None, doc=None)
    assert policy.evaluate("mouse_click", "")[0] == "allow"
    f.write_text(json.dumps({"version": 1, "default": "allow", "rules": [
        {"id": "r", "tool": "mouse_click", "app": "*", "action": "deny"}]}))
    assert policy.evaluate("mouse_click", "")[0] == "deny"


def test_deny_rule_blocks(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [
        {"id": "no-files", "tool": "file_*", "app": "*", "action": "deny"}])
    assert policy.evaluate("file_read", "")[0] == "deny"
    with pytest.raises(PermissionError) as e:
        policy.gate("file_read")
    assert "no-files" in str(e.value)
    policy.gate("mouse_click")  # unmatched tool stays allowed


def test_most_specific_wins_over_order(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [
        {"id": "broad", "tool": "browser_*", "app": "*", "action": "deny"},
        {"id": "narrow", "tool": "browser_click", "app": "*", "action": "allow"},
    ])
    assert policy.evaluate("browser_click", "")[1]["id"] == "narrow"
    assert policy.evaluate("browser_navigate", "")[1]["id"] == "broad"


def test_tie_goes_to_earliest_rule(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [
        {"id": "first", "tool": "key_press", "app": "*", "action": "ask"},
        {"id": "second", "tool": "key_press", "app": "*", "action": "deny"},
    ])
    action, rule = policy.evaluate("key_press", "")
    assert (action, rule["id"]) == ("ask", "first")


def test_app_pattern_matching(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [
        {"id": "bank", "tool": "*", "app": "*bank*", "action": "deny"}])
    assert policy.evaluate("mouse_click", "firefox|My Bank — login")[0] == "deny"
    assert policy.evaluate("mouse_click", "firefox|news site")[0] == "allow"


def test_default_deny(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [
        {"id": "ok", "tool": "todo_*", "app": "*", "action": "allow"}],
        default="deny")
    assert policy.evaluate("todo_write", "")[0] == "allow"
    assert policy.evaluate("mouse_click", "")[0] == "deny"


def test_ask_exempt_tools_skip_ask_but_not_deny(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [
        {"id": "ask-all", "tool": "*", "app": "*", "action": "ask"}])
    policy.gate("ask_user")  # exempt from ASK -> allowed without a question
    write_rules(tmp_path, monkeypatch, [
        {"id": "deny-all", "tool": "*", "app": "*", "action": "deny"}])
    with pytest.raises(PermissionError):
        policy.gate("ask_user")  # deny still applies


def test_ask_flow_allow_and_deny(tmp_path, monkeypatch):
    write_rules(tmp_path, monkeypatch, [
        {"id": "ask-shell", "tool": "mouse_*", "app": "*", "action": "ask",
         "note": "clicks are risky"}])
    monkeypatch.setenv("JARVIS_QUESTIONS_DIR", str(tmp_path / "q"))

    def answer(with_text):
        qdir = tmp_path / "q"
        deadline = time.time() + 5
        while time.time() < deadline:
            pending = [p for p in qdir.glob("*.json")] if qdir.exists() else []
            if pending:
                qid = pending[0].stem
                (qdir / f"{qid}.answer").write_text(json.dumps({"answer": with_text}))
                return
            time.sleep(0.02)

    t = threading.Thread(target=answer, args=("Allow",)); t.start()
    policy.gate("mouse_click")  # approved -> no raise
    t.join()

    t = threading.Thread(target=answer, args=("Deny",)); t.start()
    with pytest.raises(PermissionError):
        policy.gate("mouse_move")
    t.join()


def test_decisions_are_logged(tmp_path, monkeypatch):
    log = tmp_path / "policy_log.jsonl"
    monkeypatch.setattr(policy, "_LOG_FILE", log)
    write_rules(tmp_path, monkeypatch, [
        {"id": "no-sms", "tool": "device_sms", "app": "*", "action": "deny"}])
    with pytest.raises(PermissionError):
        policy.gate("device_sms")
    row = json.loads(log.read_text().strip().splitlines()[-1])
    assert row["tool"] == "device_sms" and row["allowed"] is False
    assert row["rule"] == "no-sms"


def test_install_wraps_tool_manager():
    class Mgr:
        async def call_tool(self, name, arguments, *a, **kw):
            return "ran:" + name

    class Fake:
        _tool_manager = Mgr()

    fake = Fake()
    policy.install(fake)
    assert getattr(fake._tool_manager, "_jarvis_policy_gated") is True
    before = fake._tool_manager.call_tool
    policy.install(fake)  # idempotent
    assert fake._tool_manager.call_tool is before


def test_cmd_scanner_gates_free_form_commands(tmp_path, monkeypatch):
    """jarvis#76 f12: the command scanner routes a risky command through the
    ask-bus in the SAME call_tool wrapper; deny blocks, allow proceeds, and
    JARVIS_CMD_SCAN=0 bypasses it entirely."""
    import asyncio

    from computer_use_mcp import ask_bus, cmd_scan

    write_rules(tmp_path, monkeypatch, [])  # trust gate allows everything
    monkeypatch.setattr(policy, "_LOG_FILE", tmp_path / "policy_log.jsonl")

    class Mgr:
        async def call_tool(self, name, arguments, *a, **kw):
            return "ran:" + name

    class Fake:
        _tool_manager = Mgr()

    fake = Fake()
    policy.install(fake)
    call = fake._tool_manager.call_tool
    fork = ":(){ :|:& };:"

    # Force the scanner to flag regardless of the actual command text.
    monkeypatch.setattr(cmd_scan, "scan", lambda cmd: cmd_scan.Result(
        risky=True, reason="fork bomb", cues=["fork bomb"], severity="high"))

    # Deny -> PermissionError from the scanner (the detached runner never spawns).
    monkeypatch.setattr(ask_bus, "ask", lambda *a, **k: {"answer": "Deny"})
    with pytest.raises(PermissionError) as e:
        asyncio.run(call("bg_start", {"command": fork}))
    assert "blocked by scanner" in str(e.value)

    # Allow -> proceeds to the real tool.
    monkeypatch.setattr(ask_bus, "ask", lambda *a, **k: {"answer": "Allow"})
    assert asyncio.run(call("monitor", {"command": fork})) == "ran:monitor"

    # A timeout / no-answer is treated as deny.
    monkeypatch.setattr(ask_bus, "ask", lambda *a, **k: {"answer": ""})
    with pytest.raises(PermissionError):
        asyncio.run(call("watch", {"command": fork}))

    # Escape hatch: JARVIS_CMD_SCAN=0 skips scanning (ask must NOT be consulted).
    def _boom(*a, **k):
        raise AssertionError("ask_bus.ask called while scanning disabled")

    monkeypatch.setattr(ask_bus, "ask", _boom)
    monkeypatch.setenv("JARVIS_CMD_SCAN", "0")
    assert asyncio.run(call("bg_start", {"command": fork})) == "ran:bg_start"

    # Non-command tools are never scanned (scan would flag, but it isn't called).
    monkeypatch.delenv("JARVIS_CMD_SCAN", raising=False)
    assert asyncio.run(call("mouse_click", {"x": 1})) == "ran:mouse_click"

    # The deny decision was audited to the policy log.
    rows = [json.loads(l) for l in
            (tmp_path / "policy_log.jsonl").read_text().splitlines() if l]
    denials = [r for r in rows if r.get("kind") == "cmd_scan" and not r["allowed"]]
    assert denials and denials[0]["reason"] == "fork bomb"


# --- C++/Python trust-policy glob-matching parity conformance --------------
# core/src/TrustPolicyStore.cpp's globMatch() (Settings "test rule" preview +
# the command.shell gate) must match this module's fnmatchcase-based matching
# in evaluate() — the REAL enforcement / source of truth — on every pattern.
# Both consume the SAME fixture, core/tests/fixtures/trust_policy_vectors.json
# (also read by core/tests/trust_policy_test.cpp), so a divergence is caught
# on either side without hand-duplicating cases. See that file's "_schema"
# key for the vector shape: each vector is one glob-match probe
# {"pattern", "value", "tool": bool, "app": bool, "expected": bool, "note"},
# where exactly one of tool/app selects which of evaluate()'s two matching
# contexts to probe (tool = case-sensitive; app = case-insensitive, mirroring
# `if not fnmatchcase(tool, tpat)` / `fnmatchcase((app or "").lower(),
# apat.lower())` there). This test exercises fnmatchcase EXACTLY the way
# evaluate() does — it does not change policy.py's matching logic (fnmatchcase
# stays the source of truth) — and skips (does not fail) if the fixture
# doesn't exist yet.
# --- PLAN MODE gate (_plan_mode_gate) ---------------------------------------


def _reset_plan_cache():
    policy._PLAN_CACHE.clear()


def test_plan_status_session_scoped_and_cached(monkeypatch):
    from computer_use_mcp import daemon_client

    _reset_plan_cache()
    calls = []

    def fake_current_session_id(default=""):
        return "sess-a"

    def fake_call(method, params=None, timeout=15.0):
        calls.append((method, params))
        return {"restricted": True, "source": "settings"}

    monkeypatch.setattr(daemon_client, "current_session_id", fake_current_session_id)
    monkeypatch.setattr(daemon_client, "call", fake_call)

    assert policy._plan_status() == (True, "settings")
    assert policy._plan_status() == (True, "settings")
    assert len(calls) == 1, "second call within TTL must hit the cache, not the daemon"

    # A different session id gets its own cache entry (shared global engine —
    # must not leak session A's status onto session B).
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "sess-b")
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0:
                         calls.append((method, params)) or {"restricted": False, "source": ""})
    assert policy._plan_status() == (False, "")
    assert len(calls) == 2, "a different session must NOT reuse session A's cache entry"


def test_plan_status_fails_closed(monkeypatch):
    from computer_use_mcp import daemon_client

    _reset_plan_cache()
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "sess-x")

    def boom(method, params=None, timeout=15.0):
        raise RuntimeError("daemon unreachable")

    monkeypatch.setattr(daemon_client, "call", boom)
    # Deliberate deviation from this module's usual fail-OPEN convention: PLAN
    # mode is a safety guarantee, so an unreachable daemon must NOT silently
    # grant full write access.
    assert policy._plan_status() == (True, "unreachable")


def test_plan_status_fails_closed_on_ambiguous_session(monkeypatch):
    # Codex review (PR #130): an empty current_session_id() (0 or 2+ sessions
    # running on the shared global engine) must not query plan.status with ""
    # — some other session's cached state (or lack of it) could read back as
    # unrestricted and get cached under the empty key for this call too.
    from computer_use_mcp import daemon_client

    _reset_plan_cache()
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "")

    calls = []
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0:
                         calls.append((method, params)) or {"restricted": False, "source": ""})

    assert policy._plan_status() == (True, "ambiguous_session")
    assert not calls, "must fail closed WITHOUT querying plan.status for an ambiguous session"


def test_bust_plan_cache_forces_refetch(monkeypatch):
    from computer_use_mcp import daemon_client

    _reset_plan_cache()
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "sess-c")
    calls = []
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0:
                         calls.append(1) or {"restricted": True, "source": "self"})

    assert policy._plan_status() == (True, "self")
    assert policy._plan_status() == (True, "self")
    assert len(calls) == 1  # still cached

    policy.bust_plan_cache("sess-c")
    assert policy._plan_status() == (True, "self")
    assert len(calls) == 2  # cache was busted -> re-fetched


def test_plan_mode_gate_denies_unsafe_allows_safe(tmp_path, monkeypatch):
    import asyncio

    from computer_use_mcp import daemon_client

    _reset_plan_cache()
    write_rules(tmp_path, monkeypatch, [])  # trust gate: allow all
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "sess-plan")
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0:
                         {"restricted": True, "source": "settings"})

    class Mgr:
        async def call_tool(self, name, arguments, *a, **kw):
            return "ran:" + name

    class Fake:
        _tool_manager = Mgr()

    fake = Fake()
    policy.install(fake)
    call = fake._tool_manager.call_tool

    # A write/execute tool is hard-denied while restricted, with NO ask-bus
    # escalation (unlike trust-policy "ask" rules).
    with pytest.raises(PermissionError) as e:
        asyncio.run(call("mouse_click", {}))
    assert "PLAN mode is active" in str(e.value)

    # present_plan / agent_start / todo_write / read tools stay callable.
    for safe_tool in ("present_plan", "agent_start", "todo_write", "enter_plan_mode",
                       "exit_plan_mode", "agent_send"):
        assert asyncio.run(call(safe_tool, {})) == "ran:" + safe_tool


def test_plan_mode_gate_noop_when_unrestricted(tmp_path, monkeypatch):
    import asyncio

    from computer_use_mcp import daemon_client

    _reset_plan_cache()
    write_rules(tmp_path, monkeypatch, [])  # isolate from this machine's real trust policy
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "sess-free")
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0:
                         {"restricted": False, "source": ""})

    class Mgr:
        async def call_tool(self, name, arguments, *a, **kw):
            return "ran:" + name

    class Fake:
        _tool_manager = Mgr()

    fake = Fake()
    policy.install(fake)
    assert asyncio.run(fake._tool_manager.call_tool("mouse_click", {})) == "ran:mouse_click"


def test_plan_mode_gate_runs_before_trust_policy(tmp_path, monkeypatch):
    """The plan gate must be wired FIRST, ahead of the trust-policy gate's own
    'ask' escalation — not merely "also denies" (an 'allow' rule can't tell
    the two orderings apart, since _plan_mode_gate raises unconditionally
    either way). Use an 'ask' trust rule and prove ask_bus is NEVER consulted:
    if the trust gate ran first, it would call ask_bus.ask() before the plan
    gate ever got a chance to raise its own denial."""
    import asyncio

    from computer_use_mcp import ask_bus, daemon_client

    _reset_plan_cache()
    write_rules(tmp_path, monkeypatch, [
        {"id": "ask-first", "tool": "mouse_click", "app": "*", "action": "ask"}])
    monkeypatch.setattr(daemon_client, "current_session_id", lambda default="": "sess-priority")
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0:
                         {"restricted": True, "source": "self"})

    def _boom(*a, **k):
        raise AssertionError("ask_bus.ask called -- trust-policy gate ran before the plan gate")

    monkeypatch.setattr(ask_bus, "ask", _boom)

    class Mgr:
        async def call_tool(self, name, arguments, *a, **kw):
            return "ran:" + name

    class Fake:
        _tool_manager = Mgr()

    fake = Fake()
    policy.install(fake)
    with pytest.raises(PermissionError) as e:
        asyncio.run(fake._tool_manager.call_tool("mouse_click", {}))
    assert "PLAN mode is active" in str(e.value)


def _trust_policy_fixture_path() -> Path:
    # computer-use/tests/test_policy.py -> repo root is two parents up.
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "core" / "tests" / "fixtures" / "trust_policy_vectors.json"


def test_glob_matching_matches_shared_cpp_fixture():
    from fnmatch import fnmatchcase

    fixture_path = _trust_policy_fixture_path()
    if not fixture_path.exists():
        pytest.skip(f"shared conformance fixture not present yet: {fixture_path}")
    doc = json.loads(fixture_path.read_text(encoding="utf-8"))
    vectors = doc["vectors"] if isinstance(doc, dict) else doc
    assert vectors, f"{fixture_path} is present but has no vectors"

    for i, vec in enumerate(vectors):
        pattern, value = vec["pattern"], vec["value"]
        is_tool, is_app = bool(vec["tool"]), bool(vec["app"])
        assert is_tool != is_app, f"vector {i}: exactly one of tool/app must be true"
        if is_tool:
            # Tool-field matching in evaluate(): case-sensitive, as-is.
            matched = fnmatchcase(value, pattern)
        else:
            # App-field matching in evaluate(): case-insensitive.
            matched = fnmatchcase(value.lower(), pattern.lower())
        assert matched == vec["expected"], (
            f"vector {i} ({vec.get('note', '')!r}): "
            f"fnmatchcase(pattern={pattern!r}, value={value!r}, "
            f"{'tool' if is_tool else 'app'}-mode) = {matched!r}, expected {vec['expected']!r}"
        )
