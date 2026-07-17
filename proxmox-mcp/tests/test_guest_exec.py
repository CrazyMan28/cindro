"""guest_exec's polling loop, with `ops.run` monkeypatched — never shells out
to a real qm binary, never actually sleeps (poller seam)."""

import json

from proxmox_mcp import proxmox_ops as ops


def test_guest_exec_immediate_success(monkeypatch):
    calls = iter([
        json.dumps({"pid": 4242}),
        json.dumps({"exited": 1, "exitcode": 0, "out-data": "hello\n", "err-data": ""}),
    ])
    monkeypatch.setattr(ops, "run", lambda cmd, timeout=20.0: next(calls))
    result = ops.guest_exec(104, ["echo", "hello"], timeout=5.0)
    assert result == {"ok": True, "exit_code": 0, "out": "hello\n", "err": ""}


def test_guest_exec_polls_until_exited(monkeypatch):
    calls = iter([
        json.dumps({"pid": 99}),
        json.dumps({"exited": 0}),
        json.dumps({"exited": 0}),
        json.dumps({"exited": 1, "exitcode": 1, "out-data": "", "err-data": "boom"}),
    ])
    sleeps = []
    monkeypatch.setattr(ops, "run", lambda cmd, timeout=20.0: next(calls))
    result = ops.guest_exec(104, ["false"], timeout=5.0, poller=sleeps.append)
    assert result == {"ok": False, "exit_code": 1, "out": "", "err": "boom"}
    assert sleeps == [0.5, 0.5]  # polled twice before the third status was exited


def test_guest_exec_no_pid_returns_error(monkeypatch):
    monkeypatch.setattr(ops, "run", lambda cmd, timeout=20.0: json.dumps({}))
    result = ops.guest_exec(104, ["echo", "hi"])
    assert result["ok"] is False and "no pid" in result["error"]


def test_guest_exec_command_error_returns_error(monkeypatch):
    def raise_error(cmd, timeout=20.0):
        raise ops.CommandError(cmd, 1, "guest agent not running")
    monkeypatch.setattr(ops, "run", raise_error)
    result = ops.guest_exec(104, ["echo", "hi"])
    assert result["ok"] is False and "guest agent not running" in result["error"]


def test_guest_exec_blocks_direct_reboot_command(monkeypatch):
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() should never be called for a blocked command")))
    result = ops.guest_exec(104, ["reboot"])
    assert result["ok"] is False and "blocked" in result["error"]


def test_guest_exec_blocks_shutdown_via_shell_wrapper(monkeypatch):
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() should never be called for a blocked command")))
    result = ops.guest_exec(104, ["sh", "-c", "shutdown -r now"])
    assert result["ok"] is False and "blocked" in result["error"]


def test_guest_exec_blocks_windows_shutdown_exe(monkeypatch):
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() should never be called for a blocked command")))
    result = ops.guest_exec(104, ["cmd", "/c", "shutdown.exe", "/r"])
    assert result["ok"] is False and "blocked" in result["error"]


def test_guest_exec_blocks_sysrq_trigger(monkeypatch):
    # `echo b > /proc/sysrq-trigger` reboots without touching any reboot binary.
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() should never be called for a blocked command")))
    result = ops.guest_exec(104, ["sh", "-c", "echo b > /proc/sysrq-trigger"])
    assert result["ok"] is False and "blocked" in result["error"]


def test_guest_exec_blocks_kexec(monkeypatch):
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() should never be called for a blocked command")))
    result = ops.guest_exec(104, ["kexec", "-e"])
    assert result["ok"] is False and "blocked" in result["error"]


def test_guest_exec_blocks_dbus_send_transport(monkeypatch):
    # The D-Bus route to logind: target a power method whose name is NOT itself
    # a denylisted word (Suspend, unlike Reboot/PowerOff/Halt) so the block can
    # ONLY come from the `dbus-send` transport entry — this genuinely guards it
    # (an argv containing `reboot` would match that substring first and pass
    # even if `dbus-send` were removed from the denylist).
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() should never be called for a blocked command")))
    argv = ["dbus-send", "--system",
            "--dest=org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager.Suspend",
            "boolean:true"]
    assert ops._guest_exec_blocked(argv) == "dbus-send"
    result = ops.guest_exec(104, argv)
    assert result["ok"] is False and "'dbus-send'" in result["error"]


def test_guest_exec_blocks_busctl_transport(monkeypatch):
    # Same idea for busctl: `busctl call ... Suspend` carries no other
    # denylisted token, so blocking can only be the new `busctl` entry.
    monkeypatch.setattr(ops, "run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("run() should never be called for a blocked command")))
    argv = ["busctl", "call", "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager", "Suspend", "b", "true"]
    assert ops._guest_exec_blocked(argv) == "busctl"
    result = ops.guest_exec(104, argv)
    assert result["ok"] is False and "'busctl'" in result["error"]


def test_guest_exec_allows_ordinary_diagnostic_command(monkeypatch):
    calls = iter([
        json.dumps({"pid": 1}),
        json.dumps({"exited": 1, "exitcode": 0, "out-data": "top output\n", "err-data": ""}),
    ])
    monkeypatch.setattr(ops, "run", lambda cmd, timeout=20.0: next(calls))
    result = ops.guest_exec(104, ["ps", "aux", "--sort=-%cpu"])
    assert result["ok"] is True
