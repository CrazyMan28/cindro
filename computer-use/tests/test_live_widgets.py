"""Live-widget lifecycle + viewer-gating (battery) contracts.

The live-widget engine must:
  * STOP a job's work when the canvas/widget is deleted (canvas_del/widget_del),
  * only do work (shell exec + bus append) while a fresh VIEWER lease covers the
    job — otherwise idle (battery), and resume when a viewer reappears,
  * a pinned home-screen widget keeps it alive but at a >=60s cadence floor,
  * dedup unchanged values, but force a render on the first tick after a viewer
    newly appears so a freshly-opened view sees current state.

Hermetic: every on-disk dir is redirected to tmp via env, mirroring how
test_render_widget.py redirects JARVIS_WIDGETS_LOG.
"""

from __future__ import annotations

import json

import pytest

from computer_use_mcp import live_widgets, widgets_bus


@pytest.fixture
def env(tmp_path, monkeypatch):
    jobs = tmp_path / "jobs"
    viewers = tmp_path / "viewers"
    bus = tmp_path / "widgets.jsonl"
    pidf = tmp_path / "sup.pid"
    monkeypatch.setenv("JARVIS_WIDGET_JOBS", str(jobs))
    monkeypatch.setenv("JARVIS_WIDGET_VIEWERS", str(viewers))
    monkeypatch.setenv("JARVIS_WIDGETS_LOG", str(bus))
    monkeypatch.setenv("JARVIS_WIDGET_SUPERVISOR_PID", str(pidf))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    # Never spawn the real detached supervisor process from a unit test; the tick
    # logic is exercised directly via Supervisor.tick().
    monkeypatch.setattr(live_widgets, "ensure_supervisor", lambda: 0)
    return {"jobs": jobs, "viewers": viewers, "bus": bus, "pidf": pidf}


def _bus_lines(path):
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def _job(jid="w1", session_id="", interval=5):
    return {
        "id": jid,
        "command": "echo hi",
        "interval_sec": interval,
        "template": {"type": "text", "text": "{{value}}"},
        "title": "",
        "target": "canvas",
        "session_id": session_id,
    }


# --- coverage ------------------------------------------------------------

def test_no_lease_is_not_covered():
    covered, viewer = live_widgets.coverage(_job("w1", "s1"), [])
    assert covered is False and viewer is False


def test_all_lease_covers_any_job_as_viewer():
    leases = [{"scope": "all", "kind": "canvas", "ts": 0}]
    covered, viewer = live_widgets.coverage(_job("w1", "s1"), leases)
    assert covered is True and viewer is True


def test_session_lease_covers_matching_session():
    leases = [{"scope": "s1", "kind": "chat", "ts": 0}]
    assert live_widgets.coverage(_job("w1", "s1"), leases) == (True, True)
    # ...but not a different session
    assert live_widgets.coverage(_job("w1", "s2"), leases) == (False, False)


def test_widget_popout_lease_covers_that_widget():
    leases = [{"scope": "widget:w1", "kind": "popout", "ts": 0}]
    assert live_widgets.coverage(_job("w1", "s1"), leases) == (True, True)
    assert live_widgets.coverage(_job("w2", "s1"), leases)[0] is False


def test_pin_lease_covers_but_is_not_a_viewer():
    leases = [{"scope": "widget:w1", "kind": "pin", "ts": 0}]
    covered, viewer = live_widgets.coverage(_job("w1", "s1"), leases)
    assert covered is True and viewer is False


# --- effective interval --------------------------------------------------

def test_viewer_keeps_natural_interval():
    assert live_widgets.effective_interval(_job(interval=1), viewer=True) == 1.0


def test_pin_only_clamps_to_60s_floor():
    assert live_widgets.effective_interval(_job(interval=1), viewer=False) == 60.0


# --- supervisor tick decisions ------------------------------------------

class _Spy:
    def __init__(self, value="v0"):
        self.value = value
        self.ran = []
        self.emitted = []

    def runner(self, job):
        self.ran.append(job["id"])
        return self.value

    def emitter(self, job, value):
        self.emitted.append((job["id"], value))


def test_uncovered_job_does_no_work():
    sup = live_widgets.Supervisor()
    spy = _Spy()
    sup.tick(now=100.0, jobs=[_job("w1", "s1")], leases=[], runner=spy.runner, emitter=spy.emitter)
    assert spy.ran == [] and spy.emitted == []


def test_newly_covered_job_force_emits():
    sup = live_widgets.Supervisor()
    spy = _Spy("42")
    leases = [{"scope": "all", "kind": "canvas", "ts": 0}]
    sup.tick(now=100.0, jobs=[_job("w1", "s1")], leases=leases, runner=spy.runner, emitter=spy.emitter)
    assert spy.emitted == [("w1", "42")]


def test_unchanged_value_is_deduped_after_first():
    sup = live_widgets.Supervisor()
    spy = _Spy("42")
    leases = [{"scope": "all", "kind": "canvas", "ts": 0}]
    job = _job("w1", "s1", interval=1)
    sup.tick(now=100.0, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)  # force emit
    sup.tick(now=101.5, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)  # due, same value
    assert spy.emitted == [("w1", "42")]  # only the first


