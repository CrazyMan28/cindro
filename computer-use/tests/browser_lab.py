"""Real-Chromium lab for the graphical browser tools.

Boots headless Chromium with the REAL unpacked extension loaded, points the
extension at an in-process engine bridge (the same ExtensionBridge + /ws/extension
endpoint the engine serves), and serves fixture pages that imitate graphical
consoles: a noVNC-style canvas, a cross-origin iframe console (127.0.0.1 page
embedding a localhost frame == a separate site, so an out-of-process iframe), a
transformed nested iframe, and a letterboxed object-fit canvas. Every console
logs the input it receives so tests can assert what the guest would have seen.

Everything (uvicorn, bridge futures, tool coroutines) runs on ONE asyncio loop in
a background thread; tests submit coroutines with Lab.run().
"""

from __future__ import annotations

import asyncio
import functools
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

# Module level on purpose: with postponed annotations FastAPI resolves the
# endpoint's `WebSocket` annotation from module globals.
from fastapi import FastAPI, WebSocket

REPO = Path(__file__).resolve().parents[2]
EXTENSIONS = {
    "cindro": REPO / "extension",
    "bridge": REPO / "computer-use" / "extension",
}
TOKEN = "lab-token-0123456789"


def find_chromium() -> Optional[str]:
    cands = [os.environ.get("CINDRO_TEST_CHROMIUM"), "/opt/pw-browsers/chromium"]
    cands += [shutil.which(n) for n in ("chromium", "chromium-browser", "google-chrome-for-testing")]
    for c in cands:
        if c and os.path.exists(c) and os.access(c, os.X_OK):
            return c
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ------------------------------------------------------------------ fixture pages

CONSOLE_JS = r"""
// A fake VNC console: a canvas framebuffer that logs input in GUEST
// (framebuffer) coordinates, like noVNC translating to RFB pointer events.
function fakeConsole(canvas, sink) {
  const g = canvas.getContext('2d');
  let on = false;
  function draw() {
    g.fillStyle = '#123'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = on ? '#0f0' : '#f00'; g.fillRect(100, 100, 200, 60);
    g.fillStyle = '#fff'; g.font = '28px monospace'; g.fillText('C:\\> ' + typed, 20, 400);
  }
  let typed = '';
  function guest(e) {
    const r = canvas.getBoundingClientRect();
    // object-fit: contain letterbox aware (like a scaled noVNC display)
    const fw = canvas.width, fh = canvas.height;
    const fit = getComputedStyle(canvas).objectFit;
    let x = r.left, y = r.top, w = r.width, h = r.height;
    if (fit === 'contain') {
      const s = Math.min(r.width / fw, r.height / fh);
      w = fw * s; h = fh * s; x = r.left + (r.width - w) / 2; y = r.top + (r.height - h) / 2;
    }
    // truncate, like noVNC's Display.absX/absY (toSigned32bit -> x | 0)
    return [Math.floor((e.clientX - x) * fw / w), Math.floor((e.clientY - y) * fh / h)];
  }
  const log = (o) => sink(Object.assign({ t: performance.now() }, o));
  for (const t of ['mousedown', 'mouseup', 'mousemove', 'dblclick', 'contextmenu']) {
    canvas.addEventListener(t, (e) => {
      if (t === 'contextmenu') e.preventDefault();
      const [gx, gy] = guest(e);
      log({ type: t, gx, gy, button: e.button, buttons: e.buttons, detail: e.detail,
            shift: e.shiftKey, ctrl: e.ctrlKey, trusted: e.isTrusted });
      if (t === 'mousedown') {
        canvas.focus({ preventScroll: true });  // as noVNC does
        if (gx >= 100 && gx <= 300 && gy >= 100 && gy <= 160) { on = !on; draw(); }
      }
    });
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [gx, gy] = guest(e);
    log({ type: 'wheel', gx, gy, dy: e.deltaY, dx: e.deltaX, trusted: e.isTrusted });
  }, { passive: false });
  for (const t of ['keydown', 'keyup']) {
    canvas.addEventListener(t, (e) => {
      e.preventDefault();   // like noVNC: the guest gets it, the browser doesn't
      log({ type: t, key: e.key, code: e.code, keyCode: e.keyCode, shift: e.shiftKey,
            ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, trusted: e.isTrusted });
      if (t === 'keydown' && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        typed += e.key; draw();
      }
      if (t === 'keydown' && e.key === 'Enter') { typed = ''; draw(); }
    });
  }
  draw();
}
"""


