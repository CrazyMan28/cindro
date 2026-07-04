"""The Chat tab — the Claude-Code-style terminal agent.

A RichLog transcript streams the session's NormalizedBrainEvent flow live
(thinking, messages, tool cards, approvals, errors, canvas-widget notes) and
an Input at the bottom sends turns. Slash commands:

    /new             start a fresh conversation
    /stop            cancel the running turn
    /goal <text>     set a persistent goal on this session (empty clears)
    /y  /n           approve / deny the pending permission request
"""

from __future__ import annotations

import asyncio
import json
from typing import Optional

from rich.markdown import Markdown
from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Input, RichLog, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.command_palette import CommandPalette

BUILTIN_COMMANDS = [
    ("new", "start a fresh chat"), ("stop", "cancel the current turn"),
    ("goal", "set the session goal"), ("y", "approve the pending action"),
    ("n", "deny the pending action"), ("canvas", "open the Canvas tab"),
    ("widgets", "open the Widgets tab"), ("phone", "open the Phone tab"),
    ("computer", "open the Computer tab"), ("browser", "open the Browser tab"),
    ("activity", "open the Activity tab"), ("replay", "open the Replay tab"),
    ("mcp", "open the MCP tab"), ("plugins", "open the Plugins tab"),
    ("ssh", "open the SSH tab"), ("memorygraph", "open the Memory Graph tab"),
    ("home", "open the Home tab"), ("schedules", "open the Schedules tab"),
    ("tui", "ask Jarvis to add/edit/remove a TUI page"),
]

TAB_JUMP_COMMANDS = {name for name, _ in BUILTIN_COMMANDS
                    if name not in ("new", "stop", "goal", "y", "n")}


class BrainEvent(Message):
    """A session event forwarded from the pump worker to the UI thread."""

    def __init__(self, session_id: str, ev: dict) -> None:
        self.session_id = session_id
        self.ev = ev
        super().__init__()


