"""Persistence + policy logic for the full-power Proxmox operator.

Three small JSON stores, all read/written by BOTH the operator MCP tools
(Jarvis) and the daemon's proxmoxop.* RPCs (the user, via the dashboard) —
one source of truth each:

  operator_policy.json  (CONFIG_DIR) — the user-editable permission policy that
                        gates every MUTATING operator tool. Read here for the
                        server-side deny backstop; the daemon's operatorGate is
                        the primary (interactive ask/allow/deny) enforcer and
                        reads the SAME file.
  operator_layout.json  (STATE_DIR)  — the Home widget grid (tiles the user
                        drags/resizes and Jarvis edits via proxmox_dashboard_*).
  operator_tasks.json   (STATE_DIR)  — the Tasks Kanban board.

The policy resolver is pure (no I/O when a policy dict is passed in) so it is
fully unit-testable, and it is mirrored by the daemon's C++ operatorGate — keep
the two in lock-step if you change rule-matching semantics.
"""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path

from proxmox_mcp import config

# Operator tools that only READ Proxmox/board state — never gated, never need
# an approval. Everything NOT in FREE_TOOLS (and proxmox_api with a mutating
# HTTP method) is treated as mutating and runs through the permission policy.
# The daemon's operatorGate keeps an identical list in C++ — edit both together.
READ_ONLY_TOOLS = frozenset({
    "proxmox_vm_list", "proxmox_vm_status", "proxmox_vm_config_get",
    "proxmox_snapshot_list", "proxmox_backup_list",
    "proxmox_storage_list", "proxmox_storage_content", "proxmox_iso_list",
    "proxmox_network_list", "proxmox_firewall_get",
    "proxmox_node_list", "proxmox_node_status", "proxmox_cluster_status",
    "proxmox_ct_list", "proxmox_ct_config_get",
    "proxmox_task_status", "proxmox_task_log", "proxmox_tasks_recent",
    "proxmox_dashboard_layout_get", "proxmox_tasks_list",
})

# Tools that WRITE only local dashboard state (the Home grid, the Tasks board) —
# not Proxmox. Jarvis curates these freely, so they bypass the permission gate
# like reads do. They never touch qm/pvesh.
BOARD_WRITE_TOOLS = frozenset({
    "proxmox_dashboard_layout_set", "proxmox_task_create", "proxmox_task_update",
})

# The full set of operator tools that never require approval.
FREE_TOOLS = READ_ONLY_TOOLS | BOARD_WRITE_TOOLS

_DEFAULT_POLICY = {"default_risky": "ask", "rules": [], "updated": 0}
_EFFECTS = ("allow", "ask", "deny")


# --- policy ------------------------------------------------------------------

def load_policy(path: Path | None = None) -> dict:
    """Read the policy (missing/corrupt file → the safe default: ask before
    every risky action, no standing rules)."""
    p = Path(path or config.OPERATOR_POLICY_FILE)
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return dict(_DEFAULT_POLICY)
    if not isinstance(data, dict):
        return dict(_DEFAULT_POLICY)
    data.setdefault("default_risky", "ask")
    data.setdefault("rules", [])
    return data


def save_policy(policy: dict, path: Path | None = None) -> dict:
    p = Path(path or config.OPERATOR_POLICY_FILE)
    out = {"default_risky": policy.get("default_risky", "ask"),
           "rules": list(policy.get("rules", [])),
           "updated": int(time.time())}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, indent=2))
    return out


def _rule_matches(match: dict, ctx: dict) -> bool:
    """Every key present in `match` must equal the corresponding context value.
    An empty match matches everything (a catch-all rule)."""
    for key, want in (match or {}).items():
        have = ctx.get(key)
        if key == "method":
            if str(have or "").upper() != str(want).upper():
                return False
        elif key == "vmid":
            try:
                if int(have) != int(want):
                    return False
            except (TypeError, ValueError):
                return False
        elif str(have if have is not None else "") != str(want):
            return False
    return True


def resolve_effect(tool: str, ctx: dict | None = None, policy: dict | None = None) -> str:
    """Effect for a MUTATING call: 'allow' | 'ask' | 'deny'.

    `ctx` may carry {verb, method, vmid} (tool is filled in from `tool`).
    First matching rule wins; otherwise `default_risky`. Read-only tools should
    never reach here — callers consult READ_ONLY_TOOLS first."""
    pol = policy if policy is not None else load_policy()
    full_ctx = dict(ctx or {})
    full_ctx.setdefault("tool", tool)
    for rule in pol.get("rules", []):
        effect = rule.get("effect")
        if effect in _EFFECTS and _rule_matches(rule.get("match") or {}, full_ctx):
            return effect
    default = pol.get("default_risky", "ask")
    return default if default in _EFFECTS else "ask"


def is_mutating_method(method: str) -> bool:
    """proxmox_api classification: only GET/HEAD/OPTIONS are read-only."""
    return str(method or "").upper() not in ("GET", "HEAD", "OPTIONS")


# --- Home widget grid --------------------------------------------------------

_DEFAULT_LAYOUT = {"tiles": [], "updated": 0}

