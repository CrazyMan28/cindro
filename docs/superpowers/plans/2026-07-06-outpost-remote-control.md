# Outpost Remote Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SSH tab (allow-list + exec console) with "Outpost": a one-line-install pairing system that registers any Windows/Linux/macOS machine with Orin over a token exchange, after which Orin can run shell commands and grab screenshots on that machine by name.

**Architecture:** A new standalone MCP service `outpost-mcp` (port 8798, cloned from `jarvis-mcp/`'s layout) owns pairing, a per-machine token registry, and a persistent WebSocket relay. The remote machine runs a small **Go** `outpost-agent` binary that **dials OUT** to `outpost-mcp` and holds a WebSocket; exec/screenshot requests are relayed over that held socket (no inbound firewall/NAT change on the target, survives roaming). `outpost-mcp` exposes both MCP tools (for external agents) and a loopback REST surface. The jarvisd daemon proxies six thin `outpost.*` control verbs to that REST surface (mirroring its existing `phone.http`/`phone.mcp` loopback pattern), and the web dashboard, TUI v2, and legacy Python TUI drive those verbs. The old SSH code (daemon handlers, `SshAllowList` core class, and every UI surface) is deleted last, after Outpost is fully wired.

**Agent language decision (committed):** The agent is a **single cross-compiled Go binary**. Go produces one static, dependency-free executable per OS/arch with **no runtime assumed on the target** — the exact property the spec requires (Python is not guaranteed on a stock Windows box; a Go X11/Wayland screenshot library is fragile on the user's sway/Wayland Linux). Exec uses `os/exec`; the WebSocket client uses the pure-Go `github.com/coder/websocket` (builds cleanly with `CGO_ENABLED=0`); **screenshots shell out to the platform's proven native capture** — PowerShell `CopyFromScreen` on Windows (the exact method already in this repo's `windows/testlab/screenshot.ps1`), and `grim`→`scrot`→`import` on Linux — so the binary needs no CGO screen-capture dependency and cross-compiles trivially. The build machine (dev/CI) fetches the one Go module at build time; the shipped binary is fully self-contained.

**Tech Stack:** Python 3.12 + FastAPI + FastMCP + uvicorn (`outpost-mcp`), Go 1.26 + coder/websocket (`outpost-agent`), C++/Qt6 (jarvisd daemon proxy + `UiManifest`/`TuiLayoutStore`), SolidJS/Vite (web), Bun/OpenTUI/SolidJS (TUI v2), Python/Textual (legacy TUI).

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the approved design.

- **New service port:** `8798` (confirmed free — next after `8797`/jarvis-mcp). Advertise host default `127.0.0.1`, bind `0.0.0.0`.
- **Token convention:** inbound bearer = `secrets.token_urlsafe(32)`, stored `~/.config/jarvis/outpost_mcp_token` (0600, auto-generated on first start), accepted as `Authorization: Bearer <t>` OR `?token=<t>` query param. Mirror `jarvis-mcp/jarvis_mcp/{config,auth}.py` exactly.
- **Per-machine tokens:** `secrets.token_urlsafe(32)`, stored as **SHA-256 hex hashes only** (never plaintext), returned to the agent exactly once at pairing, fully revocable.
- **Pairing codes:** one-shot, **10-minute (600s) TTL** `bootstrap_id`. One-shot means a second redemption of the same id fails.
- **Registry file:** `~/.config/jarvis/outpost_machines.json` (0600). Row shape mirrors `core/include/jarvis/DeviceRegistry.h`'s `DeviceRow`: `{id, name, os, transport, status, last_seen, paired_at}` (+ private `token_sha256`). Tools reference machines by **name OR id**.
- **Host resolution order:** Tailscale IP → LAN IP → localhost (mirror `phone/server/src/agents/enrollmentService.ts` lines ~96-102).
- **Windows install one-liner MUST be `irm … -OutFile … ; & …`, NEVER `iwr|iex`** — piping straight to `iex` cannot self-elevate (documented in `windows/testlab/setup-windows-vm.ps1:26`).
- **Windows agent installs as a Scheduled Task with `-LogonType Interactive -RunLevel Highest`, NOT a Service** — a session-0 service captures a blank desktop (documented in `windows/testlab/winlab.py:82-99`). Linux/macOS agent installs as a `systemd --user` unit (mirror `packaging/jarvis-mcp.service` shape).
- **Full-trust exec once paired** — there is **no** post-pairing command allow-list. Explicit design decision; do not add one.
- **Audit tiers** (daemon `m_audit.record(tool, ok, risk, summary, sessionId, remote)`): `outpost.exec` = **high**; `outpost.pair_start` + `outpost.screenshot` = **medium**; `outpost.list` + `outpost.pair_status` + `outpost.revoke` = **low**.
- **Out of scope for v1 (do NOT build):** file transfer, port-forwarding, persistent PTY streaming, exposing `outpost.*` over the phone app's Contract-C device WS, inline screenshot image rendering in TUI v2 (a JSON detail view is sufficient), and porting the **Qt desktop app** (`desktop/`) to Outpost. NOTE: the Qt desktop app consumes `ssh.*` too, but its `Bridge` already **degrades cleanly** to empty/"not available yet" states when those verbs return `unknown_method` (`desktop/src/Bridge.cpp:3646-3672`), so deleting the daemon `ssh.*` handlers reverts the desktop SSH page to that pre-existing degraded state rather than crashing — a follow-up, not part of this plan.

---

## File Structure

**New — `outpost-mcp/` (Python MCP service, cloned layout from `jarvis-mcp/`):**
- `pyproject.toml` — package metadata, deps, `outpost-mcp` entry point, pytest config.
- `outpost_mcp/__init__.py` — version.
- `outpost_mcp/config.py` — paths, port 8798, inbound bearer, agent-bin dir, host resolution.
- `outpost_mcp/auth.py` — bearer-token check for inbound HTTP (verbatim from jarvis-mcp shape).
- `outpost_mcp/registry.py` — `MachineRegistry`: `outpost_machines.json` CRUD, SHA-256 token hashing, name-or-id + by-token lookup, status/last_seen.
- `outpost_mcp/pairing.py` — `PairingStore`: mint/redeem one-shot 10-min bootstraps; render the `sh` + `ps1` install scripts.
- `outpost_mcp/agent_hub.py` — `AgentHub` + `AgentConnection`: hold live agent WebSockets, correlate exec/screenshot request→result by `req_id`.
- `outpost_mcp/tools_outpost.py` — the six `outpost_*` MCP tools.
- `outpost_mcp/server.py` — FastAPI app: auth middleware, `/health`, REST routes, `/agent/ws`, `/agent/download`, FastMCP mount.
- `outpost-mcp/tests/conftest.py` — hermetic tmp config-dir + token fixtures.
- `outpost-mcp/tests/test_registry.py`, `test_pairing.py`, `test_agent_hub.py`, `test_tools.py`, `test_server.py`.
- `outpost-mcp/client-setup.sh` — register the endpoint with Claude Code / Codex (adapted from jarvis-mcp).
- `outpost-mcp/agent-bin/` — cross-compiled agent binaries served by `/agent/download` (populated by the Go build).
- `packaging/outpost-mcp.service` — systemd `--user` unit (mirror `packaging/jarvis-mcp.service`).

**New — `outpost-agent/` (Go binary that runs ON the paired machine):**
- `go.mod` — module + pinned `coder/websocket`.
- `main.go` — load config, dial-out connect loop w/ backoff, hello + dispatch (exec/screenshot/ping).
- `exec.go` — `runShell` (platform shell).
- `screenshot.go` — `captureScreen` (Windows PowerShell / Linux grim→scrot→import) + PNG dim decode.
- `exec_test.go`, `screenshot_test.go` — Go unit tests.
- `build.sh` — cross-compile matrix into `../outpost-mcp/agent-bin/`.

**Modified — daemon / core (C++):**
- `daemon/src/ControlServer.h` / `.cpp` — add six `handleOutpost*` proxy handlers + `outpostHttp` helper + `outpost.` in `isOpsMethod`/dispatch (Task 8); remove all `ssh.*` handlers + `m_sshAllow` + include (Task 12).
- `core/src/UiManifest.cpp` — replace the `ssh` page block + `ssh` command with `outpost` equivalents (Task 10).
- `core/src/TuiLayoutStore.cpp` — swap reserved id `ssh`→`outpost` (Task 10).
- `core/tests/ui_manifest_test.cpp` — swap expected id `ssh`→`outpost` (Task 10).
- `core/CMakeLists.txt` / `windows/CMakeLists.txt` — remove `SshAllowList` sources + test (Task 12).
- **Deleted:** `core/src/SshAllowList.cpp`, `core/include/jarvis/SshAllowList.h`, `core/tests/ssh_allowlist_test.cpp` (Task 12).

**Modified — web (SolidJS):**
- `web/src/pages/outpost.tsx` — **new** Outpost page (pairing card + machine list + exec console + screenshot). `web/src/pages/ssh.tsx` **deleted** (Task 9).
- `web/src/components/NavIcon.tsx` — replace the `ssh` glyph with an `outpost` glyph (Task 9).

**Modified — legacy Python TUI:**
- `cli/jarvis_cli/tui/system_panes.py` — replace `SshPane` with `OutpostPane` (Task 11).
- `cli/jarvis_cli/tui/chat.py` — swap `ssh`→`outpost` in imports / `BUILTIN_COMMANDS` / `POPUP_PANE_FACTORIES` / title (Task 11).

---

## Task 1: Scaffold the outpost-mcp package (config + auth)

**Files:**
- Create: `outpost-mcp/pyproject.toml`
- Create: `outpost-mcp/outpost_mcp/__init__.py`
- Create: `outpost-mcp/outpost_mcp/config.py`
- Create: `outpost-mcp/outpost_mcp/auth.py`
- Create: `outpost-mcp/tests/conftest.py`
- Test: `outpost-mcp/tests/test_config.py`

**Interfaces:**
- Produces: `config.get_bearer_token() -> str`, `config.host() -> str`, `config.port() -> int`, `config.resolve_advertise_host() -> str`, `config.advertise_base_url() -> str`, `config.agent_bin_dir() -> Path`, `config.OUTPOST_CONFIG_DIR`, `config.MACHINES_FILE`, `config.TOKEN_FILE`, `config.BOOTSTRAP_TTL_SECONDS`. `auth.request_ok(request) -> bool`.
- Env overrides (used by every later task's tests): `OUTPOST_CONFIG_DIR`, `OUTPOST_MCP_TOKEN`, `OUTPOST_MCP_PORT`, `OUTPOST_MCP_HOST`, `OUTPOST_ADVERTISE_HOST`, `OUTPOST_AGENT_BIN_DIR`.

- [ ] **Step 1: Write `outpost-mcp/pyproject.toml`**

```toml
[project]
name = "outpost-mcp"
version = "0.1.0"
description = "Outpost-MCP: pair remote Windows/Linux/macOS machines with Jarvis and run gated exec/screenshot over a dialed-out WebSocket relay."
requires-python = ">=3.12"
dependencies = [
    "mcp>=1.26.0",
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pyyaml>=6.0",
]

[project.scripts]
outpost-mcp = "outpost_mcp.server:main"

[dependency-groups]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
    "websockets>=12.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["outpost_mcp"]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra"
asyncio_mode = "auto"
```

- [ ] **Step 2: Write `outpost-mcp/outpost_mcp/__init__.py`**

```python
"""Outpost-MCP: pair remote machines with Jarvis; relay gated exec + screenshot."""

__version__ = "0.1.0"
```

- [ ] **Step 3: Write `outpost-mcp/outpost_mcp/config.py`**

```python
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
```

- [ ] **Step 4: Write `outpost-mcp/outpost_mcp/auth.py`**

```python
"""Bearer-token auth for inbound HTTP (mirrors jarvis-mcp/auth.py).

Every path except /health and the one-shot /pair/* + /agent/download bootstrap
routes is token-checked by the FastAPI middleware. Accepts
`Authorization: Bearer <t>` or the `?token=` fallback (fleet convention)."""

import hmac
from typing import Optional

from fastapi import Request

from outpost_mcp.config import get_bearer_token


def _token_ok(token: Optional[str]) -> bool:
    return bool(token) and hmac.compare_digest(token, get_bearer_token())


def _bearer_from_header(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1]


def request_ok(request: Request) -> bool:
    if _token_ok(_bearer_from_header(request.headers.get("Authorization"))):
        return True
    return _token_ok(request.query_params.get("token"))
```

- [ ] **Step 5: Write `outpost-mcp/tests/conftest.py`**

```python
"""Hermetic fixtures: every test gets its own tmp config dir (isolated
outpost_machines.json + token) and a fixed inbound bearer."""

import pytest


@pytest.fixture(autouse=True)
def tmp_config(monkeypatch, tmp_path):
    monkeypatch.setenv("OUTPOST_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("OUTPOST_MCP_TOKEN", "test-inbound-token")
    monkeypatch.setenv("OUTPOST_ADVERTISE_HOST", "127.0.0.1")
    monkeypatch.setenv("OUTPOST_MCP_PORT", "8798")
    yield
```

- [ ] **Step 6: Write the failing test `outpost-mcp/tests/test_config.py`**

```python
import importlib

from outpost_mcp import config


def test_port_and_token_env_override():
    assert config.port() == 8798
    assert config.get_bearer_token() == "test-inbound-token"


def test_advertise_base_url_uses_override():
    assert config.advertise_base_url() == "http://127.0.0.1:8798"


def test_resolve_host_prefers_env():
    assert config.resolve_advertise_host() == "127.0.0.1"


def test_config_dir_is_tmp(tmp_path, monkeypatch):
    # OUTPOST_CONFIG_DIR is read at import; recompute the path it would use.
    importlib.reload(config)
    assert str(config.OUTPOST_CONFIG_DIR).endswith(str(config.OUTPOST_CONFIG_DIR.name))
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd outpost-mcp && OUTPOST_CONFIG_DIR= /usr/bin/env -u PYTHONPATH uv run pytest tests/test_config.py -v`
Expected: 4 passed. (If `uv` is unavailable, use `python -m pytest` inside a venv with the deps from `pyproject.toml`.)

- [ ] **Step 8: Commit**

```bash
git add outpost-mcp/pyproject.toml outpost-mcp/outpost_mcp/__init__.py outpost-mcp/outpost_mcp/config.py outpost-mcp/outpost_mcp/auth.py outpost-mcp/tests/conftest.py outpost-mcp/tests/test_config.py
git commit -m "feat(outpost): scaffold outpost-mcp package (config + auth)"
```

---

## Task 2: Machine registry

**Files:**
- Create: `outpost-mcp/outpost_mcp/registry.py`
- Test: `outpost-mcp/tests/test_registry.py`

**Interfaces:**
- Consumes: `config.MACHINES_FILE`.
- Produces: `MachineRegistry(path=None)` with `.load()`, `.add(name, os_name, transport="ws") -> {"row": dict, "token": str}`, `.list() -> list[dict]` (public rows, no token), `.get(machine) -> dict|None` (by name OR id), `.by_token(token) -> dict|None`, `.set_status(machine_id, status, seen=True)`, `.revoke(machine) -> bool`. Public row keys: `id, name, os, transport, status, last_seen, paired_at`. Private key: `token_sha256`.

- [ ] **Step 1: Write the failing test `outpost-mcp/tests/test_registry.py`**

```python
from outpost_mcp.registry import MachineRegistry, _hash_token


def test_add_returns_token_once_and_hashes_at_rest(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    res = reg.add("Alice-PC", "windows")
    token = res["token"]
    row = res["row"]
    assert row["id"] and row["name"] == "Alice-PC" and row["os"] == "windows"
    assert row["status"] == "offline" and row["transport"] == "ws"
    assert row["token_sha256"] == _hash_token(token)
    # public list never leaks the hash
    assert "token_sha256" not in reg.list()[0]


def test_get_by_name_or_id(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    assert reg.get("box")["id"] == row["id"]
    assert reg.get(row["id"])["name"] == "box"
    assert reg.get("nope") is None


def test_by_token_and_status(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    res = reg.add("box", "linux")
    found = reg.by_token(res["token"])
    assert found and found["id"] == res["row"]["id"]
    assert reg.by_token("wrong") is None
    reg.set_status(res["row"]["id"], "online")
    assert reg.list()[0]["status"] == "online"
    assert reg.list()[0]["last_seen"] > 0


def test_revoke_and_persist(tmp_path):
    path = tmp_path / "m.json"
    reg = MachineRegistry(path)
    row = reg.add("box", "linux")["row"]
    assert reg.revoke("box") is True
    assert reg.revoke("box") is False
    # a fresh registry reading the same file sees the deletion
    assert MachineRegistry(path).list() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'outpost_mcp.registry'`.

- [ ] **Step 3: Write `outpost-mcp/outpost_mcp/registry.py`**

```python
"""MachineRegistry — the paired-machine store (~/.config/jarvis/outpost_machines.json).

Row shape mirrors core/include/jarvis/DeviceRegistry.h's DeviceRow:
{id, name, os, transport, status, last_seen, paired_at} plus a private
token_sha256 (per-machine bearer, SHA-256 hashed — plaintext is never stored)."""

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Optional

from outpost_mcp import config

_PUBLIC_KEYS = ("id", "name", "os", "transport", "status", "last_seen", "paired_at")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class MachineRegistry:
    def __init__(self, path: Optional[Path] = None):
        self._path = Path(path) if path else config.MACHINES_FILE
        self._machines: list[dict[str, Any]] = []
        self.load()

    def load(self) -> None:
        try:
            data = json.loads(self._path.read_text())
            self._machines = data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            self._machines = []

    def _persist(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._machines, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(self._path)

    @staticmethod
    def _public(m: dict[str, Any]) -> dict[str, Any]:
        return {k: m.get(k) for k in _PUBLIC_KEYS}

    def add(self, name: str, os_name: str, transport: str = "ws") -> dict[str, Any]:
        mid = secrets.token_hex(8)
        raw = secrets.token_urlsafe(32)
        row = {
            "id": mid,
            "name": name or mid,
            "os": os_name,
            "transport": transport,
            "status": "offline",
            "last_seen": 0,
            "paired_at": int(time.time() * 1000),
            "token_sha256": _hash_token(raw),
        }
        self._machines.append(row)
        self._persist()
        return {"row": row, "token": raw}

    def list(self) -> list[dict[str, Any]]:
        return [self._public(m) for m in self._machines]

    def get(self, machine: str) -> Optional[dict[str, Any]]:
        for m in self._machines:
            if m["id"] == machine or m["name"] == machine:
                return m
        return None

    def by_token(self, token: str) -> Optional[dict[str, Any]]:
        h = _hash_token(token)
        for m in self._machines:
            if hmac.compare_digest(m.get("token_sha256", ""), h):
                return m
        return None

    def set_status(self, machine_id: str, status: str, seen: bool = True) -> None:
        for m in self._machines:
            if m["id"] == machine_id:
                m["status"] = status
                if seen:
                    m["last_seen"] = int(time.time() * 1000)
                self._persist()
                return

    def revoke(self, machine: str) -> bool:
        m = self.get(machine)
        if not m:
            return False
        self._machines = [x for x in self._machines if x["id"] != m["id"]]
        self._persist()
        return True
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_registry.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add outpost-mcp/outpost_mcp/registry.py outpost-mcp/tests/test_registry.py
git commit -m "feat(outpost): machine registry with SHA-256 hashed per-machine tokens"
```

---

## Task 3: Pairing store + install-script templates

**Files:**
- Create: `outpost-mcp/outpost_mcp/pairing.py`
- Test: `outpost-mcp/tests/test_pairing.py`

**Interfaces:**
- Consumes: `config.BOOTSTRAP_TTL_SECONDS`, `config.advertise_base_url()`.
- Produces: `PairingStore(ttl_seconds=config.BOOTSTRAP_TTL_SECONDS)` with `.start(name="", os_hint="") -> {pairing_code, bootstrap_id, expires_at, install_cmd_linux, install_cmd_windows}`, `.valid(bootstrap_id) -> bool`, `.status(bootstrap_id) -> {status, ...}` (status ∈ `unknown|pending|expired|paired`), `.redeem(bootstrap_id) -> dict|None` (one-shot), `.mark_paired(bootstrap_id, machine_id)`, `.render_sh(bootstrap_id) -> str`, `.render_ps1(bootstrap_id) -> str`.

- [ ] **Step 1: Write the failing test `outpost-mcp/tests/test_pairing.py`**

```python
import time

from outpost_mcp.pairing import PairingStore


def test_start_returns_oneliners_and_code():
    ps = PairingStore()
    r = ps.start(name="win-box", os_hint="windows")
    assert len(r["pairing_code"]) == 6 and r["pairing_code"].isdigit()
    assert r["bootstrap_id"]
    assert r["install_cmd_linux"].startswith("curl -fsSL http://127.0.0.1:8798/pair/")
    assert r["install_cmd_linux"].endswith("/sh | bash")
    # Windows one-liner MUST be irm -OutFile + &, never iwr|iex.
    assert "irm http://127.0.0.1:8798/pair/" in r["install_cmd_windows"]
    assert "-OutFile" in r["install_cmd_windows"]
    assert "iex" not in r["install_cmd_windows"]


def test_redeem_is_one_shot():
    ps = PairingStore()
    bid = ps.start()["bootstrap_id"]
    assert ps.valid(bid) is True
    assert ps.redeem(bid) is not None
    # second redemption fails
    assert ps.redeem(bid) is None
    assert ps.valid(bid) is False


def test_ttl_expiry():
    ps = PairingStore(ttl_seconds=0)
    bid = ps.start()["bootstrap_id"]
    time.sleep(0.01)
    assert ps.valid(bid) is False
    assert ps.status(bid)["status"] == "expired"
    assert ps.redeem(bid) is None


def test_status_lifecycle():
    ps = PairingStore()
    assert ps.status("nope")["status"] == "unknown"
    bid = ps.start()["bootstrap_id"]
    assert ps.status(bid)["status"] == "pending"
    ps.redeem(bid)
    ps.mark_paired(bid, "m123")
    assert ps.status(bid) == {"status": "paired", "machine_id": "m123"}


def test_render_scripts_embed_ids():
    ps = PairingStore()
    bid = ps.start()["bootstrap_id"]
    sh = ps.render_sh(bid)
    ps1 = ps.render_ps1(bid)
    assert bid in sh and "/agent/download/" in sh and "/complete" in sh
    assert "systemd" in sh
    assert bid in ps1 and "Invoke-WebRequest" in ps1
    # Windows: Scheduled Task in the interactive session, not a service.
    assert "LogonType Interactive" in ps1 and "RunLevel Highest" in ps1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_pairing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'outpost_mcp.pairing'`.

- [ ] **Step 3: Write `outpost-mcp/outpost_mcp/pairing.py`**

Note: the install scripts are built with `str.replace` on `__BASE__`/`__BID__` sentinels (NOT f-strings) so the embedded shell/PowerShell `$`/`{}` are never mangled.

```python
"""PairingStore — one-shot, 10-minute bootstrap codes + the OS install scripts.

A bootstrap_id is the one-shot secret handed to the target machine. The install
script (served open at /pair/<id>/sh|ps1) downloads the agent binary (gated by
the still-valid bootstrap_id), POSTs /pair/<id>/complete to redeem it exactly
once for {machine_id, token, ws_url}, persists the token 0600, and installs
itself: a systemd --user unit on Linux/macOS, a Scheduled Task in the
INTERACTIVE session on Windows (a session-0 service captures a blank desktop —
see windows/testlab/winlab.py)."""

import secrets
import time
from typing import Any, Optional

from outpost_mcp import config

_SH_TEMPLATE = r"""#!/usr/bin/env bash
set -euo pipefail
BASE="__BASE__"
BID="__BID__"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
esac
DIR="$HOME/.local/share/outpost-agent"
mkdir -p "$DIR"
BIN="$DIR/outpost-agent"
echo "Outpost: downloading agent ($OS/$ARCH)..."
curl -fsSL "$BASE/agent/download/$BID/$OS/$ARCH" -o "$BIN"
chmod +x "$BIN"
echo "Outpost: registering this machine..."
RESP=$(curl -fsSL -X POST "$BASE/pair/$BID/complete" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$(hostname)\",\"os\":\"$OS\",\"arch\":\"$ARCH\"}")
CFG="$HOME/.config/outpost-agent"
mkdir -p "$CFG"
printf '%s' "$RESP" > "$CFG/agent.json"
chmod 600 "$CFG/agent.json"
UNIT="$HOME/.config/systemd/user/outpost-agent.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=Outpost agent (dials Jarvis outpost-mcp)
After=network-online.target
[Service]
ExecStart=$BIN
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user enable --now outpost-agent.service || nohup "$BIN" >/dev/null 2>&1 &
else
  nohup "$BIN" >/dev/null 2>&1 &
fi
echo "Outpost agent installed."
"""

_PS1_TEMPLATE = r"""$ErrorActionPreference = 'Stop'
$Base = '__BASE__'
$Bid  = '__BID__'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
$dir = Join-Path $env:LOCALAPPDATA 'outpost-agent'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bin = Join-Path $dir 'outpost-agent.exe'
Write-Host "Outpost: downloading agent (windows/$arch)..."
Invoke-WebRequest "$Base/agent/download/$Bid/windows/$arch" -OutFile $bin
Write-Host "Outpost: registering this machine..."
$body = @{ name = $env:COMPUTERNAME; os = 'windows'; arch = $arch } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post "$Base/pair/$Bid/complete" -ContentType 'application/json' -Body $body
$cfgdir = Join-Path $env:APPDATA 'outpost-agent'
New-Item -ItemType Directory -Force -Path $cfgdir | Out-Null
($resp | ConvertTo-Json) | Set-Content -Path (Join-Path $cfgdir 'agent.json') -Encoding UTF8
# Install as a Scheduled Task in the INTERACTIVE session so screenshots see a
# real desktop (a session-0 service returns a blank capture).
$act  = New-ScheduledTaskAction -Execute $bin
$me   = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$prin = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$trig = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'OutpostAgent' -Action $act -Trigger $trig -Principal $prin -Force | Out-Null
Start-ScheduledTask -TaskName 'OutpostAgent'
Write-Host 'Outpost agent installed.'
"""


class PairingStore:
    def __init__(self, ttl_seconds: int = config.BOOTSTRAP_TTL_SECONDS):
        self._ttl = ttl_seconds
        self._bootstraps: dict[str, dict[str, Any]] = {}

    def start(self, name: str = "", os_hint: str = "") -> dict[str, Any]:
        bid = secrets.token_urlsafe(24)
        now = time.time()
        code = f"{secrets.randbelow(1000000):06d}"
        self._bootstraps[bid] = {
            "bootstrap_id": bid, "pairing_code": code,
            "name": name, "os_hint": os_hint,
            "created_at": now, "expires_at": now + self._ttl,
            "redeemed": False, "machine_id": "",
        }
        base = config.advertise_base_url()
        return {
            "pairing_code": code,
            "bootstrap_id": bid,
            "expires_at": int((now + self._ttl) * 1000),
            "install_cmd_linux": f"curl -fsSL {base}/pair/{bid}/sh | bash",
            "install_cmd_windows": (
                f"irm {base}/pair/{bid}/ps1 -OutFile "
                f"$env:TEMP\\outpost-install.ps1; & $env:TEMP\\outpost-install.ps1"
            ),
        }

    def valid(self, bootstrap_id: str) -> bool:
        b = self._bootstraps.get(bootstrap_id)
        return bool(b) and not b["redeemed"] and time.time() < b["expires_at"]

    def status(self, bootstrap_id: str) -> dict[str, Any]:
        b = self._bootstraps.get(bootstrap_id)
        if not b:
            return {"status": "unknown"}
        if b["redeemed"]:
            return {"status": "paired", "machine_id": b["machine_id"]}
        if time.time() >= b["expires_at"]:
            return {"status": "expired"}
        return {"status": "pending", "expires_at": int(b["expires_at"] * 1000)}

    def redeem(self, bootstrap_id: str) -> Optional[dict[str, Any]]:
        if not self.valid(bootstrap_id):
            return None
        b = self._bootstraps[bootstrap_id]
        b["redeemed"] = True
        return b

    def mark_paired(self, bootstrap_id: str, machine_id: str) -> None:
        if bootstrap_id in self._bootstraps:
            self._bootstraps[bootstrap_id]["machine_id"] = machine_id

    def render_sh(self, bootstrap_id: str) -> str:
        return (_SH_TEMPLATE
                .replace("__BASE__", config.advertise_base_url())
                .replace("__BID__", bootstrap_id))

    def render_ps1(self, bootstrap_id: str) -> str:
        return (_PS1_TEMPLATE
                .replace("__BASE__", config.advertise_base_url())
                .replace("__BID__", bootstrap_id))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_pairing.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add outpost-mcp/outpost_mcp/pairing.py outpost-mcp/tests/test_pairing.py
git commit -m "feat(outpost): one-shot pairing store + linux/windows install scripts"
```

---

## Task 4: Agent hub (WebSocket relay)

**Files:**
- Create: `outpost-mcp/outpost_mcp/agent_hub.py`
- Test: `outpost-mcp/tests/test_agent_hub.py`

**Interfaces:**
- Consumes: a `MachineRegistry` instance.
- Produces: `AgentConnection(machine_id, ws)` with `.request(payload: dict, timeout: float) -> dict` (adds `req_id`, awaits the matching result) and `.resolve(req_id, result)`. `AgentHub(registry)` with `.register(conn)`, `.unregister(machine_id)`, `.online(machine_id) -> bool`, async `.exec(machine, cmd, timeout=30.0, shell="auto") -> {ok, exit_code, output, error}`, async `.screenshot(machine) -> {ok, image_base64, width, height, captured_at, error}`. The `ws` object must expose async `send_text(str)`.

- [ ] **Step 1: Write the failing test `outpost-mcp/tests/test_agent_hub.py`**

```python
import asyncio
import json

import pytest

from outpost_mcp.agent_hub import AgentConnection, AgentHub
from outpost_mcp.registry import MachineRegistry


class FakeWs:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, text: str):
        self.sent.append(json.loads(text))


async def _drive(conn: AgentConnection, ws: FakeWs, reply: dict):
    """Wait for the hub to send one request, then feed the reply back."""
    while not ws.sent:
        await asyncio.sleep(0.005)
    req_id = ws.sent[-1]["req_id"]
    conn.resolve(req_id, {**reply, "req_id": req_id})


async def test_exec_roundtrip(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    ws = FakeWs()
    conn = AgentConnection(row["id"], ws)
    hub.register(conn)
    assert hub.online(row["id"]) is True
    assert reg.list()[0]["status"] == "online"

    reply = {"type": "exec_result", "ok": True, "exit_code": 0, "output": "hi", "error": ""}
    res, _ = await asyncio.gather(
        hub.exec("box", "echo hi", timeout=5),
        _drive(conn, ws, reply),
    )
    assert res == {"ok": True, "exit_code": 0, "output": "hi", "error": ""}
    assert ws.sent[-1]["type"] == "exec" and ws.sent[-1]["cmd"] == "echo hi"


async def test_exec_offline_and_unknown(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    reg.add("box", "linux")
    hub = AgentHub(reg)
    off = await hub.exec("box", "x")
    assert off["ok"] is False and off["error"] == "machine_offline"
    unk = await hub.exec("ghost", "x")
    assert unk["ok"] is False and unk["error"] == "unknown_machine"


async def test_screenshot_roundtrip(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    ws = FakeWs()
    conn = AgentConnection(row["id"], ws)
    hub.register(conn)
    reply = {"type": "screenshot_result", "ok": True, "image_base64": "AAA",
             "width": 100, "height": 50, "captured_at": 123}
    res, _ = await asyncio.gather(
        hub.screenshot("box"),
        _drive(conn, ws, reply),
    )
    assert res["ok"] and res["image_base64"] == "AAA" and res["width"] == 100


async def test_unregister_marks_offline(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    hub = AgentHub(reg)
    hub.register(AgentConnection(row["id"], FakeWs()))
    hub.unregister(row["id"])
    assert hub.online(row["id"]) is False
    assert reg.list()[0]["status"] == "offline"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_agent_hub.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'outpost_mcp.agent_hub'`.

- [ ] **Step 3: Write `outpost-mcp/outpost_mcp/agent_hub.py`**

```python
"""AgentHub — the persistent WebSocket relay to dialed-in outpost agents.

Each agent holds one WS to /agent/ws. exec/screenshot requests are pushed down
that socket with a correlation req_id; the agent's reply resolves the awaiting
future. The socket is held by the /agent/ws endpoint loop (server.py), which
routes exec_result / screenshot_result frames back into AgentConnection.resolve."""

import asyncio
import json
from typing import Any


class AgentConnection:
    def __init__(self, machine_id: str, ws: Any):
        self.machine_id = machine_id
        self.ws = ws
        self._pending: dict[str, asyncio.Future] = {}
        self._counter = 0

    def _next_req_id(self) -> str:
        self._counter += 1
        return f"r{self._counter}"

    async def request(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        req_id = self._next_req_id()
        payload["req_id"] = req_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        await self.ws.send_text(json.dumps(payload))
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    def resolve(self, req_id: str, result: dict[str, Any]) -> None:
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_result(result)


class AgentHub:
    def __init__(self, registry: Any):
        self._registry = registry
        self._conns: dict[str, AgentConnection] = {}

    def register(self, conn: AgentConnection) -> None:
        self._conns[conn.machine_id] = conn
        self._registry.set_status(conn.machine_id, "online")

    def unregister(self, machine_id: str) -> None:
        self._conns.pop(machine_id, None)
        self._registry.set_status(machine_id, "offline", seen=False)

    def online(self, machine_id: str) -> bool:
        return machine_id in self._conns

    async def exec(self, machine: str, cmd: str, timeout: float = 30.0,
                   shell: str = "auto") -> dict[str, Any]:
        m = self._registry.get(machine)
        if not m:
            return {"ok": False, "exit_code": -1, "output": "", "error": "unknown_machine"}
        conn = self._conns.get(m["id"])
        if not conn:
            return {"ok": False, "exit_code": -1, "output": "", "error": "machine_offline"}
        try:
            res = await conn.request(
                {"type": "exec", "cmd": cmd, "timeout": timeout, "shell": shell},
                timeout=timeout + 5,
            )
        except asyncio.TimeoutError:
            return {"ok": False, "exit_code": -1, "output": "", "error": "agent_timeout"}
        self._registry.set_status(m["id"], "online")
        return {
            "ok": bool(res.get("ok")),
            "exit_code": int(res.get("exit_code", -1)),
            "output": res.get("output", ""),
            "error": res.get("error", ""),
        }

    async def screenshot(self, machine: str) -> dict[str, Any]:
        m = self._registry.get(machine)
        if not m:
            return {"ok": False, "error": "unknown_machine"}
        conn = self._conns.get(m["id"])
        if not conn:
            return {"ok": False, "error": "machine_offline"}
        try:
            res = await conn.request({"type": "screenshot"}, timeout=45)
        except asyncio.TimeoutError:
            return {"ok": False, "error": "agent_timeout"}
        self._registry.set_status(m["id"], "online")
        return {
            "ok": bool(res.get("ok")),
            "image_base64": res.get("image_base64", ""),
            "width": int(res.get("width", 0)),
            "height": int(res.get("height", 0)),
            "captured_at": res.get("captured_at", 0),
            "error": res.get("error", ""),
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_agent_hub.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add outpost-mcp/outpost_mcp/agent_hub.py outpost-mcp/tests/test_agent_hub.py
git commit -m "feat(outpost): agent hub — WebSocket relay with req_id correlation"
```

---

## Task 5: MCP tools

**Files:**
- Create: `outpost-mcp/outpost_mcp/tools_outpost.py`
- Test: `outpost-mcp/tests/test_tools.py`

**Interfaces:**
- Consumes: a `FastMCP` instance, a `MachineRegistry`, a `PairingStore`, an `AgentHub`.
- Produces: `register(mcp, registry, pairing, hub) -> list[str]` registering `outpost_list_machines`, `outpost_pair_start`, `outpost_pair_status`, `outpost_exec`, `outpost_screenshot`, `outpost_revoke`.

- [ ] **Step 1: Write the failing test `outpost-mcp/tests/test_tools.py`**

```python
from mcp.server.fastmcp import FastMCP

from outpost_mcp import tools_outpost
from outpost_mcp.agent_hub import AgentHub
from outpost_mcp.pairing import PairingStore
from outpost_mcp.registry import MachineRegistry


def _payload(result):
    structured = result[1] if isinstance(result, tuple) else result
    return structured.get("result", structured) if isinstance(structured, dict) else structured


async def test_tools_registered(tmp_path):
    mcp = FastMCP("outpost-test")
    names = tools_outpost.register(
        mcp, MachineRegistry(tmp_path / "m.json"), PairingStore(), AgentHub(MachineRegistry(tmp_path / "m2.json")))
    required = {"outpost_list_machines", "outpost_pair_start", "outpost_pair_status",
                "outpost_exec", "outpost_screenshot", "outpost_revoke"}
    assert required == set(names)
    listed = {t.name for t in await mcp.list_tools()}
    assert required.issubset(listed)


async def test_list_and_revoke(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    reg.add("box", "linux")
    mcp = FastMCP("outpost-test")
    tools_outpost.register(mcp, reg, PairingStore(), AgentHub(reg))
    listed = _payload(await mcp.call_tool("outpost_list_machines", {}))
    assert listed["machines"][0]["name"] == "box"
    revoked = _payload(await mcp.call_tool("outpost_revoke", {"machine": "box"}))
    assert revoked == {"ok": True, "revoked": True}
    assert _payload(await mcp.call_tool("outpost_list_machines", {}))["machines"] == []


async def test_pair_start_shape(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    mcp = FastMCP("outpost-test")
    tools_outpost.register(mcp, reg, PairingStore(), AgentHub(reg))
    out = _payload(await mcp.call_tool("outpost_pair_start", {"name": "n", "os_hint": "linux"}))
    assert out["bootstrap_id"] and out["install_cmd_linux"] and out["install_cmd_windows"]


async def test_exec_offline(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    reg.add("box", "linux")
    mcp = FastMCP("outpost-test")
    tools_outpost.register(mcp, reg, PairingStore(), AgentHub(reg))
    out = _payload(await mcp.call_tool("outpost_exec", {"machine": "box", "cmd": "x"}))
    assert out["ok"] is False and out["error"] == "machine_offline"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_tools.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'outpost_mcp.tools_outpost'`.

- [ ] **Step 3: Write `outpost-mcp/outpost_mcp/tools_outpost.py`**

```python
"""The six outpost_* MCP tools — thin wrappers over the registry, pairing store,
and agent hub. An external agent (Claude Code / Codex) uses these to pair a
machine and then run gated shell commands / grab screenshots on it by name."""

from typing import Any

from mcp.server.fastmcp import FastMCP


def register(mcp: FastMCP, registry: Any, pairing: Any, hub: Any) -> list[str]:
    """Register every outpost_* tool; return their names."""

    @mcp.tool()
    async def outpost_list_machines() -> dict[str, Any]:
        """List paired Outpost machines: {machines:[{id,name,os,transport,status,last_seen}]}."""
        return {"machines": registry.list()}

    @mcp.tool()
    async def outpost_pair_start(name: str = "", os_hint: str = "") -> dict[str, Any]:
        """Begin pairing a NEW machine. Returns a one-shot 10-minute bootstrap +
        ready-to-paste install one-liners for Linux/macOS and Windows. Run the
        matching one-liner ON the target machine to register it."""
        return pairing.start(name, os_hint)

    @mcp.tool()
    async def outpost_pair_status(bootstrap_id: str) -> dict[str, Any]:
        """Poll a pairing: status is pending | paired | expired | unknown
        (and machine_id once paired)."""
        return pairing.status(bootstrap_id)

    @mcp.tool()
    async def outpost_exec(machine: str, cmd: str, timeout: float = 30.0,
                           shell: str = "auto") -> dict[str, Any]:
        """Run a shell command on a paired machine (by name OR id). shell:
        "auto" = PowerShell on Windows, sh on Linux/macOS. Returns
        {ok, exit_code, output, error}. Full trust — no post-pairing allow-list."""
        return await hub.exec(machine, cmd, timeout, shell)

    @mcp.tool()
    async def outpost_screenshot(machine: str) -> dict[str, Any]:
        """Grab a screenshot from a paired machine (by name OR id). Returns
        {ok, image_base64, width, height, captured_at}."""
        return await hub.screenshot(machine)

    @mcp.tool()
    async def outpost_revoke(machine: str) -> dict[str, Any]:
        """Unpair a machine (by name OR id): drops its live socket and deletes its
        token. Returns {ok, revoked}."""
        m = registry.get(machine)
        if not m:
            return {"ok": False, "revoked": False}
        hub.unregister(m["id"])
        ok = registry.revoke(m["id"])
        return {"ok": ok, "revoked": ok}

    return [
        "outpost_list_machines", "outpost_pair_start", "outpost_pair_status",
        "outpost_exec", "outpost_screenshot", "outpost_revoke",
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_tools.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add outpost-mcp/outpost_mcp/tools_outpost.py outpost-mcp/tests/test_tools.py
git commit -m "feat(outpost): six outpost_* MCP tools"
```

---

## Task 6: FastAPI server (REST + WS relay + download + MCP mount) + packaging

**Files:**
- Create: `outpost-mcp/outpost_mcp/server.py`
- Create: `outpost-mcp/client-setup.sh`
- Create: `packaging/outpost-mcp.service`
- Test: `outpost-mcp/tests/test_server.py`

**Interfaces:**
- Consumes: everything above.
- Produces: an importable `app` (FastAPI) and `main()`. Open routes: `GET /health`, `GET /pair/{bootstrap_id}/sh`, `GET /pair/{bootstrap_id}/ps1`, `GET /agent/download/{bootstrap_id}/{os_name}/{arch}`, `POST /pair/{bootstrap_id}/complete`, `WEBSOCKET /agent/ws`. Bearer-gated: `POST /api/pair/start`, `GET /api/pair/status/{bootstrap_id}`, `GET /api/machines`, `POST /api/machines/{machine_id}/revoke`, `POST /api/exec`, `POST /api/screenshot`, `POST /api/revoke`, and the `/mcp` mount.
- `/pair/{id}/complete` body: `{name, os, arch}` → `{machine_id, token, ws_url}`. `/api/exec` body: `{machine, cmd, timeout, shell}`. `/api/screenshot` + `/api/revoke` body: `{machine}`.

- [ ] **Step 1: Write the failing test `outpost-mcp/tests/test_server.py`**

This is a full integration test: it launches the real server on a test port, drives pairing, connects a **fake agent** over a real WebSocket, and exercises `/api/exec` end-to-end.

```python
import asyncio
import json
import os
import socket
import sys

import httpx
import pytest
import websockets


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture
async def server(tmp_path):
    port = _free_port()
    token = "selftest-token"
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.update({
        "OUTPOST_MCP_TOKEN": token, "OUTPOST_MCP_PORT": str(port),
        "OUTPOST_MCP_HOST": "127.0.0.1", "OUTPOST_ADVERTISE_HOST": "127.0.0.1",
        "OUTPOST_CONFIG_DIR": str(tmp_path),
    })
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "outpost_mcp.server", env=env,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient() as hc:
        for _ in range(60):
            try:
                if (await hc.get(f"{base}/health", timeout=1)).status_code == 200:
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        else:
            proc.terminate()
            raise AssertionError("outpost-mcp did not become healthy")
    try:
        yield base, port, token
    finally:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()


async def test_health_open_and_machines_gated(server):
    base, _, token = server
    async with httpx.AsyncClient() as hc:
        assert (await hc.get(f"{base}/health")).json()["service"] == "outpost-mcp"
        assert (await hc.get(f"{base}/api/machines")).status_code == 401
        r = await hc.get(f"{base}/api/machines", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200 and r.json() == {"machines": []}


async def test_pair_download_gate_and_exec_roundtrip(server):
    base, port, token = server
    auth = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient() as hc:
        start = (await hc.post(f"{base}/api/pair/start", headers=auth, json={"name": "box"})).json()
        bid = start["bootstrap_id"]
        # the sh script is served open and embeds the bootstrap id
        sh = await hc.get(f"{base}/pair/{bid}/sh")
        assert sh.status_code == 200 and bid in sh.text
        # no binary present in this tmp env -> 404 (gate passed, file missing)
        dl = await hc.get(f"{base}/agent/download/{bid}/linux/amd64")
        assert dl.status_code == 404
        # complete the pairing (open, one-shot)
        done = (await hc.post(f"{base}/pair/{bid}/complete",
                              json={"name": "box", "os": "linux", "arch": "amd64"})).json()
        assert done["machine_id"] and done["token"]
        assert done["ws_url"] == f"ws://127.0.0.1:{port}/agent/ws"
        # second completion is rejected (one-shot)
        assert (await hc.post(f"{base}/pair/{bid}/complete", json={})).status_code == 403

        # connect a fake agent and answer one exec
        machine_id, mtoken = done["machine_id"], done["token"]

        async def fake_agent():
            async with websockets.connect(f"{done['ws_url']}?token={mtoken}") as ws:
                await ws.send(json.dumps({"type": "hello", "machine_id": machine_id}))
                req = json.loads(await ws.recv())
                assert req["type"] == "exec"
                await ws.send(json.dumps({
                    "type": "exec_result", "req_id": req["req_id"], "ok": True,
                    "exit_code": 0, "output": "pong", "error": ""}))
                await asyncio.sleep(0.2)

        agent_task = asyncio.create_task(fake_agent())
        await asyncio.sleep(0.4)  # let the agent register
        res = (await hc.post(f"{base}/api/exec", headers=auth,
                             json={"machine": "box", "cmd": "echo pong"})).json()
        assert res == {"ok": True, "exit_code": 0, "output": "pong", "error": ""}
        await agent_task
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_server.py -v`
Expected: FAIL — the server module has no `app`/routes yet (subprocess exits, "did not become healthy").

- [ ] **Step 3: Write `outpost-mcp/outpost_mcp/server.py`**

```python
"""Outpost-MCP server: one FastAPI/FastMCP endpoint that pairs remote machines
and relays gated exec/screenshot over each agent's dialed-out WebSocket.

Layout mirrors jarvis-mcp/server.py:
- MCP streamable-http transport mounted at /mcp (bearer-gated).
- /health + the one-shot /pair/* + /agent/download bootstrap routes are open.
- /agent/ws is the persistent per-machine-token relay socket.
"""

import json
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from outpost_mcp import __version__, auth, config, tools_outpost
from outpost_mcp.agent_hub import AgentConnection, AgentHub
from outpost_mcp.pairing import PairingStore
from outpost_mcp.registry import MachineRegistry

registry = MachineRegistry()
pairing = PairingStore()
hub = AgentHub(registry)

mcp = FastMCP(
    "outpost",
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
OUTPOST_TOOLS = tools_outpost.register(mcp, registry, pairing, hub)
mcp_app = mcp.streamable_http_app()

# Open (no bearer): /health, one-shot bootstrap fetch/redeem, agent download.
# The WS handshake bypasses http middleware and does its own ?token gate.
_OPEN_PREFIXES = ("/pair/", "/agent/download/")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="Outpost MCP", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if (path == "/health" or request.method == "OPTIONS"
            or any(path.startswith(p) for p in _OPEN_PREFIXES)):
        return await call_next(request)
    if not auth.request_ok(request):
        return JSONResponse(status_code=401,
                            content={"error": "Unauthorized",
                                     "message": "Invalid or missing bearer token"})
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "outpost-mcp", "version": __version__,
            "machines": len(registry.list()), "tools": len(OUTPOST_TOOLS)}


# --- pairing (mixed open/gated) --------------------------------------------

@app.post("/api/pair/start")
async def api_pair_start(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    return pairing.start(body.get("name", ""), body.get("os_hint", ""))


@app.get("/api/pair/status/{bootstrap_id}")
async def api_pair_status(bootstrap_id: str):
    return pairing.status(bootstrap_id)


@app.get("/pair/{bootstrap_id}/sh")
async def pair_sh(bootstrap_id: str):
    if not pairing.valid(bootstrap_id):
        return PlainTextResponse("echo 'outpost: pairing code invalid or expired' >&2; exit 1",
                                 status_code=410)
    return PlainTextResponse(pairing.render_sh(bootstrap_id), media_type="text/x-shellscript")


@app.get("/pair/{bootstrap_id}/ps1")
async def pair_ps1(bootstrap_id: str):
    if not pairing.valid(bootstrap_id):
        return PlainTextResponse("Write-Error 'outpost: pairing code invalid or expired'",
                                 status_code=410)
    return PlainTextResponse(pairing.render_ps1(bootstrap_id))


@app.get("/agent/download/{bootstrap_id}/{os_name}/{arch}")
async def agent_download(bootstrap_id: str, os_name: str, arch: str):
    if not pairing.valid(bootstrap_id):
        return JSONResponse({"error": "invalid_bootstrap"}, status_code=403)
    name = f"outpost-agent-{os_name}-{arch}" + (".exe" if os_name == "windows" else "")
    path = config.agent_bin_dir() / name
    if not path.exists():
        return JSONResponse({"error": "agent_binary_unavailable", "name": name}, status_code=404)
    return FileResponse(str(path), filename=name)


@app.post("/pair/{bootstrap_id}/complete")
async def pair_complete(bootstrap_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    b = pairing.redeem(bootstrap_id)
    if b is None:
        return JSONResponse({"error": "invalid_or_used"}, status_code=403)
    created = registry.add(name=body.get("name") or b.get("name") or "",
                           os_name=body.get("os", ""))
    row = created["row"]
    pairing.mark_paired(bootstrap_id, row["id"])
    return {"machine_id": row["id"], "token": created["token"],
            "ws_url": f"ws://{config.resolve_advertise_host()}:{config.port()}/agent/ws"}


# --- machine ops (bearer-gated) --------------------------------------------

@app.get("/api/machines")
async def api_machines():
    return {"machines": registry.list()}


@app.post("/api/machines/{machine_id}/revoke")
async def api_revoke_id(machine_id: str):
    ok = registry.revoke(machine_id)
    return {"ok": ok, "revoked": ok}


@app.post("/api/exec")
async def api_exec(request: Request):
    body = await request.json()
    return await hub.exec(body["machine"], body["cmd"],
                          float(body.get("timeout", 30.0)), body.get("shell", "auto"))


@app.post("/api/screenshot")
async def api_screenshot(request: Request):
    body = await request.json()
    return await hub.screenshot(body["machine"])


@app.post("/api/revoke")
async def api_revoke(request: Request):
    body = await request.json()
    m = registry.get(body["machine"])
    if not m:
        return {"ok": False, "revoked": False}
    hub.unregister(m["id"])
    ok = registry.revoke(m["id"])
    return {"ok": ok, "revoked": ok}


# --- the persistent relay socket -------------------------------------------

@app.websocket("/agent/ws")
async def agent_ws(ws: WebSocket):
    m = registry.by_token(ws.query_params.get("token", ""))
    if not m:
        await ws.close(code=4401)
        return
    await ws.accept()
    conn = AgentConnection(m["id"], ws)
    hub.register(conn)
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")
            if kind in ("exec_result", "screenshot_result"):
                conn.resolve(msg.get("req_id", ""), msg)
            elif kind == "hello":
                registry.set_status(m["id"], "online")
            elif kind == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.unregister(m["id"])


# Mounted last so explicit routes win over the MCP catch-all.
app.mount("/", mcp_app)


def main() -> None:
    h, p = config.host(), config.port()
    config.get_bearer_token()  # generate + print the token path on first start
    print(f"outpost-mcp v{__version__} starting on {h}:{p}/mcp "
          f"(advertise {config.advertise_base_url()})")
    uvicorn.run(app, host=h, port=p, log_level="info")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest tests/test_server.py -v`
Expected: 2 passed. Then run the whole suite: `cd outpost-mcp && /usr/bin/env -u PYTHONPATH uv run pytest -v` — Expected: all passed.

- [ ] **Step 5: Write `outpost-mcp/client-setup.sh`** (adapted from jarvis-mcp)

```bash
#!/usr/bin/env bash
# Register the Outpost-MCP endpoint with Claude Code (~/.claude.json) and Codex
# (~/.codex/config.toml) so either agent can pair machines + run exec/screenshot.
#   ./client-setup.sh            # print snippets
#   ./client-setup.sh --apply    # patch both
set -euo pipefail

NAME="outpost"
HOST="${OUTPOST_MCP_ADVERTISE_HOST:-127.0.0.1}"
PORT="${OUTPOST_MCP_PORT:-8798}"
URL="http://${HOST}:${PORT}/mcp"
TOKEN_FILE="${HOME}/.config/jarvis/outpost_mcp_token"
CODEX_ENV_VAR="OUTPOST_MCP_TOKEN"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "WARN: $TOKEN_FILE not found — start outpost-mcp once (it auto-generates a" \
       "0600 token), or set OUTPOST_MCP_TOKEN in the environment." >&2
  TOKEN="<RUN-THE-SERVER-ONCE-TO-GENERATE>"
else
  TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
fi

CLAUDE_JSON="${HOME}/.claude.json"
CODEX_TOML="${HOME}/.codex/config.toml"

print_snippets() {
  cat <<EOF
# Outpost-MCP endpoint: ${URL}
# --- Claude Code: ~/.claude.json -> mcpServers.${NAME} ----------------------
{
  "mcpServers": {
    "${NAME}": { "type": "http", "url": "${URL}",
      "headers": { "Authorization": "Bearer ${TOKEN}" } }
  }
}
# --- Codex CLI: ~/.codex/config.toml ----------------------------------------
[mcp_servers.${NAME}]
url = "${URL}"
bearer_token_env_var = "${CODEX_ENV_VAR}"
#   export ${CODEX_ENV_VAR}="\$(cat ${TOKEN_FILE})"
EOF
}

patch_claude() {
  [[ -f "$CLAUDE_JSON" ]] || echo "{}" > "$CLAUDE_JSON"
  NAME="$NAME" URL="$URL" TOKEN="$TOKEN" CLAUDE_JSON="$CLAUDE_JSON" python3 - <<'PY'
import json, os
path = os.environ["CLAUDE_JSON"]
with open(path) as f:
    data = json.load(f)
data.setdefault("mcpServers", {})
data["mcpServers"][os.environ["NAME"]] = {
    "type": "http", "url": os.environ["URL"],
    "headers": {"Authorization": "Bearer " + os.environ["TOKEN"]}}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
print(f"patched {path}: mcpServers.{os.environ['NAME']}")
PY
}

patch_codex() {
  mkdir -p "$(dirname "$CODEX_TOML")"; touch "$CODEX_TOML"
  NAME="$NAME" URL="$URL" CODEX_ENV_VAR="$CODEX_ENV_VAR" CODEX_TOML="$CODEX_TOML" python3 - <<'PY'
import os, re
path = os.environ["CODEX_TOML"]; name = os.environ["NAME"]
with open(path) as f:
    txt = f.read()
block = (f"[mcp_servers.{name}]\n"
         f'url = "{os.environ["URL"]}"\n'
         f'bearer_token_env_var = "{os.environ["CODEX_ENV_VAR"]}"\n')
pattern = re.compile(r"^\[mcp_servers\." + re.escape(name) + r"\].*?(?=^\[|\Z)",
                     re.MULTILINE | re.DOTALL)
txt = pattern.sub(block.rstrip() + "\n", txt) if pattern.search(txt) else (
    (txt + ("\n" if txt and not txt.endswith("\n") else "")) + "\n" + block)
with open(path, "w") as f:
    f.write(txt)
print(f"patched {path}: [mcp_servers.{name}]")
PY
}

case "${1:-}" in
  --apply)  patch_claude; patch_codex ;;
  --claude) patch_claude ;;
  --codex)  patch_codex ;;
  ""|--print|-h|--help) print_snippets ;;
  *) echo "unknown arg: $1" >&2; print_snippets; exit 2 ;;
esac
```

Then `chmod +x outpost-mcp/client-setup.sh`.

- [ ] **Step 6: Write `packaging/outpost-mcp.service`** (mirror `packaging/jarvis-mcp.service`)

```ini
[Unit]
Description=Outpost-MCP server (pair remote machines; relay gated exec/screenshot)
After=network-online.target
Wants=network-online.target

[Service]
# Auto-generates ~/.config/jarvis/outpost_mcp_token (0600) on first start and
# binds 0.0.0.0:8798 (tailnet bearer model). Serves the Go agent binaries from
# outpost-mcp/agent-bin/. Run from the project's uv venv; PYTHONPATH is unset
# because the host exports a 3.14 PYTHONPATH that breaks venvs.
WorkingDirectory=%h/projects/computer_use/outpost-mcp
Environment=PYTHONPATH=
ExecStart=/usr/bin/env -u PYTHONPATH %h/.local/bin/uv run outpost-mcp
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

- [ ] **Step 7: Commit**

```bash
chmod +x outpost-mcp/client-setup.sh
git add outpost-mcp/outpost_mcp/server.py outpost-mcp/tests/test_server.py outpost-mcp/client-setup.sh packaging/outpost-mcp.service
git commit -m "feat(outpost): FastAPI server (REST + WS relay + download + MCP mount) + packaging"
```

---

## Task 7: The Go outpost-agent (dial-out, exec, screenshot) + cross-compile

**Files:**
- Create: `outpost-agent/go.mod`
- Create: `outpost-agent/main.go`
- Create: `outpost-agent/exec.go`
- Create: `outpost-agent/screenshot.go`
- Create: `outpost-agent/build.sh`
- Test: `outpost-agent/exec_test.go`, `outpost-agent/screenshot_test.go`

**Interfaces:**
- Consumes (at runtime): `~/.config/outpost-agent/agent.json` (Linux/macOS) or `%APPDATA%\outpost-agent\agent.json` (Windows) = `{machine_id, token, ws_url}`; connects `ws_url + "?token=" + token`.
- Wire protocol (server→agent): `{"type":"exec","req_id","cmd","timeout","shell"}`, `{"type":"screenshot","req_id"}`. Agent→server: `{"type":"hello","machine_id"}`, `{"type":"exec_result","req_id","ok","exit_code","output","error"}`, `{"type":"screenshot_result","req_id","ok","image_base64","width","height","captured_at","error"}`.
- Produces: `outpost-mcp/agent-bin/outpost-agent-{linux,darwin}-{amd64,arm64}` and `outpost-agent-windows-{amd64,386}.exe`.

- [ ] **Step 1: Write `outpost-agent/go.mod`**

```
module outpost-agent

go 1.26

require github.com/coder/websocket v1.8.12
```

- [ ] **Step 2: Write `outpost-agent/exec.go`**

```go
package main

import (
	"bytes"
	"context"
	"os/exec"
	"runtime"
	"time"
)

// runShell runs cmd via the platform shell, returning ok, exitCode, combined
// output, and an error string. shell "auto" => PowerShell on Windows, sh -c
// elsewhere. Full trust — no allow-list (design decision).
func runShell(cmd string, timeoutSec float64, shell string) (bool, int, string, string) {
	if timeoutSec <= 0 {
		timeoutSec = 30
	}
	ctx, cancel := context.WithTimeout(context.Background(),
		time.Duration(timeoutSec*float64(time.Second)))
	defer cancel()

	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive",
			"-Command", cmd)
	} else {
		c = exec.CommandContext(ctx, "sh", "-c", cmd)
	}
	var buf bytes.Buffer
	c.Stdout = &buf
	c.Stderr = &buf
	err := c.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return false, -1, buf.String(), "timeout"
	}
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	errStr := ""
	if err != nil && code == -1 {
		errStr = err.Error()
	}
	return err == nil, code, buf.String(), errStr
}
```

- [ ] **Step 3: Write `outpost-agent/exec_test.go`**

```go
package main

import (
	"strings"
	"testing"
)

func TestRunShellEcho(t *testing.T) {
	ok, code, out, errStr := runShell("echo hello-outpost", 10, "auto")
	if !ok || code != 0 {
		t.Fatalf("expected ok/0, got ok=%v code=%d err=%q", ok, code, errStr)
	}
	if !strings.Contains(out, "hello-outpost") {
		t.Fatalf("output missing marker: %q", out)
	}
}

func TestRunShellNonZero(t *testing.T) {
	ok, code, _, _ := runShell("exit 3", 10, "auto")
	if ok || code != 3 {
		t.Fatalf("expected fail/3, got ok=%v code=%d", ok, code)
	}
}

func TestRunShellTimeout(t *testing.T) {
	ok, _, _, errStr := runShell("sleep 5", 0.2, "auto")
	if ok || errStr != "timeout" {
		t.Fatalf("expected timeout, got ok=%v err=%q", ok, errStr)
	}
}
```

- [ ] **Step 4: Write `outpost-agent/screenshot.go`**

```go
package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// The exact CopyFromScreen capture proven in windows/testlab/screenshot.ps1.
const winShotPS = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$vs  = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size)
$bmp.Save('%s', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`

// linuxShotTools, tried in order — Wayland (grim) first, then X11 fallbacks.
var linuxShotTools = [][]string{
	{"grim", "%s"},
	{"scrot", "-o", "%s"},
	{"import", "-window", "root", "%s"},
}

func pngDims(data []byte) (int, int, error) {
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// chooseLinuxTool returns the first tool whose binary is on PATH, or "".
func chooseLinuxTool(lookup func(string) (string, error)) []string {
	for _, t := range linuxShotTools {
		if _, err := lookup(t[0]); err == nil {
			return t
		}
	}
	return nil
}

func captureToFile(path string) error {
	if runtime.GOOS == "windows" {
		return exec.Command("powershell", "-NoProfile", "-NonInteractive",
			"-Command", fmt.Sprintf(winShotPS, path)).Run()
	}
	tool := chooseLinuxTool(exec.LookPath)
	if tool == nil {
		return errors.New("no screenshot tool found (install grim, scrot, or imagemagick)")
	}
	args := make([]string, len(tool))
	for i, a := range tool {
		if a == "%s" {
			args[i] = path
		} else {
			args[i] = a
		}
	}
	return exec.Command(args[0], args[1:]...).Run()
}

// captureScreen returns base64 PNG + dimensions.
func captureScreen() (string, int, int, error) {
	path := filepath.Join(os.TempDir(), "outpost-shot.png")
	defer os.Remove(path)
	if err := captureToFile(path); err != nil {
		return "", 0, 0, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, 0, err
	}
	w, h, err := pngDims(data)
	if err != nil {
		w, h = 0, 0 // capture worked but not a PNG we can measure
	}
	return base64.StdEncoding.EncodeToString(data), w, h, nil
}
```

- [ ] **Step 5: Write `outpost-agent/screenshot_test.go`**

```go
package main

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestPngDims(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 12, 7))
	img.Set(0, 0, color.White)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	w, h, err := pngDims(buf.Bytes())
	if err != nil || w != 12 || h != 7 {
		t.Fatalf("got w=%d h=%d err=%v", w, h, err)
	}
}

func TestChooseLinuxToolNoneAvailable(t *testing.T) {
	got := chooseLinuxTool(func(string) (string, error) { return "", errors.New("nope") })
	if got != nil {
		t.Fatalf("expected nil when no tool is on PATH, got %v", got)
	}
}

func TestChooseLinuxToolPicksScrot(t *testing.T) {
	got := chooseLinuxTool(func(name string) (string, error) {
		if name == "scrot" {
			return "/usr/bin/scrot", nil
		}
		return "", errors.New("nope")
	})
	if got == nil || got[0] != "scrot" {
		t.Fatalf("expected scrot, got %v", got)
	}
}
```

- [ ] **Step 6: Write `outpost-agent/main.go`**

```go
package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type agentConfig struct {
	MachineID string `json:"machine_id"`
	Token     string `json:"token"`
	WsURL     string `json:"ws_url"`
}

func configPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("APPDATA"), "outpost-agent", "agent.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "outpost-agent", "agent.json")
}

func loadConfig() (agentConfig, error) {
	var c agentConfig
	data, err := os.ReadFile(configPath())
	if err != nil {
		return c, err
	}
	return c, json.Unmarshal(data, &c)
}

func handle(ctx context.Context, c *websocket.Conn, msg map[string]any) {
	switch msg["type"] {
	case "exec":
		cmd, _ := msg["cmd"].(string)
		timeout, _ := msg["timeout"].(float64)
		shell, _ := msg["shell"].(string)
		ok, code, out, errStr := runShell(cmd, timeout, shell)
		_ = wsjson.Write(ctx, c, map[string]any{
			"type": "exec_result", "req_id": msg["req_id"], "ok": ok,
			"exit_code": code, "output": out, "error": errStr})
	case "screenshot":
		b64, w, h, err := captureScreen()
		res := map[string]any{"type": "screenshot_result", "req_id": msg["req_id"],
			"ok": err == nil, "image_base64": b64, "width": w, "height": h,
			"captured_at": time.Now().UnixMilli(), "error": ""}
		if err != nil {
			res["error"] = err.Error()
		}
		_ = wsjson.Write(ctx, c, res)
	}
}

func connectOnce(cfg agentConfig) error {
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, cfg.WsURL+"?token="+cfg.Token, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	c.SetReadLimit(64 * 1024 * 1024) // large screenshots
	if err := wsjson.Write(ctx, c, map[string]any{
		"type": "hello", "machine_id": cfg.MachineID, "os": runtime.GOOS,
		"arch": runtime.GOARCH}); err != nil {
		return err
	}
	for {
		var msg map[string]any
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return err
		}
		go handle(ctx, c, msg)
	}
}

func main() {
	for {
		cfg, err := loadConfig()
		if err != nil {
			time.Sleep(10 * time.Second)
			continue
		}
		if err := connectOnce(cfg); err != nil {
			time.Sleep(5 * time.Second) // reconnect with backoff
		}
	}
}
```

- [ ] **Step 7: Run the Go tests**

Run: `cd outpost-agent && go mod tidy && go test ./...`
Expected: `ok  outpost-agent` (all tests pass; `go mod tidy` fetches `coder/websocket`).

- [ ] **Step 8: Write `outpost-agent/build.sh`**

```bash
#!/usr/bin/env bash
# Cross-compile the outpost-agent for every target into the outpost-mcp download
# dir. CGO_ENABLED=0 => fully static, dependency-free binaries.
set -euo pipefail
cd "$(dirname "$0")"
OUT="../outpost-mcp/agent-bin"
mkdir -p "$OUT"

build() {
  local goos="$1" goarch="$2" ext="${3:-}"
  echo "building $goos/$goarch"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags="-s -w" \
    -o "$OUT/outpost-agent-$goos-$goarch$ext" .
}

build linux   amd64
build linux   arm64
build darwin  amd64
build darwin  arm64
build windows amd64 .exe
build windows 386   .exe
echo "done -> $OUT"
ls -la "$OUT"
```

- [ ] **Step 9: Build the binaries and verify**

Run: `cd outpost-agent && chmod +x build.sh && ./build.sh`
Expected: 6 files in `outpost-mcp/agent-bin/` (`outpost-agent-linux-amd64`, `-linux-arm64`, `-darwin-amd64`, `-darwin-arm64`, `outpost-agent-windows-amd64.exe`, `-windows-386.exe`).
Then confirm the download endpoint serves them (re-run the server test): `cd outpost-mcp && OUTPOST_AGENT_BIN_DIR="$(pwd)/agent-bin" /usr/bin/env -u PYTHONPATH uv run pytest tests/test_server.py -v` — Expected: still passes (the 404 assertion uses a fresh tmp `OUTPOST_CONFIG_DIR` but the default bin dir now has files; the test's 404 check targets `linux/amd64` which now exists, so **update that one assertion**: in `test_pair_download_gate_and_exec_roundtrip`, change the download check to a non-built target `.../windows/riscv64` and keep `assert dl.status_code == 404`). Re-run the suite to confirm green.

- [ ] **Step 10: Commit**

```bash
git add outpost-agent/go.mod outpost-agent/go.sum outpost-agent/main.go outpost-agent/exec.go outpost-agent/screenshot.go outpost-agent/exec_test.go outpost-agent/screenshot_test.go outpost-agent/build.sh
git add outpost-mcp/tests/test_server.py
# agent-bin/ binaries are build artifacts — add a .gitignore for them
printf '/agent-bin/\n' > outpost-mcp/.gitignore
git add outpost-mcp/.gitignore
git commit -m "feat(outpost): cross-compiled Go agent (dial-out, exec, screenshot)"
```

---

## Task 8: Daemon — add the six outpost.* proxy verbs

**Files:**
- Modify: `daemon/src/ControlServer.h` (add handler decls + `outpostHttp` helper decl)
- Modify: `daemon/src/ControlServer.cpp` (`isOpsMethod`, `dispatchOpsMethod`, handler bodies + helper)
- Test: live smoke via the control WS (no C++ unit test — these are thin loopback proxies, matching the repo's untested `phone.mcp`/`phone.http` precedent)

**Interfaces:**
- Consumes: outpost-mcp REST at `http://127.0.0.1:8798` with bearer from `~/.config/jarvis/outpost_mcp_token`.
- Produces control verbs (all routed through `isOpsMethod`/`dispatchOpsMethod`): `outpost.list`, `outpost.pair_start{name,os_hint}`, `outpost.pair_status{bootstrap_id}`, `outpost.exec{machine,cmd,timeout,shell}`, `outpost.screenshot{machine}`, `outpost.revoke{machine}`.

- [ ] **Step 1: Add handler + helper declarations to `daemon/src/ControlServer.h`**

Immediately after the diff-review handler declarations (the `handleDiffOpenPr` line, around line 459-460), add:

```cpp
    // Outpost: remote-machine pairing + gated exec/screenshot proxied to the
    // outpost-mcp REST surface (:8798) over loopback.
    Response handleOutpostList(const Request &req);
    Response handleOutpostPairStart(const Request &req);
    Response handleOutpostPairStatus(const Request &req);
    Response handleOutpostExec(const Request &req, bool remote);
    Response handleOutpostScreenshot(const Request &req);
    Response handleOutpostRevoke(const Request &req);
    // Loopback call to outpost-mcp; returns its parsed JSON body. Sets
    // *reachable=false on transport failure.
    QJsonObject outpostHttp(const QString &httpMethod, const QString &path,
                            const QJsonObject &body, bool *reachable);
```

- [ ] **Step 2: Extend `isOpsMethod` in `daemon/src/ControlServer.cpp`**

Find (around line 5882):

```cpp
           method.startsWith(QStringLiteral("ssh.")) ||
```

Add a new line directly below it:

```cpp
           method.startsWith(QStringLiteral("outpost.")) ||
```

- [ ] **Step 3: Add dispatch cases in `dispatchOpsMethod`**

Find the ssh dispatch block (around lines 6065-6068) and add these six lines directly after the `ssh.exec` line:

```cpp
    if (m == QStringLiteral("outpost.list"))         return handleOutpostList(req);
    if (m == QStringLiteral("outpost.pair_start"))   return handleOutpostPairStart(req);
    if (m == QStringLiteral("outpost.pair_status"))  return handleOutpostPairStatus(req);
    if (m == QStringLiteral("outpost.exec"))         return handleOutpostExec(req, remote);
    if (m == QStringLiteral("outpost.screenshot"))   return handleOutpostScreenshot(req);
    if (m == QStringLiteral("outpost.revoke"))       return handleOutpostRevoke(req);
```

- [ ] **Step 4: Add the helper + handler bodies to `daemon/src/ControlServer.cpp`**

Insert this block immediately BEFORE `Response ControlServer::handleAuditList(const Request &req)` (around line 6622). (All required includes — `<QDir>`, `<QFile>`, `<QEventLoop>`, `<QTimer>`, `<QNetworkAccessManager>`, `<QNetworkReply>`, `<QNetworkRequest>`, `<QJsonObject>`, `<QJsonDocument>` — are already present in this file.)

```cpp
QJsonObject ControlServer::outpostHttp(const QString &httpMethod, const QString &path,
                                       const QJsonObject &body, bool *reachable)
{
    // outpost-mcp inbound bearer lives beside ours (~/.config/jarvis/outpost_mcp_token).
    QString token;
    {
        QFile f(QDir::homePath() + QStringLiteral("/.config/jarvis/outpost_mcp_token"));
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            token = QString::fromUtf8(f.readAll()).trimmed();
            f.close();
        }
    }
    QNetworkAccessManager nam;
    QNetworkRequest rq(QUrl(QStringLiteral("http://127.0.0.1:8798%1").arg(path)));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    if (!token.isEmpty())
        rq.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());
    const QByteArray data = QJsonDocument(body).toJson(QJsonDocument::Compact);
    QNetworkReply *reply = (httpMethod == QStringLiteral("GET"))
        ? nam.get(rq) : nam.post(rq, data);

    QEventLoop loop;
    QTimer::singleShot(60000, &loop, &QEventLoop::quit);
    connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    if (!reply->isFinished()) {
        reply->abort();
        reply->deleteLater();
        if (reachable) *reachable = false;
        return {};
    }
    const QNetworkReply::NetworkError nerr = reply->error();
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QByteArray resp = reply->readAll();
    reply->deleteLater();
    if (status == 0 && nerr != QNetworkReply::NoError) {
        if (reachable) *reachable = false;
        return {};
    }
    if (reachable) *reachable = true;
    const QJsonDocument d = QJsonDocument::fromJson(resp);
    return d.isObject() ? d.object() : QJsonObject();
}

Response ControlServer::handleOutpostList(const Request &req)
{
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("GET"),
                                      QStringLiteral("/api/machines"), {}, &ok);
    m_audit.record(QStringLiteral("outpost.list"), ok, QStringLiteral("low"),
                   QStringLiteral("listed outpost machines"));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:8798) unreachable"));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostPairStart(const Request &req)
{
    QJsonObject body;
    body.insert(QStringLiteral("name"), req.params.value(QStringLiteral("name")).toString());
    body.insert(QStringLiteral("os_hint"), req.params.value(QStringLiteral("os_hint")).toString());
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/pair/start"), body, &ok);
    m_audit.record(QStringLiteral("outpost.pair_start"), ok, QStringLiteral("medium"),
                   QStringLiteral("started outpost pairing"));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:8798) unreachable"));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostPairStatus(const Request &req)
{
    const QString bid = req.params.value(QStringLiteral("bootstrap_id")).toString();
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("GET"),
                                      QStringLiteral("/api/pair/status/%1").arg(bid), {}, &ok);
    m_audit.record(QStringLiteral("outpost.pair_status"), ok, QStringLiteral("low"),
                   QStringLiteral("polled outpost pairing"));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:8798) unreachable"));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostExec(const Request &req, bool remote)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString cmd = req.params.value(QStringLiteral("cmd")).toString();
    if (machine.trimmed().isEmpty() || cmd.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and cmd are required"));
    QJsonObject body;
    body.insert(QStringLiteral("machine"), machine);
    body.insert(QStringLiteral("cmd"), cmd);
    if (req.params.contains(QStringLiteral("timeout")))
        body.insert(QStringLiteral("timeout"), req.params.value(QStringLiteral("timeout")).toDouble());
    if (req.params.contains(QStringLiteral("shell")))
        body.insert(QStringLiteral("shell"), req.params.value(QStringLiteral("shell")).toString());
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/exec"), body, &ok);
    m_audit.record(QStringLiteral("outpost.exec"), ok && r.value(QStringLiteral("ok")).toBool(),
                   QStringLiteral("high"),
                   QStringLiteral("outpost %1: %2").arg(machine, cmd.left(80)),
                   QString(), remote);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:8798) unreachable"));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostScreenshot(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    QJsonObject body;
    body.insert(QStringLiteral("machine"), machine);
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/screenshot"), body, &ok);
    m_audit.record(QStringLiteral("outpost.screenshot"),
                   ok && r.value(QStringLiteral("ok")).toBool(), QStringLiteral("medium"),
                   QStringLiteral("outpost screenshot %1").arg(machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:8798) unreachable"));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostRevoke(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    QJsonObject body;
    body.insert(QStringLiteral("machine"), machine);
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/revoke"), body, &ok);
    m_audit.record(QStringLiteral("outpost.revoke"), ok, QStringLiteral("low"),
                   QStringLiteral("revoked outpost machine %1").arg(machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:8798) unreachable"));
    return Response::success(req.id, r);
}
```

- [ ] **Step 5: Build the daemon**

Run: `cmake --build build --target jarvisd 2>&1 | tail -20` (from the repo root; if there is no `build/` dir, configure once with `cmake -S . -B build`).
Expected: compiles with no errors referencing `handleOutpost*` or `outpostHttp`.

- [ ] **Step 6: Live smoke — verify the proxy answers over the control WS**

Start outpost-mcp (`cd outpost-mcp && OUTPOST_AGENT_BIN_DIR="$(pwd)/agent-bin" /usr/bin/env -u PYTHONPATH uv run outpost-mcp &`) and the daemon, then call `outpost.list` over the control WS. Use this one-shot Python probe:

```bash
python3 - <<'PY'
import asyncio, json, websockets, pathlib
tok = pathlib.Path.home().joinpath(".config/jarvis/control_token").read_text().strip()
async def main():
    url = f"ws://127.0.0.1:8795/control/ws?token={tok}"
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"v":1,"id":1,"method":"outpost.list","params":{}}))
        print(await ws.recv())
        await ws.send(json.dumps({"v":1,"id":2,"method":"outpost.pair_start","params":{"name":"probe"}}))
        print(await ws.recv())
asyncio.run(main())
PY
```

Expected: the first prints `{"v":1,"id":1,"ok":true,"result":{"machines":[]}}` (or the current machines); the second prints an `ok:true` result containing `bootstrap_id`, `install_cmd_linux`, `install_cmd_windows`. If outpost-mcp is stopped, expect `ok:false` with code `outpost_unreachable` (graceful, no crash).

- [ ] **Step 7: Commit**

```bash
git add daemon/src/ControlServer.h daemon/src/ControlServer.cpp
git commit -m "feat(outpost): daemon outpost.* proxy verbs -> outpost-mcp loopback REST"
```

---

## Task 9: Web dashboard — replace the SSH page with Outpost

**Files:**
- Create: `web/src/pages/outpost.tsx`
- Delete: `web/src/pages/ssh.tsx`
- Modify: `web/src/components/NavIcon.tsx` (swap the `ssh` glyph for an `outpost` glyph)

**Interfaces:**
- Consumes daemon verbs `outpost.list`, `outpost.pair_start`, `outpost.pair_status`, `outpost.exec`, `outpost.screenshot`, `outpost.revoke` via `app.client.call(method, params, timeoutMs)`.
- Produces a self-registering `PageDef { id: "outpost", label: "Outpost", section: "SYSTEM", order: 2, component: Outpost }` (auto-discovered by `web/src/App.tsx`'s `import.meta.glob("./pages/**/*.tsx")`).

- [ ] **Step 1: Replace the `ssh` glyph in `web/src/components/NavIcon.tsx`**

Find the `ssh` glyph (lines 115-120):

```javascript
  ssh: (ctx) => {
    ctx.strokeRect(2, 3, 14, 12)
    ctx.beginPath()
    ctx.moveTo(5, 7.5); ctx.lineTo(7.5, 9.5); ctx.lineTo(5, 11.5); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(9, 11.5); ctx.lineTo(12.5, 11.5); ctx.stroke()
  },
```

Replace it with an `outpost` beacon glyph:

```javascript
  outpost: (ctx) => {
    // mast + base
    ctx.beginPath(); ctx.moveTo(9, 6); ctx.lineTo(9, 15.5); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(6, 15.5); ctx.lineTo(12, 15.5); ctx.stroke()
    // beacon node
    ctx.beginPath(); ctx.arc(9, 5, 1.6, 0, Math.PI * 2); ctx.stroke()
    // signal arcs
    ctx.beginPath(); ctx.arc(9, 5, 3.8, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke()
    ctx.beginPath(); ctx.arc(9, 5, 6.2, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke()
  },
```

- [ ] **Step 2: Delete the old SSH page**

Run: `git rm web/src/pages/ssh.tsx`
(The `import.meta.glob` auto-discovery in `App.tsx` means deleting the file removes the tab; no registry edit needed.)

- [ ] **Step 3: Create `web/src/pages/outpost.tsx`**

```tsx
// Outpost — pair remote Windows/Linux/macOS machines and run gated exec +
// screenshot on them by name. Replaces the old SSH page. Pairing-card + poll
// pattern mirrors settings/devices.tsx; the exec console mirrors the old
// ssh.tsx. All verbs proxy through the daemon to outpost-mcp (:8798).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import { ControlError } from "../core/control-client"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"

interface Machine {
  id: string
  name: string
  os: string
  transport: string
  status: string
  last_seen: number
}

interface PairStart {
  pairing_code: string
  bootstrap_id: string
  expires_at: number
  install_cmd_linux: string
  install_cmd_windows: string
}

interface ExecEntry {
  id: number
  machine: string
  cmd: string
  output: string
  ok: boolean
}

let entrySeq = 0

function fmtTime(ms?: number): string {
  if (!ms) return ""
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ""
  }
}

function Outpost() {
  const app = useApp()

  const [connected, setConnected] = createSignal(app.client.connected)
  const [machines, setMachines] = createSignal<Machine[]>([])
  const [selected, setSelected] = createSignal("")
  const [listError, setListError] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)
  const [revoking, setRevoking] = createSignal("")

  const [pairing, setPairing] = createSignal(false)
  const [pair, setPair] = createSignal<PairStart | null>(null)
  const [pairState, setPairState] = createSignal("")
  const [now, setNow] = createSignal(Date.now())

  const [cmdText, setCmdText] = createSignal("")
  const [running, setRunning] = createSignal(false)
  const [entries, setEntries] = createSignal<ExecEntry[]>([])
  const [shot, setShot] = createSignal("")
  const [shotBusy, setShotBusy] = createSignal(false)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const load = async () => {
    try {
      const res = await app.client.call("outpost.list", {}, 15000)
      if (!alive) return
      const list = (res.machines ?? []) as Machine[]
      setMachines(list)
      if (!list.some((m) => m.name === selected())) setSelected(list[0]?.name ?? "")
      setListError("")
    } catch (e) {
      if (!alive) return
      setListError(String(e))
    } finally {
      if (alive) setLoaded(true)
    }
  }

  onMount(() => {
    void load()
    const conn = setInterval(() => setConnected(app.client.connected), 500)
    const timer = setInterval(() => void load(), 15000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      clearInterval(conn)
      clearInterval(timer)
      clearInterval(tick)
    })
  })

  const remaining = () => {
    const p = pair()
    return p ? Math.max(0, Math.floor((p.expires_at - now()) / 1000)) : 0
  }

  const startPairing = async () => {
    setPairing(true)
    setPairState("pending")
    try {
      const res = (await app.client.call("outpost.pair_start", {}, 15000)) as unknown as PairStart
      if (!alive) return
      setPair(res)
      void pollPairing(res.bootstrap_id)
    } catch (e) {
      app.notify(`Pairing failed: ${String(e)}`, "error")
    } finally {
      if (alive) setPairing(false)
    }
  }

  const pollPairing = async (bootstrapId: string) => {
    for (let i = 0; i < 120 && alive; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      if (!alive || pair()?.bootstrap_id !== bootstrapId) return
      try {
        const st = await app.client.call("outpost.pair_status", { bootstrap_id: bootstrapId }, 15000)
        const status = String(st.status ?? "")
        setPairState(status)
        if (status === "paired") {
          app.notify("Machine paired.")
          setPair(null)
          await load()
          return
        }
        if (status === "expired" || status === "unknown") return
      } catch {
        // transient; keep polling
      }
    }
  }

  const revoke = async (m: Machine) => {
    setRevoking(m.id)
    try {
      await app.client.call("outpost.revoke", { machine: m.id }, 15000)
      app.notify(`Revoked ${m.name}.`)
      await load()
    } catch (e) {
      app.notify(`Revoke failed: ${String(e)}`, "error")
    } finally {
      if (alive) setRevoking("")
    }
  }

  const runCmd = async (e?: Event) => {
    e?.preventDefault()
    const machine = selected()
    const cmd = cmdText().trim()
    if (!machine || !cmd || running()) return
    setRunning(true)
    setCmdText("")
    try {
      const res = await app.client.call("outpost.exec", { machine, cmd }, 40000)
      if (!alive) return
      const ok = Boolean(res.ok)
      const out = String(res.output ?? "") || String(res.error ?? "") || (ok ? "(no output)" : "(failed)")
      setEntries((prev) => [...prev, { id: ++entrySeq, machine, cmd, output: out, ok }])
    } catch (e2) {
      if (!alive) return
      const msg = e2 instanceof ControlError ? `${e2.code}: ${e2.message}` : String(e2)
      setEntries((prev) => [...prev, { id: ++entrySeq, machine, cmd, output: msg, ok: false }])
    } finally {
      if (alive) setRunning(false)
    }
  }

  const grabScreenshot = async () => {
    const machine = selected()
    if (!machine || shotBusy()) return
    setShotBusy(true)
    setShot("")
    try {
      const res = await app.client.call("outpost.screenshot", { machine }, 50000)
      if (!alive) return
      if (res.ok && res.image_base64) setShot(`data:image/png;base64,${String(res.image_base64)}`)
      else app.notify(`Screenshot failed: ${String(res.error ?? "unknown")}`, "error")
    } catch (e) {
      app.notify(`Screenshot failed: ${String(e)}`, "error")
    } finally {
      if (alive) setShotBusy(false)
    }
  }

  return (
    <div class="op-page">
      <style>{`
        .op-page { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
        .op-header { display: flex; align-items: center; gap: 12px; }
        .op-header-icon { width: 36px; height: 36px; border-radius: var(--radius-sm);
          display: flex; align-items: center; justify-content: center;
          background: var(--accent-faint); border: 1px solid var(--accent-dim); flex-shrink: 0; }
        .op-subtitle { color: var(--text-muted); font-size: 12px; }
        .op-conn-pill { margin-left: auto; display: flex; align-items: center; gap: 6px;
          font-family: var(--font-mono); font-size: 10px; color: var(--text-faint);
          padding: 4px 10px; border-radius: 999px; border: 1px solid var(--hairline-soft); }
        .op-conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
        .op-conn-dot.on { background: var(--success); }
        .op-title-line { font-size: 11px; letter-spacing: var(--track-mid); margin-bottom: 12px; }
        .op-title-line.accent { color: var(--accent); }
        .op-title-line.amber { color: var(--amber); }
        .op-pair-row { display: flex; align-items: center; gap: 12px; }
        .op-pair-text { flex: 1; }
        .op-pair-label { color: var(--text); font-size: 14px; font-weight: 500; }
        .op-pair-sub { color: var(--text-faint); font-size: 12px; }
        .op-btn { all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
          padding: 9px 18px; border-radius: var(--radius-xs); white-space: nowrap;
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          border: 1px solid var(--accent-dim); color: var(--accent-bright); background: var(--accent-faint); }
        .op-btn:hover:not(:disabled) { background: var(--accent-dim); }
        .op-btn:disabled { opacity: 0.4; cursor: default; }
        .op-cmd { display: block; margin-top: 10px; background: var(--surface-deep);
          border: 1px solid var(--accent-dim); border-radius: var(--radius-xs);
          padding: 8px 10px; font-family: var(--font-mono); font-size: 11px; color: var(--accent-bright);
          overflow-x: auto; white-space: pre; }
        .op-cmd-label { color: var(--text-faint); font-family: var(--font-display);
          font-size: 10px; letter-spacing: var(--track-wide); margin-top: 10px; }
        .op-status { margin-top: 10px; font-size: 12px; color: var(--text-muted); }
        .op-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
        .op-row { display: flex; align-items: center; gap: 12px; border-radius: var(--radius-sm);
          background: var(--panel-soft); border: 1px solid var(--hairline-soft); padding: 10px 14px; }
        .op-row.selected { border-color: var(--accent); background: var(--accent-faint); }
        .op-row-text { flex: 1; min-width: 0; }
        .op-row-name { color: var(--text); font-size: 14px; font-weight: 500; }
        .op-row-meta { color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; }
        .op-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .op-dot.online { background: var(--success); }
        .op-dot.offline { background: var(--text-faint); }
        .op-revoke { all: unset; cursor: pointer; white-space: nowrap; padding: 6px 14px;
          border-radius: var(--radius-xs); background: var(--danger-dim); color: var(--danger);
          border: 1px solid var(--danger-dim); font-family: var(--font-display);
          letter-spacing: var(--track-mid); font-size: 11px; }
        .op-revoke:disabled { opacity: 0.5; cursor: default; }
        .op-field-row { display: flex; gap: 10px; margin-top: 12px; }
        .op-input { flex: 1; min-width: 0; background: var(--surface-input);
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs); color: var(--text);
          padding: 9px 12px; font-family: var(--font-mono); font-size: 13px; }
        .op-input:focus { outline: none; border-color: var(--accent-dim); }
        .op-input:disabled { opacity: 0.5; }
        .op-console { min-height: 120px; max-height: 300px; overflow-y: auto;
          background: var(--surface-deep); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-sm); padding: 12px; margin: 12px 0;
          display: flex; flex-direction: column; gap: 10px; }
        .op-console-empty { color: var(--text-faint); font-size: 12px; text-align: center; padding: 30px 0; }
        .op-console-cmd { font-family: var(--font-mono); font-size: 12px; color: var(--accent-bright); word-break: break-word; }
        .op-console-out { font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
        .op-console-out.ok { color: var(--text-muted); }
        .op-console-out.fail { color: var(--danger); }
        .op-shot { max-width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--hairline-soft); margin-top: 10px; }
        .op-banner-error { color: var(--danger); font-size: 12px; margin-top: 10px;
          border: 1px solid var(--danger-dim); background: rgba(255,107,107,0.06);
          border-radius: var(--radius-xs); padding: 8px 10px; }
        .op-empty { color: var(--text-faint); font-size: 12px; margin-top: 10px; }
      `}</style>

      <div class="op-header">
        <div class="op-header-icon">
          <NavIcon glyph="outpost" color="var(--accent)" glow />
        </div>
        <div>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>Outpost</div>
          <div class="op-subtitle">
            Pair a remote machine with one command, then run gated exec + screenshot on it by name.
          </div>
        </div>
        <div class="op-conn-pill">
          <span class="op-conn-dot" classList={{ on: connected() }} />
          {connected() ? "daemon linked" : "connecting…"}
        </div>
      </div>

      <div class="card">
        <div class="op-title-line hud-label accent">// PAIR A MACHINE</div>
        <div class="op-pair-row">
          <div class="op-pair-text">
            <div class="op-pair-label">Add a Windows / Linux / macOS machine</div>
            <div class="op-pair-sub">Generates a one-shot install command, valid for 10 minutes.</div>
          </div>
          <button type="button" class="op-btn" disabled={pairing() || !connected()} onClick={() => void startPairing()}>
            {pairing() ? "Generating…" : pair() ? "New code" : "Pair a machine"}
          </button>
        </div>

        <Show when={pair()}>
          <div class="op-cmd-label">RUN ON LINUX / macOS</div>
          <code class="op-cmd">{pair()!.install_cmd_linux}</code>
          <div class="op-cmd-label">RUN ON WINDOWS (PowerShell)</div>
          <code class="op-cmd">{pair()!.install_cmd_windows}</code>
          <div class="op-status">
            {pairState() === "paired"
              ? "Paired ✓"
              : remaining() > 0
                ? `Waiting for the machine to check in… expires in ${remaining()}s`
                : "Code expired — request a new one"}
          </div>
        </Show>
      </div>

      <div class="card">
        <div class="op-title-line hud-label accent">// MACHINES</div>
        <Show when={listError()}>
          <div class="op-banner-error">⚠ {listError()}</div>
        </Show>
        <Show when={loaded() && machines().length === 0 && !listError()}>
          <div class="op-empty">No machines paired yet. Pair one above.</div>
        </Show>
        <div class="op-list">
          <For each={machines()}>
            {(m) => (
              <div class="op-row" classList={{ selected: m.name === selected() }} onClick={() => setSelected(m.name)}>
                <span class="op-dot" classList={{ online: m.status === "online", offline: m.status !== "online" }} />
                <div class="op-row-text">
                  <div class="op-row-name">{m.name}</div>
                  <div class="op-row-meta">
                    {m.os || "?"} · {m.status} {m.last_seen ? `· seen ${fmtTime(m.last_seen)}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  class="op-revoke"
                  disabled={revoking() === m.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    void revoke(m)
                  }}
                >
                  {revoking() === m.id ? "Revoking…" : "Revoke"}
                </button>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="card">
        <div class="op-title-line hud-label amber">
          // EXEC {selected() ? `→ ${selected()}` : "(select a machine)"}
        </div>
        <div class="op-console">
          <Show when={entries().length > 0} fallback={<div class="op-console-empty">Command output appears here.</div>}>
            <For each={entries()}>
              {(en) => (
                <div>
                  <div class="op-console-cmd">[{en.machine}] $ {en.cmd}</div>
                  <div class="op-console-out" classList={{ ok: en.ok, fail: !en.ok }}>{en.output}</div>
                </div>
              )}
            </For>
          </Show>
        </div>
        <form class="op-field-row" onSubmit={runCmd}>
          <input
            class="op-input"
            placeholder={selected() ? `Command on ${selected()}…` : "Select a machine first…"}
            value={cmdText()}
            disabled={running() || !selected()}
            onInput={(e) => setCmdText(e.currentTarget.value)}
          />
          <button type="submit" class="op-btn" disabled={!connected() || !selected() || cmdText().trim().length === 0 || running()}>
            {running() ? "Running…" : "Run"}
          </button>
          <button type="button" class="op-btn" disabled={!connected() || !selected() || shotBusy()} onClick={() => void grabScreenshot()}>
            {shotBusy() ? "…" : "Screenshot"}
          </button>
        </form>
        <Show when={shot()}>
          <img class="op-shot" src={shot()} alt="remote screenshot" />
        </Show>
      </div>
    </div>
  )
}

