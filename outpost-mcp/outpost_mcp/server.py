"""Outpost-MCP server: one FastAPI/FastMCP endpoint that pairs remote machines
and relays gated exec/screenshot over each agent's dialed-out WebSocket.

Layout mirrors jarvis-mcp/server.py:
- MCP streamable-http transport mounted at /mcp (bearer-gated).
- /health + the one-shot /pair/* + /agent/download bootstrap routes are open.
- /agent/ws is the persistent per-machine-token relay socket.
"""

import asyncio
import json
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from outpost_mcp import __version__, agent_build, auth, config, tools_outpost
from outpost_mcp.agent_hub import AgentConnection, AgentHub
from outpost_mcp.pairing import PairingStore
from outpost_mcp.registry import MachineRegistry

registry = MachineRegistry()
pairing = PairingStore()
hub = AgentHub(registry)

mcp = FastMCP(
    "outpost",
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
OUTPOST_TOOLS = tools_outpost.register(mcp, registry, pairing, hub)
mcp_app = mcp.streamable_http_app()

# Open (no bearer): /health, one-shot bootstrap fetch/redeem, agent download.
# The WS handshake bypasses http middleware and does its own ?token gate.
_OPEN_PREFIXES = ("/pair/", "/agent/download/")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="Outpost MCP", version=__version__, lifespan=lifespan)

# Serializes on-demand agent builds so two concurrent first-pairings for the
# same target don't race the same `go build` output file.
_agent_build_lock = asyncio.Lock()

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if (path == "/health" or request.method == "OPTIONS"
            or any(path.startswith(p) for p in _OPEN_PREFIXES)):
        return await call_next(request)
    if not auth.request_ok(request):
        return JSONResponse(status_code=401,
                            content={"error": "Unauthorized",
                                     "message": "Invalid or missing bearer token"})
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "outpost-mcp", "version": __version__,
            "machines": len(registry.list()), "tools": len(OUTPOST_TOOLS)}


# --- pairing (mixed open/gated) --------------------------------------------