# Canonical tile types the dashboard renders (web/src/pve/widgets/tiles.tsx's
# TILE_KINDS) and the synonym map for the descriptive names the operator model
# tends to invent (e.g. it asked for "vm_list"/"cluster_status"/"tasks_board").
# Kept in lock-step with tiles.tsx's TILE_KINDS / TILE_ALIASES so a board written
# from chat renders identically to one the user built by hand — change both.
TILE_TYPES = frozenset({
    "cpu_usage", "vm_status", "node_stats", "storage",
    "cluster_status", "recent_backups", "tasks_board", "note", "gauge",
    "node_load",
})
_TILE_ALIASES = {
    "vm_list": "vm_status", "vms": "vm_status", "guests": "vm_status",
    "guest_list": "vm_status",
    "storage_overview": "storage", "storage_usage": "storage", "storages": "storage",
    "node_resources": "node_stats", "node_status": "node_stats", "node": "node_stats",
    "cpu": "cpu_usage", "cpu_load": "cpu_usage",
    "cluster": "cluster_status", "quorum": "cluster_status",
    "backups": "recent_backups", "recent_backup": "recent_backups",
    "tasks": "tasks_board", "task_board": "tasks_board", "kanban": "tasks_board",
    "load": "node_load", "loadavg": "node_load", "system_load": "node_load",
    "sysload": "node_load",
}


def canonical_tile_type(t: object) -> str:
    s = str(t or "").strip()
    return _TILE_ALIASES.get(s, s)


def _grid_num(v: object, default: int) -> int:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _pick(primary: object, fallback: object) -> object:
    """Nullish-coalesce, matching the JS `??` in WidgetGrid.tsx's normalizeTile:
    a present-but-null grid field still falls back to the flat col/row/... value
    (dict.get(key, fallback) would instead return the null and diverge)."""
    return primary if primary is not None else fallback


def normalize_tiles(tiles: object) -> list:
    """Coerce a model-authored tile list into the exact {id,type,title?,node?,
    vmid?,grid:{x,y,w,h},content?} shape the dashboard renders. Resolves type
    aliases to canonical types AND accepts the flat col/row/width/height layout
    older builds emitted, then clamps into the 12-wide board. Mirrors
    web/src/pve/widgets/WidgetGrid.tsx's normalizeTile so a layout written from
    chat looks identical to one the user built by hand — an unknown/aliased type
    or a flat grid can no longer render as an 'unsupported tile'."""
    out: list = []
    if not isinstance(tiles, list):
        return out
    for i, raw in enumerate(tiles):
        if not isinstance(raw, dict):
            continue
        g = raw.get("grid") if isinstance(raw.get("grid"), dict) else {}
        w = max(1, min(12, _grid_num(_pick(g.get("w"), raw.get("width")), 3)))
        x = max(0, min(12 - w, _grid_num(_pick(g.get("x"), raw.get("col")), 0)))
        y = max(0, _grid_num(_pick(g.get("y"), raw.get("row")), i * 3))
        h = max(1, _grid_num(_pick(g.get("h"), raw.get("height")), 3))
        tile: dict = {
            "id": str(raw.get("id") or f"t{secrets.token_hex(4)}"),
            "type": canonical_tile_type(raw.get("type") or "note"),
            "grid": {"x": x, "y": y, "w": w, "h": h},
        }
        if isinstance(raw.get("title"), str):
            tile["title"] = raw["title"]
        if isinstance(raw.get("node"), str):
            tile["node"] = raw["node"]
        if isinstance(raw.get("vmid"), int) and not isinstance(raw.get("vmid"), bool):
            tile["vmid"] = raw["vmid"]
        if "content" in raw:
            tile["content"] = raw["content"]
        out.append(tile)
    return out


def load_layout(path: Path | None = None) -> dict:
    p = Path(path or config.OPERATOR_LAYOUT_FILE)
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return dict(_DEFAULT_LAYOUT)
    if not isinstance(data, dict):
        return dict(_DEFAULT_LAYOUT)
    data.setdefault("tiles", [])
    return data


def save_layout(layout: dict, path: Path | None = None) -> dict:
    p = Path(path or config.OPERATOR_LAYOUT_FILE)
    # Normalize on write so a model-authored board is stored in the exact shape
    # the dashboard renders (canonical types, real grid) — the user drags/resizes
    # this same file, and other open tabs refetch it, so it must never carry an
    # unsupported type or a flat/legacy grid.
    out = {"tiles": normalize_tiles(layout.get("tiles", [])), "updated": int(time.time())}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, indent=2))
    return out


# --- Tasks Kanban board ------------------------------------------------------

_TASK_STATES = ("todo", "doing", "done")


def load_tasks(path: Path | None = None) -> dict:
    p = Path(path or config.OPERATOR_TASKS_FILE)
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return {"tasks": []}
    if not isinstance(data, dict):
        return {"tasks": []}
    data.setdefault("tasks", [])
    return data


def _save_tasks(data: dict, path: Path | None = None) -> None:
    p = Path(path or config.OPERATOR_TASKS_FILE)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"tasks": list(data.get("tasks", []))}, indent=2))


def create_task(title: str, detail: str = "", status: str = "todo",
                path: Path | None = None) -> dict:
    data = load_tasks(path)
    now = int(time.time())
    task = {
        "id": "t" + secrets.token_hex(6),
        "title": title,
        "detail": detail,
        "status": status if status in _TASK_STATES else "todo",
        "created": now,
        "updated": now,
    }
    data["tasks"].append(task)
    _save_tasks(data, path)
    return task


def update_task(task_id: str, *, title: str | None = None, detail: str | None = None,
                status: str | None = None, path: Path | None = None) -> dict | None:
    data = load_tasks(path)
    for task in data["tasks"]:
        if task.get("id") == task_id:
            if title is not None:
                task["title"] = title
            if detail is not None:
                task["detail"] = detail
            if status in _TASK_STATES:
                task["status"] = status
            task["updated"] = int(time.time())
            _save_tasks(data, path)
            return task
    return None
