"""Configuration for computer-use MCP (~/.computer-use/config.yaml)."""

import os
import secrets
import socket
from pathlib import Path

import yaml


def _detect_tailscale_ip() -> str | None:
    """Return the local Tailscale IP (100.64.0.0/10) via a UDP routing probe.

    Sends no packets — asks the OS which source IP would route to Tailscale's
    DNS relay (100.100.100.100). Works on Linux and Windows without netifaces."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0)
            s.connect(("100.100.100.100", 80))
            ip = s.getsockname()[0]
            if ip.startswith("100."):
                return ip
    except Exception:
        pass
    return None

CONFIG_DIR = Path.home() / ".computer-use"
CONFIG_FILE = CONFIG_DIR / "config.yaml"

DEFAULT_CONFIG = {
    # Generated on first load; never commit this file.
    "bearer_token": "",
    # Token is the gate (tailnet model), so bind everywhere and survive
    # tailscale being down — same rationale as phone-installer/vm-agent.
    "host": "0.0.0.0",
    # 8790 project-tracker, 8791 phone-installer, 8792 phone file server,
    # 8793 intermittently bound by kihi-launcher — hence 8794.
    "port": 8794,
    "advertise_host": "127.0.0.1",
    "max_image_width": 1536,
    "ws_command_timeout": 30,
    "screenshot_tool": "auto",  # auto | grim | spectacle
    "video_source": "auto",     # auto | wlr | portal (live-video backend pref)
    "video_width": 1280,        # default JPEG frame width for /video endpoints
    "video_fps": 6,             # default frame cadence for /video/mjpeg
    "scroll_invert": False,
    "accel_autoconfig": True,
    "ydotool_socket": f"/run/user/{os.getuid()}/.ydotool_socket",
}


def load_config() -> dict:
    """Load config from YAML, creating it (with a random token) on first run."""
    if not CONFIG_FILE.exists():
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        cfg = dict(DEFAULT_CONFIG)
        cfg["bearer_token"] = secrets.token_urlsafe(32)
        with open(CONFIG_FILE, "w") as f:
            yaml.dump(cfg, f)
        os.chmod(CONFIG_FILE, 0o600)
        print(f"Created config file: {CONFIG_FILE}")
        return cfg

    with open(CONFIG_FILE) as f:
        cfg = {**DEFAULT_CONFIG, **(yaml.safe_load(f) or {})}

    if not cfg["bearer_token"]:
        cfg["bearer_token"] = secrets.token_urlsafe(32)
        with open(CONFIG_FILE, "w") as f:
            yaml.dump(cfg, f)
        os.chmod(CONFIG_FILE, 0o600)

    # Auto-detect Tailscale IP at runtime without persisting it — the Tailscale
    # IP can change across restarts (e.g. after a re-auth) and the config file
    # may have been written before Tailscale was running. Only override when
    # advertise_host is still the loopback default; an explicit user value wins.
    if cfg.get("advertise_host") == "127.0.0.1":
        ts_ip = _detect_tailscale_ip()
        if ts_ip:
            cfg["advertise_host"] = ts_ip

    return cfg


def get_bearer_token() -> str:
    return str(load_config()["bearer_token"])


def get_server_config() -> tuple[str, int]:
    cfg = load_config()
    return cfg["host"], int(cfg["port"])
