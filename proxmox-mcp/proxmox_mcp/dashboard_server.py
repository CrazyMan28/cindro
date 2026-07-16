"""proxmox-dashboard: the LAN-facing host service for the Cindro Proxmox
dashboard (:8443, TLS).

Three jobs on one port:
  1. Static-serve the built SPA (SPA fallback to index.html).
  2. Reverse-proxy the browser's control WebSocket to the co-located jarvisd's
     LOOPBACK control socket, injecting jarvisd's control token server-side —
     so the browser never sees that token and jarvisd's ControlServer keeps its
     loopback-only binding unchanged (the proxy connects from 127.0.0.1).
  3. Redirect /pve to the native Proxmox UI (:8006) — the "full takeover"
     escape hatch, so nothing is removed.

Auth boundary: a dashboard token (installer-generated, 0600) is exchanged at
/login for an HttpOnly+Secure session cookie; the WS proxy and /pve both
require it. The SPA shell itself is public (it needs to render its own login
screen) but can do nothing without the cookie.
"""

from __future__ import annotations

import asyncio
import hmac
import os
from pathlib import Path

import uvicorn
import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse

from proxmox_mcp import __version__, config

DIST = Path(os.environ.get("PROXMOX_DASHBOARD_DIST",
                           "/opt/jarvis-proxmox-agent/dashboard/dist"))
CONTROL_TOKEN_FILE = Path(os.environ.get(
    "JARVISD_CONTROL_TOKEN_FILE", "/etc/jarvis-proxmox-agent/jarvisd/control_token"))
CONTROL_WS = os.environ.get("JARVISD_CONTROL_WS", "ws://127.0.0.1:8795/control/ws")
PVE_PORT = os.environ.get("PVE_UI_PORT", "8006")
COOKIE = "cindro_session"
DASHBOARD_HOST = os.environ.get("PROXMOX_DASHBOARD_HOST", "0.0.0.0")
DASHBOARD_PORT = int(os.environ.get("PROXMOX_DASHBOARD_PORT", "8443"))
PVE_SSL_CERT = os.environ.get("PVE_SSL_CERT", "/etc/pve/local/pve-ssl.pem")
PVE_SSL_KEY = os.environ.get("PVE_SSL_KEY", "/etc/pve/local/pve-ssl.key")

app = FastAPI(title="Cindro Proxmox Dashboard", version=__version__)


def dashboard_token() -> str:
    env = os.environ.get("DASHBOARD_TOKEN")
    if env:
        return env.strip()
    try:
        return config.DASHBOARD_TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def control_token() -> str:
    try:
        return CONTROL_TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def _cookie_ok(cookies) -> bool:
    tok = dashboard_token()
    return bool(tok) and hmac.compare_digest(cookies.get(COOKIE, ""), tok)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "proxmox-dashboard", "version": __version__,
            "dist_present": (DIST / "index.html").exists()}


@app.post("/login")
async def login(request: Request):
    token = ""
    ctype = request.headers.get("content-type", "")
    if "application/json" in ctype:
        try:
            token = (await request.json()).get("token", "")
        except Exception:
            token = ""
    else:
        form = await request.form()
        token = form.get("token", "")
    want = dashboard_token()
    if not want or not hmac.compare_digest(str(token), want):
        return JSONResponse({"ok": False, "error": "invalid token"}, status_code=401)
    resp = JSONResponse({"ok": True})
    # HttpOnly + Secure (served over TLS) + SameSite=Strict; value is the token
    # itself, which never leaves this TLS channel and gates only host-local
    # loopback access. 7-day lifetime.
    resp.set_cookie(COOKIE, want, httponly=True, secure=True, samesite="strict",
                    max_age=7 * 24 * 3600, path="/")
    return resp


@app.post("/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.get("/auth")
async def auth_check(request: Request):
    return {"authed": _cookie_ok(request.cookies)}


@app.get("/pve")
@app.get("/pve/{path:path}")
async def pve_escape(request: Request, path: str = ""):
    """Full-takeover escape hatch: bounce to the native Proxmox UI on :8006."""
    if not _cookie_ok(request.cookies):
        return RedirectResponse("/", status_code=302)
    host = request.url.hostname or "127.0.0.1"
    return RedirectResponse(f"https://{host}:{PVE_PORT}/{path}", status_code=302)


@app.websocket("/control/ws")
async def control_ws(ws: WebSocket):
    """Browser <-> loopback jarvisd control socket, with the jarvisd token
    injected server-side."""
    if not _cookie_ok(ws.cookies):
        await ws.close(code=1008)  # policy violation
        return
    await ws.accept()
    backend_url = f"{CONTROL_WS}?token={control_token()}"
    try:
        async with websockets.connect(backend_url, max_size=None,
                                      ping_interval=None) as backend:
            async def browser_to_backend():
                try:
                    while True:
                        await backend.send(await ws.receive_text())
                except (WebSocketDisconnect, RuntimeError):
                    pass

            async def backend_to_browser():
                try:
                    async for msg in backend:
                        if isinstance(msg, bytes):
                            await ws.send_bytes(msg)
                        else:
                            await ws.send_text(msg)
                except Exception:
                    pass

            b2 = asyncio.create_task(browser_to_backend())
            f2 = asyncio.create_task(backend_to_browser())
            done, pending = await asyncio.wait(
                {b2, f2}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception:
        pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


_PLACEHOLDER = """<!doctype html><html><head><meta charset="utf-8">
<title>Cindro Proxmox Dashboard</title></head>
<body style="font-family:system-ui;background:#0A0F17;color:#EAF2F8;padding:3rem">
<h1 style="color:#3DD6FF">Cindro Proxmox Dashboard</h1>
<p>The dashboard is running, but its web bundle isn't installed yet.</p>
<p style="color:#90A6B8">Publish a <code>cindro-proxmox-dashboard.tgz</code> release asset
(or push a build to <code>%s</code>) and restart <code>proxmox-dashboard</code>.</p>
</body></html>""" % str(DIST)


@app.get("/{full_path:path}")
async def spa(full_path: str):
    """Static SPA with history-fallback. Public (the SPA renders its own login);
    the WS proxy + /pve are the gated surfaces."""
    if full_path and ".." not in full_path:
        candidate = DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
    index = DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return HTMLResponse(_PLACEHOLDER)


def main() -> None:
    kwargs = {"host": DASHBOARD_HOST, "port": DASHBOARD_PORT, "log_level": "info"}
    if Path(PVE_SSL_CERT).exists() and Path(PVE_SSL_KEY).exists():
        kwargs["ssl_certfile"] = PVE_SSL_CERT
        kwargs["ssl_keyfile"] = PVE_SSL_KEY
    else:
        print(f"proxmox-dashboard: WARNING no TLS cert at {PVE_SSL_CERT} — serving plain HTTP")
    print(f"proxmox-dashboard v{__version__} on {DASHBOARD_HOST}:{DASHBOARD_PORT} "
          f"(dist={DIST}, present={(DIST / 'index.html').exists()})")
    uvicorn.run(app, **kwargs)


if __name__ == "__main__":
    main()
