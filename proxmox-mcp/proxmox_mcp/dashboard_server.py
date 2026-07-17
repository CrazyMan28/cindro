"""proxmox-dashboard: the LAN-facing host service for the Cindro Proxmox
dashboard (:8443, TLS).

This is a REVERSE PROXY, not an auth system of its own. Three jobs on one port:

  1. Reverse-proxy every real Proxmox path (``/api2``, ``/pve2``, ``/pwt``,
     noVNC/xterm.js console assets, docs, ...) straight through to the
     co-located ``pveproxy`` on 127.0.0.1:8006 — HTTP *and* WebSocket upgrades
     (the noVNC/xterm console sockets). Headers, cookies and body pass through
     unmodified in both directions, so ``Set-Cookie: PVEAuthCookie=...`` and
     the ``CSRFPreventionToken`` flow to/from the browser exactly like they do
     against :8006 directly. This makes the whole Proxmox REST API same-origin
     with the dashboard SPA — the SPA authenticates with Proxmox's OWN
     ``/access/ticket`` and never needs a Cindro-specific login of its own.
  2. Static-serve the built SPA (history-fallback to index.html) at ``/`` and
     any path that ISN'T a recognized Proxmox asset prefix.
  3. Bridge the Cindro AI daemon under ``/_jarvis/*``:
       - ``/_jarvis/ws``       operator chat, proxied to the co-located
                                jarvisd's loopback control socket (token
                                injected server-side; the browser never sees
                                it), restricted to a method allowlist.
       - ``/_jarvis/settings`` GET/POST so the SPA can read/write the AI
                                provider configuration (API keys, default
                                model/brain) through the same daemon.
       - ``/_jarvis/health``   liveness probe for the dashboard process itself.

Auth boundary for #3: since this service has NO session store of its own, it
piggybacks on Proxmox's: a request is "authed" iff its ``PVEAuthCookie`` is
currently accepted by pveproxy (checked live via ``GET /api2/json/version``,
the cheapest authenticated endpoint — this also means ticket expiry/renewal
just works, because it's Proxmox's own logic, not a reimplementation of it).
"""

from __future__ import annotations

import asyncio
import json
import os
import ssl
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from proxmox_mcp import __version__

DIST = Path(os.environ.get("PROXMOX_DASHBOARD_DIST",
                           "/opt/jarvis-proxmox-agent/dashboard/dist"))
CONTROL_TOKEN_FILE = Path(os.environ.get(
    "JARVISD_CONTROL_TOKEN_FILE", "/etc/jarvis-proxmox-agent/jarvisd/control_token"))
CONTROL_WS = os.environ.get("JARVISD_CONTROL_WS", "ws://127.0.0.1:8795/control/ws")
DASHBOARD_HOST = os.environ.get("PROXMOX_DASHBOARD_HOST", "0.0.0.0")
DASHBOARD_PORT = int(os.environ.get("PROXMOX_DASHBOARD_PORT", "8443"))
PVE_SSL_CERT = os.environ.get("PVE_SSL_CERT", "/etc/pve/local/pve-ssl.pem")
PVE_SSL_KEY = os.environ.get("PVE_SSL_KEY", "/etc/pve/local/pve-ssl.key")

# The co-located pveproxy this whole file reverse-proxies to. Overridable for
# tests (point it at a local mock instead of the real :8006).
PVE_UPSTREAM_HOST = os.environ.get("PVE_UPSTREAM_HOST", "127.0.0.1")
PVE_UI_PORT = os.environ.get("PVE_UI_PORT", "8006")
PVE_HTTP_BASE = f"https://{PVE_UPSTREAM_HOST}:{PVE_UI_PORT}"
PVE_WS_BASE = f"wss://{PVE_UPSTREAM_HOST}:{PVE_UI_PORT}"
PVE_AUTH_COOKIE = "PVEAuthCookie"  # the cookie name Proxmox's own ticket auth sets

# ---------------------------------------------------------------------------
# HTTP reverse proxy to pveproxy
# ---------------------------------------------------------------------------

