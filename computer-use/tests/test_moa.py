"""Mixture-of-Agents advisory ensemble (jarvis#76 item 10): parallel per-brain
fan-out over a mocked daemon_client (no real daemon / subagents)."""

import json

import pytest

from computer_use_mcp import daemon_client, tools_jarvis_ops


class FakeMcp:
    def __init__(self):
        self.tools = {}

    def tool(self, *a, **k):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture
def moa(monkeypatch):
    import time as _t
    monkeypatch.setattr(_t, "sleep", lambda s: None)
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "parent-1")
    m = FakeMcp()
    tools_jarvis_ops.register(m)
    return m.tools["agent_moa"]


def make_daemon(monkeypatch, results):
    dispatched = {"n": 0, "params": []}
    ids = list(results.keys())

    def fake_call(method, params=None, timeout=15.0):
        if method == "agents.dispatch":
            dispatched["params"].append(params)
            sid = ids[dispatched["n"]]
            dispatched["n"] += 1
            return {"session_id": sid}
        if method == "agents.result":
            r = results.get(params["session_id"], {"status": "done", "summary": ""})
            return {"running": False, "status": r["status"], "summary": r["summary"]}
        return {}

    monkeypatch.setattr(daemon_client, "call", fake_call)
    return dispatched


def test_explicit_advisors_fan_out_per_brain(moa, monkeypatch):
    d = make_daemon(monkeypatch, {
        "a1": {"status": "done", "summary": "codex says X"},
        "a2": {"status": "done", "summary": "claude says Y"},
    })
    out = json.loads(moa("should we shard the db?", [
        {"brain": "codex"},
        {"brain": "claude", "model": "opus", "role": "skeptic: try to refute"},
    ]))
    assert len(out["advisors"]) == 2
    assert d["params"][0]["brain"] == "codex"
    assert d["params"][1]["brain"] == "claude"
    assert d["params"][1]["model"] == "opus"
    assert "skeptic" in d["params"][1]["system_prompt"]
    # parent link threads through so advisors show under this session's tree
    assert all(p["parent_session_id"] == "parent-1" for p in d["params"])
    answers = {a["answer"] for a in out["advisors"]}
    assert answers == {"codex says X", "claude says Y"}
    assert all(a["status"] == "done" for a in out["advisors"])


def test_default_trio_when_no_advisors(moa, monkeypatch):
    d = make_daemon(monkeypatch, {
        "a1": {"status": "done", "summary": "1"},
        "a2": {"status": "done", "summary": "2"},
        "a3": {"status": "done", "summary": "3"},
    })
    out = json.loads(moa("hard question"))
    assert len(out["advisors"]) == 3
    brains = [p.get("brain") for p in d["params"]]
    assert brains == ["codex", "claude", "api"]
    assert d["params"][2]["model"] == "mistral-large-latest"


def test_dispatch_failure_marks_advisor_error(moa, monkeypatch):
    calls = {"n": 0}

    def fake_call(method, params=None, timeout=15.0):
        if method == "agents.dispatch":
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("brain not installed")
            return {"session_id": "ok-1"}
        if method == "agents.result":
            return {"running": False, "status": "done", "summary": "fine"}
        return {}

    monkeypatch.setattr(daemon_client, "call", fake_call)
    out = json.loads(moa("q", [{"brain": "codex"}, {"brain": "claude"}]))
    statuses = [a["status"] for a in out["advisors"]]
    assert statuses.count("error") == 1
    assert statuses.count("done") == 1
    # one failed dispatch never blocks the healthy advisor
    assert out["advisors"][1]["answer"] == "fine"


def test_advisor_cap_at_four(moa, monkeypatch):
    d = make_daemon(monkeypatch, {f"a{i}": {"status": "done", "summary": str(i)}
                                  for i in range(1, 5)})
    out = json.loads(moa("q", [{"brain": "codex"}] * 7))
    assert len(out["advisors"]) == 4
    assert d["n"] == 4
