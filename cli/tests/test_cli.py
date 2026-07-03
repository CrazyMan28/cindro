"""jarvis-cli tests: config resolution, the streaming control client, the
one-shot ask flow, and the quick subcommands — all against MockDaemon."""

from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from harness import DaemonThread, MockDaemon, run  # noqa: E402

from jarvis_cli import config  # noqa: E402
from jarvis_cli.control import ControlClient, ControlError  # noqa: E402


@pytest.fixture()
def isolated_env(tmp_path, monkeypatch):
    """Point the CLI at an isolated config dir (no live daemon leakage)."""
    monkeypatch.setenv("JARVIS_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("JARVIS_CONTROL_WS", raising=False)
    monkeypatch.delenv("JARVIS_CONTROL_TOKEN", raising=False)
    monkeypatch.delenv("JARVIS_CONTROL_PORT", raising=False)
    return tmp_path


# --- config -----------------------------------------------------------------

def test_config_dir_override(isolated_env):
    assert config.config_dir() == isolated_env


def test_control_port_from_config_toml(isolated_env):
    (isolated_env / "config.toml").write_text(
        "default_brain = 'codex'\n[ports]\ncontrol = 9123\ndevice = 8796\n")
    assert config.control_port() == 9123


def test_control_port_default(isolated_env):
    assert config.control_port() == 8795


def test_ws_url_includes_token(isolated_env, monkeypatch):
    (isolated_env / "control_token").write_text("sekrit\n")
    url = config.control_ws_url()
    assert url.endswith("?token=sekrit")
    monkeypatch.setenv("JARVIS_CONTROL_TOKEN", "envwins")
    assert config.control_ws_url().endswith("?token=envwins")


# --- control client ------------------------------------------------------------

def test_call_roundtrip_and_error():
    async def scenario():
        d = await MockDaemon().start()
        c = ControlClient(url_factory=lambda: d.url)
        try:
            pong = await c.call("ping", {})
            assert pong.get("pong") is True
            with pytest.raises(ControlError):
                await c.call("no.such.method", {})
        finally:
            await c.close()
            await d.stop()
    run(scenario())


def test_streaming_events_scoped_per_session():
    async def scenario():
        d = await MockDaemon().start()

        async def send_events(daemon, ws, params):
            sid = params["session_id"]
            await daemon.emit(ws, sid, {"kind": "message", "role": "assistant",
                                        "text": "hi"})
            await daemon.emit(ws, "OTHER", {"kind": "message", "role": "assistant",
                                            "text": "leak"})
            await daemon.emit(ws, sid, {"kind": "final"})
        d.on_send = send_events

        c = ControlClient(url_factory=lambda: d.url)
        try:
            res = await c.call("session.create", {"profile": "coworker"})
            sid = res["session_id"]
            q = await c.subscribe(sid)
            assert d.subscribed == [sid]
            await c.call("session.send", {"session_id": sid, "text": "yo"})
            got = [await asyncio.wait_for(q.get(), 5) for _ in range(2)]
            kinds = [g["kind"] for g in got]
            assert kinds == ["message", "final"]  # the foreign event never lands
        finally:
            await c.close()
            await d.stop()
    run(scenario())


def test_broadcast_hook():
    async def scenario():
        d = await MockDaemon().start()
        seen: list[tuple[str, dict]] = []

        async def send_events(daemon, ws, params):
            await daemon.broadcast(ws, "session.opened", {"session_id": "sX"})
            await daemon.emit(ws, params["session_id"], {"kind": "final"})
        d.on_send = send_events

        c = ControlClient(url_factory=lambda: d.url,
                          on_broadcast=lambda ev, data: seen.append((ev, data)))
        try:
            res = await c.call("session.create", {})
            q = await c.subscribe(res["session_id"])
            await c.call("session.send", {"session_id": res["session_id"],
                                          "text": "x"})
            await asyncio.wait_for(q.get(), 5)
            assert seen and seen[0][0] == "session.opened"
        finally:
            await c.close()
            await d.stop()
    run(scenario())


# --- one-shot ask ----------------------------------------------------------------

async def _ask_events(daemon, ws, params):
    sid = params["session_id"]
    await daemon.emit(ws, sid, {"kind": "thinking", "text": "hmm"})
    await daemon.emit(ws, sid, {"kind": "tool_call", "name": "read_file",
                                "args": "{\"p\":1}"})
    await daemon.emit(ws, sid, {"kind": "tool_result", "name": "read_file",
                                "output": "ok"})
    await daemon.emit(ws, sid, {"kind": "message", "role": "assistant",
                                "text": "**done**"})
    await daemon.emit(ws, sid, {"kind": "final"})


def test_ask_streams_to_final(monkeypatch, capsys):

    with DaemonThread(on_send=_ask_events) as d:
        monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
        monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
        from jarvis_cli.oneshot import cmd_ask
        rc = cmd_ask("do the thing", timeout=10)
    out = capsys.readouterr().out
    assert rc == 0
    assert "done" in out
    assert "read_file" in out
    # created-session hint names the mock's sid
    assert "sess_cli_1" in out


async def _approval_events(daemon, ws, params):
    await daemon.emit(ws, params["session_id"],
                      {"kind": "approval", "approval_id": "ap1",
                       "summary": "rm -rf /"})
    # the harness's approval.respond emits the final


def test_ask_auto_denies_approvals(monkeypatch, capsys):
    with DaemonThread(on_send=_approval_events) as d:
        monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
        monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
        from jarvis_cli.oneshot import cmd_ask
        rc = cmd_ask("dangerous", timeout=10)
        responded = [(m, p) for (m, p) in d.calls if m == "approval.respond"]
    assert rc == 0
    assert responded and responded[0][1]["decision"] == "deny"
    assert responded[0][1]["approval_id"] == "ap1"
    assert "auto-DENIED" in capsys.readouterr().out


# --- quick subcommands ------------------------------------------------------------

def test_sessions_and_search_and_version(monkeypatch, capsys):
    with DaemonThread() as d:
        monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
        monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
        from jarvis_cli.main import main
        assert main(["sessions"]) == 0
        assert main(["search", "hello"]) == 0
        assert main(["version"]) == 0
    # rich's number-highlighter injects ANSI codes INSIDE "9.9.9" — strip first.
    out = re.sub(r"\x1b\[[0-9;]*m", "", capsys.readouterr().out)
    assert "hello world" in out      # session title + search hit title
    assert "9.9.9" in out            # daemon version via settings.get


def test_status_against_mock(monkeypatch, capsys):
    with DaemonThread() as d:
        monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
        monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
        from jarvis_cli.doctor import cmd_status
        rc = cmd_status()
    out = capsys.readouterr().out
    assert rc == 0
    assert "9.9.9" in out and "codex" in out


def test_status_unreachable_daemon(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("JARVIS_CONFIG_DIR", str(tmp_path))  # no token/port
    monkeypatch.setenv("JARVIS_CONTROL_WS", "ws://127.0.0.1:1/control/ws")
    monkeypatch.delenv("JARVIS_CONTROL_TOKEN", raising=False)
    from jarvis_cli.doctor import cmd_status
    assert cmd_status() == 1