# Real pveproxy path prefixes we forward as-is. Everything else falls through
# to the SPA (history-fallback), so the SPA's own client-side routes (e.g.
# /vms, /chat) never get mistaken for Proxmox assets and vice versa.
_PVE_PROXY_PREFIXES = (
    "/api2",            # REST/JSON + extjs API root (auth, VM/CT ops, tasks...)
    "/pve2",            # manager6 JS/CSS bundle
    "/pwt",             # proxmox-widget-toolkit assets
    "/novnc",           # noVNC console assets
    "/xtermjs",         # xterm.js console assets
    "/pve-docs",        # inline docs viewer
    "/proxmoxlib.js",
    "/qrcode.min.js",
    "/mobile",          # touch UI
    "/vncterm",         # legacy vt100 terminal assets
)

# Hop-by-hop / connection-specific headers that must never be blindly forwarded
# in either direction (RFC 7230 §6.1) — everything else (including Cookie,
# Set-Cookie, CSRFPreventionToken, Authorization) passes straight through.
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
})

# uvicorn stamps its own accurate "date"/"server" on every outbound response;
# forwarding pveproxy's copies too would just duplicate them (technically
# non-conformant, and needlessly names the internal upstream to the LAN).
_RESPONSE_STRIP = _HOP_BY_HOP | {"date", "server"}

# A single shared self-signed-tolerant SSL context for the WS console proxy
# (pveproxy's cert is the cluster's own pve-ssl.pem — self-signed by default,
# same reason the HTTP proxy client below uses verify=False).
_INSECURE_SSL_CTX = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
_INSECURE_SSL_CTX.check_hostname = False
_INSECURE_SSL_CTX.verify_mode = ssl.CERT_NONE


def _is_pve_asset(path: str) -> bool:
    p = "/" + path.lstrip("/")
    return any(p == prefix or p.startswith(prefix + "/") for prefix in _PVE_PROXY_PREFIXES)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # One shared, connection-pooled client for the lifetime of the process.
    _app.state.http_client = httpx.AsyncClient(
        verify=False, timeout=httpx.Timeout(30.0, read=300.0))
    try:
        yield
    finally:
        await _app.state.http_client.aclose()


app = FastAPI(title="Cindro Proxmox Dashboard", version=__version__, lifespan=_lifespan)


async def _proxy_http(request: Request, full_path: str) -> Response:
    """Forward one HTTP request to pveproxy and stream its response straight
    back — method, headers, cookies and body in both directions, unmodified,
    so Set-Cookie (PVEAuthCookie) and CSRFPreventionToken flow through exactly
    as they would talking to :8006 directly."""
    # Use the RAW (still-percent-encoded) path from the ASGI scope, NOT the
    # FastAPI-decoded `full_path`: a Proxmox volid like "local:backup/vzdump-..."
    # arrives as "local%3Abackup%2Fvzdump-...", and decoding the %2F would split
    # it into extra path segments pveproxy rejects (breaking backup/content ops).
    # httpx preserves existing percent-encoding, so the encoded slash survives.
    raw_path = request.scope.get("raw_path")
    path = raw_path.decode("latin-1") if raw_path else request.url.path
    if not path.startswith("/"):
        path = "/" + path
    url = f"{PVE_HTTP_BASE}{path}"
    if request.url.query:
        url += f"?{request.url.query}"
    fwd_headers = [(k, v) for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP]
    body = await request.body()

    client: httpx.AsyncClient = request.app.state.http_client
    try:
        upstream_req = client.build_request(request.method, url, headers=fwd_headers, content=body)
        upstream = await client.send(upstream_req, stream=True)
    except httpx.HTTPError:
        return JSONResponse({"error": "proxmox_unreachable"}, status_code=502)

    resp_headers = [(k, v) for k, v in upstream.headers.items()
                    if k.lower() not in _RESPONSE_STRIP and k.lower() != "set-cookie"]
    resp = StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code,
                             headers=dict(resp_headers),
                             background=BackgroundTask(upstream.aclose))
    # dict() would drop all but the last Set-Cookie if there were several —
    # append each one as its own raw header so multi-cookie responses survive.
    for raw_cookie in upstream.headers.get_list("set-cookie"):
        resp.raw_headers.append((b"set-cookie", raw_cookie.encode("latin-1")))
    return resp


