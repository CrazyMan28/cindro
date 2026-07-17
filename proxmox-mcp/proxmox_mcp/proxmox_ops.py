"""Pure decision logic + qm/pvesh shellouts for the Proxmox workload manager.

Kept as two halves on purpose: the shellout helpers below are the only things
that ever spawn a subprocess (monkeypatch `run` in tests), and every decision
function takes already-parsed plain data — no subprocess access — so
proxmox_tune's safety rails (cooldown/headroom/hotplug/caps) are fully
unit-testable without a real qm/pvesh binary anywhere near CI.
"""

from __future__ import annotations

import json
import subprocess
import time


class CommandError(RuntimeError):
    """qm/pvesh exited non-zero; .stderr carries its error text."""

    def __init__(self, cmd: list[str], returncode: int, stderr: str):
        super().__init__(f"{' '.join(cmd)} failed ({returncode}): {stderr.strip()}")
        self.cmd = cmd
        self.returncode = returncode
        self.stderr = stderr

    @property
    def redacted(self) -> str:
        """A trimmed message safe to surface into an operator/chat transcript.
        `str(self)` joins the FULL argv (absolute host paths, node names,
        volids) and the raw stderr — infrastructure detail that shouldn't leak
        to the operator. This keeps the exit code and stderr (the actionable
        part) but drops the argv; the full form stays in `str(self)`/`.cmd` for
        server-side logging."""
        detail = (self.stderr or "").strip()
        return f"command failed ({self.returncode}): {detail}" if detail \
            else f"command failed ({self.returncode})"


def run(cmd: list[str], timeout: float = 20.0) -> str:
    """Run a qm/pvesh command, return stdout. Raises CommandError on failure.
    The ONLY function in this module that shells out — tests monkeypatch
    this, never subprocess itself."""
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise CommandError(cmd, proc.returncode, proc.stderr)
    return proc.stdout


def qm_list() -> list[dict]:
    return parse_qm_list(run(["qm", "list"]))


def qm_config(vmid: int) -> dict:
    return parse_qm_config(run(["qm", "config", str(vmid)]))


def vm_status(node: str, vmid: int) -> dict:
    out = run(["pvesh", "get", f"/nodes/{node}/qemu/{vmid}/status/current",
               "--output-format", "json"])
    return json.loads(out)


def host_status(node: str) -> dict:
    out = run(["pvesh", "get", f"/nodes/{node}/status", "--output-format", "json"])
    return json.loads(out)


def qm_set(vmid: int, *, cores: int | None = None, memory_mb: int | None = None) -> None:
    cmd = ["qm", "set", str(vmid)]
    if cores is not None:
        cmd += ["--cores", str(cores)]
    if memory_mb is not None:
        cmd += ["--memory", str(memory_mb)]
    run(cmd)


# Reject anything that could restart/power-cycle the guest from the inside —
# `qm guest exec` is a DIFFERENT mechanism than `qm reboot`, so "no restart
# tool is registered" alone doesn't stop it; this denylist is what actually
# closes that gap. Matched case-insensitively against the whole argv (not
# just argv[0]) so `sh -c "shutdown -r now"` / `cmd /c shutdown /r` are
# caught too, not just a direct invocation.
#
# Beyond the obvious binaries, cover the non-obvious in-guest power paths that
# never touch shutdown/reboot: the magic-SysRq trigger (`echo b >
# /proc/sysrq-trigger`), an in-place kernel replacement (`kexec -e`), and the
# D-Bus route to logind/systemd (`dbus-send`/`busctl ... login1 ... Reboot`).
# (The login1 method names Reboot/PowerOff/Halt are already caught by their
# substrings; denying the transports too covers Suspend/Hibernate and any
# obfuscated member name.)
_GUEST_EXEC_DENYLIST = (
    "shutdown", "reboot", "poweroff", "halt", "telinit", "systemctl",
    "init 0", "init 6", "pm-suspend", "pm-hibernate", "loginctl",
    "shutdown.exe", "wsl.exe",
    "sysrq-trigger", "kexec", "dbus-send", "busctl",
)


def _guest_exec_blocked(argv: list[str]) -> str | None:
    joined = " ".join(argv).lower()
    for banned in _GUEST_EXEC_DENYLIST:
        if banned in joined:
            return banned
    return None