def _page(body: str, script: str = "", title: str = "lab") -> str:
    return (f"<!doctype html><html><head><meta charset=utf-8><title>{title}</title>"
            "<style>html,body{margin:0;padding:0;background:#ddd;overflow:hidden}</style>"
            f"<script>{CONSOLE_JS}</script></head><body>{body}<script>{script}</script></body></html>")


SINK_SELF = "window.__log = []; const sink = (o) => window.__log.push(o);"
SINK_TOP = "const sink = (o) => top.postMessage({__lab: o}, '*');"
COLLECT = ("window.__log = []; window.addEventListener('message', "
           "(m) => { if (m.data && m.data.__lab) window.__log.push(m.data.__lab); });")

PAGES = {
    # noVNC-like: 1024x768 framebuffer scaled to 800x600 at (40,30).
    "novnc.html": _page(
        '<div id="noVNC_container" style="position:absolute;left:40px;top:30px">'
        '<canvas id="noVNC_canvas" tabindex="-1" width="1024" height="768" '
        'style="width:800px;height:600px;display:block;outline:none"></canvas></div>',
        SINK_SELF + "fakeConsole(document.getElementById('noVNC_canvas'), sink);",
        title="noVNC - pve"),
    # The console page that gets framed (cross-origin) by frame_outer.html.
    "frame_console.html": _page(
        '<canvas id="screen" class="guac-display" tabindex="-1" width="640" height="480" '
        'style="width:640px;height:480px;display:block;outline:none"></canvas>',
        SINK_TOP + "fakeConsole(document.getElementById('screen'), sink);",
        title="Guacamole"),
    # Letterboxed: 1920x1080 framebuffer in an 800x800 box, object-fit: contain.
    "letterbox.html": _page(
        '<canvas id="c" tabindex="-1" width="1920" height="1080" '
        'style="position:absolute;left:100px;top:50px;width:800px;height:800px;'
        'object-fit:contain;background:#000;outline:none"></canvas>',
        SINK_SELF + "fakeConsole(document.getElementById('c'), sink);",
        title="letterbox"),
    # Plain DOM page for regressions + insert-mode typing.
    "form.html": (
        "<!doctype html><html><head><meta charset=utf-8><title>form</title></head><body>"
        "<input id='name' style='position:absolute;left:50px;top:50px;width:300px;height:30px'>"
        "<button id='go' style='position:absolute;left:50px;top:120px;width:120px;height:40px' "
        "onclick=\"document.title='clicked:'+document.getElementById('name').value\">Go</button>"
        "</body></html>"),
}


def outer_page(frame_origin: str, transform: bool = False) -> str:
    style = ("position:absolute;left:150px;top:90px;width:640px;height:480px;"
             "border:5px solid #333;padding:7px;background:#fff")
    if transform:
        style += ";transform:scale(0.75);transform-origin:0 0"
    inner = (f'<iframe id="console" src="{frame_origin}/frame_console.html" '
             f'style="{style}"></iframe>')
    return _page(inner, COLLECT, title="Remote console")


def nested_page(mid_origin: str) -> str:
    # main -> (same-origin) wrapper iframe at (60,40) -> cross-origin console
    return _page(f'<iframe src="{mid_origin}/frame_outer.html" '
                 'style="position:absolute;left:60px;top:40px;width:1000px;height:700px;'
                 'border:0"></iframe>', COLLECT, title="Portal")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D401
        pass