def test_changed_value_emits_again():
    sup = live_widgets.Supervisor()
    spy = _Spy("42")
    leases = [{"scope": "all", "kind": "canvas", "ts": 0}]
    job = _job("w1", "s1", interval=1)
    sup.tick(now=100.0, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)
    spy.value = "43"
    sup.tick(now=101.5, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)
    assert spy.emitted == [("w1", "42"), ("w1", "43")]


def test_not_due_yet_skips():
    sup = live_widgets.Supervisor()
    spy = _Spy("42")
    leases = [{"scope": "all", "kind": "canvas", "ts": 0}]
    job = _job("w1", "s1", interval=5)
    sup.tick(now=100.0, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)  # force
    spy.value = "43"
    sup.tick(now=102.0, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)  # only 2s < 5s
    assert spy.emitted == [("w1", "42")]


def test_pin_only_job_respects_60s_floor():
    sup = live_widgets.Supervisor()
    spy = _Spy("42")
    leases = [{"scope": "widget:w1", "kind": "pin", "ts": 0}]
    job = _job("w1", "s1", interval=1)
    sup.tick(now=100.0, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)  # force
    spy.value = "43"
    sup.tick(now=140.0, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)  # 40s < 60s floor
    assert spy.emitted == [("w1", "42")]
    spy.value = "44"
    sup.tick(now=161.0, jobs=[job], leases=leases, runner=spy.runner, emitter=spy.emitter)  # 61s >= floor
    assert spy.emitted == [("w1", "42"), ("w1", "44")]


def test_reopen_after_uncovered_force_emits_again():
    sup = live_widgets.Supervisor()
    spy = _Spy("42")
    on = [{"scope": "all", "kind": "canvas", "ts": 0}]
    job = _job("w1", "s1", interval=1)
    sup.tick(now=100.0, jobs=[job], leases=on, runner=spy.runner, emitter=spy.emitter)   # force emit
    sup.tick(now=200.0, jobs=[job], leases=[], runner=spy.runner, emitter=spy.emitter)   # uncovered, idle
    sup.tick(now=300.0, jobs=[job], leases=on, runner=spy.runner, emitter=spy.emitter)   # reopened -> force
    assert spy.emitted == [("w1", "42"), ("w1", "42")]
    assert spy.ran == ["w1", "w1"]  # never ran while uncovered


# --- delete / delete_all -------------------------------------------------

def test_delete_removes_job_file_and_emits_remove(env):
    live_widgets.start("w1", "echo hi", 5, {"type": "text", "text": "{{value}}"})
    assert (env["jobs"] / "w1.json").exists()
    live_widgets.delete("w1")
    assert not (env["jobs"] / "w1.json").exists()
    ops = [l for l in _bus_lines(env["bus"]) if l.get("op") == "remove" and l.get("id") == "w1"]
    assert ops, "delete must append a remove marker so the card drops everywhere"


def test_stop_is_alias_for_delete(env):
    live_widgets.start("w9", "echo hi", 5, {"type": "text", "text": "{{value}}"})
    assert live_widgets.stop("w9") is True
    assert not (env["jobs"] / "w9.json").exists()


def test_delete_all_scoped_to_session(env, monkeypatch):
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "sA")
    live_widgets.start("a1", "echo a", 5, {"type": "text", "text": "{{value}}"})
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "sB")
    live_widgets.start("b1", "echo b", 5, {"type": "text", "text": "{{value}}"})
    live_widgets.delete_all(session_id="sA")
    assert not (env["jobs"] / "a1.json").exists()
    assert (env["jobs"] / "b1.json").exists()  # other session untouched


def test_start_persists_session_id(env, monkeypatch):
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "sX")
    live_widgets.start("w1", "echo hi", 5, {"type": "text", "text": "{{value}}"})
    job = json.loads((env["jobs"] / "w1.json").read_text())
    assert job["session_id"] == "sX"


def test_start_does_one_immediate_render(env):
    live_widgets.start("w1", "printf seven", 5, {"type": "text", "text": "{{value}}"})
    renders = [l for l in _bus_lines(env["bus"]) if l.get("id") == "w1" and "spec" in l]
    assert renders and renders[-1]["spec"]["text"] == "seven"


# --- leases on disk ------------------------------------------------------

def test_lease_roundtrip_and_ttl(env):
    live_widgets.write_lease("s1", "chat", "deviceX", ts_ms=10_000)
    fresh = live_widgets.read_leases(now_ms=20_000)  # 10s old, fresh
    assert any(l["scope"] == "s1" and l["kind"] == "chat" for l in fresh)
    stale = live_widgets.read_leases(now_ms=10_000 + 60_000)  # 60s old, > 45s TTL
    assert stale == []


def test_clear_lease_removes_it(env):
    live_widgets.write_lease("s1", "chat", "deviceX", ts_ms=10_000)
    live_widgets.clear_lease("s1", "deviceX")
    assert live_widgets.read_leases(now_ms=11_000) == []
