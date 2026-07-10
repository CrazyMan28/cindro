"""Scout batteries, parsers, and the sanctioned guest_service path — all with
`ops.run` / exec seams monkeypatched, never a real qm/pct anywhere."""

import json
import subprocess

from proxmox_mcp import proxmox_ops as ops
from proxmox_mcp import scout


# --- the batteries must survive the free-form denylist -----------------------

def test_linux_battery_passes_denylist():
    assert ops._guest_exec_blocked(scout.LINUX_ARGV) is None


def test_windows_battery_passes_denylist():
    assert ops._guest_exec_blocked(scout.WINDOWS_ARGV) is None


def test_batteries_do_not_use_systemctl():
    # services must come from cgroup dirs — systemctl is denylisted and the
    # denylist must never be weakened to accommodate the scout
    assert "systemctl" not in scout.LINUX_BATTERY
    assert "systemctl" not in scout.WINDOWS_BATTERY


# --- pct list / exec ----------------------------------------------------------

PCT_LIST = """VMID       Status     Lock         Name
100        running                 web-ct
101        stopped                 db-ct
102        running    backup       locked-ct
"""


def test_parse_pct_list_with_and_without_lock():
    cts = scout.parse_pct_list(PCT_LIST)
    assert cts == [
        {"vmid": 100, "name": "web-ct", "status": "running"},
        {"vmid": 101, "name": "db-ct", "status": "stopped"},
        {"vmid": 102, "name": "locked-ct", "status": "running"},
    ]


def test_pct_exec_blocked_command(monkeypatch):
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() must not be called for a blocked command")))
    result = scout.pct_exec(100, ["systemctl", "restart", "nginx"])
    assert result["ok"] is False and "blocked" in result["error"]


def test_pct_exec_success(monkeypatch):
    seen = {}

    def fake_run(cmd, timeout=20.0):
        seen["cmd"] = cmd
        return "out\n"

    monkeypatch.setattr(ops, "run", fake_run)
    result = scout.pct_exec(100, ["df", "-h"])
    assert result == {"ok": True, "exit_code": 0, "out": "out\n", "err": ""}
    assert seen["cmd"][:4] == ["pct", "exec", "100", "--"]


def test_pct_exec_command_error(monkeypatch):
    def raise_error(cmd, timeout=20.0):
        raise ops.CommandError(cmd, 3, "container not running")
    monkeypatch.setattr(ops, "run", raise_error)
    result = scout.pct_exec(100, ["df", "-h"])
    assert result["ok"] is False and result["err"] == "container not running"


def test_pct_exec_timeout(monkeypatch):
    def raise_timeout(cmd, timeout=20.0):
        raise subprocess.TimeoutExpired(cmd, timeout)
    monkeypatch.setattr(ops, "run", raise_timeout)
    result = scout.pct_exec(100, ["sleep", "999"])
    assert result["ok"] is False and "timed out" in result["error"]


# --- agent ping / os family ---------------------------------------------------

def test_agent_ping_true_false(monkeypatch):
    monkeypatch.setattr(ops, "run", lambda cmd, timeout=20.0: "")
    assert scout.agent_ping(104) is True

    def raise_error(cmd, timeout=20.0):
        raise ops.CommandError(cmd, 255, "not running")
    monkeypatch.setattr(ops, "run", raise_error)
    assert scout.agent_ping(104) is False


def test_guest_os_family_from_osinfo(monkeypatch):
    monkeypatch.setattr(ops, "run",
                        lambda cmd, timeout=20.0: json.dumps({"id": "mswindows"}))
    assert scout.guest_os_family(106) == "windows"
    monkeypatch.setattr(ops, "run",
                        lambda cmd, timeout=20.0: json.dumps({"id": "debian"}))
    assert scout.guest_os_family(104) == "linux"


def test_guest_os_family_falls_back_to_ostype(monkeypatch):
    def run(cmd, timeout=20.0):
        if cmd[:2] == ["qm", "agent"]:
            raise ops.CommandError(cmd, 255, "no agent")
        return "ostype: win11\ncores: 4\nmemory: 8192\n"
    monkeypatch.setattr(ops, "run", run)
    assert scout.guest_os_family(106) == "windows"


# --- battery parsing ------------------------------------------------------------

def test_parse_battery_sections_and_crlf():
    text = ("===HOSTNAME===\r\nwin-runner\r\n===OS===\r\nMicrosoft Windows 11 Pro\r\n"
            "===SERVICES===\r\nWinRM\r\nDocker\r\n===PORTS===\r\n")
    sections = scout.parse_battery(text)
    assert sections["hostname"] == ["win-runner"]
    assert sections["os"] == ["Microsoft Windows 11 Pro"]
    assert sections["services"] == ["WinRM", "Docker"]
    assert sections["ports"] == []  # present but empty is fine


def test_parse_battery_ignores_preamble_noise():
    sections = scout.parse_battery("stray banner\n===OS===\ndebian\n")
    assert "os" in sections and sections["os"] == ["debian"]


# --- scout_qemu / scout_lxc ------------------------------------------------------

def test_scout_qemu_no_agent(monkeypatch):
    monkeypatch.setattr(scout, "agent_ping", lambda vmid: False)
    result = scout.scout_qemu(104)
    assert result["ok"] is False and result["agent"] is False


