"""Workspace / virtual-desktop tools (JOB 1).

Two layers:
  - dispatch tests: mock session.get_session + the backends to prove `which`
    routing and arg validation, no compositor needed (always run).
  - sway smoke test: drive a REAL nested headless sway (the `nested_sway`
    fixture) through list/create/switch/rename and assert the workspace tree
    actually changes. Skipped when sway/grim aren't installed.
"""

from __future__ import annotations

import pytest

from computer_use_mcp import session, workspaces


# -- dispatch / routing (no compositor) ---------------------------------------


def _fake_session(kind: str) -> session.SessionInfo:
    return session.SessionInfo(kind=kind, session_id=kind, swaysock=f"/tmp/{kind}.sock")


def test_resolve_rejects_non_workspace_kind(monkeypatch):
    monkeypatch.setattr(session, "get_session",
                        lambda which="active": _fake_session("browser"))
    with pytest.raises(RuntimeError, match="don't support session kind"):
        workspaces.list_workspaces("active")


def test_switch_routes_to_sway_backend(monkeypatch):
    calls = {}
    monkeypatch.setattr(session, "get_session",
                        lambda which="active": _fake_session("agent"))
    monkeypatch.setattr(workspaces, "_sway_switch",
                        lambda info, name, num: calls.setdefault("sway", (name, num)) or {"ok": 1})
    workspaces.switch_workspace(num=2, which="agent")
    assert calls["sway"] == (None, 2)


def test_switch_routes_to_kde_backend(monkeypatch):
    calls = {}
    monkeypatch.setattr(session, "get_session",
                        lambda which="active": _fake_session("kde"))
    monkeypatch.setattr(workspaces, "_kwin_switch",
                        lambda name, num: calls.setdefault("kde", (name, num)) or {"ok": 1})
    workspaces.switch_workspace(name="research", which="kde")
    assert calls["kde"] == ("research", None)


def test_create_routes_per_compositor(monkeypatch):
    monkeypatch.setattr(session, "get_session",
                        lambda which="active": _fake_session("sway"))
    monkeypatch.setattr(workspaces, "_sway_create",
                        lambda info, name: {"created": name, "compositor": "sway"})
    out = workspaces.create_workspace("research", which="sway")
    assert out["created"] == "research" and out["compositor"] == "sway"


def test_switch_requires_name_or_num(monkeypatch):
    monkeypatch.setattr(session, "get_session",
                        lambda which="active": _fake_session("sway"))
    # No swaymsg call should happen — validation fires first.
    monkeypatch.setattr(workspaces, "_sway_run_command",
                        lambda *a, **k: pytest.fail("should not run a command"))
    with pytest.raises(ValueError, match="needs name or num"):
        workspaces.switch_workspace(which="sway")


# -- live sway smoke test -----------------------------------------------------


def _agent_info(nested_sway) -> session.SessionInfo:
    return session.SessionInfo(
        kind="agent", session_id="agent",
        wayland_display=nested_sway["wayland_display"],
        swaysock=nested_sway["swaysock"],
        runtime_dir=nested_sway["runtime_dir"],
    )


def test_sway_workspace_lifecycle(nested_sway):
    """create -> appears+focused -> switch by num -> rename -> reflected in list,
    against a real nested headless sway."""
    info = _agent_info(nested_sway)

    # Baseline: sway starts on workspace "1".
    base = workspaces._sway_list(info)
    assert any(w["focused"] for w in base)

    # Create a named workspace; it should exist and be focused.
    workspaces._sway_create(info, "research")
    after = workspaces._sway_list(info)
    research = next((w for w in after if w["name"] == "research"), None)
    assert research is not None, f"'research' not in {after}"
    assert research["focused"], "newly created workspace should be focused"

    # Rename the current ('research') workspace.
    workspaces._sway_rename(info, "research2", old="research")
    names = {w["name"] for w in workspaces._sway_list(info)}
    assert "research2" in names
    assert "research" not in names

    # Switch to a numeric workspace (creates/focuses ws 5).
    workspaces._sway_switch(info, name=None, num=5)
    focused = next(w for w in workspaces._sway_list(info) if w["focused"])
    assert str(focused["num"]) == "5" or focused["name"] == "5"


def test_sway_list_via_public_api(nested_sway):
    """The public list_workspaces() path works for an agent-kind session built
    from the nested sway (exercises _resolve + sway dispatch)."""
    info = _agent_info(nested_sway)
    import computer_use_mcp.session as sess
    # Make get_session('agent') return our nested-sway-backed info.
    orig = sess.get_session
    sess.get_session = lambda which="active": info if which in ("agent", "active") else orig(which)
    try:
        out = workspaces.list_workspaces("agent")
    finally:
        sess.get_session = orig
    assert out["compositor"] == "agent"
    assert isinstance(out["workspaces"], list) and out["workspaces"]