async def _pve_authed(cookie_value: str) -> bool:
    """True iff `cookie_value` is a PVEAuthCookie pveproxy currently accepts.
    We ask pveproxy itself (cheapest authenticated GET) instead of
    reimplementing Proxmox's ticket verification/expiry/renewal logic."""
    if not cookie_value:
        return False
    try:
        async with httpx.AsyncClient(verify=False, timeout=8) as client:
            r = await client.get(f"{PVE_HTTP_BASE}/api2/json/version",
                                 cookies={PVE_AUTH_COOKIE: cookie_value})
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def _cookie_userid(cookie_value: str) -> str:
    """The userid embedded in a PVEAuthCookie ("PVE:<userid>:<ts>::<sig>").
    Only trusted AFTER the ticket is verified against pveproxy — a forged cookie
    could claim any userid, but pveproxy would reject its signature."""
    from urllib.parse import unquote
    parts = unquote(cookie_value).split(":")
    return parts[1] if len(parts) > 1 else ""


async def _pve_admin(cookie_value: str) -> bool:
    """True iff the ticket belongs to a FULL Proxmox admin — root@pam, or a user
    holding EVERY privilege Proxmox's own built-in `Administrator` role grants,
    on '/'. A merely-valid ticket, or a hand-picked privilege subset, is NOT
    enough: the Cindro operator can do anything a root shell can via its
    full-power MCP, and the AI provider keys are host-wide secrets, so only a
    genuine admin may command it or configure it. Deliberately queries
    `access/roles/Administrator` instead of hardcoding a privilege list — a
    custom role can be built from an arbitrary subset of privileges (e.g. just
    VM.Allocate/VM.PowerMgmt/Datastore.Allocate/Sys.Modify for a "power user"
    who is NOT an admin), so any fixed subset is satisfiable by a non-admin
    role; only requiring the role's CURRENT, COMPLETE privilege set is
    authoritative."""
    if not cookie_value:
        return False
    # root@pam is the built-in superuser — allow it, but only once pveproxy has
    # confirmed the ticket is genuine (defeats a forged "root@pam" cookie).
    if _cookie_userid(cookie_value) == "root@pam":
        return await _pve_authed(cookie_value)
    try:
        async with httpx.AsyncClient(verify=False, timeout=8) as client:
            role_r = await client.get(
                f"{PVE_HTTP_BASE}/api2/json/access/roles/Administrator",
                cookies={PVE_AUTH_COOKIE: cookie_value})
            if role_r.status_code != 200:
                return False
            # Codex review (PR #130): a role object represents its privileges as a
            # single comma-separated `privs` STRING (e.g. "VM.Allocate,Sys.Modify,...")
            # not a map of privilege-name -> bool. Treating .items() as that map
            # produced required == ["privs"], which /access/permissions never has a
            # key for, so every non-root@pam admin failed this check. Parse + split
            # the real privs string instead.
            admin_role = (role_r.json() or {}).get("data") or {}
            privs_str = admin_role.get("privs", "") if isinstance(admin_role, dict) else ""
            required = [p for p in privs_str.split(",") if p]
            if not required:
                return False
            r = await client.get(f"{PVE_HTTP_BASE}/api2/json/access/permissions",
                                 cookies={PVE_AUTH_COOKIE: cookie_value})
        if r.status_code != 200:
            return False
        perms = (r.json() or {}).get("data") or {}
        root = perms.get("/", {}) if isinstance(perms, dict) else {}
        return all(root.get(p) for p in required)
    except (httpx.HTTPError, ValueError):
        return False


def _same_origin(origin: str, host: str) -> bool:
    """CSRF / cross-site-WebSocket-hijack defense for the /_jarvis/* endpoints:
    the request's Origin must match the dashboard's own Host. A cross-site page
    can send the ambient PVEAuthCookie on a fetch/WS handshake, but it cannot
    forge a same-origin Origin header — so requiring it blocks CSWSH/CSRF."""
    if not origin or not host:
        return False
    try:
        return urlsplit(origin).netloc == host
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# WebSocket reverse proxy to pveproxy (noVNC / xterm.js consoles)
# ---------------------------------------------------------------------------

