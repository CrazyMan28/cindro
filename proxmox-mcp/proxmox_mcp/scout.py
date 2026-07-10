"""Agentless guest scouting: what is actually RUNNING inside each VM/CT.

No per-guest agent install — QEMU VMs are inspected through the guest agent
Proxmox already talks to (`qm guest exec`), LXC containers through
`pct exec` (which needs nothing inside the CT at all). One marker-delimited
command battery per guest keeps it to a single round-trip; every section is
head-capped so output stays far under the 256KB outpost exec cap and the
resulting JARVIS.md profiles stay readable.

Two hard rules inherited from proxmox_ops:
- Free-form exec always goes through the _GUEST_EXEC_DENYLIST gate
  (pct_exec below re-uses the exact same gate as guest_exec).
- `systemctl` is on that denylist, so the batteries list services from
  /sys/fs/cgroup/*/system.slice instead. Do NOT "fix" that by weakening the
  denylist.

guest_service() is the one sanctioned exception: it builds its argv itself
from a regex-validated service name and a closed verb set {start, restart,
status} — deliberately no `stop` and no power verbs, so the agent can heal a
stuck service but never kill one (and still can never touch VM power).
"""

from __future__ import annotations

import json
import re
import subprocess

from proxmox_mcp import proxmox_ops
from proxmox_mcp.proxmox_ops import CommandError, _guest_exec_blocked

# One `sh -c` round-trip. Sections are ===MARKER=== delimited for parse_battery.
# Services come from cgroup dirs because `systemctl` is denylisted (see module
# docstring); both cgroup v2 and v1 paths are listed so old guests still work.
LINUX_BATTERY = (
    "echo ===HOSTNAME===; cat /proc/sys/kernel/hostname 2>/dev/null; "
    "echo ===OS===; head -5 /etc/os-release 2>/dev/null; "
    "echo ===UPTIME===; cat /proc/uptime 2>/dev/null; "
    "echo ===SERVICES===; ls -d /sys/fs/cgroup/system.slice/*.service "
    "/sys/fs/cgroup/systemd/system.slice/*.service 2>/dev/null "
    "| sed 's#.*/##' | sort -u | head -40; "
    "echo ===PORTS===; (ss -tulpnH 2>/dev/null || netstat -tulpn 2>/dev/null) | head -40; "
    "echo ===DOCKER===; (docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null "
    "|| podman ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null) | head -30; "
    "echo ===DISK===; df -hP 2>/dev/null | head -20; "
    "echo ===TOP===; ps aux --sort=-%cpu 2>/dev/null | head -15; "
    "echo ===MEM===; free -m 2>/dev/null | head -3"
)

# One powershell round-trip for Windows guests (needs the QEMU GA Windows
# service installed in the guest — scout_qemu reports agent:False otherwise).
WINDOWS_BATTERY = (
    "$ErrorActionPreference='SilentlyContinue'; "
    "'===HOSTNAME==='; $env:COMPUTERNAME; "
    "'===OS==='; (Get-CimInstance Win32_OperatingSystem).Caption; "
    "'===SERVICES==='; Get-Service | Where-Object {$_.Status -eq 'Running'} "
    "| Select-Object -First 40 -ExpandProperty Name; "
    "'===PORTS==='; Get-NetTCPConnection -State Listen | Select-Object -First 40 "
    "| ForEach-Object { \"$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)\" }; "
    "'===DOCKER==='; docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'; "
    "'===DISK==='; Get-PSDrive -PSProvider FileSystem | ForEach-Object "
    "{ \"$($_.Name): used=$([math]::Round($_.Used/1GB,1))GB free=$([math]::Round($_.Free/1GB,1))GB\" }; "
    "'===TOP==='; Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 "
    "| ForEach-Object { \"$($_.ProcessName) cpu=$([math]::Round($_.CPU,1)) "
    "memMB=$([math]::Round($_.WorkingSet64/1MB))\" }"
)

LINUX_ARGV = ["sh", "-c", LINUX_BATTERY]
WINDOWS_ARGV = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_BATTERY]


def parse_pct_list(output: str) -> list[dict]:
    """`pct list` -> [{vmid,name,status}]. Header: VMID Status Lock Name —
    Lock is usually blank, so rows split into 3 fields (no lock) or 4."""
    cts = []
    lines = [ln for ln in output.splitlines() if ln.strip()]
    for line in lines[1:]:  # skip header
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            vmid = int(parts[0])
        except ValueError:
            continue
        cts.append({"vmid": vmid, "name": parts[-1], "status": parts[1]})
    return cts


def pct_list() -> list[dict]:
    return parse_pct_list(proxmox_ops.run(["pct", "list"]))


def pct_exec(vmid: int, argv: list[str], timeout: float = 60.0) -> dict:
    """Run `argv` inside a running LXC container (`pct exec` — no guest agent
    needed). Same denylist gate and same result shape as guest_exec."""
    blocked = _guest_exec_blocked(argv)
    if blocked:
        return {"ok": False,
                "error": f"blocked: '{blocked}' looks like a restart/shutdown command; "
                        "guest exec is diagnostic-only"}
    return _pct_exec_unchecked(vmid, argv, timeout)


def _pct_exec_unchecked(vmid: int, argv: list[str], timeout: float = 60.0) -> dict:
    """pct_exec without the denylist gate — same restricted callers as
    proxmox_ops._exec_via_agent_unchecked (see there)."""
    try:
        out = proxmox_ops.run(["pct", "exec", str(vmid), "--", *argv], timeout=timeout)
        return {"ok": True, "exit_code": 0, "out": out, "err": ""}
    except CommandError as exc:
        return {"ok": False, "exit_code": exc.returncode, "out": "", "err": exc.stderr}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timed out after {timeout}s in pct exec"}


