"""Configuration for outpost-mcp.

Own inbound bearer at ~/.config/jarvis/outpost_mcp_token (0600, auto-generated
on first start). The token is the gate (tailnet model, same as jarvis-mcp), so
we bind everywhere by default; /health and the one-shot /pair/* bootstrap paths
are the only open routes. Machines persist to ~/.config/jarvis/outpost_machines.json.
"""

import os
import secrets
import socket
import subprocess
from pathlib import Path

OUTPOST_CONFIG_DIR = Path(os.environ.get("OUTPOST_CONFIG_DIR")
                          or str(Path.home() / ".config" / "jarvis"))
TOKEN_FILE = OUTPOST_CONFIG_DIR / "outpost_mcp_token"
MACHINES_FILE = OUTPOST_CONFIG_DIR / "outpost_machines.json"

DEFAULT_HOST = "0.0.0.0"
# 8797 jarvis-mcp is the last taken port; 8798 is the next free one.
DEFAULT_PORT = 8798
ADVERTISE_HOST = "127.0.0.1"
BOOTSTRAP_TTL_SECONDS = 600  # one-shot 10-minute pairing codes

# The Go agent binaries live next to this package (outpost-mcp/agent-bin/).
_PKG_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_AGENT_BIN_DIR = _PKG_ROOT / "agent-bin"


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v else default


def host() -> str:
    return _env("OUTPOST_MCP_HOST", DEFAULT_HOST)


def port() -> int:
    try:
        return int(_env("OUTPOST_MCP_PORT", str(DEFAULT_PORT)))
    except ValueError:
        return DEFAULT_PORT


def agent_bin_dir() -> Path:
    return Path(os.environ.get("OUTPOST_AGENT_BIN_DIR") or str(DEFAULT_AGENT_BIN_DIR))


def get_bearer_token() -> str:
    """This server's inbound bearer; auto-generate a 0600 token on first run.
    Env override OUTPOST_MCP_TOKEN wins (tests / ephemeral runs)."""
    env = os.environ.get("OUTPOST_MCP_TOKEN")
    if env:
        return env.strip()
    try:
        existing = TOKEN_FILE.read_text().strip()
        if existing:
            return existing
    except OSError:
        pass
    OUTPOST_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token)
    os.chmod(TOKEN_FILE, 0o600)
    print(f"outpost-mcp: created bearer token at {TOKEN_FILE}")
    return token


def resolve_advertise_host() -> str:
    """Tailscale IP > LAN IP > localhost (mirrors enrollmentService order)."""
    env = os.environ.get("OUTPOST_ADVERTISE_HOST")
    if env:
        return env.strip()
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True,
                             text=True, timeout=3)
        lines = [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]
        if lines:
            return lines[0]
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    return "127.0.0.1"


def advertise_base_url() -> str:
    return f"http://{resolve_advertise_host()}:{port()}"