async def _proxy_ws_to_pve(websocket: WebSocket, full_path: str) -> None:
    """Dumb-pipe a WS upgrade through to pveproxy. pveproxy re-validates the
    PVEAuthCookie (and any vncticket in the query string) on the upgrade
    itself, so this proxy doesn't need its own auth check here.

    Mirrors the traversal guard the HTTP side already carries (_serve_spa /
    _proxy_http): reject any ".." segment or an absolute path before building
    the upstream URL. PVE_WS_BASE is a fixed loopback target so there's no
    off-host SSRF here, but a "../.." could still normalize the upstream path
    off the console-asset tree — defense-in-depth parity with the HTTP proxy."""
    if ".." in full_path or full_path.startswith("/"):
        await websocket.close(code=1008)  # policy violation
        return
    query = websocket.url.query
    upstream_url = f"{PVE_WS_BASE}/{full_path.lstrip('/')}" + (f"?{query}" if query else "")
    cookie_header = websocket.headers.get("cookie", "")
    requested_subprotocols = [p.strip() for p in
                              websocket.headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
    try:
        async with websockets.connect(
            upstream_url,
            additional_headers={"Cookie": cookie_header} if cookie_header else None,
            subprotocols=requested_subprotocols or None,
            ssl=_INSECURE_SSL_CTX,
            max_size=None,
            open_timeout=10,
            ping_interval=None,
        ) as backend:
            await websocket.accept(subprotocol=backend.subprotocol)

            async def browser_to_backend():
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg["type"] == "websocket.disconnect":
                            break
                        if msg.get("text") is not None:
                            await backend.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await backend.send(msg["bytes"])
                except (WebSocketDisconnect, RuntimeError):
                    pass

            async def backend_to_browser():
                try:
                    async for message in backend:
                        if isinstance(message, bytes):
                            await websocket.send_bytes(message)
                        else:
                            await websocket.send_text(message)
                except Exception:
                    pass

            t1 = asyncio.create_task(browser_to_backend())
            t2 = asyncio.create_task(backend_to_browser())
            done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# /_jarvis/* — the Cindro AI daemon bridge
# ---------------------------------------------------------------------------

# The dashboard forwards to the loopback daemon WITH its control token, so it
# must only relay the methods this Proxmox-only SPA actually needs — never
# the full Contract A surface (outpost.exec / mcp.add / hooks.* / session
# enumeration of OTHER host sessions / etc). A compromised/XSS'd bundle on
# this LAN-facing origin can't escalate past these.
_ALLOWED_METHODS = frozenset({
    "session.create", "session.send", "session.subscribe", "approval.respond",
    # Side-effect-free liveness check; kept for the SPA's reconnect/health UI.
    "ping",
})
_ALLOWED_PREFIXES = ("proxmoxop.",)


def _method_allowed(method: str) -> bool:
    return method in _ALLOWED_METHODS or any(method.startswith(p) for p in _ALLOWED_PREFIXES)


def control_token() -> str:
    try:
        return CONTROL_TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


async def _jarvisd_call(calls: list[tuple[str, dict]]) -> list[dict]:
    """Open one short-lived Contract A control-WS connection to the co-located
    jarvisd, run `calls` in order, return their response frames
    ({v,id,ok,result|error} — see docs/ARCHITECTURE.md)."""
    url = f"{CONTROL_WS}?token={control_token()}"
    results: list[dict] = []
    loop = asyncio.get_event_loop()
    async with websockets.connect(url, max_size=16 * 1024 * 1024, open_timeout=10) as backend:
        for rid, (method, params) in enumerate(calls, start=1):
            await backend.send(json.dumps({"v": 1, "id": rid, "method": method, "params": params}))
            # Bound the TOTAL wait for this call's reply, not each recv() — jarvisd
            # may interleave unsolicited/broadcast frames, and a per-recv timeout
            # alone would let the loop consume those forever and hang the worker.
            deadline = loop.time() + 20
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    results.append({"v": 1, "id": rid, "ok": False,
                                    "error": {"message": "jarvisd reply timed out"}})
                    break
                frame = json.loads(await asyncio.wait_for(backend.recv(), timeout=remaining))
                if frame.get("id") == rid:
                    results.append(frame)
                    break
    return results


@app.get("/_jarvis/health")
async def jarvis_health():
    return {"status": "ok", "service": "proxmox-dashboard", "version": __version__,
            "dist_present": (DIST / "index.html").exists()}


@app.websocket("/_jarvis/ws")
async def jarvis_ws(ws: WebSocket):
    """Browser <-> loopback jarvisd control socket. Gated on a datacenter ADMIN
    ticket (the operator is root-equivalent via its full-power MCP, so a
    merely-valid ticket is not enough) AND a same-origin handshake (cross-site
    WebSocket-hijack defense). The jarvisd control token is injected server-side
    and never reaches the browser."""
    if not _same_origin(ws.headers.get("origin", ""), ws.headers.get("host", "")):
        await ws.close(code=1008)
        return
    if not await _pve_admin(ws.cookies.get(PVE_AUTH_COOKIE, "")):
        await ws.close(code=1008)  # policy violation
        return
    await ws.accept()
    backend_url = f"{CONTROL_WS}?token={control_token()}"
    # session.create/send/subscribe are in _ALLOWED_METHODS, but the method name
    # alone doesn't bind them to the operator: a compromised same-origin bundle
    # (the threat model above) could call session.create with NO agent/target_ref
    # to spin up a plain coder/coworker session, then session.send/subscribe it —
    # riding this socket's privileged daemon token while bypassing the operator
    # policy gate entirely. Restrict session.create's params to the operator
    # agent/target, and only allow send/subscribe against session ids this
    # connection itself legitimately created that way (tracked below from the
    # backend's own session.create replies, never trusted from the browser).
    allowed_sessions: set[str] = set()
    pending_operator_creates: set = set()
    try:
        async with websockets.connect(backend_url, max_size=None, ping_interval=None) as backend:

            async def browser_to_backend():
                try:
                    while True:
                        raw = await ws.receive_text()
                        method = ""
                        frame_id = None
                        params: dict = {}
                        try:
                            frame = json.loads(raw)
                            method = str(frame.get("method", ""))
                            frame_id = frame.get("id")
                            params = frame.get("params") or {}
                            if not isinstance(params, dict):
                                params = {}
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
                        if method == "session.create":
                            agent = params.get("agent")
                            target_ref = params.get("target_ref") or params.get("target") or ""
                            brain = params.get("brain")
                            # Codex review (PR #130): the `or` let a caller satisfy just ONE
                            # marker (e.g. agent=="proxmox-operator" alone) while choosing an
                            # arbitrary brain/profile/cwd and a blank/non-operator target_ref.
                            # ControlServer::makeBrain only routes "proxmox-op-*" through the
                            # approval-gated operator MCP for the "api" brain — a codex/claude
                            # session created this way would run OUTSIDE that policy while still
                            # passing this check and landing in allowed_sessions. Require the
                            # agent, an operator target_ref, AND brain=="api" together — exactly
                            # what the legitimate dashboard client sends (chat.tsx).
                            is_operator = (
                                agent == "proxmox-operator" and brain == "api" and
                                isinstance(target_ref, str) and target_ref.startswith("proxmox-op-"))
                            if not is_operator:
                                await ws.send_text(json.dumps({
                                    "id": frame_id, "ok": False,
                                    "error": {"code": "method_not_allowed",
                                              "message": "session.create from the dashboard is "
                                                         "restricted to the proxmox-operator agent"},
                                }))
                                continue
                            if frame_id is not None:
                                pending_operator_creates.add(frame_id)
                        elif method == "session.send":
                            sid = params.get("session_id")
                            if not isinstance(sid, str) or sid not in allowed_sessions:
                                await ws.send_text(json.dumps({
                                    "id": frame_id, "ok": False,
                                    "error": {"code": "method_not_allowed",
                                              "message": f"{method} is not permitted for this "
                                                         "session from the dashboard"},
                                }))
                                continue
                        elif method == "session.subscribe":
                            # Codex review (PR #130): the dashboard client sends this as
                            # {session_ids: [...]} (plural array, cindro-client.ts), not the
                            # singular session_id session.send uses — looking for session_id
                            # here rejected every legitimate subscription, leaving the backend
                            # connection in legacy unscoped broadcast mode (every daemon
                            # session's events, not just the operator's). Validate every id in
                            # the array belongs to this connection's own allowed_sessions.
                            sids = params.get("session_ids")
                            if (not isinstance(sids, list) or not sids or
                                    not all(isinstance(s, str) and s in allowed_sessions for s in sids)):
                                await ws.send_text(json.dumps({
                                    "id": frame_id, "ok": False,
                                    "error": {"code": "method_not_allowed",
                                              "message": f"{method} is not permitted for this "
                                                         "session from the dashboard"},
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
                            continue
                        try:
                            frame = json.loads(msg)
                        except ValueError:
                            frame = None
                        if isinstance(frame, dict) and frame.get("id") in pending_operator_creates:
                            pending_operator_creates.discard(frame.get("id"))
                            if frame.get("ok"):
                                sid = (frame.get("result") or {}).get("session_id")
                                if isinstance(sid, str) and sid:
                                    allowed_sessions.add(sid)
                        # Codex review (PR #130): this backend connection opens
                        # UNSCOPED (jarvisd's ControlServer only scopes a client
                        # once IT sends session.subscribe — this proxy doesn't do
                        # that on the browser's behalf until the browser's first
                        # chat message) and stays that way indefinitely for a
                        # dashboard tab that never chats — jarvisd's "legacy
                        # broadcast" then relays EVERY session's session.event/
                        # session.opened frames here, which we'd otherwise hand
                        # straight to the browser. Filter these two event kinds
                        # against this connection's own allowed_sessions
                        # (starts empty, so nothing leaks before an operator
                        # session is actually created) instead of relying on the
                        # daemon-side scoping this proxy never establishes.
                        if isinstance(frame, dict) and frame.get("event") in (
                                "session.event", "session.opened"):
                            sid = (frame.get("data") or {}).get("session_id")
                            if sid not in allowed_sessions:
                                continue
                        await ws.send_text(msg)
                except Exception:
                    pass

            async def revalidate_periodically():
                # _pve_admin above only gates the HANDSHAKE — this socket then stays
                # privileged indefinitely regardless of what happens to the Proxmox
                # ticket afterward (expiry, account disable, revoked privileges). Close
                # it once the ticket that opened it stops being a genuine admin ticket.
                cookie_value = ws.cookies.get(PVE_AUTH_COOKIE, "")
                try:
                    while True:
                        await asyncio.sleep(30)
                        if not await _pve_admin(cookie_value):
                            await ws.close(code=1008)
                            return
                except Exception:
                    return

            b2 = asyncio.create_task(browser_to_backend())
            f2 = asyncio.create_task(backend_to_browser())
            r2 = asyncio.create_task(revalidate_periodically())
            done, pending = await asyncio.wait(
                {b2, f2, r2}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception:
        pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


@app.get("/_jarvis/settings")
async def jarvis_settings_get(request: Request):
    """{settings, models} — settings.get + model.list, straight from jarvisd,
    so the SPA can render/edit the AI provider configuration. Admin-only — the
    AI provider keys are host-wide secrets.

    Same-origin-guarded like the POST below (parity): a cross-site page can ride
    the ambient PVEAuthCookie to fetch this, and the body echoes the provider
    config back — so reject a cross-origin Origin. Note the asymmetry with the
    POST's unconditional `_same_origin`: a *same-origin* GET carries NO Origin
    header (browsers only add it for cross-origin reads and for unsafe methods),
    so the SPA's own `fetch(credentials:"include")` would be wrongly rejected if
    we demanded one. We therefore block only a PRESENT, mismatched Origin — the
    exact shape of the cross-site credentialed read we're defending against. The
    POST can demand Origin outright because every state-changing request has one."""
    origin = request.headers.get("origin", "")
    if origin and not _same_origin(origin, request.headers.get("host", "")):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not await _pve_admin(request.cookies.get(PVE_AUTH_COOKIE, "")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        # Always ask for the API brain's catalog (the SPA maps these into the
        # Cloud/Ollama pickers as models_by_brain.api) — a bare model.list would
        # default to m_config.defaultBrain and, on a codex/claude host, return
        # CLI models the settings page would mis-file as API models. force=true
        # refreshes the live provider catalog (Anthropic /v1/models, Ollama tags).
        frames = await _jarvisd_call([("settings.get", {}),
                                      ("model.list", {"brain": "api", "force": True})])
    except Exception:
        return JSONResponse({"error": "jarvisd_unreachable"}, status_code=502)
    settings_frame, models_frame = frames
    if not settings_frame.get("ok") or not models_frame.get("ok"):
        return JSONResponse({"error": "jarvisd_error"}, status_code=502)
    return {"settings": settings_frame.get("result", {}), "models": models_frame.get("result", {})}


@app.post("/_jarvis/settings")
async def jarvis_settings_post(request: Request):
    """Body is the settings.set patch verbatim — {api_keys:{...}, default_model,
    default_brain, ...any other settings.get field}. jarvisd's SettingsStore is
    the authority on which keys are valid; unknown keys are ignored there.
    Admin-only + same-origin (CSRF defense: a cross-site page could otherwise
    ride the ambient PVEAuthCookie to silently rewrite the AI provider keys)."""
    if not _same_origin(request.headers.get("origin", ""), request.headers.get("host", "")):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not await _pve_admin(request.cookies.get(PVE_AUTH_COOKIE, "")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        patch = await request.json()
    except Exception:
        patch = None
    if not isinstance(patch, dict):
        return JSONResponse({"error": "bad_request"}, status_code=400)
    try:
        # ControlServer::handleSettingsSet reads params["patch"] (see
        # daemon/src/ControlServer.cpp and desktop/src/Bridge.cpp, which wraps
        # the same way) — the RPC params are NOT the patch itself.
        (frame,) = await _jarvisd_call([("settings.set", {"patch": patch})])
    except Exception:
        return JSONResponse({"error": "jarvisd_unreachable"}, status_code=502)
    if not frame.get("ok"):
        return JSONResponse({"error": frame.get("error", {}).get("message", "settings.set failed")},
                            status_code=502)
    return {"ok": True}


# ---------------------------------------------------------------------------
# SPA static serving (history-fallback) + the catch-all router
# ---------------------------------------------------------------------------

_PLACEHOLDER = """<!doctype html><html><head><meta charset="utf-8">
<title>Cindro Proxmox Dashboard</title></head>
<body style="font-family:system-ui;background:#0A0F17;color:#EAF2F8;padding:3rem">
<h1 style="color:#3DD6FF">Cindro Proxmox Dashboard</h1>
<p>The dashboard is running, but its web bundle isn't installed yet.</p>
<p style="color:#90A6B8">Publish a <code>cindro-proxmox-dashboard.tgz</code> release asset
(or push a build to <code>%s</code>) and restart <code>proxmox-dashboard</code>.</p>
</body></html>""" % str(DIST)


_DIST_RESOLVED = DIST.resolve()


def _serve_spa(full_path: str) -> Response:
    """Static SPA with history-fallback: unknown non-proxy paths (including
    the SPA's own client-side routes) always resolve to index.html.

    SECURITY: reject absolute paths and anything that escapes DIST. `%2F`-encoded
    input can decode to a leading slash, and `DIST / "/etc/passwd"` yields
    "/etc/passwd" (an absolute right-hand operand drops the base) — so without the
    containment check below this unauthenticated, root-run fallback would serve
    arbitrary host files (e.g. the jarvisd control token)."""
    if full_path and ".." not in full_path and not full_path.startswith("/"):
        candidate = (DIST / full_path).resolve()
        if str(candidate) == str(_DIST_RESOLVED) or str(candidate).startswith(str(_DIST_RESOLVED) + os.sep):
            if candidate.is_file():
                return FileResponse(candidate)
    index = DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return HTMLResponse(_PLACEHOLDER)


_ALL_HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]


@app.api_route("/", methods=_ALL_HTTP_METHODS)
async def root(request: Request):
    return _serve_spa("")


@app.api_route("/{full_path:path}", methods=_ALL_HTTP_METHODS)
async def catch_all(request: Request, full_path: str):
    """Everything that isn't /_jarvis/* (matched above, so it never reaches
    here): a recognized Proxmox asset prefix proxies to pveproxy, anything
    else falls back to the SPA."""
    if _is_pve_asset(full_path):
        return await _proxy_http(request, full_path)
    return _serve_spa(full_path)


@app.websocket("/{full_path:path}")
async def catch_all_ws(websocket: WebSocket, full_path: str):
    """Any WS upgrade that isn't /_jarvis/ws (matched above) is a Proxmox
    console socket (noVNC/xterm.js) — proxy it straight through to pveproxy."""
    await _proxy_ws_to_pve(websocket, full_path)


def main() -> None:
    kwargs = {"host": DASHBOARD_HOST, "port": DASHBOARD_PORT, "log_level": "info"}
    if Path(PVE_SSL_CERT).exists() and Path(PVE_SSL_KEY).exists():
        kwargs["ssl_certfile"] = PVE_SSL_CERT
        kwargs["ssl_keyfile"] = PVE_SSL_KEY
    else:
        print(f"proxmox-dashboard: WARNING no TLS cert at {PVE_SSL_CERT} — serving plain HTTP")
    print(f"proxmox-dashboard v{__version__} on {DASHBOARD_HOST}:{DASHBOARD_PORT} "
          f"(dist={DIST}, present={(DIST / 'index.html').exists()}, "
          f"upstream={PVE_HTTP_BASE})")
    uvicorn.run(app, **kwargs)


if __name__ == "__main__":
    main()
