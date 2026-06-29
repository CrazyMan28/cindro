"""computer-use MCP server: FastAPI app hosting the MCP transport at /mcp,
the Chrome-extension WebSocket at /ws/extension, and /health."""

import asyncio
import json
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from computer_use_mcp import (
    __version__, agent_bus, auth, live_widgets, screen, session, tools_bg,
    tools_browser, tools_desktop, tools_jarvis_ops, tools_phone, tools_todo,
    tools_widgets,
)
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
tools_jarvis_ops.register(mcp)   # schedule / memory / skills (proxied to jarvisd)
tools_widgets.register(mcp)      # render_widget — generative UI on the desktop CANVAS
tools_todo.register(mcp)         # todo_write/read/clear — the agent's live plan/checklist
tools_bg.register(mcp)           # bg_start/monitor/wake_me_in — background jobs + self-wake
tools_phone.register(mcp)        # call_user/twilio_call_and_wait/device_sms/… (proxied to the phone server via jarvisd)
mcp_app = mcp.streamable_http_app()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Make sure the single live-widget supervisor is running (idempotent, pid-file
    # guarded). The always-on host engine is the primary owner; per-session engines
    # also call this from live_widgets.start(), but only one supervisor ever exists.
    try:
        live_widgets.ensure_supervisor()
    except Exception:
        pass
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
    if request.url.path in ("/health", "/ready") or request.method == "OPTIONS":
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
    # /health must answer FAST and unconditionally — the daemon (AgentDesktop)
    # polls it as the per-session engine's readiness gate. The full
    # session.detect() shells out to kscreen-doctor (KDE output enumeration),
    # which BLOCKS for its whole timeout whenever the host session bus / runtime
    # dir is reachable-but-slow. In a per-session *agent* engine (spawned with an
    # isolated XDG_RUNTIME_DIR) those host probes repeatedly time out, the daemon
    # hammers /health, and a pile of stuck kscreen-doctor children starves the
    # engine so readiness never flips. So: only report the *cheap* compositor
    # hint (the agent session is known from env; otherwise a quick kwin/sway pgrep
    # via session.detect_compositor_fast), and never run the kscreen path here.
    try:
        compositor = await asyncio.wait_for(
            asyncio.to_thread(session.compositor_hint), timeout=2.0)
    except asyncio.TimeoutError:
        compositor = "detect-timeout"
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


@app.get("/ready")
async def ready():
    """DEEP readiness gate for the daemon's AgentDesktop.ensure().

    /health only reports the cheap compositor hint, so a 200 there does NOT prove
    the nested compositor can actually serve a tool call yet (the model's first
    tool call can fire into a half-up engine — the observed flaky failure: empty
    desktop + a single failed tool_result + zero successful tool_calls). /ready
    instead proves the engine can do REAL work against the nested desktop:
      1. the agent SessionInfo resolves (env-bound nested compositor), and
      2. a live grim capture of the nested output succeeds.
    Only then is it safe to let the session run a tool. Returns 200 {ready:true}
    when usable, else 503 with the reason — the daemon polls until 200/timeout.
    Unauthenticated like /health (it leaks nothing) so the readiness gate never
    races the bearer."""
    # Only meaningful for an agent-bound engine; a non-agent engine is "ready" as
    # soon as it answers (the host session path doesn't have this race).
    is_agent = bool(os.environ.get(session.AGENT_WAYLAND_ENV) or
                    os.environ.get(session.AGENT_SWAYSOCK_ENV))
    if not is_agent:
        return {"ready": True, "kind": "host"}
    try:
        # A real grab of the nested output — the same path tools use. This both
        # resolves the agent session AND proves grim can talk to the compositor.
        frame = await asyncio.wait_for(
            asyncio.to_thread(_probe_agent_frame), timeout=4.0)
    except asyncio.TimeoutError:
        return JSONResponse(status_code=503,
                            content={"ready": False, "reason": "probe-timeout"})
    except Exception as exc:  # noqa: BLE001 — surface the reason to the daemon
        return JSONResponse(status_code=503,
                            content={"ready": False, "reason": f"{type(exc).__name__}: {exc}"})
    if not frame:
        return JSONResponse(status_code=503,
                            content={"ready": False, "reason": "empty-frame"})
    return {"ready": True, "kind": "agent", "bytes": len(frame)}


def _probe_agent_frame() -> bytes:
    """Blocking helper: grab one JPEG frame of the nested agent desktop. Raises if
    the compositor/grim isn't usable yet (caught by /ready)."""
    return screen.grab_jpeg_frame(which="agent", width=320)


@app.websocket("/ws/extension")
async def ws_extension(websocket: WebSocket):
    await bridge.handle(websocket)


# -- live video for the daemon (Wave 4 MJPEG -> Wave 6 WebRTC) ------------------
#
# Fed by screen.video_source (grim/wlr per-frame) + the agent-pointer bus. These
# are auth-gated by auth_middleware like every non-/health path (the tailnet
# bearer model) — no exemption is added. `?which=agent|active` selects the source
# (default agent = the nested headless desktop, per spikes/RESULTS.md).

_MJPEG_BOUNDARY = "jarvisframe"


def _video_params(request: Request) -> dict:
    cfg = load_config()
    q = request.query_params
    which = q.get("which", "agent")
    if which not in ("agent", "active", "kde", "sway"):
        which = "agent"
    try:
        width = int(q["width"]) if "width" in q else int(cfg.get("video_width", 1280))
    except ValueError:
        width = int(cfg.get("video_width", 1280))
    try:
        fps = float(q["fps"]) if "fps" in q else float(cfg.get("video_fps", 6))
    except ValueError:
        fps = float(cfg.get("video_fps", 6))
    try:
        quality = int(q.get("quality", 70))
    except ValueError:
        quality = 70
    cursor = q.get("cursor", "").lower() in ("1", "true", "yes")
    return {"which": which, "width": width, "fps": fps, "quality": quality,
            "cursor": cursor}


@app.get("/video/frame")
async def video_frame(request: Request):
    """Single JPEG frame of the selected session (default the agent desktop)."""
    p = _video_params(request)
    try:
        jpeg = await asyncio.to_thread(
            screen.grab_jpeg_frame, p["which"],
            width=p["width"], quality=p["quality"], include_cursor=p["cursor"],
        )
    except Exception as exc:
        return JSONResponse(status_code=503,
                            content={"error": "capture failed", "message": str(exc)})
    return Response(content=jpeg, media_type="image/jpeg")


@app.get("/video/mjpeg")
async def video_mjpeg(request: Request):
    """multipart/x-mixed-replace MJPEG stream the daemon re-publishes to phones."""
    p = _video_params(request)

    async def gen():
        gen_it = screen.video_source(
            p["which"], fps=p["fps"], width=p["width"],
            quality=p["quality"], include_cursor=p["cursor"],
        )
        try:
            while True:
                if await request.is_disconnected():
                    break
                frame = await asyncio.to_thread(next, gen_it, None)
                if frame is None:
                    break
                yield (
                    b"--" + _MJPEG_BOUNDARY.encode() + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n"
                    + frame + b"\r\n"
                )
        finally:
            gen_it.close()

    return StreamingResponse(
        gen(),
        media_type=f"multipart/x-mixed-replace; boundary={_MJPEG_BOUNDARY}",
    )


@app.websocket("/video/stream")
async def video_stream(websocket: WebSocket):
    """Continuous JPEG frames (binary) multiplexed with agent-pointer events
    (text JSON). The daemon consumes this to drive both the phone mirror and the
    distinct-cursor overlay from one connection. Auth: ?token= or Bearer."""
    if not auth.ws_ok(websocket):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    cfg = load_config()
    q = websocket.query_params
    which = q.get("which", "agent")
    if which not in ("agent", "active", "kde", "sway"):
        which = "agent"
    width = int(q.get("width", cfg.get("video_width", 1280)))
    fps = float(q.get("fps", cfg.get("video_fps", 6)))
    quality = int(q.get("quality", 70))

    pointer_q = agent_bus.subscribe()
    gen_it = screen.video_source(which, fps=fps, width=width, quality=quality)

    async def pump_pointers():
        try:
            while True:
                ev = await pointer_q.get()
                await websocket.send_text(json.dumps({"type": "pointer", **ev}))
        except Exception:
            pass

    pointer_task = asyncio.create_task(pump_pointers())
    try:
        while True:
            frame = await asyncio.to_thread(next, gen_it, None)
            if frame is None:
                break
            await websocket.send_bytes(frame)
    except Exception:
        pass
    finally:
        pointer_task.cancel()
        agent_bus.unsubscribe(pointer_q)
        gen_it.close()


# Mounted last so /health, /ws/extension and /video/* win routing.
app.mount("/", mcp_app)


def main() -> None:
    host, port = load_config()["host"], int(load_config()["port"])
    print(f"computer-use MCP v{__version__} starting on {host}:{port}/mcp")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