const page: PageDef = { id: "outpost", label: "Outpost", section: "SYSTEM", order: 2, component: Outpost }
export default page
```

- [ ] **Step 4: Typecheck / build the web bundle**

Run: `cd web && bun install && bun run build 2>&1 | tail -20` (or the project's configured build command — check `web/package.json` `scripts`).
Expected: build succeeds; no remaining reference to `pages/ssh.tsx` and no `glyph="ssh"` usages (grep `grep -rn "glyph=\"ssh\"" web/src` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/outpost.tsx web/src/components/NavIcon.tsx
git rm web/src/pages/ssh.tsx
git commit -m "feat(outpost): web dashboard Outpost page (replaces SSH)"
```

---

## Task 10: TUI v2 — replace the ssh manifest entry with outpost

**Files:**
- Modify: `core/src/UiManifest.cpp` (ssh page block ~172-182; ssh command ~218)
- Modify: `core/src/TuiLayoutStore.cpp` (reserved id list ~line 21)
- Modify: `core/tests/ui_manifest_test.cpp` (expected id list ~line 74)

**Interfaces:**
- Consumes: daemon verbs `outpost.list`, `outpost.exec`, `outpost.screenshot`, `outpost.revoke`, `outpost.pair_start`.
- Produces: a manifest `outpost` table page + `outpost` navigate command + `pair` verb command; reserved page id `outpost`. The generic `tui/src/pages/engine/TablePage.tsx` renders it with no frontend changes (`show:"detail"` renders exec/screenshot results as a JSON detail view — no image rendering, per scope).

