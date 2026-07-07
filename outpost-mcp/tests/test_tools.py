from mcp.server.fastmcp import FastMCP

from outpost_mcp import tools_outpost
from outpost_mcp.agent_hub import AgentHub
from outpost_mcp.pairing import PairingStore
from outpost_mcp.registry import MachineRegistry


def _payload(result):
    structured = result[1] if isinstance(result, tuple) else result
    return structured.get("result", structured) if isinstance(structured, dict) else structured


async def test_tools_registered(tmp_path):
    mcp = FastMCP("outpost-test")
    names = tools_outpost.register(
        mcp, MachineRegistry(tmp_path / "m.json"), PairingStore(), AgentHub(MachineRegistry(tmp_path / "m2.json")))
    required = {"outpost_list_machines", "outpost_pair_start", "outpost_pair_status",
                "outpost_exec", "outpost_screenshot", "outpost_revoke"}
    assert required == set(names)
    listed = {t.name for t in await mcp.list_tools()}
    assert required.issubset(listed)


async def test_list_and_revoke(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    reg.add("box", "linux")
    mcp = FastMCP("outpost-test")
    tools_outpost.register(mcp, reg, PairingStore(), AgentHub(reg))
    listed = _payload(await mcp.call_tool("outpost_list_machines", {}))
    assert listed["machines"][0]["name"] == "box"
    revoked = _payload(await mcp.call_tool("outpost_revoke", {"machine": "box"}))
    assert revoked == {"ok": True, "revoked": True}
    assert _payload(await mcp.call_tool("outpost_list_machines", {}))["machines"] == []


async def test_pair_start_shape(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    mcp = FastMCP("outpost-test")
    tools_outpost.register(mcp, reg, PairingStore(), AgentHub(reg))
    out = _payload(await mcp.call_tool("outpost_pair_start", {"name": "n", "os_hint": "linux"}))
    assert out["bootstrap_id"] and out["install_cmd_linux"] and out["install_cmd_windows"]


async def test_exec_offline(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    reg.add("box", "linux")
    mcp = FastMCP("outpost-test")
    tools_outpost.register(mcp, reg, PairingStore(), AgentHub(reg))
    out = _payload(await mcp.call_tool("outpost_exec", {"machine": "box", "cmd": "x"}))
    assert out["ok"] is False and out["error"] == "machine_offline"
