"""`cindro status` (quick snapshot) and `cindro doctor` (deep health check).

Both are read-only. `status` answers "is everything up?" in one glance;
`doctor` walks every layer (config, daemon, engine, phone, web, brains) and
prints what's wrong AND how to fix it. Exit code 0 = healthy, 1 = problems.
"""

from __future__ import annotations

import asyncio
import os
import socket
import sys

from rich.console import Console
from rich.table import Table

from jarvis_cli import config
from jarvis_cli.control import ControlClient

ENGINE_PORT = int(os.environ.get("JARVIS_ENGINE_PORT", "8794"))
PHONE_PORT = int(os.environ.get("JARVIS_PHONE_PORT", "8801"))
WEB_PORT = int(os.environ.get("JARVIS_WEB_PORT", "8788"))


def _tcp_open(port: int, host: str = "127.0.0.1", timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


async def _daemon_snapshot() -> dict:
    """Everything status/doctor wants from the daemon, in one connection."""
    out: dict = {"reachable": False}
    c = ControlClient()
    try:
        s = await c.call("settings.get", {}, timeout=6)
        out["reachable"] = True
        out["settings"] = s.get("settings", s)
        try:
            rows = (await c.call("session.list", {}, timeout=6)).get("sessions", [])
            out["sessions"] = len(rows)
            out["running"] = sum(1 for r in rows if r.get("state") == "running")
        except Exception:
            pass
        try:
            agents = (await c.call("agents.running", {}, timeout=6)).get("agents", [])
            out["agents_running"] = sum(1 for a in agents if a.get("running"))
        except Exception:
            pass
        try:
            sub = await c.call("phone.event.subscribe", {}, timeout=6)
            out["phone_bridge"] = bool(sub.get("bridge_connected"))
        except Exception:
            pass
    except Exception as exc:
        out["error"] = str(exc)
    finally:
        await c.close()
    return out


def _mark(ok: bool, good: str = "up", bad: str = "down") -> str:
    return f"[green]● {good}[/green]" if ok else f"[red]● {bad}[/red]"


def cmd_status() -> int:
    console = Console()
    snap = asyncio.run(_daemon_snapshot())
    settings = snap.get("settings", {})

    t = Table(title="Cindro status", title_justify="left",
              header_style="bold cyan", border_style="bright_black")
    t.add_column("component")
    t.add_column("state")
    t.add_column("detail", overflow="fold")

    daemon_detail = ""
    if snap.get("reachable"):
        daemon_detail = (f"v{settings.get('version', '?')} "
                         f"({settings.get('git_sha', '?')}) "
                         f"on :{config.control_port()}")
    else:
        daemon_detail = snap.get("error", "not reachable")
    t.add_row("jarvisd (daemon)", _mark(snap.get("reachable", False)), daemon_detail)

    engine_up = _tcp_open(ENGINE_PORT)
    t.add_row("computer-use engine", _mark(engine_up),
              f"127.0.0.1:{ENGINE_PORT}" if engine_up else
              f"nothing listening on :{ENGINE_PORT}")

    phone_up = _tcp_open(PHONE_PORT)
    detail = f"127.0.0.1:{PHONE_PORT}"
    if snap.get("phone_bridge") is not None:
        detail += (" · event bridge connected" if snap.get("phone_bridge")
                   else " · event bridge NOT connected")
    t.add_row("phone server", _mark(phone_up, bad="not running"),
              detail if phone_up else "optional — phone subsystem not set up")

    web_up = _tcp_open(WEB_PORT)
    t.add_row("web dashboard", _mark(web_up, bad="not running"),
              f"http://127.0.0.1:{WEB_PORT}" if web_up
              else "optional — start with: cindro web start")

    if snap.get("reachable"):
        t.add_row("sessions", "[cyan]·[/cyan]",
                  f"{snap.get('sessions', 0)} total, "
                  f"{snap.get('running', 0)} mid-turn, "
                  f"{snap.get('agents_running', 0)} background agents running")
        t.add_row("brain", "[cyan]·[/cyan]",
                  f"{settings.get('default_brain', '?')} / "
                  f"{settings.get('default_model', '') or 'default model'}")

    console.print(t)
    return 0 if snap.get("reachable") else 1


def cmd_doctor() -> int:
    console = Console()
    problems = 0

    def check(ok: bool, what: str, fix: str = "") -> None:
        nonlocal problems
        if ok:
            console.print(f"  [green]✔[/green] {what}")
        else:
            problems += 1
            console.print(f"  [red]✘[/red] {what}")
            if fix:
                console.print(f"      [yellow]fix:[/yellow] {fix}")

    console.print("[bold cyan]cindro doctor[/bold cyan]")

    console.print("[bold]config[/bold]")
    cdir = config.config_dir()
    check(cdir.is_dir(), f"config dir {cdir}",
          "run the daemon once (cindro start) to create it")
    tok = config.control_token()
    check(bool(tok), f"control token ({cdir / 'control_token'})",
          "start jarvisd once — it generates the token on first run")
    check((cdir / "config.toml").is_file(), f"config.toml ({cdir / 'config.toml'})",
          "created by the daemon / setup wizard on first run")

    console.print("[bold]data[/bold]")
    ddir = config.data_dir()
    check(ddir.is_dir(), f"data dir {ddir}",
          "created on first daemon run")

    console.print("[bold]daemon[/bold]")
    port_open = _tcp_open(config.control_port())
    check(port_open, f"control port 127.0.0.1:{config.control_port()}",
          "cindro start   (Linux: systemctl --user status jarvisd)")
    snap = asyncio.run(_daemon_snapshot()) if port_open else {}
    if port_open:
        check(snap.get("reachable", False),
              "Contract A handshake (auth + settings.get)",
              "token mismatch? re-read ~/.config/jarvis/control_token; "
              "restart the daemon if it persists")
        if snap.get("reachable"):
            s = snap.get("settings", {})
            console.print(f"      version [cyan]{s.get('version', '?')}[/cyan] "
                          f"sha [cyan]{s.get('git_sha', '?')}[/cyan] · "
                          f"{snap.get('sessions', 0)} sessions")
            brains = s.get("brains", [])
            check(bool(brains), f"brains available ({', '.join(brains) or 'none'})",
                  "install codex or claude CLI, or add an API key in Settings")

    console.print("[bold]engine[/bold]")
    check(_tcp_open(ENGINE_PORT),
          f"computer-use engine 127.0.0.1:{ENGINE_PORT}",
          "Linux: systemctl --user status computer-use-mcp; "
          "Windows: the daemon starts jarvis-engine.exe on demand")

    console.print("[bold]optional[/bold]")
    if _tcp_open(PHONE_PORT):
        bridge = snap.get("phone_bridge")
        check(bridge is not False,
              "phone server + event bridge",
              "restart jarvisd to reconnect the bridge")
    else:
        console.print("  [bright_black]–[/bright_black] phone server not running "
                      "(fine unless you use the phone subsystem)")
    if _tcp_open(WEB_PORT):
        console.print(f"  [green]✔[/green] web dashboard http://127.0.0.1:{WEB_PORT}")
    else:
        console.print("  [bright_black]–[/bright_black] web dashboard not running "
                      "(cindro web start)")

    if problems == 0:
        console.print("\n[bold green]all checks passed[/bold green]")
        return 0
    console.print(f"\n[bold red]{problems} problem(s) found[/bold red]")
    return 1
