"""Agent Committee Mode (jarvis#69): parallel dispatch + judge, over a mocked
daemon_client (no real daemon / subagents)."""

import json

import pytest

from computer_use_mcp import daemon_client, tools_jarvis_ops


class FakeMcp:
    """Captures @mcp.tool()-decorated funcs so we can call agent_committee."""

    def __init__(self):
        self.tools = {}

    def tool(self, *a, **k):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture
def committee(monkeypatch, tmp_path):
    import time as _t
    monkeypatch.setattr(_t, "sleep", lambda s: None)
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "parent-1")
    m = FakeMcp()
    tools_jarvis_ops.register(m)
    return m.tools["agent_committee"]


def make_daemon(monkeypatch, results):
    """results: {session_id: {status, summary}}. dispatch() hands out ids in order."""
    dispatched = {"n": 0}
    ids = list(results.keys())

    def fake_call(method, params=None, timeout=15.0):
        if method == "agents.dispatch":
            sid = ids[dispatched["n"]]
            dispatched["n"] += 1
            return {"session_id": sid}
        if method == "agents.result":
            sid = params["session_id"]
            r = results.get(sid, {"status": "done", "summary": ""})
            return {"running": False, "status": r["status"], "summary": r["summary"]}
        return {}
    monkeypatch.setattr(daemon_client, "call", fake_call)
    return dispatched


def test_two_members_and_judge(committee, monkeypatch):
    make_daemon(monkeypatch, {
        "m1": {"status": "done", "summary": "solution A"},
        "m2": {"status": "done", "summary": "solution B"},
        "j": {"status": "done", "summary": "A wins because ..."},
    })
    out = json.loads(committee("build X", ["mvp-first", "risk-first"]))
    assert len(out["members"]) == 2
    assert out["members"][0]["strategy"] == "mvp-first"
    assert out["members"][0]["summary"] == "solution A"
    assert out["members"][1]["summary"] == "solution B"
    assert out["verdict"]["summary"].startswith("A wins")


def test_judge_disabled(committee, monkeypatch):
    make_daemon(monkeypatch, {
        "m1": {"status": "done", "summary": "A"},
        "m2": {"status": "done", "summary": "B"},
    })
    out = json.loads(committee("t", ["a", "b"], judge=False))
    assert "verdict" not in out
    assert len(out["members"]) == 2


def test_requires_two_strategies(committee, monkeypatch):
    make_daemon(monkeypatch, {})
    out = json.loads(committee("t", ["only-one"]))
    assert "error" in out


def test_caps_at_six_members(committee, monkeypatch):
    ids = {f"m{i}": {"status": "done", "summary": f"s{i}"} for i in range(6)}
    ids["j"] = {"status": "done", "summary": "verdict"}
    make_daemon(monkeypatch, ids)
    out = json.loads(committee("t", [f"strat{i}" for i in range(10)]))
    assert len(out["members"]) == 6


def test_judge_skipped_when_no_results(committee, monkeypatch):
    make_daemon(monkeypatch, {
        "m1": {"status": "error", "summary": ""},
        "m2": {"status": "error", "summary": ""},
    })
    out = json.loads(committee("t", ["a", "b"]))
    assert out["verdict"]["status"] == "error"