def agent_ping(vmid: int) -> bool:
    """Does this VM have a responsive QEMU guest agent right now?"""
    try:
        proxmox_ops.run(["qm", "agent", str(vmid), "ping"], timeout=10.0)
        return True
    except (CommandError, subprocess.TimeoutExpired):
        return False


def guest_os_family(vmid: int) -> str:
    """'windows' or 'linux' (everything non-Windows scouts fine with the
    Linux battery). Prefers the guest agent's own get-osinfo; falls back to
    the ostype in the VM config."""
    try:
        info = json.loads(proxmox_ops.run(["qm", "agent", str(vmid), "get-osinfo"],
                                          timeout=10.0))
        if isinstance(info, dict):
            osid = str(info.get("result", info).get("id", "")).lower()
            if osid:
                return "windows" if osid == "mswindows" else "linux"
    except (CommandError, ValueError, AttributeError, subprocess.TimeoutExpired):
        pass
    try:
        ostype = proxmox_ops.qm_config(vmid)["raw"].get("ostype", "")
        if ostype.lower().startswith("w"):
            return "windows"
    except (CommandError, subprocess.TimeoutExpired):
        pass
    return "linux"


def parse_battery(text: str) -> dict[str, list[str]]:
    """===MARKER=== delimited battery output -> {section: [lines]}. Strips
    CR (Windows guests emit CRLF) and tolerates empty/missing sections."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw_line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.rstrip()
        stripped = line.strip()
        if stripped.startswith("===") and stripped.endswith("===") and len(stripped) > 6:
            current = stripped.strip("=").strip().lower()
            sections.setdefault(current, [])
            continue
        if current is not None and stripped:
            sections[current].append(line)
    return sections


def scout_qemu(vmid: int) -> dict:
    """Full inside-look at one QEMU VM. Returns {ok, agent, os_family,
    observed?, error?} — agent:False (not an exception) when the guest agent
    isn't responding, so a fleet scout just records it and moves on."""
    if not agent_ping(vmid):
        return {"ok": False, "agent": False, "os_family": "",
                "error": "guest agent not responding"}
    family = guest_os_family(vmid)
    if family == "windows":
        res = proxmox_ops.guest_exec(vmid, WINDOWS_ARGV, timeout=120.0)
    else:
        res = proxmox_ops.guest_exec(vmid, LINUX_ARGV, timeout=60.0)
    out = res.get("out", "") or ""
    if not out.strip():
        return {"ok": False, "agent": True, "os_family": family,
                "error": res.get("error") or res.get("err") or "empty battery output"}
    return {"ok": True, "agent": True, "os_family": family,
            "observed": parse_battery(out)}


def scout_lxc(vmid: int) -> dict:
    """Same for an LXC container — no guest agent involved, `agent` is None
    (meaningless for CTs; don't render it as yes/no)."""
    res = pct_exec(vmid, LINUX_ARGV, timeout=60.0)
    out = res.get("out", "") or ""
    if not out.strip():
        return {"ok": False, "agent": None, "os_family": "linux",
                "error": res.get("error") or res.get("err") or "empty battery output"}
    return {"ok": True, "agent": None, "os_family": "linux",
            "observed": parse_battery(out)}


def summarize(observed: dict) -> str:
    """One-liner for scout_status results / memory entries."""
    parts = []
    hostname = (observed.get("hostname") or [""])[0].strip()
    if hostname:
        parts.append(hostname)
    services = observed.get("services") or []
    if services:
        head = ", ".join(s.strip() for s in services[:3])
        more = f" +{len(services) - 3}" if len(services) > 3 else ""
        parts.append(f"services: {head}{more}")
    docker = observed.get("docker") or []
    if docker:
        parts.append(f"{len(docker)} containers")
    ports = observed.get("ports") or []
    if ports:
        parts.append(f"{len(ports)} listening ports")
    return "; ".join(parts) if parts else "no observations"


# --- sanctioned service control (the ONE denylist bypass) --------------------

_SERVICE_NAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,128}$")
_SERVICE_VERBS = ("start", "restart", "status")  # no stop, no power — heal, don't kill


def guest_service(vmid: int, service: str, verb: str, *, kind: str = "qemu",
                  os_family: str = "linux", blocklist: frozenset | set = frozenset()) -> dict:
    """start/restart/status a service INSIDE a guest. The argv is built here
    from a validated service name (no shell, no quoting surface) and a closed
    verb set — that is what makes bypassing the free-form denylist safe.
    Mutating verbs are refused for blocklisted VMs (status is fine)."""
    if verb not in _SERVICE_VERBS:
        return {"ok": False,
                "error": f"verb must be one of {list(_SERVICE_VERBS)} (no stop/power verbs — "
                        "this tool heals services, it never kills them)"}
    if not _SERVICE_NAME_RE.match(service or ""):
        return {"ok": False, "error": "invalid service name (letters, digits, _.@- only)"}
    if verb != "status" and vmid in blocklist:
        return {"ok": False, "error": f"VM {vmid} is blocklisted; not touching its services"}

    if os_family == "windows":
        ps = {
            "start": f"Start-Service -Name {service}; Get-Service -Name {service} | Format-List Name,Status",
            "restart": f"Restart-Service -Name {service}; Get-Service -Name {service} | Format-List Name,Status",
            "status": f"Get-Service -Name {service} | Format-List Name,Status,StartType",
        }[verb]
        argv = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps]
    elif verb == "status":
        argv = ["systemctl", "status", "--no-pager", "--lines=5", service]
    else:
        argv = ["systemctl", verb, service]

    if kind == "lxc":
        return _pct_exec_unchecked(vmid, argv, timeout=60.0)
    return proxmox_ops._exec_via_agent_unchecked(vmid, argv, timeout=60.0)
