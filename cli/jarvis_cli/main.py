"""`jarvis` entry point — subcommand dispatch.

    jarvis                     full-screen TUI agent (all GUI screens, in the terminal)
    jarvis status              one-glance health snapshot
    jarvis doctor              deep health check with fixes (exit 1 on problems)
    jarvis start | stop        headless daemon (+engine) up/down — no GUI needed
    jarvis web start|stop      the browser dashboard
    jarvis ask "..."           one streamed turn straight to stdout
    jarvis sessions            recent sessions
    jarvis search "..."        full-text search across all chat history
    jarvis version             CLI + daemon versions
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from rich.console import Console


def _cmd_sessions() -> int:
    from rich.table import Table
    from jarvis_cli.control import one_call

    console = Console()
    try:
        rows = asyncio.run(one_call("session.list", {})).get("sessions", [])
    except Exception as exc:
        console.print(f"[red]{exc}[/red]")
        return 1
    t = Table(title=f"{len(rows)} session(s)", title_justify="left",
              header_style="bold cyan", border_style="bright_black")
    for col in ("id", "title", "brain", "state"):
        t.add_column(col)
    for r in rows[:30]:
        t.add_row(str(r.get("id", "")), str(r.get("title", ""))[:60],
                  str(r.get("brain", "")), str(r.get("state", "")))
    console.print(t)
    return 0


def _cmd_search(query: str) -> int:
    from jarvis_cli.control import one_call

    console = Console()
    try:
        hits = asyncio.run(one_call("session.search", {"q": query, "limit": 15})
                           ).get("hits", [])
    except Exception as exc:
        console.print(f"[red]{exc}[/red]")
        return 1
    if not hits:
        console.print("[yellow]no matches[/yellow]")
        return 0
    for h in hits:
        ev = h.get("ev", {})
        text = (ev.get("text") or ev.get("output") or "")[:160].replace("\n", " ")
        console.print(f"[cyan]{h.get('session_title') or h.get('session_id')}"
                      f"[/cyan] [bright_black]#{h.get('seq')}[/bright_black] {text}")
    return 0


def _cmd_version() -> int:
    from jarvis_cli import __version__
    from jarvis_cli.control import one_call

    console = Console()
    console.print(f"jarvis-cli [cyan]{__version__}[/cyan]")
    try:
        s = asyncio.run(one_call("settings.get", {}, timeout=5))
        s = s.get("settings", s)
        console.print(f"jarvisd    [cyan]{s.get('version', '?')}[/cyan] "
                      f"([bright_black]{s.get('git_sha', '?')}[/bright_black])")
    except Exception:
        console.print("jarvisd    [red]not reachable[/red]")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="jarvis",
        description="The Jarvis terminal — a full agent in your shell. "
                    "Run with no arguments for the TUI.")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("status", help="one-glance health snapshot")
    sub.add_parser("doctor", help="deep health check with suggested fixes")
    sub.add_parser("start", help="start jarvisd (+engine) headless — no GUI")
    sub.add_parser("stop", help="stop the headless daemon (+engine)")

    web = sub.add_parser("web", help="the browser dashboard")
    web.add_argument("action", choices=["start", "stop"])

    ask = sub.add_parser("ask", help='one streamed turn: jarvis ask "fix the failing test"')
    ask.add_argument("prompt")
    ask.add_argument("--session", help="continue an existing session id")
    ask.add_argument("--brain", help="codex | claude | api | ...")
    ask.add_argument("--model", help="model override for the brain")
    ask.add_argument("--timeout", type=float, default=600.0,
                     help="max seconds to wait between events (default 600)")

    sub.add_parser("sessions", help="list recent sessions")
    search = sub.add_parser("search", help="full-text search across ALL chat history")
    search.add_argument("query")
    sub.add_parser("version", help="CLI + daemon versions")
    sub.add_parser("tui", help="the full-screen TUI (same as no arguments)")

    args = parser.parse_args(argv)

    if args.cmd == "status":
        from jarvis_cli.doctor import cmd_status
        return cmd_status()
    if args.cmd == "doctor":
        from jarvis_cli.doctor import cmd_doctor
        return cmd_doctor()
    if args.cmd == "start":
        from jarvis_cli.services import cmd_start
        return cmd_start()
    if args.cmd == "stop":
        from jarvis_cli.services import cmd_stop
        return cmd_stop()
    if args.cmd == "web":
        from jarvis_cli.services import cmd_web
        return cmd_web(args.action)
    if args.cmd == "ask":
        from jarvis_cli.oneshot import cmd_ask
        return cmd_ask(args.prompt, args.session, args.brain, args.model,
                       args.timeout)
    if args.cmd == "sessions":
        return _cmd_sessions()
    if args.cmd == "search":
        return _cmd_search(args.query)
    if args.cmd == "version":
        return _cmd_version()

    # No subcommand (or explicit `tui`) -> the full-screen terminal agent.
    from jarvis_cli.tui.app import JarvisTui
    JarvisTui().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
