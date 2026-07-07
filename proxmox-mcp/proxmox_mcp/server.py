"""Proxmox-MCP server: one FastAPI/FastMCP endpoint, localhost-only, that the
co-located jarvisd (running the scheduled ApiBrain/Mistral loop) calls.

Layout mirrors outpost-mcp/server.py, minus the pairing/websocket machinery
this service doesn't need (it only ever has one caller, on the same host).
"""

from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from proxmox_mcp import __version__, auth, config, tools_proxmox

mcp = FastMCP(
    "proxmox",
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
PROXMOX_TOOLS = tools_proxmox.register(mcp)
mcp_app = mcp.streamable_http_app()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="Proxmox MCP", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path == "/health" or request.method == "OPTIONS":
        return await call_next(request)
    if not auth.request_ok(request):
        return JSONResponse(status_code=401,
                            content={"error": "Unauthorized",
                                     "message": "Invalid or missing bearer token"})
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "proxmox-mcp", "version": __version__,
            "tools": len(PROXMOX_TOOLS)}


# Mounted last so /health wins over the MCP catch-all.
app.mount("/", mcp_app)


def main() -> None:
    h, p = config.host(), config.port()
    config.get_bearer_token()  # generate + persist on first start
    print(f"proxmox-mcp v{__version__} starting on {h}:{p}/mcp")
    uvicorn.run(app, host=h, port=p, log_level="info")


if __name__ == "__main__":
    main()
