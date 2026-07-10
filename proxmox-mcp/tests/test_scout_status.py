"""scout_status: the pid-liveness + staleness lock that keeps two fleet
scouts from interleaving without ever wedging scouting forever."""

import os
import subprocess

from proxmox_mcp import scout_status


def test_read_default_idle(tmp_path):
    assert scout_status.read(tmp_path / "nope.json") == {"state": "idle"}
    bad = tmp_path / "bad.json"
    bad.write_text("{broken")
    assert scout_status.read(bad) == {"state": "idle"}


def test_write_read_round_trip(tmp_path):
    f = tmp_path / "scout_status.json"
    status = {"state": "running", "pid": os.getpid(), "started_at": 123,
              "total": 3, "done": 1, "results": []}
    scout_status.write(f, status)
    assert scout_status.read(f) == status


def test_is_running_live_pid(tmp_path):
    now = 1_000_000
    status = {"state": "running", "pid": os.getpid(), "started_at": now - 1000}
    assert scout_status.is_running(status, now) is True


def test_is_running_dead_pid(tmp_path):
    proc = subprocess.Popen(["true"])
    proc.wait()  # reaped -> pid is gone
    now = 1_000_000
    status = {"state": "running", "pid": proc.pid, "started_at": now - 1000}
    assert scout_status.is_running(status, now) is False


def test_is_running_stale_started_at(tmp_path):
    now = 1_000_000_000
    status = {"state": "running", "pid": os.getpid(),
              "started_at": now - 31 * 60 * 1000}  # >30min old
    assert scout_status.is_running(status, now) is False


def test_is_running_other_states(tmp_path):
    assert scout_status.is_running({"state": "done", "pid": os.getpid(),
                                    "started_at": 1}, 2) is False
    assert scout_status.is_running({"state": "idle"}, 2) is False