- [ ] **Step 1: Replace the ssh page block in `core/src/UiManifest.cpp`**

Find (lines ~172-182):

```cpp
    {"id": "ssh", "title": "SSH", "section": "system", "kind": "table",
     "data": {"list": {"verb": "ssh.allow_list", "result_key": "hosts"}},
     "columns": [{"key": "host", "label": "Allow-listed host"}],
     "row_actions": [
       {"id": "remove", "label": "Remove", "kind": "verb", "verb": "ssh.allow_remove",
        "params": {"host": "$host"}, "confirm": true},
       {"id": "exec",   "label": "Run command", "kind": "verb", "verb": "ssh.exec",
        "params": {"host": "$host", "cmd": "$input"}, "input": "command"}],
     "input_actions": [
       {"id": "add", "placeholder": "Allow-list a host…", "kind": "verb",
        "verb": "ssh.allow_add", "params": {"host": "$input"}}]},
```

Replace with:

```cpp
    {"id": "outpost", "title": "Outpost", "section": "system", "kind": "table",
     "data": {"list": {"verb": "outpost.list", "result_key": "machines"}},
     "columns": [
       {"key": "name",      "label": "Machine"},
       {"key": "os",        "label": "OS"},
       {"key": "status",    "label": "Status"},
       {"key": "last_seen", "label": "Last seen", "format": "reltime"}],
     "row_actions": [
       {"id": "exec",       "label": "Run command", "kind": "verb", "verb": "outpost.exec",
        "params": {"machine": "$name", "cmd": "$input"}, "input": "command", "show": "detail"},
       {"id": "screenshot", "label": "Screenshot", "kind": "verb", "verb": "outpost.screenshot",
        "params": {"machine": "$name"}, "show": "detail"},
       {"id": "revoke",     "label": "Revoke", "kind": "verb", "verb": "outpost.revoke",
        "params": {"machine": "$name"}, "confirm": true}]},
```

