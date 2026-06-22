"""Configuration for computer-use MCP (~/.computer-use/config.yaml)."""

import os
import secrets
from pathlib import Path

import yaml

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
    return cfg


def get_bearer_token() -> str:
    return str(load_config()["bearer_token"])


def get_server_config() -> tuple[str, int]:
    cfg = load_config()
    return cfg["host"], int(cfg["port"])