def test_scout_qemu_linux(monkeypatch):
    monkeypatch.setattr(scout, "agent_ping", lambda vmid: True)
    monkeypatch.setattr(scout, "guest_os_family", lambda vmid: "linux")
    seen = {}

    def fake_guest_exec(vmid, argv, timeout=30.0, poller=None):
        seen["argv"] = argv
        return {"ok": True, "exit_code": 0,
                "out": "===HOSTNAME===\nci-runner\n===SERVICES===\nnginx.service\n",
                "err": ""}

    monkeypatch.setattr(ops, "guest_exec", fake_guest_exec)
    result = scout.scout_qemu(104)
    assert result["ok"] is True and result["agent"] is True
    assert result["observed"]["hostname"] == ["ci-runner"]
    assert seen["argv"] == scout.LINUX_ARGV


def test_scout_qemu_windows_battery_selected(monkeypatch):
    monkeypatch.setattr(scout, "agent_ping", lambda vmid: True)
    monkeypatch.setattr(scout, "guest_os_family", lambda vmid: "windows")
    seen = {}

    def fake_guest_exec(vmid, argv, timeout=30.0, poller=None):
        seen["argv"] = argv
        return {"ok": True, "exit_code": 0, "out": "===HOSTNAME===\r\nwin\r\n", "err": ""}

    monkeypatch.setattr(ops, "guest_exec", fake_guest_exec)
    result = scout.scout_qemu(106)
    assert result["ok"] is True and result["os_family"] == "windows"
    assert seen["argv"] == scout.WINDOWS_ARGV


def test_scout_qemu_empty_output_is_error(monkeypatch):
    monkeypatch.setattr(scout, "agent_ping", lambda vmid: True)
    monkeypatch.setattr(scout, "guest_os_family", lambda vmid: "linux")
    monkeypatch.setattr(ops, "guest_exec",
                        lambda *a, **k: {"ok": False, "error": "agent busy"})
    result = scout.scout_qemu(104)
    assert result["ok"] is False and "agent busy" in result["error"]


def test_scout_lxc(monkeypatch):
    monkeypatch.setattr(ops, "run",
                        lambda cmd, timeout=20.0: "===HOSTNAME===\nweb-ct\n")
    result = scout.scout_lxc(100)
    assert result["ok"] is True and result["agent"] is None
    assert result["observed"]["hostname"] == ["web-ct"]


def test_summarize():
    observed = {"hostname": ["ci-runner"],
                "services": ["a.service", "b.service", "c.service", "d.service"],
                "docker": ["x\timg\tUp"], "ports": ["0.0.0.0:22", "0.0.0.0:80"]}
    s = scout.summarize(observed)
    assert "ci-runner" in s and "+1" in s and "1 containers" in s and "2 listening" in s
    assert scout.summarize({}) == "no observations"


# --- guest_service: the one sanctioned denylist bypass ---------------------------

def _capture_agent_exec(monkeypatch):
    seen = {}

    def fake(vmid, argv, timeout=30.0, poller=None):
        seen["vmid"], seen["argv"] = vmid, argv
        return {"ok": True, "exit_code": 0, "out": "done", "err": ""}

    monkeypatch.setattr(ops, "_exec_via_agent_unchecked", fake)
    return seen


def test_guest_service_rejects_stop_and_power_verbs(monkeypatch):
    monkeypatch.setattr(ops, "_exec_via_agent_unchecked", lambda *a, **k: (
        (_ for _ in ()).throw(AssertionError("must not exec"))))
    for verb in ("stop", "poweroff", "shutdown", "kill", "disable"):
        result = scout.guest_service(104, "nginx", verb)
        assert result["ok"] is False and "verb" in result["error"]


def test_guest_service_rejects_bad_service_names(monkeypatch):
    monkeypatch.setattr(ops, "_exec_via_agent_unchecked", lambda *a, **k: (
        (_ for _ in ()).throw(AssertionError("must not exec"))))
    for name in ("nginx; rm -rf /", "a b", "$(reboot)", "", "x'y"):
        result = scout.guest_service(104, name, "restart")
        assert result["ok"] is False and "service name" in result["error"]


def test_guest_service_blocklist_refuses_mutation_allows_status(monkeypatch):
    seen = _capture_agent_exec(monkeypatch)
    blocked = scout.guest_service(104, "nginx", "restart", blocklist={104})
    assert blocked["ok"] is False and "blocklisted" in blocked["error"]
    status = scout.guest_service(104, "nginx", "status", blocklist={104})
    assert status["ok"] is True and seen["argv"][0] == "systemctl"


def test_guest_service_linux_restart_argv(monkeypatch):
    seen = _capture_agent_exec(monkeypatch)
    result = scout.guest_service(104, "gitea-runner", "restart")
    assert result["ok"] is True
    assert seen["argv"] == ["systemctl", "restart", "gitea-runner"]


def test_guest_service_windows_argv(monkeypatch):
    seen = _capture_agent_exec(monkeypatch)
    result = scout.guest_service(106, "actions.runner", "start", os_family="windows")
    assert result["ok"] is True
    assert seen["argv"][0] == "powershell.exe"
    assert "Start-Service -Name actions.runner" in seen["argv"][-1]


def test_guest_service_lxc_uses_pct(monkeypatch):
    seen = {}

    def fake_pct(vmid, argv, timeout=60.0):
        seen["vmid"], seen["argv"] = vmid, argv
        return {"ok": True, "exit_code": 0, "out": "", "err": ""}

    monkeypatch.setattr(scout, "_pct_exec_unchecked", fake_pct)
    result = scout.guest_service(100, "nginx", "start", kind="lxc")
    assert result["ok"] is True
    assert seen["argv"] == ["systemctl", "start", "nginx"]