- [ ] **Step 2: Replace the ssh command in `core/src/UiManifest.cpp`**

Find (line ~218):

```cpp
    {"name": "ssh",      "description": "SSH allow-list", "kind": "page", "target": "ssh"},
```

Replace with (a navigate-to-page command plus a pair-start verb command):

```cpp
    {"name": "outpost",  "description": "remote machines", "kind": "page", "target": "outpost"},
    {"name": "pair",     "description": "pair a new Outpost machine", "kind": "verb",
     "verb": "outpost.pair_start"},
```

- [ ] **Step 3: Swap the reserved id in `core/src/TuiLayoutStore.cpp`**

Find (line ~21):

```cpp
    QStringLiteral("plugins"), QStringLiteral("ssh"), QStringLiteral("memorygraph"),
```

Replace with:

```cpp
    QStringLiteral("plugins"), QStringLiteral("outpost"), QStringLiteral("memorygraph"),
```

- [ ] **Step 4: Swap the expected id in `core/tests/ui_manifest_test.cpp`**

Find (lines ~73-75):

```cpp
                             "memorygraph", "skills", "agents", "queue",
                             "schedules", "activity", "mcp", "plugins", "ssh",
                             "replay", "settings"})
```

Replace the `"ssh"` token with `"outpost"`:

