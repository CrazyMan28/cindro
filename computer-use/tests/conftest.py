"""Shared fixtures for the computer-use Wave 5 upgrade tests."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time
from pathlib import Path

import pytest

UID = os.getuid()
RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{UID}")

_SWAY_CONF = """\
output HEADLESS-1 resolution 1600x1000 position 0,0
output HEADLESS-1 background #112233 solid_color
"""


def _have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


@pytest.fixture
def nested_sway(tmp_path):
    """Spin a nested headless Sway (output HEADLESS-1) and yield a dict with its
    WAYLAND_DISPLAY / SWAYSOCK. Skips the test if sway/grim are unavailable or
    the compositor never comes up (e.g. no wlroots headless backend in CI)."""
    if not (_have("sway") and _have("grim") and _have("swaymsg")):
        pytest.skip("sway/grim/swaymsg not installed — headless video test skipped")

    conf = tmp_path / "sway_headless.conf"
    conf.write_text(_SWAY_CONF)

    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env["WLR_BACKENDS"] = "headless"
    env["WLR_LIBINPUT_NO_DEVICES"] = "1"
    env["XDG_RUNTIME_DIR"] = RUNTIME_DIR

    before = set(_sway_socks())
    proc = subprocess.Popen(
        ["sway", "-c", str(conf)],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    sock = None
    deadline = time.time() + 8
    while time.time() < deadline:
        if proc.poll() is not None:
            pytest.skip("nested sway exited immediately — no headless backend here")
        new = set(_sway_socks()) - before
        cand = sorted(new, key=lambda p: os.path.getmtime(p), reverse=True)
        for c in cand:
            rc = subprocess.run(
                ["swaymsg", "-s", c, "-t", "get_version"],
                capture_output=True, env=env,
            ).returncode
            if rc == 0:
                sock = c
                break
        if sock:
            break
        time.sleep(0.25)

    if sock is None:
        _kill(proc)
        pytest.skip("nested sway IPC socket never appeared")

    # Resolve this sway's WAYLAND_DISPLAY: the newest wayland-* socket.
    wl = _newest_wayland_display(env, sock)
    if wl is None:
        _kill(proc)
        pytest.skip("could not resolve nested WAYLAND_DISPLAY")

    try:
        yield {"swaysock": sock, "wayland_display": wl, "runtime_dir": RUNTIME_DIR}
    finally:
        _kill(proc)


def _sway_socks() -> list[str]:
    import glob
    return glob.glob(f"{RUNTIME_DIR}/sway-ipc.{UID}.*.sock")


def _newest_wayland_display(env: dict, sock: str) -> str | None:
    """Find the WAYLAND_DISPLAY whose grim can see HEADLESS-1 on this sway."""
    import glob
    socks = [
        p for p in glob.glob(f"{RUNTIME_DIR}/wayland-*")
        if not p.endswith(".lock")
    ]
    socks.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for p in socks:
        name = os.path.basename(p)
        e = dict(env)
        e["WAYLAND_DISPLAY"] = name
        r = subprocess.run(
            ["grim", "-o", "HEADLESS-1", "-"],
            capture_output=True, env=e,
        )
        if r.returncode == 0 and r.stdout[:8] == b"\x89PNG\r\n\x1a\n":
            return name
    return None


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass
