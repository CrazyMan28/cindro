#!/usr/bin/env python3
"""Tiny stdlib-only static file server for the JARVIS web console.

No framework, no dependencies — just serves web/index.html + app.js + style.css
so a browser can load the dashboard. The dashboard then talks DIRECTLY to the
daemon control WebSocket (ws://127.0.0.1:8795/control/ws); this server never
proxies or relays that connection.

Usage:
    python3 web/serve.py                 # 127.0.0.1:8799
    python3 web/serve.py --port 8788     # pick another port (8799 is used by the
                                         # Agent Phone server on some machines)
    python3 web/serve.py --host 0.0.0.0  # expose on the LAN (see the note below)

Binds to 127.0.0.1 by default. The control WS is loopback-only, so the browser
must run on the same machine as the daemon; to drive it from elsewhere, forward
port 8795 (ssh -L / tailscale) rather than exposing this server broadly.
"""

import argparse
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    """Serve the web/ directory with dev-friendly no-cache headers."""

    def end_headers(self):
        # No caching so edits show up on reload without a hard refresh.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        # This page only ever connects to a loopback WS + does no cross-origin
        # fetches; a tight referrer policy is harmless and tidy.
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[jarvis-web] %s - %s\n" % (self.address_string(), fmt % args))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Static server for the Jarvis web console.")
    ap.add_argument("--host", default="127.0.0.1",
                    help="interface to bind (default: 127.0.0.1, loopback-only)")
    ap.add_argument("--port", type=int, default=8799,
                    help="port to listen on (default: 8799)")
    args = ap.parse_args(argv)

    handler = partial(Handler, directory=ROOT)
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as e:
        sys.stderr.write(
            "[jarvis-web] could not bind %s:%d — %s\n"
            "            (port in use? try --port 8788)\n" % (args.host, args.port, e))
        return 1

    url = "http://%s:%d/" % ("127.0.0.1" if args.host in ("0.0.0.0", "") else args.host, args.port)
    sys.stderr.write("[jarvis-web] serving %s at %s\n" % (ROOT, url))
    sys.stderr.write("[jarvis-web] Ctrl-C to stop\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n[jarvis-web] stopped\n")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