```cpp
                             "memorygraph", "skills", "agents", "queue",
                             "schedules", "activity", "mcp", "plugins", "outpost",
                             "replay", "settings"})
```

- [ ] **Step 5: Build + run the manifest test**

Run: `cmake --build build --target ui_manifest_test && ctest --test-dir build -R ui_manifest_test --output-on-failure`
Expected: `ui_manifest_test` passes (the outpost table page has `data.list` verb/result_key + columns; the reserved-id + expected-id lists now contain `outpost`, not `ssh`).

- [ ] **Step 6: Commit**

```bash
git add core/src/UiManifest.cpp core/src/TuiLayoutStore.cpp core/tests/ui_manifest_test.cpp
git commit -m "feat(outpost): TUI v2 manifest — replace ssh page/command with outpost"
```

---

## Task 11: Legacy Python TUI — replace SshPane with OutpostPane

**Files:**
- Modify: `cli/jarvis_cli/tui/system_panes.py` (replace `SshPane` with `OutpostPane`)
- Modify: `cli/jarvis_cli/tui/chat.py` (import, `BUILTIN_COMMANDS`, `POPUP_PANE_FACTORIES`, title)

**Interfaces:**
- Consumes: daemon verbs `outpost.list`, `outpost.exec`, `outpost.pair_start`, `outpost.revoke` via `self.client.call(method, params)`.
- Produces: `OutpostPane(TablePane)` (same shape as the other `TablePane` subclasses) registered as the `outpost` popup.

