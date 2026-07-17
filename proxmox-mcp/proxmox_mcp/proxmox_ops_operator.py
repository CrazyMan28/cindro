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
    except proxmox_ops.CommandError as exc:
        # .redacted (not str(exc)) — don't leak the full argv (absolute host
        # paths / node names / volids) into the operator transcript.
        return {"ok": False, "error": exc.redacted}


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
    # Derive the target VM/CT id from the path (proxmox_api has no vmid arg) so
    # VM-scoped rules apply to the generic passthrough here too.
    if "vmid" not in full_ctx:
        m = re.search(r"/(?:qemu|lxc)/(\d+)", path)
        if m:
            full_ctx["vmid"] = int(m.group(1))
        else:
            # Many mutating calls carry the target in the BODY, not the path
            # (create {vmid}, vzdump {vmid}, clone {newid}) — include it so a
            # VM-scoped deny rule can't be bypassed through the passthrough.
            for k in ("vmid", "newid"):
                if isinstance(params, dict) and params.get(k) is not None:
                    try:
                        full_ctx["vmid"] = int(params[k])
                    except (TypeError, ValueError):
                        pass
                    break
    if operator_store.resolve_effect(tool, full_ctx) == "deny":
        return {"status": "denied",
                "reason": "blocked by a permission-policy deny rule",
                "tool": tool}
    try:
        return {"ok": True, "result": run_pvesh(verb, path, params)}
    except proxmox_ops.CommandError as exc:
        # .redacted (not str(exc)) — see read(): keep host paths/node names out
        # of the operator transcript.
        return {"ok": False, "error": exc.redacted}
