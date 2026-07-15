"""End-to-end operator tool tests: drive each tool through FastMCP.call_tool
(so path-building + gating are exercised exactly as in production), with the
subprocess seam monkeypatched."""

import pytest
from mcp.server.fastmcp import FastMCP

from proxmox_mcp import config, operator_store, proxmox_ops, tools_operator


def _raw(res):
    """FastMCP.call_tool returns (content_blocks, structured_result)."""
    return res[1] if isinstance(res, tuple) else res


@pytest.fixture
def mcp_and_calls(monkeypatch):
    calls = []

    def fake_run(cmd, timeout=20.0):
        calls.append(cmd)
        return '{"data": "ok"}'

    monkeypatch.setattr(proxmox_ops, "run", fake_run)
    # default: allow everything so mutating tools actually run (deny is tested
    # separately). The daemon gate is what normally asks; the server backstop
    # only blocks explicit deny rules.
    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "allow", "rules": []})
    m = FastMCP("t")
    tools_operator.register(m)
    return m, calls


async def test_vm_list_is_read_cluster_resources(mcp_and_calls):
    m, calls = mcp_and_calls
    await m.call_tool("proxmox_vm_list", {})
    assert calls[0] == ["pvesh", "get", "/cluster/resources", "-type", "vm",
                        "--output-format", "json"]


async def test_vm_power_builds_status_path(mcp_and_calls):
    m, calls = mcp_and_calls
    await m.call_tool("proxmox_vm_power", {"vmid": 106, "action": "reboot"})
    assert calls[0] == ["pvesh", "create", "/nodes/pve/qemu/106/status/reboot",
                        "--output-format", "json"]


async def test_vm_power_rejects_bad_action(mcp_and_calls):
    m, calls = mcp_and_calls
    res = _raw(await m.call_tool("proxmox_vm_power", {"vmid": 1, "action": "nuke"}))
    assert res["ok"] is False and "action" in res["error"]
    assert calls == []  # never touched pvesh


async def test_vm_create_passes_fields_and_extra(mcp_and_calls):
    m, calls = mcp_and_calls
    await m.call_tool("proxmox_vm_create",
                      {"vmid": 120, "name": "web", "cores": 2, "memory_mb": 2048,
                       "extra": {"net0": "virtio,bridge=vmbr0"}})
    argv = calls[0]
    assert argv[:3] == ["pvesh", "create", "/nodes/pve/qemu"]
    assert "-vmid" in argv and "120" in argv
    assert "-memory" in argv and "2048" in argv
    assert "-net0" in argv and "virtio,bridge=vmbr0" in argv


async def test_vm_delete_is_delete_verb(mcp_and_calls):
    m, calls = mcp_and_calls
    await m.call_tool("proxmox_vm_delete", {"vmid": 106})
    assert calls[0][:3] == ["pvesh", "delete", "/nodes/pve/qemu/106"]


async def test_proxmox_api_get_is_read(mcp_and_calls):
    m, calls = mcp_and_calls
    await m.call_tool("proxmox_api", {"method": "GET", "path": "/version"})
    assert calls[0] == ["pvesh", "get", "/version", "--output-format", "json"]


async def test_proxmox_api_maps_http_verbs_to_pvesh(mcp_and_calls):
    m, calls = mcp_and_calls
    # PUT -> pvesh set
    await m.call_tool("proxmox_api",
                      {"method": "PUT", "path": "/nodes/pve/qemu/120/config",
                       "params": {"cores": 8}})
    assert calls[0] == ["pvesh", "set", "/nodes/pve/qemu/120/config",
                        "-cores", "8", "--output-format", "json"]
    # POST -> pvesh create, DELETE -> pvesh delete
    await m.call_tool("proxmox_api", {"method": "POST", "path": "/cluster/x"})
    assert calls[1][:2] == ["pvesh", "create"]
    await m.call_tool("proxmox_api", {"method": "DELETE", "path": "/cluster/x"})
    assert calls[2][:2] == ["pvesh", "delete"]


async def test_deny_rule_blocks_tool_without_shelling_out(monkeypatch):
    calls = []
    monkeypatch.setattr(proxmox_ops, "run",
                        lambda cmd, timeout=20.0: calls.append(cmd) or "{}")
    monkeypatch.setattr(operator_store, "load_policy",
                        lambda path=None: {"default_risky": "ask",
                                           "rules": [{"match": {"tool": "proxmox_vm_delete"},
                                                      "effect": "deny"}]})
    m = FastMCP("t")
    tools_operator.register(m)
    res = _raw(await m.call_tool("proxmox_vm_delete", {"vmid": 106}))
    assert res["status"] == "denied"
    assert calls == []


async def test_board_layout_and_tasks_are_local(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "OPERATOR_LAYOUT_FILE", tmp_path / "layout.json")
    monkeypatch.setattr(config, "OPERATOR_TASKS_FILE", tmp_path / "tasks.json")
    m = FastMCP("t")
    tools_operator.register(m)

    await m.call_tool("proxmox_dashboard_layout_set",
                      {"tiles": [{"id": "cpu", "spec": {"type": "text"}}]})
    got = _raw(await m.call_tool("proxmox_dashboard_layout_get", {}))
    assert got["tiles"][0]["id"] == "cpu"

    made = _raw(await m.call_tool("proxmox_task_create", {"title": "check 104"}))
    _raw(await m.call_tool("proxmox_task_update", {"task_id": made["id"], "status": "done"}))
    listed = _raw(await m.call_tool("proxmox_tasks_list", {}))
    assert listed["tasks"][0]["status"] == "done"
