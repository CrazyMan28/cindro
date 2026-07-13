"""Phone Permissions gate (Phone → Permissions): the computer-use side that
enforces 'deny' (fail fast) and 'ask' (interactive) for the brain's phone tools.
The tool->capability map + defaults mirror core/src/PhonePolicyStore.cpp."""

import json

import pytest

from computer_use_mcp import ask_bus, policy


def write_phone_policy(tmp_path, monkeypatch, caps):
    f = tmp_path / "phone_policy.json"
    f.write_text(json.dumps({"version": 1, "capabilities": caps}))
    monkeypatch.setenv("JARVIS_PHONE_POLICY_FILE", str(f))
    return f


def test_missing_file_uses_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_PHONE_POLICY_FILE", str(tmp_path / "nope.json"))
    # Defaults: send_sms=ask, outbound_calls=allow, spend_money=ask, access_memory=allow.
    assert policy._phone_decision("device_sms", {}) == "ask"          # send_sms default
    assert policy._phone_decision("call_user", {}) == "allow"          # outbound_calls default
    assert policy._phone_decision("twilio_call_and_wait", {}) == "ask" # stricter(allow, spend ask)
    assert policy._phone_decision("store_memory", {}) == "allow"       # access_memory default
    assert policy._phone_decision("list_extensions", {}) == "allow"    # ungated


def test_corrupt_file_uses_defaults(tmp_path, monkeypatch):
    f = tmp_path / "phone_policy.json"
    f.write_text("{ not json")
    monkeypatch.setenv("JARVIS_PHONE_POLICY_FILE", str(f))
    assert policy._phone_decision("device_sms", {}) == "ask"


def test_deny_blocks(tmp_path, monkeypatch):
    monkeypatch.setattr(policy, "_LOG_FILE", tmp_path / "log.jsonl")
    write_phone_policy(tmp_path, monkeypatch, {"send_sms": "deny"})
    with pytest.raises(PermissionError):
        policy._phone_gate("twilio_sms", {})
    with pytest.raises(PermissionError):
        policy._phone_gate("device_sms", {})
    policy._phone_gate("list_extensions", {})  # ungated -> no raise


def test_spend_money_is_the_stricter_gate(tmp_path, monkeypatch):
    monkeypatch.setattr(policy, "_LOG_FILE", tmp_path / "log.jsonl")
    # A billed PSTN call denies via spend_money even though outbound_calls=allow.
    write_phone_policy(tmp_path, monkeypatch,
                       {"spend_money": "deny", "outbound_calls": "allow"})
    assert policy._phone_decision("twilio_call_and_wait", {}) == "deny"
    with pytest.raises(PermissionError):
        policy._phone_gate("twilio_call_and_wait", {})
    # In-app call has no PSTN cost -> unaffected by spend_money.
    assert policy._phone_decision("call_user", {}) == "allow"
    policy._phone_gate("call_user", {})  # no raise


def test_ask_flow_allow_and_deny(tmp_path, monkeypatch):
    monkeypatch.setattr(policy, "_LOG_FILE", tmp_path / "log.jsonl")
    write_phone_policy(tmp_path, monkeypatch, {"send_sms": "ask"})

    monkeypatch.setattr(ask_bus, "ask", lambda *a, **k: {"answer": "Allow"})
    policy._phone_gate("device_sms", {})  # approved -> no raise

    monkeypatch.setattr(ask_bus, "ask", lambda *a, **k: {"answer": "Deny"})
    with pytest.raises(PermissionError):
        policy._phone_gate("device_sms", {})


def test_screening_tools_gated_against_answer_calls(tmp_path, monkeypatch):
    monkeypatch.setattr(policy, "_LOG_FILE", tmp_path / "log.jsonl")
    # screen_unknown -> disabling screening would desync the policy: deny it.
    write_phone_policy(tmp_path, monkeypatch, {"answer_calls": "screen_unknown"})
    assert policy._phone_decision("twilio_screening_disable", {}) == "deny"
    assert policy._phone_decision("twilio_screening_enable", {}) == "allow"
    # allowed_only -> the reverse.
    write_phone_policy(tmp_path, monkeypatch, {"answer_calls": "allowed_only"})
    assert policy._phone_decision("twilio_screening_enable", {}) == "deny"
    assert policy._phone_decision("twilio_screening_disable", {}) == "allow"


def test_call_user_and_wait_escalation_is_billable(tmp_path, monkeypatch):
    write_phone_policy(tmp_path, monkeypatch, {"spend_money": "deny", "outbound_calls": "allow"})
    # Plain in-app call is free -> unaffected by spend_money.
    assert policy._phone_decision("call_user_and_wait", {}) == "allow"
    # escalate_to_twilio can fall back to a billable PSTN call -> deny.
    assert policy._phone_decision("call_user_and_wait", {"escalate_to_twilio": True}) == "deny"
    # ...including via the phone_tool escape hatch.
    assert policy._phone_decision(
        "phone_tool",
        {"tool": "call_user_and_wait", "arguments_json": '{"escalate_to_twilio": true}'},
    ) == "deny"


def test_phone_tool_escape_hatch_unwraps_inner_name(tmp_path, monkeypatch):
    monkeypatch.setattr(policy, "_LOG_FILE", tmp_path / "log.jsonl")
    write_phone_policy(tmp_path, monkeypatch, {"send_sms": "deny"})
    # phone_tool(tool="twilio_sms", ...) must be gated by the INNER tool name.
    assert policy._phone_decision("phone_tool", {"tool": "twilio_sms"}) == "deny"
    with pytest.raises(PermissionError):
        policy._phone_gate("phone_tool", {"tool": "twilio_sms"})
    # phone_tool wrapping an ungated tool stays allowed.
    assert policy._phone_decision("phone_tool", {"tool": "list_extensions"}) == "allow"
    policy._phone_gate("phone_tool", {"tool": "list_extensions"})  # no raise