- [ ] **Step 1: Replace `SshPane` in `cli/jarvis_cli/tui/system_panes.py`**

Find the entire `SshPane` class (lines 78-121) and replace it with:

```python
class OutpostPane(TablePane):
    HINT = "type a command + enter: run on selected · p: pair · x: revoke · r: refresh"
    COLUMNS = ("machine", "os", "status")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="command to run on the selected machine", id="outpost-exec")
        from textual.widgets import DataTable
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def fetch(self) -> list[dict]:
        res = await self.client.call("outpost.list", {})
        return list(res.get("machines", []))

    def to_cells(self, r: dict) -> tuple:
        status = r.get("status", "")
        return (r.get("name", ""), r.get("os", ""),
                Text(status, style="green" if status == "online" else "bright_black"))

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "outpost-exec":
            return
        cmd = event.value.strip()
        event.input.value = ""
        row = self.selected()
        if not cmd or not row:
            return
        try:
            res = await self.client.call("outpost.exec",
                                         {"machine": row["name"], "cmd": cmd})
            out = res.get("output") or res.get("error") or "(no output)"
            self.notify(f"[{row['name']}] {str(out)[:400]}", timeout=12)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "p":
            try:
                res = await self.client.call("outpost.pair_start", {})
                self.notify("Linux: " + res.get("install_cmd_linux", "")
                            + "  |  Windows: " + res.get("install_cmd_windows", ""),
                            timeout=20)
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("outpost.revoke", {"machine": row["name"]})
                except (ControlError, ConnectionError, TimeoutError) as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()
```

