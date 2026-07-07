"""Configuration for proxmox-mcp.

Everything this service needs lives under two directories on the Proxmox
host, both written by the Outpost install flow (outpost.install_workload):

  /etc/jarvis-proxmox-agent/   config.toml, blocklist.json, mcp_token,
                                mistral_api_key, project_tracker_token (0600)
  /var/lib/jarvis-proxmox-agent/  state.json, memory.db (durable, survives
                                the user's laptop being off)

Both roots are overridable via env vars so tests never touch the real
filesystem paths.
"""

import os
import secrets
import tomllib
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("PROXMOX_AGENT_CONFIG_DIR") or "/etc/jarvis-proxmox-agent")
STATE_DIR = Path(os.environ.get("PROXMOX_AGENT_STATE_DIR") or "/var/lib/jarvis-proxmox-agent")

CONFIG_TOML = CONFIG_DIR / "config.toml"
BLOCKLIST_FILE = CONFIG_DIR / "blocklist.json"
MCP_TOKEN_FILE = CONFIG_DIR / "mcp_token"
# NOTE: the Mistral API key is NOT read here. It belongs to the co-located
# jarvisd process (the ApiBrain caller), which reads it from ITS OWN
# secrets.json at $JARVIS_CONFIG_DIR/secrets.json ({"mistral": "<key>"}) —
# see SettingsStore::apiKey(). proxmox-mcp itself never talks to Mistral.
TRACKER_TOKEN_FILE = CONFIG_DIR / "project_tracker_token"

STATE_FILE = STATE_DIR / "state.json"
MEMORY_DB = STATE_DIR / "memory.db"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8799

# Defaults used when config.toml is absent/partial — conservative (small bump
# steps, generous cooldown) since this runs unattended against a host the
# user actually depends on for CI.
_DEFAULTS = {
    "node": "pve",
    "check_interval_minutes": 5,
    "cooldown_minutes": 15,
    "reserve_cores": 2,
    "reserve_mem_mb": 4096,
    "bump_step_cores": 2,
    "bump_step_mem_mb": 2048,
    "max_cores_per_vm": 16,
    "max_mem_mb_per_vm": 32768,
    "cpu_congested_pct": 85.0,
    "mem_congested_pct": 90.0,
    "project_tracker_agent_name": "proxmox-pve",
    "project_tracker_project_id": "proj-jarvis",
    "project_tracker_url": "http://100.114.201.41:8790/mcp",
}


def settings() -> dict:
    """Merge config.toml over the defaults (missing file/keys are fine)."""
    merged = dict(_DEFAULTS)
    try:
        with open(CONFIG_TOML, "rb") as f:
            merged.update(tomllib.load(f))
    except (OSError, tomllib.TOMLDecodeError):
        pass
    return merged


def get_bearer_token() -> str:
    """This server's inbound bearer (the pve-local jarvisd authenticates with
    it). Env override wins (tests); else read the installer-written file;
    generate+persist one on first run so a bare `proxmox-mcp` still works."""
    env = os.environ.get("PROXMOX_MCP_TOKEN")
    if env:
        return env.strip()
    try:
        existing = MCP_TOKEN_FILE.read_text().strip()
        if existing:
            return existing
    except OSError:
        pass
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    MCP_TOKEN_FILE.write_text(token)
    os.chmod(MCP_TOKEN_FILE, 0o600)
    return token


def project_tracker_token() -> str:
    try:
        return TRACKER_TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def host() -> str:
    return os.environ.get("PROXMOX_MCP_HOST", DEFAULT_HOST)


def port() -> int:
    try:
        return int(os.environ.get("PROXMOX_MCP_PORT", str(DEFAULT_PORT)))
    except ValueError:
        return DEFAULT_PORT
