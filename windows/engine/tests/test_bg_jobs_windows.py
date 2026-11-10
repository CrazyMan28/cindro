"""Windows bg_jobs fix (server_windows.install_bg_jobs_fix): wake_me_in /
bg_start / bg_monitor runners must re-enter server_windows in --bg-runner mode
(NOT `<frozen exe> -m computer_use_mcp.bg_jobs`, which booted a second engine
and never fired the wake), and liveness must not use os.kill(pid, 0)."""

from __future__ import annotations

import os
import sys

import server_windows as sw


def test_runner_argv_frozen_uses_bg_runner_flag_not_dash_m():
    argv = sw._bg_runner_argv(["--sleep", "--job", "wake-1"], frozen=True,
                              executable=r"C:\Cindro\engine\jarvis-engine.exe")
    assert argv == [r"C:\Cindro\engine\jarvis-engine.exe", "--bg-runner",
                    "--sleep", "--job", "wake-1"]
    assert "-m" not in argv


def test_runner_argv_unfrozen_runs_server_windows_script():
    argv = sw._bg_runner_argv(["--run", "--job", "j"], frozen=False,
                              executable="python.exe")
    assert argv[0] == "python.exe"
    assert os.path.basename(argv[1]) == "server_windows.py"
    assert argv[2:] == ["--bg-runner", "--run", "--job", "j"]


def test_main_dispatches_bg_runner(monkeypatch):
    from computer_use_mcp import bg_jobs
    seen = []
    monkeypatch.setattr(bg_jobs, "_main", lambda a: seen.append(list(a)))
    monkeypatch.setattr(sys, "argv", ["jarvis-engine.exe", "--bg-runner",
                                      "--sleep", "--job", "wake-9"])
    sw.main()
    assert seen == [["--sleep", "--job", "wake-9"]]


def test_install_rebinds_spawn_alive_and_stop(monkeypatch, tmp_path):
    from computer_use_mcp import bg_jobs
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path))
    for attr in ("_spawn_runner", "_alive", "stop"):
        monkeypatch.setattr(bg_jobs, attr, getattr(bg_jobs, attr))
    monkeypatch.delattr(bg_jobs, "_cindro_win_fixed", raising=False)

    killed = []
    monkeypatch.setattr(sw, "_win_kill_tree", lambda pid: killed.append(pid))
    sw.install_bg_jobs_fix(alive=lambda pid: True)
    assert bg_jobs._spawn_runner is sw._win_spawn_bg_runner

    bg_jobs._write_meta("wake-1", {"id": "wake-1", "state": "sleeping",
                                   "runner_pid": 4242, "pid": None})
    monkeypatch.setattr(bg_jobs.os, "kill", lambda *a: None)  # orig stop's fallback
    out = bg_jobs.stop("wake-1")
    assert out["state"] == "stopped"
    assert killed == [4242]
    assert bg_jobs._read_meta("wake-1")["state"] == "stopped"
    monkeypatch.delattr(bg_jobs, "_cindro_win_fixed", raising=False)