def guest_exec(vmid: int, argv: list[str], timeout: float = 30.0,
               poller=None) -> dict:
    """Run `argv` INSIDE vmid's guest OS via the QEMU Guest Agent (`qm guest
    exec` / `qm guest exec-status`), for read-only diagnostics — e.g. "what's
    actually eating CPU in there" before deciding how much to bump. Requires
    the guest agent to be installed+running in that VM; a stopped VM or one
    without the agent just returns ok:False.

    Rejects anything resembling a restart/shutdown/power command (see
    _GUEST_EXEC_DENYLIST) — this tool is diagnostic-only, and "the agent has
    no way to restart a VM" must hold even via the guest agent, not just via
    qm reboot.

    `qm guest exec` returns a pid immediately; we poll exec-status until it
    reports exited or `timeout` elapses. `poller` is a test seam (defaults to
    time.sleep) so unit tests never actually sleep."""
    blocked = _guest_exec_blocked(argv)
    if blocked:
        return {"ok": False,
                "error": f"blocked: '{blocked}' looks like a restart/shutdown command; "
                        "proxmox_guest_exec is diagnostic-only"}
    return _exec_via_agent_unchecked(vmid, argv, timeout, poller)


def _exec_via_agent_unchecked(vmid: int, argv: list[str], timeout: float = 30.0,
                              poller=None) -> dict:
    """guest_exec's mechanics WITHOUT the denylist gate. The ONLY callers
    allowed here are guest_exec (which gates first) and scout.guest_service
    (which builds its argv itself from a regex-validated service name and a
    closed verb set — that's why e.g. `systemctl restart <svc>` may pass
    through even though "systemctl" is denylisted for free-form argv). Never
    expose this to a tool that accepts caller-supplied argv."""
    poller = poller or time.sleep
    try:
        pid_info = json.loads(run(["qm", "guest", "exec", str(vmid), "--", *argv]))
    except (CommandError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    pid = pid_info.get("pid")
    if pid is None:
        return {"ok": False, "error": f"no pid in qm guest exec response: {pid_info}"}

    deadline = time.time() + timeout
    while True:
        try:
            status = json.loads(run(["qm", "guest", "exec-status", str(vmid), str(pid)]))
        except (CommandError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}
        if status.get("exited"):
            return {
                "ok": status.get("exitcode", 1) == 0,
                "exit_code": status.get("exitcode"),
                "out": status.get("out-data", ""),
                "err": status.get("err-data", ""),
            }
        if time.time() >= deadline:
            return {"ok": False, "error": f"timed out after {timeout}s waiting on guest command"}
        poller(0.5)


def qm_reboot(vmid: int) -> None:
    """The ONLY function in this whole package that restarts a VM. Called
    exclusively by the local daemon's explicit proxmox.restart_vm RPC (via
    outpost.exec) — never by proxmox_tune, never by the scheduled agent loop."""
    run(["qm", "reboot", str(vmid)])


# --- pure parsers ------------------------------------------------------------

def parse_qm_list(output: str) -> list[dict]:
    """`qm list` -> [{vmid,name,status,mem_mb}]. Header line:
    VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID"""
    vms = []
    lines = [ln for ln in output.splitlines() if ln.strip()]
    for line in lines[1:]:  # skip header
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            vmid = int(parts[0])
            mem_mb = int(parts[3])
        except ValueError:
            continue
        vms.append({"vmid": vmid, "name": parts[1], "status": parts[2], "mem_mb": mem_mb})
    return vms


def parse_qm_config(output: str) -> dict:
    """`qm config <vmid>` -> {cores:int, memory:int (MB), hotplug:set[str], raw:{...}}."""
    cfg: dict = {"raw": {}}
    for line in output.splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        cfg["raw"][key.strip()] = val.strip()
    cfg["cores"] = int(cfg["raw"].get("cores", "1") or "1")
    cfg["memory"] = int(cfg["raw"].get("memory", "512") or "512")
    cfg["hotplug"] = {h.strip() for h in cfg["raw"].get("hotplug", "").split(",") if h.strip()}
    return cfg


def hotplug_supports(hotplug: set[str], dimension: str) -> bool:
    """dimension: 'cpu' or 'memory'. Proxmox's hotplug field lists exactly
    that vocabulary (plus disk/network/usb/cloudinit)."""
    return dimension in hotplug


# --- safety-rail decisions (pure; the whole point of unit-testing this) ----

def in_cooldown(last_action_at_ms: int | None, now_ms: int, cooldown_minutes: int) -> bool:
    if not last_action_at_ms:
        return False
    return (now_ms - last_action_at_ms) < cooldown_minutes * 60_000


def is_congested(cpu_pct: float, mem_pct: float, cfg: dict) -> bool:
    return cpu_pct >= cfg["cpu_congested_pct"] or mem_pct >= cfg["mem_congested_pct"]


def host_headroom_ok(all_vm_configs: list[dict], node_cores: int, node_mem_mb: int,
                      cfg: dict, delta_cores: int = 0, delta_mem_mb: int = 0) -> tuple[bool, str]:
    """Sum every VM's CONFIGURED cores/memory (not live usage) + the proposed
    delta, and keep it under the host's capacity minus the configured
    reserve. Returns (ok, reason) so callers can surface why a bump was
    refused instead of just silently skipping it."""
    used_cores = sum(v.get("cores", 0) for v in all_vm_configs) + delta_cores
    used_mem = sum(v.get("memory", 0) for v in all_vm_configs) + delta_mem_mb
    max_cores = node_cores - cfg["reserve_cores"]
    max_mem = node_mem_mb - cfg["reserve_mem_mb"]
    if used_cores > max_cores:
        return False, f"host core headroom exhausted ({used_cores}/{max_cores})"
    if used_mem > max_mem:
        return False, f"host memory headroom exhausted ({used_mem}MB/{max_mem}MB)"
    return True, ""


def clamp_bump(current: int, requested: int, step_cap: int, per_vm_cap: int) -> int:
    """A tune request never jumps by more than step_cap in one action, and
    never pushes the VM past per_vm_cap, regardless of what was asked for."""
    bumped = min(requested, current + step_cap)
    return min(bumped, per_vm_cap)


def _resolve_bump(requested: int | None, current: int, step_cap: int,
                  per_vm_cap: int) -> int | None:
    """Shared by decide_tune's cores/memory branches: None if no increase was
    requested (or the clamp doesn't actually raise the value), else the
    clamped new value."""
    if requested is None or requested <= current:
        return None
    bumped = clamp_bump(current, requested, step_cap, per_vm_cap)
    return bumped if bumped > current else None


def decide_tune(*, vmid: int, blocklist: set[int], requested_cores: int | None,
                 requested_memory_mb: int | None, current_cores: int, current_memory_mb: int,
                 hotplug: set[str], all_vm_configs: list[dict], node_cores: int,
                 node_mem_mb: int, cfg: dict, last_action_at_ms: int | None, now_ms: int) -> dict:
    """The single gate proxmox_tune calls before ever touching `qm set`.
    Returns {ok, reason, cores, memory_mb, applied_live_cores, applied_live_memory}
    — cores/memory_mb are None when that dimension wasn't requested or was
    rejected; applied_live_* tells the caller whether THIS dimension can be
    hot-applied or will only take effect after a (user-triggered) restart.
    NEVER calls qm_set/qm_reboot itself — pure decision only."""
    if vmid in blocklist:
        return {"ok": False, "reason": "blocklisted"}
    if in_cooldown(last_action_at_ms, now_ms, cfg["cooldown_minutes"]):
        return {"ok": False, "reason": "cooldown"}

    new_cores = _resolve_bump(requested_cores, current_cores,
                              cfg["bump_step_cores"], cfg["max_cores_per_vm"])
    new_memory_mb = _resolve_bump(requested_memory_mb, current_memory_mb,
                                  cfg["bump_step_mem_mb"], cfg["max_mem_mb_per_vm"])

    if new_cores is None and new_memory_mb is None:
        return {"ok": False,
                "reason": "nothing to apply (already at/above cap, or no increase requested)"}

    delta_cores = (new_cores - current_cores) if new_cores is not None else 0
    delta_mem = (new_memory_mb - current_memory_mb) if new_memory_mb is not None else 0
    ok, reason = host_headroom_ok(all_vm_configs, node_cores, node_mem_mb, cfg,
                                  delta_cores, delta_mem)
    if not ok:
        return {"ok": False, "reason": reason}

    return {
        "ok": True,
        "reason": "",
        "cores": new_cores,
        "memory_mb": new_memory_mb,
        "applied_live_cores": new_cores is not None and hotplug_supports(hotplug, "cpu"),
        "applied_live_memory": new_memory_mb is not None and hotplug_supports(hotplug, "memory"),
    }
