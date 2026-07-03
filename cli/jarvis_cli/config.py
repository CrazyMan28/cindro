"""Endpoint + token resolution for the CLI.

Mirrors how the daemon and its clients resolve things (Windows + Linux):
  - config root: $JARVIS_CONFIG_DIR else ~/.config/jarvis (profile isolation)
  - control token: <config>/control_token   (env JARVIS_CONTROL_TOKEN wins)
  - control port: config.toml [ports] control (default 8795); env
    JARVIS_CONTROL_HOST / JARVIS_CONTROL_PORT override host/port
  - data root: $JARVIS_DATA_DIR else $XDG_DATA_HOME/jarvis else
    ~/.local/share/jarvis
"""

from __future__ import annotations

import os
from pathlib import Path


def config_dir() -> Path:
    override = os.environ.get("JARVIS_CONFIG_DIR")
    return Path(override) if override else Path.home() / ".config" / "jarvis"


def data_dir() -> Path:
    override = os.environ.get("JARVIS_DATA_DIR")
    if override:
        return Path(override)
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "jarvis"


def control_token() -> str:
    env = os.environ.get("JARVIS_CONTROL_TOKEN")
    if env:
        return env.strip()
    try:
        return (config_dir() / "control_token").read_text().strip()
    except OSError:
        return ""


def control_port() -> int:
    env = os.environ.get("JARVIS_CONTROL_PORT")
    if env:
        try:
            return int(env)
        except ValueError:
            pass
    # config.toml [ports] control = N — the same flat parse the daemon uses.
    try:
        section = ""
        for raw in (config_dir() / "config.toml").read_text().splitlines():
            line = raw.strip()
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1].strip()
                continue
            if section == "ports" and line.startswith("control"):
                _, _, v = line.partition("=")
                try:
                    p = int(v.strip())
                    if 0 < p < 65536:
                        return p
                except ValueError:
                    pass
    except OSError:
        pass
    return 8795


def control_host() -> str:
    return os.environ.get("JARVIS_CONTROL_HOST", "127.0.0.1")


def control_ws_url() -> str:
    base = os.environ.get("JARVIS_CONTROL_WS")
    if not base:
        base = f"ws://{control_host()}:{control_port()}/control/ws"
    token = control_token()
    if not token:
        return base
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}token={token}"
