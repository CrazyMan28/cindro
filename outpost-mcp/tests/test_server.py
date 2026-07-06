import asyncio
import json
import os
import socket
import sys

import httpx
import pytest
import websockets


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture
async def server(tmp_path):
    port = _free_port()
    token = "selftest-token"
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.update({
        "OUTPOST_MCP_TOKEN": token, "OUTPOST_MCP_PORT": str(port),
        "OUTPOST_MCP_HOST": "127.0.0.1", "OUTPOST_ADVERTISE_HOST": "127.0.0.1",
        "OUTPOST_CONFIG_DIR": str(tmp_path),
    })
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "outpost_mcp.server", env=env,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as hc:
        for _ in range(60):
            try:
                if (await hc.get(f"{base}/health", timeout=1)).status_code == 200:
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        else:
            proc.terminate()
            raise AssertionError("outpost-mcp did not become healthy")
    try:
        yield base, port, token
    finally:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()


async def test_health_open_and_machines_gated(server):
    base, _, token = server
    async with httpx.AsyncClient() as hc:
        assert (await hc.get(f"{base}/health")).json()["service"] == "outpost-mcp"
        assert (await hc.get(f"{base}/api/machines")).status_code == 401
        r = await hc.get(f"{base}/api/machines", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200 and r.json() == {"machines": []}


async def test_pair_download_gate_and_exec_roundtrip(server):
    base, port, token = server
    auth = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient() as hc:
        start = (await hc.post(f"{base}/api/pair/start", headers=auth, json={"name": "box"})).json()
        bid = start["bootstrap_id"]
        # the sh script is served open and embeds the bootstrap id
        sh = await hc.get(f"{base}/pair/{bid}/sh")
        assert sh.status_code == 200 and bid in sh.text
        # no binary present in this tmp env -> 404 (gate passed, file missing)
        dl = await hc.get(f"{base}/agent/download/{bid}/linux/amd64")
        assert dl.status_code == 404
        # complete the pairing (open, one-shot)
        done = (await hc.post(f"{base}/pair/{bid}/complete",
                              json={"name": "box", "os": "linux", "arch": "amd64"})).json()
        assert done["machine_id"] and done["token"]
        assert done["ws_url"] == f"ws://127.0.0.1:{port}/agent/ws"
        # second completion is rejected (one-shot)
        assert (await hc.post(f"{base}/pair/{bid}/complete", json={})).status_code == 403

        # connect a fake agent and answer one exec
        machine_id, mtoken = done["machine_id"], done["token"]

        async def fake_agent():
            async with websockets.connect(f"{done['ws_url']}?token={mtoken}") as ws:
                await ws.send(json.dumps({"type": "hello", "machine_id": machine_id}))
                req = json.loads(await ws.recv())
                assert req["type"] == "exec"
                await ws.send(json.dumps({
                    "type": "exec_result", "req_id": req["req_id"], "ok": True,
                    "exit_code": 0, "output": "pong", "error": ""}))
                await asyncio.sleep(0.2)

        agent_task = asyncio.create_task(fake_agent())
        await asyncio.sleep(0.4)  # let the agent register
        res = (await hc.post(f"{base}/api/exec", headers=auth,
                             json={"machine": "box", "cmd": "echo pong"})).json()
        assert res == {"ok": True, "exit_code": 0, "output": "pong", "error": ""}
        await agent_task