# ------------------------------------------------------------------ the lab

class Lab:
    def __init__(self, ext: str = "cindro"):
        self.ext_dir = EXTENSIONS[ext]
        self.tmp = Path(tempfile.mkdtemp(prefix="cindro-lab-"))
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.proc: Optional[subprocess.Popen] = None
        self.httpd = None
        self.mcp = None
        self.server = None

    # -- plumbing
    def run(self, coro, timeout: float = 90) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def start(self, chromium: str) -> "Lab":
        import uvicorn
        from mcp.server.fastmcp import FastMCP
        from computer_use_mcp import auth, tools_browser
        from computer_use_mcp.browser_bridge import bridge

        self.bridge = bridge
        # A previous lab's loop is gone, so its socket never ran handle()'s
        # cleanup: forget it, or `connected` would lie until we're displaced.
        bridge._ws = None
        bridge.hello = {}
        auth.get_bearer_token = lambda: TOKEN  # the lab's token is the gate
        self.thread.start()

        # Fixture site, reachable as 127.0.0.1 AND localhost (two sites -> OOPIF).
        site = self.tmp / "site"
        site.mkdir()
        for name, html in PAGES.items():
            (site / name).write_text(html)
        self.http_port = _free_port()
        self.origin_a = f"http://127.0.0.1:{self.http_port}"
        self.origin_b = f"http://localhost:{self.http_port}"
        (site / "frame_outer.html").write_text(outer_page(self.origin_b))
        (site / "frame_outer_scaled.html").write_text(outer_page(self.origin_b, transform=True))
        (site / "nested.html").write_text(nested_page(self.origin_a))
        handler = functools.partial(_Quiet, directory=str(site))
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", self.http_port), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

        # Engine bridge endpoint.
        app = FastAPI()

        @app.websocket("/ws/extension")
        async def ws_extension(websocket: WebSocket):
            await bridge.handle(websocket)

        self.ws_port = _free_port()
        cfg = uvicorn.Config(app, host="127.0.0.1", port=self.ws_port, log_level="warning")
        self.server = uvicorn.Server(cfg)
        self.loop.call_soon_threadsafe(lambda: self.loop.create_task(self.server.serve()))

        self.mcp = FastMCP("lab")
        tools_browser.register(self.mcp)

        # Chromium with the real extension.
        prof = self.tmp / "profile"
        args = [chromium, "--headless=new", "--no-sandbox", "--disable-gpu",
                "--disable-dev-shm-usage",  # CI containers have a tiny /dev/shm
                "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen",
                f"--user-data-dir={prof}", f"--load-extension={self.ext_dir}",
                f"--disable-extensions-except={self.ext_dir}",
                "--remote-debugging-port=0", "--window-size=1280,900",
                "--force-device-scale-factor=1", "about:blank"]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        ws_url = None
        deadline = time.time() + 30
        while time.time() < deadline and ws_url is None:
            line = self.proc.stderr.readline()
            m = re.search(r"DevTools listening on (ws://\S+)", line or "")
            if m:
                ws_url = m.group(1)
        if not ws_url:
            raise RuntimeError("chromium did not start")
        threading.Thread(target=lambda: [None for _ in self.proc.stderr], daemon=True).start()
        self.browser_ws = ws_url
        self.run(self._configure_extension())
        return self

    async def _cdp_session(self):
        import websockets
        return await websockets.connect(self.browser_ws, max_size=64 * 2**20)

    async def _sw_eval(self, expression: str) -> Any:
        """Evaluate JS inside the extension's service worker (via browser CDP)."""
        ws = await self._cdp_session()
        try:
            mid = 0

            async def call(method, params=None, session=None):
                nonlocal mid
                mid += 1
                msg = {"id": mid, "method": method, "params": params or {}}
                if session:
                    msg["sessionId"] = session
                await ws.send(json.dumps(msg))
                while True:
                    r = json.loads(await ws.recv())
                    if r.get("id") == mid:
                        if "error" in r:
                            raise RuntimeError(r["error"])
                        return r["result"]

            target = None
            for _ in range(100):
                tl = await call("Target.getTargets")
                for t in tl["targetInfos"]:
                    if t["type"] == "service_worker" and t["url"].endswith("/sw.js"):
                        target = t
                if target:
                    break
                await asyncio.sleep(0.1)
            if not target:
                raise RuntimeError("extension service worker not found")
            att = await call("Target.attachToTarget", {"targetId": target["targetId"], "flatten": True})
            sid = att["sessionId"]
            # A stopped worker restarts on attach; evaluating before its context
            # exists lands in a bare scope ("chrome is not defined").
            await call("Runtime.enable", {}, sid)
            for _ in range(50):
                probe = await call("Runtime.evaluate", {"expression": "typeof chrome",
                                                        "returnByValue": True}, sid)
                if probe["result"].get("value") == "object":
                    break
                await asyncio.sleep(0.1)
            res = await call("Runtime.evaluate", {"expression": expression, "awaitPromise": True,
                                                  "returnByValue": True}, sid)
            if res.get("exceptionDetails"):
                raise RuntimeError(res["exceptionDetails"])
            return res["result"].get("value")
        finally:
            await ws.close()

    async def _configure_extension(self):
        await self._sw_eval(
            f"chrome.storage.local.set({{port: {self.ws_port}, token: '{TOKEN}'}})"
            ".then(() => { ensureConnected(); return true; })")
        for _ in range(200):
            if self.bridge.connected and self.bridge.hello:
                return
            await asyncio.sleep(0.05)
        raise RuntimeError("extension never connected to the lab bridge")

    def sw_eval(self, expression: str) -> Any:
        return self.run(self._sw_eval(expression))

    # -- tools
    def tool(self, name: str, **kwargs) -> Any:
        fn = self.mcp._tool_manager.get_tool(name).fn
        return self.run(fn(**kwargs))

    def call(self, name: str, **kwargs) -> dict:
        """Run a tool and return its JSON part (images dropped)."""
        out = self.tool(name, **kwargs)
        if isinstance(out, list):
            text = [o for o in out if isinstance(o, str)][-1]
        else:
            text = out
        return json.loads(text)

    def open(self, page: str, origin: Optional[str] = None) -> int:
        url = f"{origin or self.origin_a}/{page}"
        res = self.call("browser_tab_new", url=url)
        return res["id"]

    def eval(self, js: str, tab_id: Optional[int] = None) -> Any:
        return self.call("browser_eval", js=js, tab_id=tab_id).get("value")

    def log(self, tab_id: int, clear: bool = True, settle: float = 0.25) -> list[dict]:
        """Input the fixture console(s) received. postMessage hops from OOPIFs
        are async, so wait until the log stops growing (or ~1.5s if empty)."""
        n, last, deadline = -1, time.time(), time.time() + 1.5
        while time.time() < deadline:
            cur = self.eval("window.__log.length", tab_id) or 0
            if cur != n:
                n, last = cur, time.time()
            elif cur and time.time() - last >= settle:
                break
            time.sleep(0.05)
        js = "(() => { const l = window.__log.slice(); %s return l; })()" % (
            "window.__log.length = 0;" if clear else "")
        return self.eval(js, tab_id) or []

    def stop(self) -> None:
        try:
            if self.proc:
                self.proc.terminate()
                try:
                    self.proc.wait(10)
                except Exception:
                    self.proc.kill()
            # Let the bridge see the extension's socket close while the loop runs.
            deadline = time.time() + 5
            while getattr(self, "bridge", None) and self.bridge.connected and time.time() < deadline:
                time.sleep(0.05)
            if self.httpd:
                self.httpd.shutdown()
            if self.server:
                self.server.should_exit = True
                time.sleep(0.3)
        finally:
            self.loop.call_soon_threadsafe(self.loop.stop)
            shutil.rmtree(self.tmp, ignore_errors=True)
