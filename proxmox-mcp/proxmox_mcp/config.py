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

# --- Full-power operator ("Cindro Proxmox Dashboard") ------------------------
# The interactive dashboard's Jarvis drives a SECOND, separate MCP catalog
# (proxmox-operator-mcp, :8800) that can do everything the Proxmox GUI can —
# unlike the restricted tuning catalog above, which never gets power/create
# tools. Its own bearer, its own token file. The user-editable permission
# policy that gates every mutating operator tool lives in CONFIG_DIR; the
# Jarvis-and-user-editable Home layout + Tasks board live in STATE_DIR.
OPERATOR_MCP_TOKEN_FILE = CONFIG_DIR / "operator_mcp_token"
DASHBOARD_TOKEN_FILE = CONFIG_DIR / "dashboard_token"
OPERATOR_POLICY_FILE = CONFIG_DIR / "operator_policy.json"

STATE_FILE = STATE_DIR / "state.json"
MEMORY_DB = STATE_DIR / "memory.db"
PROFILES_DIR = STATE_DIR / "vms"                       # JARVIS.md per VM/CT
SCOUT_STATUS_FILE = STATE_DIR / "scout_status.json"    # live fleet-scan progress
PINGED_FILE = STATE_DIR / "pinged.json"                # watch rules
PINGED_EVENTS_FILE = STATE_DIR / "pinged_events.jsonl" # fired-rule history
OPERATOR_LAYOUT_FILE = STATE_DIR / "operator_layout.json"  # Home widget grid
OPERATOR_TASKS_FILE = STATE_DIR / "operator_tasks.json"    # Tasks Kanban board

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8799
DEFAULT_OPERATOR_PORT = 8800

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
    "max_pending_questions": 3,
    "profile_stale_days": 7,
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


def _write_secret_file(path: Path, content: str) -> None:
    """Write a token file that is 0600 from the instant it exists — never even
    briefly world-readable. A plain `write_text()` creates the file with the
    default-umask perms and only tightens them on the *following* `os.chmod`,
    leaving a TOCTOU window in which another local user could read the token.

    O_CREAT's 0600 mode applies ONLY to a freshly created file; if `path`
    already exists at looser perms (e.g. 0644), O_TRUNC keeps those perms while
    the secret bytes are written, and a post-write `os.chmod` would tighten
    them only AFTER the secret was already on disk world-readable. So `fchmod`
    the descriptor to 0600 BEFORE writing anything — that closes the window in
    both the fresh-create and pre-existing cases. O_TRUNC preserves
    write_text's overwrite-in-place semantics."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", closefd=False) as f:
            f.write(content)
    finally:
        os.close(fd)


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
    token = secrets.token_urlsafe(32)
    _write_secret_file(MCP_TOKEN_FILE, token)
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


def operator_get_bearer_token() -> str:
    """The full-power operator server's inbound bearer (the co-located jarvisd
    running the interactive dashboard session authenticates with it). Env
    override wins (tests); else the installer-written file; else generate +
    persist one on first run. Deliberately DISTINCT from the tuning catalog's
    mcp_token so the two endpoints can never be confused for one another."""
    env = os.environ.get("OPERATOR_MCP_TOKEN")
    if env:
        return env.strip()
    try:
        existing = OPERATOR_MCP_TOKEN_FILE.read_text().strip()
        if existing:
            return existing
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    _write_secret_file(OPERATOR_MCP_TOKEN_FILE, token)
    return token


def operator_port() -> int:
    try:
        return int(os.environ.get("OPERATOR_MCP_PORT", str(DEFAULT_OPERATOR_PORT)))
    except ValueError:
        return DEFAULT_OPERATOR_PORT
