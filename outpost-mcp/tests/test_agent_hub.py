import asyncio
import json

import pytest

from outpost_mcp.agent_hub import AgentConnection, AgentHub
from outpost_mcp.registry import MachineRegistry


class FakeWs:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, text: str):
        self.sent.append(json.loads(text))


async def _drive(conn: AgentConnection, ws: FakeWs, reply: dict):
    """Wait for the hub to send one request, then feed the reply back."""
    while not ws.sent:
        await asyncio.sleep(0.005)
    req_id = ws.sent[-1]["req_id"]
    conn.resolve(req_id, {**reply, "req_id": req_id})


async def test_exec_roundtrip(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    ws = FakeWs()
    conn = AgentConnection(row["id"], ws)
    hub.register(conn)
    assert hub.online(row["id"]) is True
    assert reg.list()[0]["status"] == "online"

    reply = {"type": "exec_result", "ok": True, "exit_code": 0, "output": "hi", "error": ""}
    res, _ = await asyncio.gather(
        hub.exec("box", "echo hi", timeout=5),
        _drive(conn, ws, reply),
    )
    assert res == {"ok": True, "exit_code": 0, "output": "hi", "error": ""}
    assert ws.sent[-1]["type"] == "exec" and ws.sent[-1]["cmd"] == "echo hi"


async def test_exec_offline_and_unknown(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    reg.add("box", "linux")
    hub = AgentHub(reg)
    off = await hub.exec("box", "x")
    assert off["ok"] is False and off["error"] == "machine_offline"
    unk = await hub.exec("ghost", "x")
    assert unk["ok"] is False and unk["error"] == "unknown_machine"


async def test_screenshot_roundtrip(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    ws = FakeWs()
    conn = AgentConnection(row["id"], ws)
    hub.register(conn)
    reply = {"type": "screenshot_result", "ok": True, "image_base64": "AAA",
             "width": 100, "height": 50, "captured_at": 123}
    res, _ = await asyncio.gather(
        hub.screenshot("box"),
        _drive(conn, ws, reply),
    )
    assert res["ok"] and res["image_base64"] == "AAA" and res["width"] == 100


async def test_unregister_marks_offline(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    hub.register(AgentConnection(row["id"], FakeWs()))
    hub.unregister(row["id"])
    assert hub.online(row["id"]) is False
    assert reg.list()[0]["status"] == "offline"
