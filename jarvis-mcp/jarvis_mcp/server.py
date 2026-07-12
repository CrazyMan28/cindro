"""Jarvis-MCP server: a single FastMCP/HTTP endpoint that fronts the whole
Jarvis stack so external agents (Claude Code / Codex) can drive Jarvis.

Layout (mirrors computer-use/server.py):
- MCP streamable-http transport mounted at /mcp (bearer-gated).
- /health is open (readiness gate for supervisors).
- jarvis_* tools wrap Contract A (jarvisd control WS, :8795).
- jarvis_cu_* tools re-export the computer-use engine (:8794) so ONE endpoint
  gives Jarvis orchestration + full computer use.

Auth: a single inbound bearer (token at ~/.config/jarvis/jarvis_mcp_token, or
the JARVIS_MCP_TOKEN env override), checked by the FastAPI middleware on every
path except /health — the same tailnet bearer model as computer-use.
"""

import asyncio
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from jarvis_mcp import __version__, auth, config, cu_proxy
from jarvis_mcp import tools_jarvis
from jarvis_mcp.control_client import client as control_client

# Tailnet + bearer-token model: every request is token-checked by the
# middleware, so DNS-rebinding protection (which would reject the Tailscale IP /
# MagicDNS Host headers) is disabled — same rationale as computer-use.
mcp = FastMCP(
    "jarvis",
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)

# Register the Jarvis orchestration tools eagerly; the computer-use re-export is
# discovered at startup (lifespan) since it needs an async client round-trip.
JARVIS_TOOLS = tools_jarvis.register(mcp)
CU_TOOLS: list[str] = []

mcp_app = mcp.streamable_http_app()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Discover + register the computer-use tools as jarvis_cu_* proxies. Tolerant
    # of the engine being down — the Jarvis-only surface still serves.
    global CU_TOOLS
    try:
        CU_TOOLS = await cu_proxy.register_all(mcp)
    except Exception as exc:  # never let re-export failure block startup
        print(f"jarvis-mcp: computer-use re-export failed: {exc}")
        CU_TOOLS = []
    async with mcp.session_manager.run():
        try:
            yield
        finally:
            await control_client.close()


app = FastAPI(title="Cindro MCP", version=__version__, lifespan=lifespan)

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
            content={"error": "Unauthorized",
                     "message": "Invalid or missing bearer token"},
        )
    return await call_next(request)


@app.get("/health")
async def health():
    """Open readiness endpoint. Reports whether the daemon control WS answers a
    ping (cheap) and how the computer-use re-export resolved."""
    cu_url, cu_token = config.computer_use_endpoint()
    daemon_ok = False
    daemon_detail = ""
    try:
        await asyncio.wait_for(control_client.call("ping", timeout=4), timeout=5)
        daemon_ok = True
    except Exception as exc:  # daemon down / token mismatch
        daemon_detail = str(exc)
    return {
        "status": "ok",
        "service": "jarvis-mcp",
        "version": __version__,
        "daemon_control_ok": daemon_ok,
        "daemon_detail": daemon_detail,
        "jarvis_tools": len(JARVIS_TOOLS),
        "computer_use_reexported": len(CU_TOOLS),
        "computer_use_endpoint": cu_url,
        "computer_use_bearer_configured": bool(cu_token),
    }


# Mounted last so /health wins routing over the MCP catch-all.
app.mount("/", mcp_app)


def main() -> None:
    h, p = config.host(), config.port()
    # Touch the token so it's generated (and its path printed) on first start.
    config.get_bearer_token()
    print(f"jarvis-mcp v{__version__} starting on {h}:{p}/mcp "
          f"(advertise {config.ADVERTISE_HOST}:{p})")
    uvicorn.run(app, host=h, port=p, log_level="info")


if __name__ == "__main__":
    main()
