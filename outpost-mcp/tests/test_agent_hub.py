import asyncio
import json

import pytest
from starlette.websockets import WebSocketDisconnect

from outpost_mcp.agent_hub import AgentConnection, AgentHub
from outpost_mcp.registry import MachineRegistry


class FakeWs:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, text: str):
        self.sent.append(json.loads(text))


class DeadWs:
    """A socket that has already died: send_text raises, mimicking a
    disconnected/closing Starlette WebSocket."""

    def __init__(self, exc: Exception):
        self._exc = exc

    async def send_text(self, text: str):
        raise self._exc


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


async def test_unregister_stale_conn_does_not_evict_newer_connection(tmp_path):
    """Reconnect/roam race: WS1 drops, agent reconnects on WS2 before WS1's
    server-side loop notices the dead socket. WS2's hub.register() replaces
    the map entry; WS1's belated `finally: hub.unregister(machine_id, conn1)`
    must be a no-op (conn2 is current), not evict the live connection."""
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)

    conn1 = AgentConnection(row["id"], FakeWs())
    hub.register(conn1)
    assert hub.online(row["id"]) is True

    # Reconnect: a second WS for the same machine takes over before conn1's
    # loop has noticed its socket is dead.
    conn2 = AgentConnection(row["id"], FakeWs())
    hub.register(conn2)
    assert hub.online(row["id"]) is True

    # conn1's server-side loop finally errors out and tears itself down —
    # this must NOT touch conn2's registration.
    hub.unregister(row["id"], conn1)
    assert hub.online(row["id"]) is True
    assert reg.list()[0]["status"] == "online"

    # conn2 eventually really does disconnect — now it should go offline.
    hub.unregister(row["id"], conn2)
    assert hub.online(row["id"]) is False
    assert reg.list()[0]["status"] == "offline"


# --- Finding 2: send_text failure must not raise a raw 500 -----------------

@pytest.mark.parametrize("exc", [
    WebSocketDisconnect(code=1006),
    RuntimeError('Cannot call "send" once a close message has been sent.'),
])
async def test_exec_treats_dead_socket_send_as_machine_offline(tmp_path, exc):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    conn = AgentConnection(row["id"], DeadWs(exc))
    hub.register(conn)
    assert hub.online(row["id"]) is True

    res = await hub.exec("box", "echo hi")
    assert res == {"ok": False, "exit_code": -1, "output": "", "error": "machine_offline"}
    # The now-useless connection must be torn down, not left registered.
    assert hub.online(row["id"]) is False
    assert reg.list()[0]["status"] == "offline"


async def test_screenshot_treats_dead_socket_send_as_machine_offline(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    conn = AgentConnection(row["id"], DeadWs(WebSocketDisconnect(code=1006)))
    hub.register(conn)

    res = await hub.screenshot("box")
    assert res["ok"] is False and res["error"] == "machine_offline"
    assert hub.online(row["id"]) is False


async def test_request_raises_connection_error_and_clears_pending(tmp_path):
    """Unit-level check on AgentConnection itself: a send_text failure must
    surface as ConnectionError (the sentinel AgentHub knows how to handle),
    and must not leave a dangling future in _pending."""
    conn = AgentConnection("m1", DeadWs(RuntimeError("socket closed")))
    with pytest.raises(ConnectionError):
        await conn.request({"type": "exec"}, timeout=5)
    assert conn._pending == {}
