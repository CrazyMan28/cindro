"""`jarvis start|stop` (headless daemon + engine) and `jarvis web start|stop`.

Headless means: bring up jarvisd (and the computer-use engine service where one
exists) WITHOUT any GUI — chat then happens through this CLI, the web
dashboard, the phone, or the extension.

Linux: the installed systemd --user units (jarvisd, computer-use-mcp) are the
source of truth; fall back to launching the binaries directly when systemd is
unavailable. Windows: launch/stop jarvisd.exe from the install dir (the daemon
starts the frozen engine on demand).

HARD RULE respected here: never broad-kill by name — stop uses systemctl or
the exact PID we can attribute to the binary path.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from rich.console import Console

from jarvis_cli import config

console = Console()

IS_WIN = sys.platform.startswith("win")


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def _daemon_binary() -> Path | None:
    """Locate jarvisd across install layouts (Linux ~/.local/bin; Windows
    Program Files / a repo build tree; JARVIS_HOME override for tests)."""
    override = os.environ.get("JARVIS_HOME")
    candidates: list[Path] = []
    exe = "jarvisd.exe" if IS_WIN else "jarvisd"
    if override:
        candidates += [Path(override) / exe, Path(override) / "bin" / exe]
    if IS_WIN:
        for env in ("ProgramFiles", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                candidates.append(Path(base) / "Jarvis" / exe)
    else:
        candidates.append(Path.home() / ".local" / "bin" / exe)
    found = shutil.which(exe)
    if found:
        candidates.append(Path(found))
    for c in candidates:
        if c.is_file():
            return c
    return None


def _have_user_systemd() -> bool:
    if IS_WIN or not shutil.which("systemctl"):
        return False
    return _run(["systemctl", "--user", "is-system-running"]).returncode in (0, 1)
    # (degraded == rc 1 still means user systemd is answering)


def cmd_start() -> int:
    if _have_user_systemd():
        ok = True
        for unit in ("jarvisd", "computer-use-mcp"):
            r = _run(["systemctl", "--user", "start", unit])
            if r.returncode == 0:
                console.print(f"[green]✔[/green] started {unit} (systemd --user)")
            else:
                # engine unit is optional on minimal installs
                lvl = "red" if unit == "jarvisd" else "yellow"
                console.print(f"[{lvl}]•[/{lvl}] {unit}: {r.stderr.strip() or 'not installed'}")
                ok = ok and unit != "jarvisd"
        return 0 if ok else 1

    binary = _daemon_binary()
    if binary is None:
        console.print("[red]jarvisd not found[/red] — install Orin first "
                      "(packaging/install.sh on Linux, Jarvis-Setup.exe on Windows)")
        return 1
    creation = {}
    if IS_WIN:
        creation = {"creationflags": 0x00000008 | 0x00000200}  # DETACHED | NEW_PROCESS_GROUP
    subprocess.Popen([str(binary)], stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                     start_new_session=not IS_WIN, **creation)
    console.print(f"[green]✔[/green] launched {binary} headless")
    return 0


def cmd_stop() -> int:
    if _have_user_systemd():
        rc = 0
        for unit in ("jarvisd", "computer-use-mcp"):
            r = _run(["systemctl", "--user", "stop", unit])
            state = "stopped" if r.returncode == 0 else (r.stderr.strip() or "not running")
            console.print(f"[cyan]•[/cyan] {unit}: {state}")
            if unit == "jarvisd" and r.returncode != 0:
                rc = 1
        return rc
    if IS_WIN:
        # HARD RULE: stop by PID, never by image name — /IM would kill EVERY
        # jarvisd.exe (multi-profile installs, dev builds, CI runners). Match
        # only processes running THIS install's binary path.
        binary = _daemon_binary()
        if binary is None:
            console.print("[yellow]jarvisd.exe not found — nothing to stop[/yellow]")
            return 1
        safe_binary = str(binary).replace("'", "''")
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='jarvisd.exe'\" | "
              f"Where-Object {{ $_.ExecutablePath -eq '{safe_binary}' }} | "
              "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }")
        r = _run(["powershell", "-NoProfile", "-Command", ps])
        if r.returncode != 0:
            console.print(f"[red]•[/red] jarvisd ({binary}): failed to query process "
                          f"({r.stderr.strip() or 'unknown error'})")
            return 1
        pids = [p for p in r.stdout.split() if p.strip().isdigit()]
        console.print(f"[cyan]•[/cyan] jarvisd ({binary}): "
                      + (f"stopped pid {', '.join(pids)}" if pids else "not running"))
        return 0
    console.print("[yellow]no user systemd[/yellow] — stop the jarvisd process "
                  "you launched (kill <pid>); refusing to pkill by name")
    return 1


# --- web dashboard -------------------------------------------------------------

def _web_dir() -> Path | None:
    """Locate the Bun+Vite web dashboard (repo checkout or installed share)."""
    override = os.environ.get("JARVIS_WEB_DIR")
    candidates = [Path(override)] if override else []
    candidates += [
        config.data_dir() / "web",
        Path.home() / ".local" / "share" / "jarvis" / "web",
    ]
    # repo layouts: <repo>/web relative to this file (cli/jarvis_cli/services.py)
    here = Path(__file__).resolve()
    for up in (here.parents[2], here.parents[3] if len(here.parents) > 3 else None):
        if up:
            candidates.append(up / "web")
    for c in candidates:
        if c and (c / "server.ts").is_file():
            return c
    return None


def _web_pidfile() -> Path:
    return config.config_dir() / "web-dashboard.pid"


def _pid_alive(pid: int) -> bool:
    if IS_WIN:
        r = _run(["tasklist", "/FI", f"PID eq {pid}"])
        return str(pid) in r.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def cmd_web(action: str) -> int:
    pidfile = _web_pidfile()
    if action == "stop":
        try:
            pid = int(pidfile.read_text().strip())
        except (OSError, ValueError):
            console.print("[yellow]web dashboard pid file not found[/yellow] — "
                          "was it started with `jarvis web start`?")
            return 1
        try:
            if IS_WIN:
                _run(["taskkill", "/PID", str(pid), "/F"])
            else:
                os.kill(pid, 15)
            console.print(f"[green]✔[/green] stopped web dashboard (pid {pid})")
        except OSError as exc:
            console.print(f"[yellow]•[/yellow] pid {pid}: {exc}")
        pidfile.unlink(missing_ok=True)
        return 0

    try:
        existing_pid = int(pidfile.read_text().strip())
    except (OSError, ValueError):
        existing_pid = None
    if existing_pid and _pid_alive(existing_pid):
        port = os.environ.get("JARVIS_WEB_PORT", "8788")
        console.print(f"[yellow]•[/yellow] web dashboard already running (pid {existing_pid}) "
                      f"at http://127.0.0.1:{port} — stop it first with `jarvis web stop` "
                      "if you want to restart it")
        return 0

    web = _web_dir()
    if web is None:
        console.print("[red]web/ not found[/red] — run from an Orin checkout or "
                      "set JARVIS_WEB_DIR")
        return 1
    bun = shutil.which("bun")
    if bun is None:
        console.print("[red]bun not found on PATH[/red] — install it from https://bun.sh "
                      "to run the web dashboard")
        return 1

    if not (web / "node_modules").is_dir():
        console.print("[dim]installing web dashboard dependencies…[/dim]")
        install = _run([bun, "install"], cwd=str(web))
        if install.returncode != 0:
            console.print(f"[red]bun install failed[/red]\n{install.stderr}")
            return 1

    console.print("[dim]building web dashboard…[/dim]")
    build = _run([bun, "run", "build"], cwd=str(web))
    if build.returncode != 0:
        console.print(f"[red]web dashboard build failed[/red]\n{build.stderr}")
        return 1

    # server.ts's own default (8799 was serve.py's) collides with the legacy
    # phone server on some installs — always pass an explicit port.
    port = os.environ.get("JARVIS_WEB_PORT", "8788")
    proc = subprocess.Popen(
        [bun, "server.ts", "--port", port],
        cwd=str(web), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL, start_new_session=not IS_WIN,
    )
    time.sleep(0.8)
    if proc.poll() is not None:
        console.print("[red]web dashboard exited immediately[/red] — "
                      f"run `bun {web / 'server.ts'}` to see why")
        return 1
    pidfile.parent.mkdir(parents=True, exist_ok=True)
    pidfile.write_text(str(proc.pid))
    console.print(f"[green]✔[/green] web dashboard on http://127.0.0.1:{port} "
                  f"(pid {proc.pid}) — stop with: jarvis web stop")

    token = config.control_token()
    if token:
        console.print(f"[cyan]control token:[/cyan] {token}")
    else:
        console.print("[yellow]no control token found[/yellow] — pair from the desktop app "
                      "instead (Settings → Browser Extension → Generate pairing code)")
    return 0
