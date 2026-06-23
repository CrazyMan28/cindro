"""Upgrade (1): session.py detects the nested 'agent' desktop from explicit env.

The agent session is NOT discovered on seat0 — it is requested by the daemon via
JARVIS_AGENT_WAYLAND_DISPLAY / JARVIS_AGENT_SWAYSOCK. These tests exercise that
env-driven discovery in isolation (no live compositor needed) so they always run.
"""

from __future__ import annotations

import os

import pytest

from computer_use_mcp import session


@pytest.fixture(autouse=True)
def _clear_agent_env(monkeypatch):
    monkeypatch.delenv(session.AGENT_WAYLAND_ENV, raising=False)
    monkeypatch.delenv(session.AGENT_SWAYSOCK_ENV, raising=False)
    monkeypatch.delenv(session.AGENT_RUNTIME_DIR_ENV, raising=False)
    # The detect() cache must not leak between tests.
    session._CACHE = None
    yield
    session._CACHE = None


def test_no_agent_without_env():
    assert session._find_agent_sway({}) is None
    # Even when only an unrelated var is set.
    assert session._find_agent_sway({"FOO": "bar"}) is None


def test_agent_detected_from_env_vars():
    env = {
        session.AGENT_WAYLAND_ENV: "wayland-9",
        session.AGENT_SWAYSOCK_ENV: f"/run/user/{os.getuid()}/sway-ipc.{os.getuid()}.4242.sock",
    }
    info = session._find_agent_sway(env)
    assert info is not None
    assert info.kind == "agent"
    assert info.active is False
    assert info.wayland_display == "wayland-9"
    assert info.swaysock.endswith("4242.sock")
    # PID parsed out of the sway IPC socket name.
    assert info.compositor_pid == 4242


def test_agent_env_normalizes_absolute_wayland_path():
    env = {
        session.AGENT_WAYLAND_ENV: f"/run/user/{os.getuid()}/wayland-3",
        session.AGENT_SWAYSOCK_ENV: "",
    }
    info = session._find_agent_sway(env)
    assert info is not None
    # Absolute path collapses to the bare socket name for WAYLAND_DISPLAY.
    assert info.wayland_display == "wayland-3"


def test_agent_session_env_overlay_targets_nested_socket():
    env = {
        session.AGENT_WAYLAND_ENV: "wayland-9",
        session.AGENT_SWAYSOCK_ENV: "/run/user/x/sway-ipc.sock",
        session.AGENT_RUNTIME_DIR_ENV: "/run/user/9999",
    }
    info = session._find_agent_sway(env)
    overlay = info.env()
    assert overlay["WAYLAND_DISPLAY"] == "wayland-9"
    assert overlay["SWAYSOCK"] == "/run/user/x/sway-ipc.sock"
    assert overlay["XDG_RUNTIME_DIR"] == "/run/user/9999"
    assert "PYTHONPATH" not in overlay


def test_detect_appends_agent_and_never_active(monkeypatch):
    """With the env vars set, detect() must surface an 'agent' session that is
    never the result['active'] (the host seat stays active)."""
    monkeypatch.setenv(session.AGENT_WAYLAND_ENV, "wayland-9")
    monkeypatch.setenv(
        session.AGENT_SWAYSOCK_ENV,
        f"/run/user/{os.getuid()}/sway-ipc.{os.getuid()}.4242.sock",
    )
    # Pretend there are no host compositors so the test is hermetic.
    monkeypatch.setattr(session, "_find_kwin", lambda: None)
    monkeypatch.setattr(session, "_find_sway", lambda: None)
    monkeypatch.setattr(session, "_wayland_socket_owners", lambda: {})
    monkeypatch.setattr(session, "_xwayland_displays", lambda: {})
    monkeypatch.setattr(session, "_active_session_id", lambda: "host")
    # Don't shell out for outputs.
    monkeypatch.setattr(session, "_sway_outputs", lambda info: None)
    monkeypatch.setattr(session, "_kde_outputs", lambda info: None)

    d = session.detect(refresh=True)
    kinds = [s.kind for s in d["sessions"]]
    assert "agent" in kinds
    assert d["active"] is None  # agent is never promoted to active

    agent = session.get_session("agent")
    assert agent.kind == "agent"
