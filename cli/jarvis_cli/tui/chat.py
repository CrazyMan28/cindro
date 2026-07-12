"""The Chat tab — the Claude-Code-style terminal agent.

A RichLog transcript streams the session's NormalizedBrainEvent flow live
(thinking, messages, tool cards, approvals, errors, canvas-widget notes) and
an Input at the bottom sends turns. Slash commands:

    /new             start a fresh conversation
    /stop            cancel the running turn
    /goal <text>     set a persistent goal on this session (empty clears)
    /y  /n           approve / deny the pending permission request
    /voice           open push-to-talk voice mode (same as F2)
    /stage <file>    stage a file from the last `diff` event
    /commit [msg]    commit staged changes (message optional)
    /revert <file>   revert a file from the last `diff` event
    /openpr [title]  open a pull request (title optional)

The command palette itself (see command_palette.py) renders directly ABOVE
this Input, not below it — mounted with before=<the Input widget> rather than
appended after it.
"""

from __future__ import annotations

import asyncio
import json
import math
from typing import Optional

from rich.markdown import Markdown
from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.css.query import NoMatches
from textual.message import Message
from textual.widgets import Input, ListItem, ListView, RichLog, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.activity_pane import ActivityPane
from jarvis_cli.tui.arc_reactor import ArcReactorWidget
from jarvis_cli.tui.command_palette import CommandPalette, PALETTE_TRANSITION_MS
from jarvis_cli.tui.degrade import call_degrading
from jarvis_cli.tui.diff_render import render_diff_event
from jarvis_cli.tui.misc_panes import MemoryGraphPane, SchedulesPane
from jarvis_cli.tui.quick_view import QuickViewScreen
from jarvis_cli.tui.screens import AgentsPane, MemoryPane, QueuePane, SessionsPane, SkillsPane
from jarvis_cli.tui.system_panes import McpPane, OutpostPane, PluginsPane

# typewriter reveal tuning (see _start_typewriter): a bounded total duration
# regardless of message length, so huge replies never make the user wait.
TYPEWRITER_TICK_MS = 18
TYPEWRITER_MIN_MS = 300
TYPEWRITER_MAX_MS = 1800
TYPEWRITER_MS_PER_CHAR = 6

BUILTIN_COMMANDS = [
    ("new", "start a fresh chat"), ("stop", "cancel the current turn"),
    ("goal", "set the session goal"), ("y", "approve the pending action"),
    ("n", "deny the pending action"), ("chat", "open the Chat tab"),
    ("sessions", "peek at Sessions"), ("memory", "peek at Memory"),
    ("skills", "peek at Skills"), ("agents", "peek at Agents"),
    ("queue", "peek at Queue"), ("settings", "open the Settings tab"),
    ("canvas", "open the Canvas tab"),
    ("widgets", "open the Widgets tab"), ("phone", "open the Phone tab"),
    ("computer", "open the Computer tab"), ("browser", "open the Browser tab"),
    ("activity", "peek at Activity"), ("replay", "open the Replay tab"),
    ("mcp", "peek at MCP"), ("plugins", "peek at Plugins"),
    ("outpost", "peek at Outpost"), ("memorygraph", "peek at the Memory Graph"),
    ("home", "open the Home tab"), ("schedules", "peek at Schedules"),
    ("tui", "ask Jarvis to add/edit/remove a TUI page"),
    ("model", "pick the active model"),
    ("provider", "pick codex, claude, or api"),
    ("voice", "open push-to-talk voice mode"),
    ("stage", "stage a file from the last diff"),
    ("commit", "commit staged changes"),
    ("revert", "revert a file from the last diff"),
    ("openpr", "open a pull request for the current branch"),
]

# These 11 screens have NO tab-* TabPane in app.py's main TabbedContent at
# all anymore — they open ONLY as an inline QuickViewScreen popup (see
# quick_view.py). A fresh pane instance is built by the factory each time,
# with its own "*-quick" id, so repeated opens never collide with each other.
POPUP_PANE_FACTORIES = {
    "memory": lambda: MemoryPane(id="memory-quick"),
    "skills": lambda: SkillsPane(id="skills-quick"),
    "agents": lambda: AgentsPane(id="agents-quick"),
    "queue": lambda: QueuePane(id="queue-quick"),
    "activity": lambda: ActivityPane(id="activity-quick"),
    "memorygraph": lambda: MemoryGraphPane(id="memorygraph-quick"),
    "mcp": lambda: McpPane(id="mcp-quick"),
    "plugins": lambda: PluginsPane(id="plugins-quick"),
    "outpost": lambda: OutpostPane(id="outpost-quick"),
    "schedules": lambda: SchedulesPane(id="schedules-quick"),
    "sessions": lambda: SessionsPane(id="sessions-quick"),
}
POPUP_COMMANDS = set(POPUP_PANE_FACTORIES)