class ChatPane(Vertical):
    """Owns ONE active session at a time (switchable from the Sessions tab)."""

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.session_id: str = ""
        self.pending_approval: str = ""
        self._pump_task: Optional[asyncio.Task] = None

    # -- layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:
        yield RichLog(id="transcript", wrap=True, markup=False, auto_scroll=True)
        yield Static("", id="chat-status")
        yield Input(placeholder="Message Jarvis…  (/new /stop /goal /y /n)",
                    id="chat-input")

    def on_mount(self) -> None:
        log = self.query_one("#transcript", RichLog)
        log.write(Text("◉ JARVIS", style="bold cyan"))
        log.write(Text("Type a message to start a conversation. "
                       "Tab switches screens; Ctrl+Q quits.", style="bright_black"))

    # -- helpers ---------------------------------------------------------------
    @property
    def client(self):
        return self.app.client  # the shared ControlClient (JarvisTui owns it)

    def _log(self, renderable) -> None:
        self.query_one("#transcript", RichLog).write(renderable)

    def _status(self, text: str, style: str = "bright_black") -> None:
        self.query_one("#chat-status", Static).update(Text(text, style=style))

    # -- session lifecycle -------------------------------------------------------
    async def open_session(self, session_id: str, title: str = "") -> None:
        """Attach the chat to an existing session (from the Sessions tab)."""
        self._cancel_pump()
        self.session_id = session_id
        self.pending_approval = ""
        log = self.query_one("#transcript", RichLog)
        log.clear()
        log.write(Text(f"— session {title or session_id} —", style="bold cyan"))
        try:
            hist = await self.client.call("session.history",
                                          {"session_id": session_id, "limit": 40})
            for item in hist.get("events", []):
                self._render_ev(item.get("ev", item), replay=True)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            log.write(Text(f"history unavailable: {exc}", style="yellow"))
        await self.client.subscribe(session_id)
        self._ensure_pump()

    async def _ensure_session(self) -> str:
        if self.session_id:
            return self.session_id
        res = await self.client.call("session.create", {"profile": "coworker"},
                                     timeout=20)
        self.session_id = res.get("session_id", "")
        if not self.session_id:
            raise ControlError("bad_reply", "session.create returned no session_id")
        await self.client.subscribe(self.session_id)
        self._ensure_pump()
        return self.session_id

    def _ensure_pump(self) -> None:
        if self._pump_task is None or self._pump_task.done():
            self._pump_task = asyncio.create_task(self._pump())

    def _cancel_pump(self) -> None:
        # A pump parked in q.get() on the OLD session's queue would never see
        # a session switch — kill it; the next _ensure_pump starts fresh.
        if self._pump_task is not None and not self._pump_task.done():
            self._pump_task.cancel()
        self._pump_task = None

    async def _pump(self) -> None:
        """Forward the ACTIVE session's events into the textual message queue.
        Bounded waits so a session switch is picked up within half a second
        even while parked on the previous session's queue."""
        try:
            while self.session_id:
                sid = self.session_id
                q = self.client.queue_for(sid)
                if q is None:
                    await asyncio.sleep(0.2)
                    continue
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                self.post_message(BrainEvent(sid, ev))
        except asyncio.CancelledError:
            pass

    # -- input -----------------------------------------------------------------
    async def on_input_changed(self, event) -> None:
        if event.input.id != "chat-input":
            return
        value = event.value
        if value.startswith("/") and " " not in value:
            await self._open_or_update_palette(value[1:])
        else:
            self._close_palette()

    async def _open_or_update_palette(self, query: str) -> None:
        try:
            existing = self.query_one(CommandPalette)
        except Exception:
            try:
                res = await self.client.call("command.list", {})
                customs = [(c["name"], c.get("description", "")) for c in res.get("commands", [])]
            except Exception:
                customs = []
            existing = CommandPalette(BUILTIN_COMMANDS, customs)
            await self.mount(existing)
        existing.filter(query)

    def _close_palette(self) -> None:
        try:
            self.query_one(CommandPalette).remove()
        except Exception:
            pass

    async def run_slash_command(self, name: str, args: str) -> None:
        if name in ("y", "yes"):
            await self._respond_approval(True)
        elif name in ("n", "no"):
            await self._respond_approval(False)
        elif name == "new":
            await self.new_session()
        elif name == "stop":
            await self._stop_turn()
        elif name == "goal":
            await self._set_goal(args)
        elif name in TAB_JUMP_COMMANDS:
            from textual.widgets import TabbedContent
            self.app.query_one(TabbedContent).active = f"tab-{name}"
        else:
            try:
                res = await self.app.client.call("command.invoke", {"name": name, "args": args})
            except Exception as exc:
                self.notify(str(exc), severity="error")
                return
            if "prompt" in res:
                await self._send(res["prompt"])
            elif "mcp_tool" in res:
                self.notify(f"custom command '{name}' calls MCP tool "
                           f"'{res['mcp_tool']}' — invoke it via a normal chat turn "
                           f"for now (direct in-TUI MCP dispatch is a fast-follow)")
            elif "shell" in res:
                self.notify(f"custom command '{name}' would run script "
                           f"'{res['shell']}' — shell execution wiring is a fast-follow")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "chat-input":
            return
        text = event.value.strip()
        try:
            palette = self.query_one(CommandPalette)
        except Exception:
            palette = None
        if palette is not None:
            name = palette.selected_name() or (text[1:] if text.startswith("/") else text[1:])
            self._close_palette()
            event.input.value = ""
            if name:
                parts = name.split(" ", 1)
                await self.run_slash_command(parts[0], parts[1] if len(parts) > 1 else "")
            return
        event.input.value = ""
        if not text:
            return
        if text.startswith("/"):
            parts = text[1:].split(" ", 1)
            await self.run_slash_command(parts[0], parts[1] if len(parts) > 1 else "")
            return
        await self._send(text)

    @work(exclusive=False)
    async def new_session(self) -> None:
        self._cancel_pump()
        if self.session_id:
            await self.client.unsubscribe(self.session_id)
        self.session_id = ""
        self.pending_approval = ""
        log = self.query_one("#transcript", RichLog)
        log.clear()
        log.write(Text("— new conversation —", style="bold cyan"))
        self._status("")

    async def _send(self, text: str) -> None:
        try:
            sid = await self._ensure_session()
            self._log(Text(f"❯ {text}", style="bold white"))
            self._status("thinking…", "cyan")
            await self.client.call("session.send", {"session_id": sid, "text": text},
                                   timeout=30)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self._log(Text(f"send failed: {exc}", style="red"))
            self._status("")

    async def _stop_turn(self) -> None:
        if not self.session_id:
            return
        try:
            await self.client.call("session.cancel", {"session_id": self.session_id})
            self._status("turn cancelled", "yellow")
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self._log(Text(f"cancel failed: {exc}", style="red"))

    async def _set_goal(self, goal: str) -> None:
        try:
            sid = await self._ensure_session()
            await self.client.call("session.set_goals",
                                   {"session_id": sid, "goals": goal})
            self._log(Text(f"◎ goal {'cleared' if not goal else 'set: ' + goal}",
                           style="magenta"))
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self._log(Text(f"set_goals failed: {exc}", style="red"))

    async def _respond_approval(self, allow: bool) -> None:
        if not self.pending_approval or not self.session_id:
            self._status("no approval pending")
            return
        try:
            await self.client.call("approval.respond",
                                   {"session_id": self.session_id,
                                    "approval_id": self.pending_approval,
                                    "decision": "allow" if allow else "deny"})
            self._log(Text(f"✋ {'allowed' if allow else 'denied'}",
                           style="green" if allow else "red"))
            self.pending_approval = ""
            self._status("")
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self._log(Text(f"approval.respond failed: {exc}", style="red"))

    # -- event rendering ---------------------------------------------------------
    def on_brain_event(self, msg: BrainEvent) -> None:
        if msg.session_id != self.session_id:
            return  # stale pump delivery from a previous session
        self._render_ev(msg.ev)

    def _render_ev(self, ev: dict, replay: bool = False) -> None:
        kind = ev.get("kind", "")
        if kind == "thinking":
            txt = (ev.get("text") or "").strip()
            if txt and not replay:
                self._status("· " + txt.splitlines()[-1][:120], "bright_black")
        elif kind == "message":
            role = ev.get("role", "")
            text = ev.get("text", "")
            if role == "assistant":
                self._log(Markdown(text))
                if not replay:
                    self._status("")
            elif role == "user":
                self._log(Text(f"❯ {text}", style="bold white"))
        elif kind == "tool_call":
            args = ev.get("args", "")
            if not isinstance(args, str):
                args = json.dumps(args)
            self._log(Text(f"⚙ {ev.get('name', 'tool')} {args[:140]}",
                           style="yellow"))
            if not replay:
                self._status(f"running {ev.get('name', 'tool')}…", "yellow")
        elif kind == "tool_result":
            out = str(ev.get("output", "")).strip()
            if out:
                self._log(Text("  ↳ " + out[:200].replace("\n", " ⏎ "),
                               style="bright_black"))
        elif kind == "approval":
            self.pending_approval = str(ev.get("approval_id", ""))
            what = ev.get("summary") or ev.get("tool") or "an action"
            self._log(Text(f"✋ Jarvis asks permission: {what}", style="bold red"))
            self._log(Text("   type /y to allow · /n to deny", style="red"))
            self._status("approval pending — /y or /n", "red")
        elif kind == "error":
            self._log(Text(f"✖ {ev.get('message', 'error')}", style="bold red"))
            if not replay:
                self._status("")
        elif kind == "final":
            self._log(Text("─" * 40, style="bright_black"))
            if not replay:
                self._status("")
