"""computer-use MCP server: FastAPI app hosting the MCP transport at /mcp,
the Chrome-extension WebSocket at /ws/extension, and /health."""

import asyncio
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from computer_use_mcp import __version__, auth, session, tools_browser, tools_desktop
from computer_use_mcp.browser_bridge import bridge
from computer_use_mcp.config import load_config

# Tailnet + bearer-token model (same rationale as vm-agent-mcp): every request
# is token-checked by the middleware, so DNS-rebinding protection — which would
# reject the Tailscale IP / MagicDNS Host headers — is disabled rather than
# enumerating every name this box can be reached by.
mcp = FastMCP(
    "computer-use",
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
tools_desktop.register(mcp)
tools_browser.register(mcp)
mcp_app = mcp.streamable_http_app()


@asynccontextmanager
async def lifespan(app: FastAPI):
    ping_task = asyncio.create_task(bridge.ping_loop())
    async with mcp.session_manager.run():
        try:
            yield
        finally:
            ping_task.cancel()
            try:
                await ping_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Computer Use MCP", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path == "/health" or request.method == "OPTIONS":
        return await call_next(request)
    if not auth.request_ok(request):
        return JSONResponse(
            status_code=401,
            content={"error": "Unauthorized", "message": "Invalid or missing bearer token"},
        )
    return await call_next(request)


@app.get("/health")
async def health():
    cfg = load_config()
    try:
        active = session.detect()["active"]
        compositor = active.kind if active else None
    except Exception as exc:
        compositor = f"detect-error: {exc}"
    return {
        "status": "ok",
        "service": "computer-use-mcp",
        "version": __version__,
        "active_compositor": compositor,
        "ydotoold_socket": os.path.exists(cfg["ydotool_socket"]),
        "extension_connected": bridge.connected,
    }


@app.websocket("/ws/extension")
async def ws_extension(websocket: WebSocket):
    await bridge.handle(websocket)


# Mounted last so /health and /ws/extension win routing.
app.mount("/", mcp_app)


def main() -> None:
    host, port = load_config()["host"], int(load_config()["port"])
    print(f"computer-use MCP v{__version__} starting on {host}:{port}/mcp")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