# The remaining tab-jump commands still switch TabbedContent.active — these
# now equal EXACTLY the 9 real "tab-*" ids in app.py's TabbedContent (home,
# chat, canvas, widgets, phone, computer, browser, replay, settings). "tui" is
# an ACTION command (asks Jarvis to edit the TUI layout), not a tab to jump
# to — there is no "tab-tui" TabPane in app.py. "model"/"provider" are picker
# commands (see run_slash_command), not tab jumps either. "voice" pushes the
# full-screen VoiceModeScreen (same as F2) — also not a tab. "stage"/"commit"/
# "revert"/"openpr" are diff-review actions (see _diff_action) — also not tabs.
TAB_JUMP_COMMANDS = {name for name, _ in BUILTIN_COMMANDS
                    if name not in ("new", "stop", "goal", "y", "n", "tui",
                                     "model", "provider", "voice", "stage",
                                     "commit", "revert", "openpr")
                    and name not in POPUP_COMMANDS}


class BrainEvent(Message):
    """A session event forwarded from the pump worker to the UI thread."""

    def __init__(self, session_id: str, ev: dict) -> None:
        self.session_id = session_id
        self.ev = ev
        super().__init__()


class PickerWidget(Vertical):
    """Ad-hoc inline picker: a plain ListView of (value, label) options hosted
    inside a QuickViewScreen popup. Selecting an item calls the given
    zero-return async callback with the option's VALUE (not its label), then
    dismisses the popup — used by /provider and /model instead of a full
    Pane class since neither needs its own tab/data-fetch lifecycle."""

    def __init__(self, options: list[tuple[str, str]], on_pick, **kw) -> None:
        super().__init__(**kw)
        self._options = options
        self._on_pick = on_pick

    def compose(self) -> ComposeResult:
        items = []
        for value, label in self._options:
            item = ListItem(Static(label))
            item.picker_value = value  # stashed for on_list_view_selected
            items.append(item)
        # Items are passed to the constructor (not .append()-ed after) since
        # ListView.append()/.extend() try to mount immediately — which
        # raises MountError while this widget itself is still being composed
        # (not yet attached to the DOM).
        yield ListView(*items, id="picker-list")

    async def on_list_view_selected(self, event: "ListView.Selected") -> None:
        value = getattr(event.item, "picker_value", None)
        if value is None:
            return
        await self._on_pick(value)
        self.app.pop_screen()


