"""pvesh wrapper + policy-backstop tests. Monkeypatch the single subprocess
seam (proxmox_ops.run) — never shell out to a real pvesh."""

import json

import pytest

from proxmox_mcp import operator_store
from proxmox_mcp import proxmox_ops
from proxmox_mcp import proxmox_ops_operator as ops


@pytest.fixture
def captured(monkeypatch):
    calls = []

    def fake_run(cmd, timeout=20.0):
        calls.append(cmd)
        return '{"data": {"ok": 1}}'

    monkeypatch.setattr(proxmox_ops, "run", fake_run)
    return calls


def test_run_pvesh_get_argv(captured):
    ops.run_pvesh("get", "/nodes/pve/status")
    assert captured == [["pvesh", "get", "/nodes/pve/status", "--output-format", "json"]]


def test_run_pvesh_create_with_params(captured):
    ops.run_pvesh("create", "/nodes/pve/qemu", {"vmid": 120, "name": "web", "memory": 2048})
    assert captured[0] == ["pvesh", "create", "/nodes/pve/qemu",
                           "-vmid", "120", "-name", "web", "-memory", "2048",
                           "--output-format", "json"]


def test_run_pvesh_drops_none_params(captured):
    ops.run_pvesh("set", "/nodes/pve/qemu/120/config", {"cores": 4, "name": None})
    assert "-name" not in captured[0]
    assert "-cores" in captured[0]


def test_parse_handles_json_raw_and_empty(monkeypatch):
    monkeypatch.setattr(proxmox_ops, "run", lambda cmd, timeout=20.0: '"UPID:pve:123"')
    assert ops.run_pvesh("create", "/x") == "UPID:pve:123"
    monkeypatch.setattr(proxmox_ops, "run", lambda cmd, timeout=20.0: "not json")
    assert ops.run_pvesh("get", "/x") == {"raw": "not json"}
    monkeypatch.setattr(proxmox_ops, "run", lambda cmd, timeout=20.0: "   ")
    assert ops.run_pvesh("get", "/x") == {}


def test_read_ok_and_error(monkeypatch):
    monkeypatch.setattr(proxmox_ops, "run", lambda cmd, timeout=20.0: '{"a":1}')
    assert ops.read("/nodes") == {"ok": True, "result": {"a": 1}}

    def boom(cmd, timeout=20.0):
        raise proxmox_ops.CommandError(cmd, 2, "nope")

    monkeypatch.setattr(proxmox_ops, "run", boom)
    r = ops.read("/nodes")
    assert r["ok"] is False and "nope" in r["error"]


def test_guarded_write_allows_and_runs(captured, monkeypatch):
    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "allow", "rules": []})
    r = ops.guarded_write("proxmox_vm_power", {"vmid": 106, "verb": "stop"},
                          "create", "/nodes/pve/qemu/106/status/stop")
    assert r["ok"] is True
    assert captured  # it actually shelled out


def test_guarded_write_deny_does_not_shell_out(captured, monkeypatch):
    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "ask",
                                           "rules": [{"match": {"vmid": 106}, "effect": "deny"}]})
    r = ops.guarded_write("proxmox_vm_delete", {"vmid": 106}, "delete", "/nodes/pve/qemu/106")
    assert r["status"] == "denied"
    assert captured == []  # backstop refused BEFORE any pvesh call


def test_guarded_write_vm_deny_rule_applies_to_proxmox_api_path(captured, monkeypatch):
    # A VM-scoped deny {vmid:106} must block proxmox_api DELETE /nodes/x/qemu/106
    # even though proxmox_api carries no vmid arg (it's parsed from the path).
    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "allow",
                                           "rules": [{"match": {"vmid": 106}, "effect": "deny"}]})
    denied = ops.guarded_write("proxmox_api", {"method": "DELETE"}, "delete",
                               "/nodes/pve/qemu/106")
    assert denied["status"] == "denied"
    assert captured == []  # never shelled out
    # a different vmid in the path is unaffected (default allow -> runs)
    ok = ops.guarded_write("proxmox_api", {"method": "DELETE"}, "delete",
                           "/nodes/pve/qemu/107")
    assert ok["ok"] is True


def test_guarded_write_surfaces_command_error(monkeypatch):
    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "allow", "rules": []})

    def boom(cmd, timeout=20.0):
        raise proxmox_ops.CommandError(cmd, 1, "vm 999 does not exist")

    monkeypatch.setattr(proxmox_ops, "run", boom)
    r = ops.guarded_write("proxmox_vm_power", {"vmid": 999, "verb": "start"},
                          "create", "/nodes/pve/qemu/999/status/start")
    assert r["ok"] is False and "999" in r["error"]


def test_guarded_write_timeout_detaches_with_upid(monkeypatch):
    # A long op (vzdump) whose pvesh client outruns the timeout must NOT read as
    # a failure — the worker keeps running, so report it running + hand back the
    # UPID to poll, and never let the model "fix" it by re-issuing.
    import subprocess

    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "allow", "rules": []})
    monkeypatch.setattr(ops, "node", lambda: "pve")
    upid = "UPID:pve:0001:0002:0003:vzdump:100:root@pam:"

    def fake_run(cmd, timeout=20.0):
        joined = " ".join(cmd)
        if "/vzdump" in joined:                      # the backup create -> times out
            raise subprocess.TimeoutExpired(cmd, timeout)
        if "/tasks" in joined:                       # the active-task lookup -> running vzdump on 100
            return json.dumps([{"id": "100", "type": "vzdump", "upid": upid, "status": "running"}])
        return "{}"

    monkeypatch.setattr(proxmox_ops, "run", fake_run)
    r = ops.guarded_write("proxmox_backup_create", {"vmid": 100}, "create",
                          "/nodes/pve/vzdump", {"vmid": 100, "storage": "USB-Storage"})
    assert r["ok"] is True and r["status"] == "running" and r["detached"] is True
    assert r["upid"] == upid
    assert "do not re-issue" in r["note"].lower()


def test_running_task_upid_none_when_no_match(monkeypatch):
    # No active task for the vmid -> empty UPID (the caller then falls back to
    # proxmox_tasks_recent), and the lookup never raises even if it times out.
    import subprocess

    monkeypatch.setattr(ops, "node", lambda: "pve")
    monkeypatch.setattr(proxmox_ops, "run",
                        lambda cmd, timeout=20.0: json.dumps([{"id": "999", "endtime": 1, "upid": "x"}]))
    assert ops._running_task_upid({100}) == ""

    def boom(cmd, timeout=20.0):
        raise subprocess.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(proxmox_ops, "run", boom)
    assert ops._running_task_upid({100}) == ""  # lookup failure -> "", not an exception


def test_guarded_write_error_redacts_argv(monkeypatch):
    # The operator transcript keeps the actionable stderr + exit code but must
    # NOT echo the full argv (absolute host paths / node names leak topology).
    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "allow", "rules": []})

    def boom(cmd, timeout=20.0):
        raise proxmox_ops.CommandError(cmd, 1, "config lock timeout")

    monkeypatch.setattr(proxmox_ops, "run", boom)
    r = ops.guarded_write("proxmox_vm_config_set", {"vmid": 106}, "set",
                          "/nodes/pve/qemu/106/config", {"cores": 8})
    assert r["ok"] is False
    assert "config lock timeout" in r["error"]        # stderr kept
    assert "/nodes/pve/qemu/106" not in r["error"]    # host path NOT leaked
    assert "pvesh" not in r["error"]                  # argv NOT leaked
