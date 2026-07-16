"""proxmox-operator-mcp: the full-power Proxmox tool server (:8800, loopback).

A SECOND MCP endpoint alongside the restricted tuning server (server.py, :8799).
Same shape — one FastMCP mounted under a bearer-gated FastAPI app, localhost
only — but a DISTINCT bearer (operator_mcp_token) and the full tools_operator
catalog. Only the co-located jarvisd running the interactive dashboard session
(routed here by the "proxmox-op-" targetRef) ever calls it; the restricted
:8799 catalog and its token are never touched.
"""

import hmac
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from proxmox_mcp import __version__, config, tools_operator
from proxmox_mcp.auth import _bearer_from_header

mcp = FastMCP(
    "proxmox-operator",
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
OPERATOR_TOOLS = tools_operator.register(mcp)
mcp_app = mcp.streamable_http_app()


def _operator_token_ok(token) -> bool:
    return bool(token) and hmac.compare_digest(token, config.operator_get_bearer_token())


def _request_ok(request: Request) -> bool:
    if _operator_token_ok(_bearer_from_header(request.headers.get("Authorization"))):
        return True
    return _operator_token_ok(request.query_params.get("token"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="Proxmox Operator MCP", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path == "/health" or request.method == "OPTIONS":
        return await call_next(request)
    if not _request_ok(request):
        return JSONResponse(status_code=401,
                            content={"error": "Unauthorized",
                                     "message": "Invalid or missing bearer token"})
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "proxmox-operator-mcp", "version": __version__,
            "tools": len(OPERATOR_TOOLS)}


# Mounted last so /health wins over the MCP catch-all.
app.mount("/", mcp_app)


def main() -> None:
    h, p = config.host(), config.operator_port()
    config.operator_get_bearer_token()  # generate + persist on first start
    print(f"proxmox-operator-mcp v{__version__} starting on {h}:{p}/mcp")
    uvicorn.run(app, host=h, port=p, log_level="info")


if __name__ == "__main__":
    main()