class ChatPane(Vertical):
    """Owns ONE active session at a time (switchable from the Sessions tab)."""

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.session_id: str = ""
        self.pending_approval: str = ""
        self._pump_task: Optional[asyncio.Task] = None
        # the in-progress typewriter reveal (see _start_typewriter) and the
        # full text it's revealing — kept alongside the task so a cancel
        # (new message / /stop / /new / session switch) can flush whatever
        # was in flight straight into the permanent transcript instead of
        # leaving a half-typed line stranded in #typing-preview.
        self._typewriter_task: Optional[asyncio.Task] = None
        self._typewriter_text: str = ""

    # -- layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:
        # landing reactor: the Chat pane's "empty state" — a big ambiently
        # spinning reactor shown only until a conversation is under way.
        yield ArcReactorWidget(size=13, spinning=True, thinking=False,
                               id="landing-reactor")
        yield RichLog(id="transcript", wrap=True, markup=False, auto_scroll=True)
        # where the in-progress typewriter reveal lives (see _start_typewriter);
        # empty/hidden until a live assistant reply starts revealing.
        yield Static("", id="typing-preview")
        yield Horizontal(
            ArcReactorWidget(size=5, spinning=True, thinking=False,
                             id="status-reactor"),
            Static("", id="chat-status"),
            id="status-row",
        )
        yield Input(placeholder="Message Jarvis…  (/new /stop /goal /y /n)",
                    id="chat-input")

    def on_mount(self) -> None:
        log = self.query_one("#transcript", RichLog)
        log.write(Text("◉ JARVIS", style="bold cyan"))
        log.write(Text("Type a message to start a conversation. "
                       "Tab switches screens; Ctrl+Q quits.", style="bright_black"))
        status_reactor = self.query_one("#status-reactor", ArcReactorWidget)
        status_reactor.display = False
        status_reactor.pause()
        self._update_landing_reactor()

    # -- helpers ---------------------------------------------------------------
    @property
    def client(self):
        return self.app.client  # the shared ControlClient (JarvisTui owns it)

    def _log(self, renderable) -> None:
        self.query_one("#transcript", RichLog).write(renderable)

    def _status(self, text: str, style: str = "bright_black") -> None:
        self.query_one("#chat-status", Static).update(Text(text, style=style))

    def _update_landing_reactor(self) -> None:
        """The big ambient reactor is the Chat pane's empty state — visible
        only until a conversation is under way (a session exists)."""
        try:
            reactor = self.query_one("#landing-reactor", ArcReactorWidget)
        except Exception:
            return
        visible = not self.session_id
        reactor.display = visible
        if visible:
            reactor.resume()
        else:
            reactor.pause()

    def _set_thinking(self, active: bool) -> None:
        """Show/hide the small reactor near #chat-status and gate its
        `.thinking` animation — mirrors a turn being in flight."""
        try:
            reactor = self.query_one("#status-reactor", ArcReactorWidget)
        except Exception:
            return
        reactor.display = active
        reactor.thinking = active
        if active:
            reactor.resume()
        else:
            reactor.pause()

    # -- typewriter reveal -------------------------------------------------------
    def _start_typewriter(self, text: str) -> None:
        """Progressively reveal a LIVE assistant reply into #typing-preview,
        then finalize it into the permanent RichLog transcript. Any reveal
        already in flight is cancelled first (and its text flushed in full —
        see _cancel_typewriter) so a fast second reply never leaves a
        half-typed line stranded."""
        self._cancel_typewriter()
        self._typewriter_text = text
        self._typewriter_task = asyncio.create_task(self._reveal_typewriter(text))

    async def _reveal_typewriter(self, text: str) -> None:
        preview = self.query_one("#typing-preview", Static)
        total_ms = min(TYPEWRITER_MAX_MS,
                       max(TYPEWRITER_MIN_MS, len(text) * TYPEWRITER_MS_PER_CHAR))
        ticks = max(1, int(total_ms // TYPEWRITER_TICK_MS))
        chunk = max(1, math.ceil(len(text) / ticks))
        n = 0
        while n < len(text):
            n = min(len(text), n + chunk)
            # Plain text during the reveal — no per-tick Markdown re-parse.
            # The real Markdown parse happens exactly once below, when the
            # completed text is finalized into the permanent transcript.
            preview.update(Text(text[:n]))
            if n < len(text):
                await asyncio.sleep(TYPEWRITER_TICK_MS / 1000.0)
        # completed naturally (not cancelled) — finalize into the permanent
        # scrollback and clear the live preview + in-flight bookkeeping.
        self._typewriter_text = ""
        self._typewriter_task = None
        preview.update("")
        self._log(Markdown(text))

    def _cancel_typewriter(self) -> None:
        """Cancel any in-progress reveal. If one was in flight, its full text
        is flushed straight into the transcript (rather than left half-typed
        in #typing-preview) — covers a new live message arriving mid-reveal,
        /stop, /new, and session switches."""
        task = self._typewriter_task
        self._typewriter_task = None
        if task is not None and not task.done():
            task.cancel()
        pending = self._typewriter_text
        self._typewriter_text = ""
        if pending:
            try:
                self.query_one("#typing-preview", Static).update("")
            except Exception:
                pass
            self._log(Markdown(pending))

    # -- session lifecycle -------------------------------------------------------
    async def open_session(self, session_id: str, title: str = "") -> None:
        """Attach the chat to an existing session (from the Sessions tab)."""
        self._cancel_pump()
        self.session_id = session_id
        self.pending_approval = ""
        self._set_thinking(False)
        self._update_landing_reactor()
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
        # Every caller of _cancel_pump (new_session/open_session, and this
        # method itself is called on any session switch) is a point where an
        # in-flight typewriter reveal must not keep writing into what is
        # about to become the WRONG session's view.
        self._cancel_typewriter()

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
            if existing.closing:
                # Mid exit-fade (see _close_palette) — let it finish
                # disappearing and mount a fresh one rather than reusing an
                # instance that's animating toward invisible.
                existing.remove()
                raise NoMatches("palette is closing")
        except Exception:
            try:
                res = await self.client.call("command.list", {})
                customs = [(c["name"], c.get("description", "")) for c in res.get("commands", [])]
            except Exception:
                customs = []
            existing = CommandPalette(BUILTIN_COMMANDS, customs)
            # Mount directly ABOVE the input line (not appended after it,
            # which would render below) — same before=/after= positional
            # mount TablePane uses to place its spinner right after a
            # specific widget (see screens.py TablePane.on_mount).
            await self.mount(existing, before=self.query_one("#chat-input"))
        existing.filter(query)

    def _close_palette(self) -> None:
        """Dismiss the palette with a brief fade/slide-out instead of an
        abrupt removal. Idempotent: safe to call with no palette mounted,
        or repeatedly on one that's already fading out — either way it just
        returns without raising (matches the surrounding try/except style)."""
        try:
            palette = self.query_one(CommandPalette)
        except Exception:
            return
        if palette.closing:
            return  # already fading out — a timer is already queued to remove it
        palette.start_exit()
        self.set_timer(PALETTE_TRANSITION_MS / 1000.0,
                       lambda: self._remove_palette(palette))

    def _remove_palette(self, palette: CommandPalette) -> None:
        try:
            if palette.parent is not None:  # still attached — not already removed
                palette.remove()
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
        elif name == "tui":
            await self._send(f"Please help me with the TUI page layout: {args}"
                             if args else "Please help me with the TUI page layout.")
        elif name == "provider":
            await self._open_provider_picker()
        elif name == "model":
            await self._open_model_picker()
        elif name == "voice":
            # Same call F2's action_voice_mode makes — reuse it rather than
            # duplicating the push_screen(VoiceModeScreen(...)) call.
            self.app.action_voice_mode()
        elif name in ("stage", "revert"):
            await self._diff_action(name, args)
        elif name == "commit":
            await self._diff_action("commit", args)
        elif name == "openpr":
            await self._diff_action("open_pr", args)
        elif name in POPUP_COMMANDS:
            factory = POPUP_PANE_FACTORIES[name]
            title = name.capitalize() if name != "mcp" else "MCP"
            if name == "outpost":
                title = "Outpost"
            elif name == "memorygraph":
                title = "Memory Graph"
            self.app.push_screen(QuickViewScreen(title, factory))
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
            elif "mcp_tool" in res or "shell" in res:
                # The daemon now EXECUTES these kinds server-side and returns
                # {executed, ok, output} (an old daemon just echoes the target
                # back — keep the honest degrade for that skew).
                if res.get("executed"):
                    ok = bool(res.get("ok"))
                    out = str(res.get("output") or "").strip()
                    kind = "mcp_tool" if "mcp_tool" in res else "shell"
                    target = res.get(kind, "")
                    head = Text(("✓ " if ok else "✕ ") + f"/{name} → {target}",
                                style="green" if ok else "red")
                    self._log(head)
                    if out:
                        self._log(Text(out[:4000], style="" if ok else "red"))
                else:
                    self.notify(f"custom command '{name}' targets "
                                f"'{res.get('mcp_tool') or res.get('shell')}' but this "
                                f"daemon predates server-side execution — update jarvisd")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "chat-input":
            return
        text = event.value.strip()
        try:
            palette = self.query_one(CommandPalette)
        except Exception:
            palette = None
        if palette is not None:
            name = palette.selected_name() or (text[1:] if text.startswith("/") else text)
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
        self._set_thinking(False)
        log = self.query_one("#transcript", RichLog)
        log.clear()
        log.write(Text("— new conversation —", style="bold cyan"))
        self._status("")
        self._update_landing_reactor()

    async def _send(self, text: str) -> None:
        try:
            sid = await self._ensure_session()
            self._update_landing_reactor()
            self._log(Text(f"❯ {text}", style="bold white"))
            self._status("thinking…", "cyan")
            self._set_thinking(True)
            await self.client.call("session.send", {"session_id": sid, "text": text},
                                   timeout=30)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self._log(Text(f"send failed: {exc}", style="red"))
            self._status("")
            self._set_thinking(False)

    async def _stop_turn(self) -> None:
        if not self.session_id:
            return
        try:
            await self.client.call("session.cancel", {"session_id": self.session_id})
            self._cancel_typewriter()
            self._set_thinking(False)
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

    # -- /provider and /model pickers -------------------------------------------
    async def _open_provider_picker(self) -> None:
        """Show the available brains (codex/claude/api) and write the pick
        back via settings.set {"patch": {"default_brain": ...}} — same
        settings.set shape SettingsPane already uses."""
        try:
            res = await self.client.call("settings.get", {})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        settings = res.get("settings", res)
        available = settings.get("available_brains") or {}
        brains = settings.get("brains") or ["codex", "claude", "api"]
        current = settings.get("default_brain", "")
        options = []
        for b in brains:
            usable = available.get(b, True)
            label = b + (" (current)" if b == current else "") + \
                    ("" if usable else " (unavailable)")
            options.append((b, label))

        async def on_pick(value: str) -> None:
            try:
                await self.client.call("settings.set",
                                       {"patch": {"default_brain": value}})
                self.notify(f"default_brain → {value}")
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")

        self.app.push_screen(QuickViewScreen(
            "Provider", lambda: PickerWidget(options, on_pick)))

    async def _open_model_picker(self) -> None:
        """Show the model list for the CURRENT default_brain (model.list) and
        write the pick back via settings.set {"patch": {"default_model": ...}}
        — default_model is a real settings.set key (ControlServer.cpp
        handleSettingsSet), so this is fully wired, not a stub."""
        try:
            res = await self.client.call("settings.get", {})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        settings = res.get("settings", res)
        brain = settings.get("default_brain", "")
        current_model = settings.get("default_model", "")
        try:
            mres = await self.client.call("model.list", {"brain": brain} if brain else {})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        models = mres.get("models") or []
        options = [(m, m + (" (current)" if m == current_model else "")) for m in models]
        if not options:
            self.notify(f"no models available for brain '{brain}'", severity="warning")
            return

        async def on_pick(value: str) -> None:
            try:
                await self.client.call("settings.set",
                                       {"patch": {"default_model": value}})
                self.notify(f"default_model → {value}")
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")

        self.app.push_screen(QuickViewScreen(
            "Model", lambda: PickerWidget(options, on_pick)))

    # -- /stage /commit /revert /openpr (diff-review actions) -------------------
    async def _diff_action(self, verb: str, args: str) -> None:
        """Call a `diff.*` daemon verb for one of the /stage /commit /revert
        /openpr commands. RichLog transcript entries aren't interactive (no
        clickable Stage/Commit/Revert/Open-PR buttons like the QML
        DiffReviewPanel's PillButtons), so these slash commands ARE the
        action row — same input-driven style as /y //n for approvals.

        Param shapes mirror desktop/src/Bridge.cpp's diffStage/diffRevert/
        diffCommit/diffOpenPr exactly: stage/revert take {session_id, path};
        commit takes {session_id, message}; open_pr takes
        {session_id, title} — message/title come from the command's free-text
        remainder and are optional (the daemon/brain can craft its own)."""
        params: dict = {}
        if self.session_id:
            params["session_id"] = self.session_id
        if verb in ("stage", "revert"):
            path = args.strip()
            if not path:
                self._log(Text(f"/{verb} needs a file path", style="yellow"))
                return
            params["path"] = path
        else:  # commit / open_pr — an optional free-text message/title
            text = args.strip()
            if text:
                params["message" if verb == "commit" else "title"] = text
        label = "PR" if verb == "open_pr" else verb
        res = await call_degrading(
            self.client, f"diff.{verb}", params,
            on_unknown_method=lambda exc: self._log(
                Text(f"diff.{verb} is not available yet", style="yellow")),
            on_error=lambda exc: self._log(Text(f"{label} failed: {exc}", style="red")))
        if res is None:
            return
        ok = res.get("ok", True) if isinstance(res, dict) else True
        detail = ""
        if isinstance(res, dict):
            detail = res.get("message") or res.get("url") or ""
        text = ("✓ " if ok else "✕ ") + label + (f"  {detail}" if detail else "")
        self._log(Text(text, style="green" if ok else "red"))

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
                if replay:
                    self._log(Markdown(text))
                else:
                    self._start_typewriter(text)
                    self._set_thinking(False)
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
        elif kind == "diff":
            self._log(render_diff_event(ev))
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
                self._set_thinking(False)
        elif kind == "final":
            self._log(Text("─" * 40, style="bright_black"))
            if not replay:
                self._status("")
                self._set_thinking(False)