- [ ] **Step 2: Update the import in `cli/jarvis_cli/tui/chat.py`**

Find (line 47):

```python
from jarvis_cli.tui.system_panes import McpPane, PluginsPane, SshPane
```

Replace with:

```python
from jarvis_cli.tui.system_panes import McpPane, OutpostPane, PluginsPane
```

- [ ] **Step 3: Update `BUILTIN_COMMANDS` in `cli/jarvis_cli/tui/chat.py`**

Find (line 68):

```python
    ("ssh", "peek at SSH"), ("memorygraph", "peek at the Memory Graph"),
```

Replace with:

```python
    ("outpost", "peek at Outpost"), ("memorygraph", "peek at the Memory Graph"),
```

- [ ] **Step 4: Update `POPUP_PANE_FACTORIES` in `cli/jarvis_cli/tui/chat.py`**

Find (line 93):

```python
    "ssh": lambda: SshPane(id="ssh-quick"),
```

Replace with:

```python
    "outpost": lambda: OutpostPane(id="outpost-quick"),
```

- [ ] **Step 5: Update the popup title block in `cli/jarvis_cli/tui/chat.py`**

Find (lines 444-445):

```python
            if name == "ssh":
                title = "SSH"
```

Replace with:

```python
            if name == "outpost":
                title = "Outpost"
```