@app.post("/api/pair/start")
async def api_pair_start(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    return pairing.start(body.get("name", ""), body.get("os_hint", ""))


@app.get("/api/pair/status/{bootstrap_id}")
async def api_pair_status(bootstrap_id: str):
    return pairing.status(bootstrap_id)


@app.get("/pair/{bootstrap_id}/sh")
async def pair_sh(bootstrap_id: str):
    if not pairing.valid(bootstrap_id):
        return PlainTextResponse("echo 'outpost: pairing code invalid or expired' >&2; exit 1",
                                 status_code=410)
    return PlainTextResponse(pairing.render_sh(bootstrap_id), media_type="text/x-shellscript")


@app.get("/pair/{bootstrap_id}/ps1")
async def pair_ps1(bootstrap_id: str):
    if not pairing.valid(bootstrap_id):
        return PlainTextResponse("Write-Error 'outpost: pairing code invalid or expired'",
                                 status_code=410)
    return PlainTextResponse(pairing.render_ps1(bootstrap_id))


@app.get("/agent/download/{bootstrap_id}/{os_name}/{arch}")
async def agent_download(bootstrap_id: str, os_name: str, arch: str):
    if not pairing.valid(bootstrap_id):
        return JSONResponse({"error": "invalid_bootstrap"}, status_code=403)
    # Enforce the target allow-list BEFORE touching the filesystem so a caller-
    # supplied os_name/arch can never select an on-disk filename (a stray/manual
    # binary in agent-bin/ must not be servable via the cache-hit fast path).
    if not agent_build.is_known_target(os_name, arch):
        return JSONResponse({"error": "unknown_target", "os": os_name, "arch": arch},
                            status_code=404)
    name = agent_build.binary_name(os_name, arch)
    path = config.agent_bin_dir() / name
    if not path.exists():
        # Self-heal: a freshly-checked-out hub has an empty agent-bin/. Build the
        # one target on demand from the Go source if a toolchain is present.
        # Offload the blocking `go build` to a worker thread (and serialize builds
        # with a lock) so a first pairing's on-demand compile never freezes the
        # single-worker event loop for every other request.
        async with _agent_build_lock:
            if not path.exists():  # re-check under the lock (another request may have built it)
                built = await asyncio.to_thread(agent_build.ensure_agent_binary, os_name, arch)
                if built is None:
                    return JSONResponse(
                        {"error": "agent_binary_unavailable", "name": name,
                         "hint": "populate outpost-mcp/agent-bin/ (run outpost-agent/build.sh) "
                                 "or install a Go toolchain so the server can build it on demand"},
                        status_code=404)
                path = built
    return FileResponse(str(path), filename=name)


@app.post("/pair/{bootstrap_id}/complete")
async def pair_complete(bootstrap_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    b = pairing.redeem(bootstrap_id)
    if b is None:
        return JSONResponse({"error": "invalid_or_used"}, status_code=403)
    name = body.get("name") or b.get("name") or ""
    # Re-pairing replaces: drop any existing same-name row (and its live
    # socket) first, or the old dead row would shadow the new one forever in
    # get()-by-name lookups (get() returns the FIRST id-or-name match).
    while name and registry.get(name):
        _revoke_machine(name)
    created = registry.add(name=name, os_name=body.get("os", ""))
    row = created["row"]
    pairing.mark_paired(bootstrap_id, row["id"])
    return {"machine_id": row["id"], "token": created["token"],
            "ws_url": f"ws://{config.resolve_advertise_host()}:{config.port()}/agent/ws"}


# --- machine ops (bearer-gated) --------------------------------------------

@app.get("/api/machines")
async def api_machines():
    return {"machines": registry.list()}


def _revoke_machine(machine: str) -> bool:
    """Shared by both revoke routes: look the machine up (by id OR name),
    drop its live socket via the hub, then delete it from the registry. A
    revoke-by-id that skips hub.unregister would leave a stale AgentConnection
    registered after the row is gone."""
    m = registry.get(machine)
    if not m:
        return False
    hub.unregister(m["id"])
    return registry.revoke(m["id"])


@app.post("/api/machines/{machine_id}/revoke")
async def api_revoke_id(machine_id: str):
    ok = _revoke_machine(machine_id)
    return {"ok": ok, "revoked": ok}


@app.post("/api/exec")
async def api_exec(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not body.get("machine"):
        return JSONResponse({"error": "bad_request", "message": "missing 'machine'"},
                             status_code=400)
    if not body.get("cmd"):
        return JSONResponse({"error": "bad_request", "message": "missing 'cmd'"},
                             status_code=400)
    return await hub.exec(body["machine"], body["cmd"],
                          float(body.get("timeout", 30.0)), body.get("shell", "auto"))


@app.post("/api/screenshot")
async def api_screenshot(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not body.get("machine"):
        return JSONResponse({"error": "bad_request", "message": "missing 'machine'"},
                             status_code=400)
    return await hub.screenshot(body["machine"])


@app.post("/api/revoke")
async def api_revoke(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not body.get("machine"):
        return JSONResponse({"error": "bad_request", "message": "missing 'machine'"},
                             status_code=400)
    ok = _revoke_machine(body["machine"])
    return {"ok": ok, "revoked": ok}


# --- the persistent relay socket -------------------------------------------

@app.websocket("/agent/ws")
async def agent_ws(ws: WebSocket):
    m = registry.by_token(ws.query_params.get("token", ""))
    if not m:
        await ws.close(code=4401)
        return
    await ws.accept()
    conn = AgentConnection(m["id"], ws)
    hub.register(conn)
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")
            if kind in ("exec_result", "screenshot_result"):
                conn.resolve(msg.get("req_id", ""), msg)
            elif kind == "hello":
                registry.set_status(m["id"], "online")
            elif kind == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"outpost-mcp: agent ws error for machine {m['id']}: {exc}")
    finally:
        hub.unregister(m["id"], conn)


# Mounted last so explicit routes win over the MCP catch-all.
app.mount("/", mcp_app)


def main() -> None:
    h, p = config.host(), config.port()
    config.get_bearer_token()  # generate + print the token path on first start
    print(f"outpost-mcp v{__version__} starting on {h}:{p}/mcp "
          f"(advertise {config.advertise_base_url()})")
    uvicorn.run(app, host=h, port=p, log_level="info")


if __name__ == "__main__":
    main()
