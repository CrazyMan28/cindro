"""Fleet runner: status progression, per-guest fault isolation, the
already-running lock, and the tool-registry invariants."""

import os

from proxmox_mcp import config, proxmox_ops, scout, scout_runner, scout_status
from proxmox_mcp.memory_store import MemoryStore


def _fleet(monkeypatch):
    monkeypatch.setattr(proxmox_ops, "qm_list", lambda: [
        {"vmid": 104, "name": "ci-runner", "status": "running", "mem_mb": 8192},
        {"vmid": 105, "name": "stopped-vm", "status": "stopped", "mem_mb": 2048},
        {"vmid": 106, "name": "win-runner", "status": "running", "mem_mb": 8192},
    ])
    monkeypatch.setattr(scout, "pct_list", lambda: [
        {"vmid": 100, "name": "web-ct", "status": "running"},
    ])


def test_run_scout_full_fleet(monkeypatch, tmp_path):
    _fleet(monkeypatch)

    def fake_qemu(vmid):
        if vmid == 106:
            raise RuntimeError("guest agent wedged")  # must not kill the run
        return {"ok": True, "agent": True, "os_family": "linux",
                "observed": {"hostname": [f"host{vmid}"], "services": ["a.service"]}}

    monkeypatch.setattr(scout, "scout_qemu", fake_qemu)
    monkeypatch.setattr(scout, "scout_lxc", lambda vmid: {
        "ok": True, "agent": None, "os_family": "linux",
        "observed": {"hostname": ["web"]}})

    profiles = tmp_path / "vms"
    status_file = tmp_path / "scout_status.json"
    memory_db = tmp_path / "memory.db"
    result = scout_runner.run_scout(None, "chat", profiles_dir=profiles,
                                    status_file=status_file, memory_db=memory_db)
    assert result["ok"] is True

    status = scout_status.read(status_file)
    assert status["state"] == "done" and status["total"] == 3 and status["done"] == 3
    by_vmid = {r["vmid"]: r for r in status["results"]}
    assert by_vmid[104]["ok"] is True and "host104" in by_vmid[104]["summary"]
    assert by_vmid[106]["ok"] is False and "wedged" in by_vmid[106]["error"]
    assert by_vmid[100]["kind"] == "lxc" and by_vmid[100]["ok"] is True

    assert (profiles / "104.md").exists() and (profiles / "100.md").exists()
    assert not (profiles / "106.md").exists()  # failed guest -> no profile
    assert not (profiles / "105.md").exists()  # stopped VM never targeted

    memories = MemoryStore(memory_db).recall()
    assert len(memories) == 1 and "scanned 3 guests, 2 profiled" in memories[0]["text"]


def test_run_scout_vmid_filter(monkeypatch, tmp_path):
    _fleet(monkeypatch)
    monkeypatch.setattr(scout, "scout_qemu", lambda vmid: {
        "ok": True, "agent": True, "os_family": "linux",
        "observed": {"hostname": [str(vmid)]}})
    result = scout_runner.run_scout([104], "agent",
                                    profiles_dir=tmp_path / "vms",
                                    status_file=tmp_path / "s.json",
                                    memory_db=tmp_path / "m.db")
    assert result["ok"] is True
    assert [r["vmid"] for r in result["status"]["results"]] == [104]


def test_run_scout_refuses_concurrent(monkeypatch, tmp_path):
    status_file = tmp_path / "s.json"
    scout_status.write(status_file, {
        "state": "running", "pid": os.getpid(),
        "started_at": scout_runner.time.time() * 1000 - 1000})
    result = scout_runner.run_scout(None, "chat", profiles_dir=tmp_path / "vms",
                                    status_file=status_file,
                                    memory_db=tmp_path / "m.db")
    assert result["ok"] is False and "already running" in result["error"]


def test_run_scout_survives_enumeration_failure(monkeypatch, tmp_path):
    def boom():
        raise proxmox_ops.CommandError(["qm", "list"], 1, "qm gone")
    monkeypatch.setattr(proxmox_ops, "qm_list", boom)
    monkeypatch.setattr(scout, "pct_list", lambda: [
        {"vmid": 100, "name": "web-ct", "status": "running"}])
    monkeypatch.setattr(scout, "scout_lxc", lambda vmid: {
        "ok": True, "agent": None, "os_family": "linux",
        "observed": {"hostname": ["web"]}})
    result = scout_runner.run_scout(None, "manual", profiles_dir=tmp_path / "vms",
                                    status_file=tmp_path / "s.json",
                                    memory_db=tmp_path / "m.db")
    assert result["ok"] is True
    assert [r["vmid"] for r in result["status"]["results"]] == [100]


def test_tool_registry_has_new_tools_and_no_power_verbs(monkeypatch, tmp_path):
    from mcp.server.fastmcp import FastMCP
    from proxmox_mcp import tools_proxmox

    monkeypatch.setattr(config, "MEMORY_DB", tmp_path / "memory.db")
    names = tools_proxmox.register(FastMCP("test"))

    for expected in ("proxmox_scout", "proxmox_scout_status", "proxmox_get_vm_profile",
                     "proxmox_update_vm_profile", "proxmox_list_vm_profiles",
                     "proxmox_ask_user", "proxmox_get_answers", "proxmox_get_tasks",
                     "proxmox_reply", "proxmox_get_due_pinged", "proxmox_record_pinged",
                     "proxmox_guest_service"):
        assert expected in names

    # The structural invariant: no VM power tool, ever.
    for name in names:
        for banned in ("restart", "reboot", "shutdown", "poweroff", "stop"):
            assert banned not in name, f"{name} looks like a power tool"