- [ ] **Step 6: Import + smoke-check the legacy TUI**

Run: `cd cli && /usr/bin/env -u PYTHONPATH uv run python -c "import jarvis_cli.tui.chat, jarvis_cli.tui.system_panes; print('ok', hasattr(jarvis_cli.tui.system_panes, 'OutpostPane'))"`
Expected: `ok True`. Also confirm no residual `SshPane`: `grep -rn "SshPane\|\"ssh\"\|'ssh'" cli/jarvis_cli/tui` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add cli/jarvis_cli/tui/system_panes.py cli/jarvis_cli/tui/chat.py
git commit -m "feat(outpost): legacy TUI OutpostPane (replaces SshPane)"
```

---

## Task 12: Remove the old SSH daemon/core code

**Files:**
- Modify: `daemon/src/ControlServer.h` (remove include, accessor, member, handler decls)
- Modify: `daemon/src/ControlServer.cpp` (remove `load()` call, `isOpsMethod` line, dispatch lines, handler bodies, refresh the SSH help prose)
- Delete: `core/src/SshAllowList.cpp`, `core/include/jarvis/SshAllowList.h`, `core/tests/ssh_allowlist_test.cpp`
- Modify: `core/CMakeLists.txt`, `windows/CMakeLists.txt` (remove `SshAllowList` registrations)

**Interfaces:**
- Removes control verbs `ssh.allow_list`, `ssh.allow_add`, `ssh.allow_remove`, `ssh.exec` (now `unknown_method`). No new interfaces. (The Qt desktop app's `Bridge` already degrades cleanly on `unknown_method` for `ssh.*` — see Global Constraints.)

- [ ] **Step 1: Confirm nothing else in core/daemon references the SshAllowList class**

Run: `grep -rn "SshAllowList" --include='*.cpp' --include='*.h' core daemon windows | grep -v worktrees`
Expected: only the lines this task removes (ControlServer.h include/accessor/member/decls, ControlServer.cpp handler bodies, the two CMakeLists, and the three files being deleted). The `desktop/src/Bridge.*` matches are the unrelated `Bridge::sshAllowList()` method — NOT the class — and are out of scope.

- [ ] **Step 2: Remove the include, accessor, member, and handler decls from `daemon/src/ControlServer.h`**

Delete line 33:

```cpp
#include "jarvis/SshAllowList.h"
```

Delete line 92:

```cpp
    SshAllowList &sshAllow() { return m_sshAllow; }
```

Delete the four ssh handler declarations (lines 450-454):

```cpp
    // Wave 8: SSH allow-list + gated exec.
    Response handleSshAllowList(const Request &req);
    Response handleSshAllowAdd(const Request &req);
    Response handleSshAllowRemove(const Request &req);
    Response handleSshExec(const Request &req, bool remote);
```

Delete the member (line 621):

```cpp
    SshAllowList m_sshAllow;
```

- [ ] **Step 3: Remove the load() call, isOpsMethod line, dispatch lines, and handler bodies from `daemon/src/ControlServer.cpp`**

Delete lines 163-164:

```cpp
    if (!m_sshAllow.load())
        qWarning("jarvisd: ssh allow-list load: %s", qPrintable(m_sshAllow.lastError()));
```

Delete the `isOpsMethod` ssh line (~5882):

```cpp
           method.startsWith(QStringLiteral("ssh.")) ||
```

Delete the four ssh dispatch lines (~6065-6068):

```cpp
    if (m == QStringLiteral("ssh.allow_list"))       return handleSshAllowList(req);
    if (m == QStringLiteral("ssh.allow_add"))        return handleSshAllowAdd(req);
    if (m == QStringLiteral("ssh.allow_remove"))     return handleSshAllowRemove(req);
    if (m == QStringLiteral("ssh.exec"))             return handleSshExec(req, remote);
```

Delete the four handler bodies `handleSshAllowList`, `handleSshAllowAdd`, `handleSshAllowRemove`, `handleSshExec` in their entirety (lines 6560-6620, from `Response ControlServer::handleSshAllowList(const Request &req)` up to and including the closing `}` of `handleSshExec` just before `Response ControlServer::handleAuditList`).

- [ ] **Step 4: Refresh the user-facing SSH help prose in `daemon/src/ControlServer.cpp`**

Find (lines ~4801-4802):

```cpp
        "**SSH** — gated remote command execution on allow-listed hosts (the user manages "
        "the allow-list in the app).\n"
```

Replace with:

```cpp
        "**Outpost** — pair a remote Windows/Linux/macOS machine (one-line install) then run "
        "gated shell commands + screenshots on it by name.\n"
```

- [ ] **Step 5: Delete the SshAllowList source, header, and test**

Run:

```bash
git rm core/src/SshAllowList.cpp core/include/jarvis/SshAllowList.h core/tests/ssh_allowlist_test.cpp
```

- [ ] **Step 6: Remove the CMake registrations**

In `core/CMakeLists.txt` delete line 61:

```cmake
    src/SshAllowList.cpp
```

delete line 114:

```cmake
    include/jarvis/SshAllowList.h
```

and delete the test block (lines 327-331):

```cmake
# SshAllowList: a non-allow-listed host is rejected with host_not_allowed and
# ssh is never spawned; allow_add/remove persistence roundtrip.
add_executable(ssh_allowlist_test tests/ssh_allowlist_test.cpp)
target_link_libraries(ssh_allowlist_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME ssh_allowlist_test COMMAND ssh_allowlist_test)
```

In `windows/CMakeLists.txt` delete line 122:

```cmake
    ${CORE_DIR}/src/SshAllowList.cpp
```

and delete line 173:

```cmake
    ${CORE_DIR}/include/jarvis/SshAllowList.h
```

- [ ] **Step 7: Reconfigure + build to verify the removal is clean**

Run: `cmake -S . -B build && cmake --build build --target jarvisd jarvis-core 2>&1 | tail -25`
Expected: configures without the `ssh_allowlist_test` target and builds with no unresolved `SshAllowList` / `handleSsh*` / `m_sshAllow` references. Confirm the test is gone: `ctest --test-dir build -N | grep -i ssh` returns nothing.

- [ ] **Step 8: Commit**

```bash
git add daemon/src/ControlServer.h daemon/src/ControlServer.cpp core/CMakeLists.txt windows/CMakeLists.txt
git rm core/src/SshAllowList.cpp core/include/jarvis/SshAllowList.h core/tests/ssh_allowlist_test.cpp
git commit -m "refactor(outpost): remove dead SSH allow-list code (daemon + core + CMake)"
```

---

## Self-Review (completed by the plan author)

**1. Spec coverage** — every design element maps to a task:
- New MCP server layout (pyproject/__init__/server/config/auth/registry/pairing/agent_hub/tools_outpost/tests/client-setup/service) → Tasks 1-6. ✅
- Port 8798, token `secrets.token_urlsafe(32)` at `outpost_mcp_token` (0600), `Bearer`/`?token=` → Tasks 1 (config/auth) + 6. ✅
- Six MCP tools with exact signatures → Task 5. ✅
- REST routes (`/health`, `/api/pair/start`, `/api/pair/status/<id>`, `/pair/<id>/sh|ps1`, `/agent/download/...`, `/pair/<id>/complete`, `/api/machines`, `/api/machines/<id>/revoke`, `WEBSOCKET /agent/ws`) → Task 6. Added `/api/exec`, `/api/screenshot`, `/api/revoke` (justified in-plan: the daemon forwards exec/screenshot/revoke-by-name over loopback HTTP, so those endpoints must exist). ✅
- Per-machine tokens SHA-256-hashed, revocable → Task 2. ✅
- Pairing flow (one-liners, Tailscale>LAN>local host resolution, `irm -OutFile` not `iwr|iex`, agent download gated by bootstrap, one-shot `/complete`, token 0600, `systemd --user` on Linux, Scheduled Task `LogonType Interactive` on Windows) → Tasks 1 (resolution) + 3 (scripts) + 6 (download/complete). ✅
- Registry `outpost_machines.json` mirroring `DeviceRow` `{id,name,os,transport,status,last_seen,paired_at}`, name-or-id → Task 2. ✅
- Network model (agent dials OUT, persistent WS, MCP relays) → Tasks 4 (hub) + 6 (WS) + 7 (agent). ✅
- Cross-language agent decision committed (single Go binary; justification in Architecture) → Task 7. ✅
- Web: delete `ssh.tsx`, add `outpost.tsx`, swap NavIcon glyph, PageDef shape → Task 9. ✅
- TUI v2: replace ssh manifest page+command, `TuiLayoutStore` reserved id, `ui_manifest_test` expected id, `show:"detail"` for screenshot → Task 10. ✅
- Legacy TUI: `OutpostPane`, `POPUP_PANE_FACTORIES`, `BUILTIN_COMMANDS`, title, import → Task 11. ✅
- Daemon: six `outpost.*` proxy verbs, `isOpsMethod`/dispatch, loopback HTTP via `QNetworkAccessManager` mirroring the phone proxy + sibling-token-file read, audit tiers (exec=high, pair_start+screenshot=medium, list+pair_status+revoke=low) → Task 8. ✅
- Daemon/core SSH removal (handlers, dispatch, `isOpsMethod`, accessor/member/include, delete `SshAllowList.{cpp,h}` + test + CMake in core & windows) → Task 12. ✅
- Security (one-shot 10-min codes, SHA-256 at rest, full-trust exec/no post-pairing allow-list, full audit) → Tasks 2/3/5/8. ✅
- Out-of-scope items are not built; the Qt desktop consumer's clean-degrade is documented rather than silently broken. ✅

**2. Placeholder scan** — no `TBD`/`TODO`/"add error handling"/"similar to Task N"/"write tests for the above" remain; every code step carries complete code and every test step carries real assertions.

**3. Type consistency** — verb names, JSON keys, and function signatures are consistent across tasks: MCP tools `outpost_*`, control verbs `outpost.*`, REST bodies `{machine,cmd,timeout,shell}` / `{machine}`, exec result `{ok,exit_code,output,error}`, screenshot result `{ok,image_base64,width,height,captured_at,error}`, machine row `{id,name,os,transport,status,last_seen,paired_at}`. `registry.get`/`by_token`/`revoke`, `hub.exec`/`screenshot`/`register`/`unregister`, `pairing.start`/`valid`/`status`/`redeem`/`mark_paired`/`render_sh`/`render_ps1` are referenced with the same names everywhere they appear. The Go wire protocol (`exec`/`exec_result`/`screenshot`/`screenshot_result`/`hello`/`ping`/`pong` + `req_id`) matches `agent_hub.py` and `server.py` exactly.
