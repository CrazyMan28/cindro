"""pvesh read/write helpers for the full-power Proxmox operator.

Layered on the existing single-subprocess seam `proxmox_ops.run()` (tests
monkeypatch that ONE function, here as in tools_proxmox), these wrap the
Proxmox REST tree exposed by `pvesh`. Reads are unrestricted; writes pass
through `guarded_write()`, which consults the user permission policy and
refuses any standing `deny` rule as a server-side backstop — even though the
daemon's operatorGate is the primary, interactive enforcer (ask/allow/deny)
and would normally never call a tool the policy denies.
"""

from __future__ import annotations

import json
import re
import subprocess

from proxmox_mcp import config, operator_store, proxmox_ops

# HTTP method (as the Proxmox API / the generic proxmox_api tool speak it) →
# the pvesh subcommand that performs it.
PVESH_VERB = {"GET": "get", "POST": "create", "PUT": "set", "DELETE": "delete"}


def node() -> str:
    """The Proxmox node these operations target (config.toml `node`, default
    "pve"). Single-node hosts are the common case; multi-node paths can be
    reached explicitly through proxmox_api."""
    return config.settings()["node"]


def _parse(output: str):
    """pvesh --output-format json returns JSON; create/set/delete often return
    just a UPID string (still valid JSON when quoted) or nothing."""
    text = (output or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        return {"raw": text}


def run_pvesh(verb: str, path: str, params: dict | None = None,
              timeout: float = 25.0):
    """Execute one pvesh call and return its parsed result. `verb` is a pvesh
    subcommand (get/create/set/delete). The ONLY place operator writes/reads
    shell out — through proxmox_ops.run (the shared test seam)."""
    cmd = ["pvesh", verb, path]
    for key, value in (params or {}).items():
        if value is None:
            continue
        cmd += [f"-{key}", str(value)]
    cmd += ["--output-format", "json"]
    return _parse(proxmox_ops.run(cmd, timeout=timeout))


def read(path: str, params: dict | None = None) -> dict:
    """A GET against the Proxmox API tree. Returns {ok, result} / {ok:False,error}."""
    try:
        return {"ok": True, "result": run_pvesh("get", path, params)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "the read did not return in time; try again"}
    except proxmox_ops.CommandError as exc:
        # .redacted (not str(exc)) — don't leak the full argv (absolute host
        # paths / node names / volids) into the operator transcript.
        return {"ok": False, "error": exc.redacted}


# Long-running Proxmox actions — vzdump/backup, migrate, a full clone — run as a
# server-side WORKER task: the API returns a UPID and the task keeps going on its
# own. Our pvesh CLIENT subprocess can outlast run_pvesh's timeout, but killing
# that client does NOT stop the worker (it finishes regardless — that's why a
# "timed out" backup keeps progressing). So a timeout on a MUTATING call is not a
# failure; it means "still running, go poll the task" — never a reason to re-run.
def _running_task_upid(vmids: set) -> str:
    """Best-effort UPID of a currently-active task on the node whose id matches
    one of `vmids`, so a timed-out mutating call can hand back the task it just
    started for the caller to poll. Returns '' if none is found (or the lookup
    itself fails/times out — it must never raise)."""
    ids = {str(v) for v in vmids if v is not None}
    if not ids:
        return ""
    try:
        tasks = run_pvesh("get", f"/nodes/{node()}/tasks",
                          {"source": "active", "limit": 100}, timeout=10.0)
    except (proxmox_ops.CommandError, subprocess.TimeoutExpired, ValueError, OSError):
        return ""
    rows = tasks if isinstance(tasks, list) else []
    for task in rows:
        # Active tasks have no endtime; guest tasks (vzdump/migrate/qmclone/...)
        # carry the vmid in `id`.
        if isinstance(task, dict) and not task.get("endtime") \
                and str(task.get("id")) in ids and task.get("upid"):
            return str(task["upid"])
    return ""


def _detached_result(vmids: set, timeout: float) -> dict:
    """The result a mutating call returns when its client subprocess times out:
    the worker task is still running, so report it as running (NOT failed) with
    its UPID and an explicit 'poll, do not re-run' instruction."""
    upid = _running_task_upid(vmids)
    return {
        "ok": True,
        "status": "running",
        "detached": True,
        "upid": upid,
        "note": (
            f"The command did not return within {int(timeout)}s, but the operation "
            "is running in the background — a timeout is NOT a failure for a long "
            "task (backup/migrate/clone). DO NOT re-issue this action. Poll "
            "proxmox_task_status with the UPID above (use proxmox_tasks_recent to "
            "find it if the UPID is empty) until it reports stopped/OK."
        ),
    }


def guarded_write(tool: str, ctx: dict, verb: str, path: str,
                  params: dict | None = None) -> dict:
    """A mutating pvesh call, gated by the permission policy's `deny` backstop.

    `tool` is the operator tool name; `ctx` carries the rule-matching context
    ({verb, method, vmid} as applicable). If the policy resolves to `deny`, the
    call is refused WITHOUT touching Proxmox. `ask`/`allow` both proceed here —
    an `ask` only reaches this server AFTER the daemon gate obtained the user's
    approval. Returns {ok, result} / {status:"denied",...} / {ok:False,error}."""
    # Include the concrete path so path-scoped rules (the daemon persists a
    # {method,path} match when a proxmox_api call is "always"-ed) evaluate here
    # the same way — keeping the backstop in lock-step with the daemon gate.
    full_ctx = dict(ctx)
    full_ctx.setdefault("path", path)
    # Every vmid this call could touch — a deny rule blocks it if it names ANY of
    # them, not just the first one found. Clone is the case that matters: POST
    # /nodes/x/qemu/100/clone {newid:106} names 100 (source, via path) AND 106
    # (destination, via params) — a VM-scoped deny on either must apply.
    vmid_candidates = set()
    if "vmid" in full_ctx:
        try:
            vmid_candidates.add(int(full_ctx["vmid"]))
        except (TypeError, ValueError):
            pass
    # Derive the target VM/CT id from the path (proxmox_api has no vmid arg) so
    # VM-scoped rules apply to the generic passthrough here too.
    m = re.search(r"/(?:qemu|lxc)/(\d+)", path)
    if m:
        vmid_candidates.add(int(m.group(1)))
    # Many mutating calls carry a (possibly DIFFERENT) target in the BODY — create
    # {vmid}, vzdump {vmid}, and clone's {newid} names the DESTINATION while the
    # path names the SOURCE — so check params too, not just as a path fallback.
    for k in ("vmid", "newid"):
        if isinstance(params, dict) and params.get(k) is not None:
            try:
                vmid_candidates.add(int(params[k]))
            except (TypeError, ValueError):
                pass
    for candidate in vmid_candidates or {None}:
        candidate_ctx = dict(full_ctx)
        if candidate is not None:
            candidate_ctx["vmid"] = candidate
        if operator_store.resolve_effect(tool, candidate_ctx) == "deny":
            return {"status": "denied",
                    "reason": "blocked by a permission-policy deny rule",
                    "tool": tool}
    try:
        return {"ok": True, "result": run_pvesh(verb, path, params)}
    except subprocess.TimeoutExpired as exc:
        # The pvesh CLIENT outran our timeout, but the server-side worker keeps
        # running (killing the client doesn't stop a backup/migrate/clone). Report
        # it as running + hand back the UPID to poll — never a hard failure the
        # model would "fix" by re-issuing the (already-running) action.
        return _detached_result(vmid_candidates, getattr(exc, "timeout", 0) or 0)
    except proxmox_ops.CommandError as exc:
        # .redacted (not str(exc)) — see read(): keep host paths/node names out
        # of the operator transcript.
        return {"ok": False, "error": exc.redacted}
