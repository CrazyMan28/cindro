"""`jarvis ask "..."` — one streamed turn without the full TUI.

Creates a session (or reuses --session), sends the prompt, and streams the
NormalizedBrainEvent flow to stdout with rich formatting until the `final`
event. Approvals auto-DENY in one-shot mode (nobody is watching a pipe) with
a note telling the user to use the TUI for interactive approvals.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from rich.console import Console
from rich.markdown import Markdown

from jarvis_cli.control import ControlClient, ControlError

console = Console()


def _shorten(text: str, n: int = 400) -> str:
    text = text.strip()
    return text if len(text) <= n else text[: n - 1] + "…"


async def _run(prompt: str, session_id: Optional[str], brain: Optional[str],
               model: Optional[str], timeout: float) -> int:
    c = ControlClient()
    rc = 0
    created = False
    try:
        if not session_id:
            params = {"profile": "coworker", "title": _shorten(prompt, 60)}
            if brain:
                params["brain"] = brain
            if model:
                params["model"] = model
            res = await c.call("session.create", params, timeout=20)
            session_id = res.get("session_id", "")
            if not session_id:
                console.print("[red]session.create returned no id[/red]")
                return 1
            created = True
        queue = await c.subscribe(session_id)
        await c.call("session.send", {"session_id": session_id, "text": prompt},
                     timeout=30)

        while True:
            try:
                ev = await asyncio.wait_for(queue.get(), timeout=timeout)
            except asyncio.TimeoutError:
                console.print(f"[red]no events for {timeout:.0f}s — giving up "
                              f"(session {session_id} may still be running)[/red]")
                return 1
            kind = ev.get("kind", "")
            if kind == "thinking":
                txt = _shorten(ev.get("text", ""), 200)
                if txt:
                    console.print(f"[bright_black]· {txt}[/bright_black]")
            elif kind == "message":
                if ev.get("role") == "assistant":
                    console.print(Markdown(ev.get("text", "")))
            elif kind == "tool_call":
                console.print(f"[yellow]⚙ {ev.get('name', 'tool')}[/yellow] "
                              f"[bright_black]{_shorten(str(ev.get('args', '')), 120)}"
                              f"[/bright_black]")
            elif kind == "tool_result":
                out = _shorten(str(ev.get('output', '')), 160)
                if out:
                    console.print(f"[bright_black]  ↳ {out}[/bright_black]")
            elif kind == "approval":
                console.print("[red]✋ approval requested — auto-DENIED in one-shot "
                              "mode (use `jarvis` TUI to approve interactively)[/red]")
                try:
                    await c.call("approval.respond",
                                 {"session_id": session_id,
                                  "approval_id": str(ev.get("approval_id", "")),
                                  "decision": "deny"}, timeout=10)
                except ControlError:
                    pass
            elif kind == "error":
                console.print(f"[red]error: {ev.get('message', '')}[/red]")
                rc = 1
            elif kind == "final":
                break
        if created:
            console.print(f"[bright_black]— session {session_id} (continue with: "
                          f"jarvis ask --session {session_id} \"...\")[/bright_black]")
        return rc
    except (ConnectionError, ControlError, TimeoutError) as exc:
        console.print(f"[red]{exc}[/red]")
        return 1
    finally:
        await c.close()


def cmd_ask(prompt: str, session_id: Optional[str] = None,
            brain: Optional[str] = None, model: Optional[str] = None,
            timeout: float = 600.0) -> int:
    return asyncio.run(_run(prompt, session_id, brain, model, timeout))
