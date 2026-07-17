"""Plan Mode tools (present_plan/enter_plan_mode/exit_plan_mode), over a
mocked daemon_client/ask_bus (no real daemon / UI)."""

import json

import pytest

from computer_use_mcp import ask_bus, daemon_client, policy, tools_plan


class FakeMcp:
    """Captures @mcp.tool()-decorated funcs so we can call them directly."""

    def __init__(self):
        self.tools = {}

    def tool(self, *a, **k):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture
def tools(monkeypatch):
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "sess-1")
    m = FakeMcp()
    tools_plan.register(m)
    return m.tools


def test_present_plan_approve_grants_session_scoped_override(tools, monkeypatch):
    """Approve & Build must call plan.exit{approved:true} — a SESSION-SCOPED
    override — and must NEVER touch the global settings.set, regardless of
    what the global agent_mode currently is. Approving one session's plan
    flipping the shared global setting would silently unblock a different,
    concurrently-running plan-restricted session whose own plan was never
    shown to the user (Codex review, PR #132 — this test guards the fix)."""
    calls = []
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0: calls.append((method, params)))
    monkeypatch.setattr(ask_bus, "ask",
                         lambda q, opts, timeout=180.0: {"answer": "Approve & Build",
                                                          "answered": True, "timed_out": False})
    busted = []
    monkeypatch.setattr(policy, "bust_plan_cache", lambda sid="": busted.append(sid))

    result = json.loads(tools["present_plan"]("Title", "body", todos=None))
    assert result == {"decision": "approve", "note": ""}
    assert ("plan.exit", {"session_id": "sess-1", "approved": True}) in calls
    assert not any(m == "settings.set" for m, _ in calls), \
        "present_plan must never touch the global agent_mode setting"
    assert not any(m == "settings.get" for m, _ in calls)
    assert busted == ["sess-1"]


def test_present_plan_writes_todos_when_given(tools, monkeypatch):
    written = []
    monkeypatch.setattr(tools_plan, "write_todos", lambda items: written.append(items))
    monkeypatch.setattr(daemon_client, "call", lambda method, params=None, timeout=15.0:
                         {"agent_mode": "coworker"})
    monkeypatch.setattr(ask_bus, "ask",
                         lambda q, opts, timeout=180.0: {"answer": "Request Changes",
                                                          "answered": True, "timed_out": False})
    monkeypatch.setattr(policy, "bust_plan_cache", lambda sid="": None)

    tools["present_plan"]("Title", "body", todos=["step 1", "step 2"])
    assert written == [["step 1", "step 2"]]


def test_present_plan_revise_returns_user_note(tools, monkeypatch):
    monkeypatch.setattr(daemon_client, "call", lambda method, params=None, timeout=15.0: {})
    monkeypatch.setattr(ask_bus, "ask",
                         lambda q, opts, timeout=180.0: {"answer": "make it shorter",
                                                          "answered": True, "timed_out": False})

    result = json.loads(tools["present_plan"]("Title", "body"))
    assert result == {"decision": "revise", "note": "make it shorter"}


def test_present_plan_timeout(tools, monkeypatch):
    monkeypatch.setattr(daemon_client, "call", lambda method, params=None, timeout=15.0: {})
    monkeypatch.setattr(ask_bus, "ask",
                         lambda q, opts, timeout=180.0: {"answer": "", "answered": False,
                                                          "timed_out": True})

    result = json.loads(tools["present_plan"]("Title", "body"))
    assert result == {"decision": "timeout", "note": ""}


def test_present_plan_question_includes_title_and_markdown(tools, monkeypatch):
    seen = {}

    def fake_ask(question, opts, timeout=180.0):
        seen["question"] = question
        seen["opts"] = opts
        return {"answer": "Request Changes", "answered": True, "timed_out": False}

    monkeypatch.setattr(daemon_client, "call", lambda method, params=None, timeout=15.0: {})
    monkeypatch.setattr(ask_bus, "ask", fake_ask)

    tools["present_plan"]("My Plan", "- step one\n- step two")
    assert "My Plan" in seen["question"]
    assert "step one" in seen["question"]
    assert seen["opts"] == ["Approve & Build", "Request Changes"]


def test_enter_plan_mode_calls_plan_enter_and_busts_cache(tools, monkeypatch):
    calls = []
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0: calls.append((method, params)))
    busted = []
    monkeypatch.setattr(policy, "bust_plan_cache", lambda sid="": busted.append(sid))

    result = json.loads(tools["enter_plan_mode"]("investigating a risky refactor"))
    assert calls == [("plan.enter", {"session_id": "sess-1"})]
    assert busted == ["sess-1"]
    assert result == {"ok": True, "reason": "investigating a risky refactor"}


def test_exit_plan_mode_calls_plan_exit_and_busts_cache(tools, monkeypatch):
    calls = []
    monkeypatch.setattr(daemon_client, "call",
                         lambda method, params=None, timeout=15.0: calls.append((method, params)))
    busted = []
    monkeypatch.setattr(policy, "bust_plan_cache", lambda sid="": busted.append(sid))

    result = json.loads(tools["exit_plan_mode"]("done researching"))
    assert calls == [("plan.exit", {"session_id": "sess-1"})]
    assert busted == ["sess-1"]
    assert result == {"ok": True, "summary": "done researching"}


def test_present_plan_never_raises_on_daemon_error(tools, monkeypatch):
    def boom(method, params=None, timeout=15.0):
        raise RuntimeError("daemon unreachable")

    monkeypatch.setattr(ask_bus, "ask", boom)
    result = json.loads(tools["present_plan"]("Title", "body"))
    assert "error" in result
