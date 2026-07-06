"""`jarvis web start` — regression coverage for the Bun+Vite dashboard launch
path (no live daemon/bun binary needed; subprocess calls are monkeypatched)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from jarvis_cli import services  # noqa: E402


class _FakeProc:
    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid

    def poll(self):
        return None  # still running


@pytest.fixture()
def isolated_env(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("JARVIS_CONTROL_WS", raising=False)
    monkeypatch.delenv("JARVIS_CONTROL_TOKEN", raising=False)
    monkeypatch.delenv("JARVIS_CONTROL_PORT", raising=False)
    return tmp_path


@pytest.fixture()
def fake_web_dir(tmp_path, monkeypatch):
    web = tmp_path / "web"
    (web / "node_modules").mkdir(parents=True)
    (web / "server.ts").write_text("// stub\n")
    monkeypatch.setattr(services, "_web_dir", lambda: web)
    monkeypatch.setattr(services.shutil, "which", lambda name: "/usr/bin/bun")
    monkeypatch.setattr(
        services, "_run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout="", stderr=""),
    )
    monkeypatch.setattr(services.subprocess, "Popen", lambda *a, **k: _FakeProc())
    monkeypatch.setattr(services.time, "sleep", lambda *_: None)
    return web


def test_cmd_web_prints_control_token(fake_web_dir, isolated_env, capsys):
    (isolated_env / "control_token").write_text("sekrit-token\n")
    rc = services.cmd_web("start")
    out = capsys.readouterr().out
    assert rc == 0
    assert "sekrit-token" in out
    assert "web dashboard on http://127.0.0.1:8788" in out


def test_cmd_web_no_token_shows_pairing_hint(fake_web_dir, isolated_env, capsys):
    rc = services.cmd_web("start")
    out = capsys.readouterr().out
    assert rc == 0
    assert "no control token found" in out


def test_cmd_web_build_failure_stops_before_serving(fake_web_dir, isolated_env, monkeypatch, capsys):
    monkeypatch.setattr(
        services, "_run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom"),
    )
    rc = services.cmd_web("start")
    out = capsys.readouterr().out
    assert rc == 1
    assert "build failed" in out
