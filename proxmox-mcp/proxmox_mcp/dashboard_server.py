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
import json
import os
import secrets
import subprocess
import time
from pathlib import Path

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse

from proxmox_mcp import __version__

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
PVE_API = os.environ.get("PVE_API_BASE", "https://127.0.0.1:8006/api2/json")
SESSION_TTL = 8 * 3600  # 8h dashboard session

# Login authenticates against Proxmox's OWN realms (Linux PAM / Proxmox VE auth,
# with TFA) via /access/ticket — the same credentials you use for the Proxmox UI
# (e.g. root@pam). A successful ticket mints an in-memory dashboard session; the
# cookie carries only the opaque session id, never the Proxmox ticket.
_serving_tls = True  # set in main(); the session cookie's Secure flag follows it
_sessions: dict[str, dict] = {}  # session_id -> {"user": str, "exp": epoch}

app = FastAPI(title="Cindro Proxmox Dashboard", version=__version__)

# The proxy forwards to the loopback daemon WITH its control token, so it must
# only relay the methods this Proxmox-only SPA actually needs — never the full
# Contract A surface (outpost.exec / mcp.add / hooks.* / settings writes / …).
# A compromised/XSS'd bundle on this LAN-facing origin can't escalate past these.
# Exactly what the pve SPA's operator flow uses — nothing that could enumerate,
# read, or control OTHER host jarvisd sessions (no session.list/history/cancel/
# set_goals/wake). The dashboard only creates/sends/subscribes to its own
# operator session and answers approvals.
_ALLOWED_METHODS = frozenset({
    "ping",
    "session.create", "session.send", "session.subscribe",
    "approval.respond",
})
_ALLOWED_PREFIXES = ("proxmoxop.",)


def _method_allowed(method: str) -> bool:
    return method in _ALLOWED_METHODS or any(method.startswith(p) for p in _ALLOWED_PREFIXES)


def control_token() -> str:
    try:
        return CONTROL_TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def _new_session(user: str) -> str:
    now = time.time()
    for k in [k for k, v in _sessions.items() if v["exp"] < now]:  # prune expired
        _sessions.pop(k, None)
    sid = secrets.token_urlsafe(32)
    _sessions[sid] = {"user": user, "exp": now + SESSION_TTL}
    return sid


def _cookie_ok(cookies) -> bool:
    s = _sessions.get(cookies.get(COOKIE, ""))
    return bool(s) and s["exp"] > time.time()


def get_realms() -> list[dict]:
    """Proxmox auth realms for the login dropdown (root-local via pvesh)."""
    try:
        out = subprocess.run(["pvesh", "get", "/access/domains", "--output-format", "json"],
                             capture_output=True, text=True, timeout=10)
        data = json.loads(out.stdout or "[]")
        realms = [{"realm": d.get("realm"),
                   "comment": d.get("comment") or d.get("type") or d.get("realm")}
                  for d in data if d.get("realm")]
        if realms:
            return realms
    except Exception:
        pass
    return [{"realm": "pam", "comment": "Linux PAM standard authentication"},
            {"realm": "pve", "comment": "Proxmox VE authentication server"}]


async def _pve_ticket(userid: str, password: str, tfa_challenge: str = "") -> dict:
    """POST Proxmox /access/ticket. Returns {ok, data} or {ok:False}."""
    data = {"username": userid, "password": password}
    if tfa_challenge:
        data["tfa-challenge"] = tfa_challenge
    try:
        async with httpx.AsyncClient(verify=False, timeout=15) as client:
            r = await client.post(f"{PVE_API}/access/ticket", data=data)
    except Exception:
        return {"ok": False}
    if r.status_code != 200:
        return {"ok": False}
    return {"ok": True, "data": (r.json() or {}).get("data") or {}}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "proxmox-dashboard", "version": __version__,
            "dist_present": (DIST / "index.html").exists()}


@app.get("/realms")
async def realms():
    return {"realms": get_realms()}


@app.post("/login")
async def login(request: Request):
    if "application/json" in request.headers.get("content-type", ""):
        try:
            body = await request.json()
        except Exception:
            body = {}
    else:
        body = dict(await request.form())
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    realm = str(body.get("realm", "pam")).strip() or "pam"
    otp = str(body.get("otp", "")).strip()
    challenge = str(body.get("tfa_challenge", ""))
    if not username or (not password and not otp):
        return JSONResponse({"ok": False, "error": "username and password required"},
                            status_code=400)
    userid = username if "@" in username else f"{username}@{realm}"

    if challenge and otp:
        res = await _pve_ticket(userid, f"totp:{otp}", challenge)  # answer the TFA challenge
    else:
        res = await _pve_ticket(userid, password)

    if not res.get("ok"):
        return JSONResponse({"ok": False, "error": "invalid credentials"}, status_code=401)
    data = res["data"]
    ticket = str(data.get("ticket", ""))
    # TFA required (first step): the ticket is a "!tfa!" challenge — ask for the code.
    if (data.get("NeedTFA") or "!tfa!" in ticket) and not (challenge and otp):
        return JSONResponse({"ok": False, "tfa": True, "tfa_challenge": ticket})
    if not ticket or "!tfa!" in ticket:
        return JSONResponse({"ok": False, "error": "two-factor authentication failed"},
                            status_code=401)
    sid = _new_session(userid)
    resp = JSONResponse({"ok": True, "user": userid})
    resp.set_cookie(COOKIE, sid, httponly=True, secure=_serving_tls, samesite="strict",
                    max_age=SESSION_TTL, path="/")
    return resp


@app.post("/logout")
async def logout(request: Request):
    _sessions.pop(request.cookies.get(COOKIE, ""), None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.get("/auth")
async def auth_check(request: Request):
    s = _sessions.get(request.cookies.get(COOKIE, ""))
    authed = bool(s) and s["exp"] > time.time()
    return {"authed": authed, "user": s["user"] if authed else ""}


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
                        raw = await ws.receive_text()
                        method = ""
                        frame_id = None
                        try:
                            frame = json.loads(raw)
                            method = str(frame.get("method", ""))
                            frame_id = frame.get("id")
                        except (ValueError, AttributeError):
                            continue  # drop malformed frames, never forward
                        if not _method_allowed(method):
                            # Refuse (don't forward to the daemon) and tell the tab.
                            await ws.send_text(json.dumps({
                                "id": frame_id, "ok": False,
                                "error": {"code": "method_not_allowed",
                                          "message": f"{method} is not permitted from the dashboard"},
                            }))
                            continue
                        await backend.send(raw)
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
    global _serving_tls
    kwargs = {"host": DASHBOARD_HOST, "port": DASHBOARD_PORT, "log_level": "info"}
    if Path(PVE_SSL_CERT).exists() and Path(PVE_SSL_KEY).exists():
        kwargs["ssl_certfile"] = PVE_SSL_CERT
        kwargs["ssl_keyfile"] = PVE_SSL_KEY
        _serving_tls = True
    else:
        # No TLS -> the session cookie must NOT be Secure or the browser won't
        # send it back over http:// and login would appear to succeed but never
        # authenticate subsequent requests.
        _serving_tls = False
        print(f"proxmox-dashboard: WARNING no TLS cert at {PVE_SSL_CERT} — serving plain HTTP")
    print(f"proxmox-dashboard v{__version__} on {DASHBOARD_HOST}:{DASHBOARD_PORT} "
          f"(dist={DIST}, present={(DIST / 'index.html').exists()})")
    uvicorn.run(app, **kwargs)


if __name__ == "__main__":
    main()
