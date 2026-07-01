"""Trust-policy gate (jarvis#71): evaluation precedence, gating, ask flow."""

import json
import threading
import time

import pytest

from computer_use_mcp import policy


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
