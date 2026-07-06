"""The non-chat tabs: Sessions, Memory, Skills, Agents, Queue, Settings.

Each pane is a DataTable-first mirror of its GUI page, refreshed when its tab
activates. Keyboard verbs are shown in each pane's hint line and mirror the
GUI's buttons (open/delete session, forget memory, pin/archive skill, cancel
queue item, cycle a setting).
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widget import Widget
from textual.widgets import DataTable, Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.arc_reactor import ArcReactorWidget


@asynccontextmanager
async def spinner_guard(pane: Widget, spinner_id: str) -> AsyncIterator[None]:
    """Show + resume the named ArcReactorWidget spinner for the duration of
    the wrapped block, hiding + pausing it again in a `finally` — so it can
    never get stuck visible (or ticking) after an exception. Shared by every
    pane that hand-rolls the show-spinner/await-fetch/hide-spinner dance
    (TablePane.refresh_data, HomePane.refresh_data, MemoryGraphPane.load_graph)
    so the pattern lives in exactly one place.

    Does NOT catch or swallow exceptions raised inside the block — callers
    keep their own try/except (for ControlError/ConnectionError/TimeoutError
    + notify) around (or outside) this context manager exactly as before;
    this only owns the spinner's visibility/tick lifecycle.
    """
    try:
        spinner = pane.query_one(f"#{spinner_id}", ArcReactorWidget)
    except Exception:
        spinner = None
    if spinner is not None:
        spinner.display = True
        spinner.resume()
    try:
        yield
    finally:
        if spinner is not None:
            spinner.display = False
            spinner.pause()


class TablePane(Vertical):
    """Shared skeleton: hint line + DataTable + optional input, async refresh.

    Every subclass — even the ones that fully override ``compose()`` to add
    their own Input row (MemoryPane, QueuePane, OutpostPane, SchedulesPane, …) —
    gets a small hidden-by-default ArcReactorWidget spinner for free: it is
    mounted in ``on_mount()`` (right after the ``.pane-hint`` Static, wherever
    that landed) rather than yielded from ``compose()``, so it never depends
    on a subclass calling super().compose(). refresh_data() shows it right
    before the daemon round-trip and hides it again in a finally block, so it
    can never get stuck visible after an exception.
    """

    HINT = ""
    COLUMNS: tuple[str, ...] = ()

    # Tab activation re-refreshes a pane, but on_mount already fetched and
    # rapid tab-hopping shouldn't hammer the daemon — skip refreshes closer
    # together than this.
    REFRESH_THROTTLE_S = 3.0

    SPINNER_ID = "pane-spinner"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.rows: list[dict] = []
        self._last_refresh = 0.0

    @property
    def client(self):
        return self.app.client

    def refresh_if_stale(self) -> None:
        import time
        if time.monotonic() - self._last_refresh >= self.REFRESH_THROTTLE_S:
            self.refresh_data()

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def on_mount(self) -> None:
        spinner = ArcReactorWidget(size=5, thinking=True, id=self.SPINNER_ID,
                                   classes="pane-spinner")
        spinner.display = False
        try:
            hint = self.query_one(".pane-hint")
        except Exception:
            hint = None
        await self.mount(spinner, after=hint)
        spinner.pause()  # hidden by default — no need to tick until shown
        self.refresh_data()

    @work(exclusive=True)
    async def refresh_data(self) -> None:
        import time
        self._last_refresh = time.monotonic()
        async with spinner_guard(self, self.SPINNER_ID):
            try:
                self.rows = await self.fetch()
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.rows = []
                self.notify(str(exc), severity="error", timeout=4)
        table = self.query_one(DataTable)
        table.clear()
        for row in self.rows:
            table.add_row(*self.to_cells(row))

    def selected(self) -> dict | None:
        table = self.query_one(DataTable)
        if not self.rows or table.cursor_row is None:
            return None
        if 0 <= table.cursor_row < len(self.rows):
            return self.rows[table.cursor_row]
        return None

    # subclasses implement:
    async def fetch(self) -> list[dict]:
        raise NotImplementedError

    def to_cells(self, row: dict) -> tuple:
        raise NotImplementedError


class SessionsPane(TablePane):
    HINT = "enter: open in Chat · n: new chat · x: delete · r: refresh"
    COLUMNS = ("title", "brain", "state", "id")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("session.list", {})
        return list(res.get("sessions", []))

    def to_cells(self, r: dict) -> tuple:
        state = r.get("state", "")
        style = {"running": "yellow", "idle": "green"}.get(state, "bright_black")
        return (r.get("title") or "(untitled)", r.get("brain", ""),
                Text(state, style=style), r.get("id", ""))

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("session.delete",
                                           {"session_id": row.get("id", "")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()
        elif event.key == "n":
            await self.app.open_chat("", "")
        elif event.key == "enter":
            row = self.selected()
            if row:
                await self.app.open_chat(row.get("id", ""), row.get("title", ""))
                event.stop()


class MemoryPane(TablePane):
    HINT = ("type to search · enter: search · type below + enter: remember (#tags) · "
            "x: forget · r: refresh")
    COLUMNS = ("memory", "tags", "id")

    # Matches the GUI's exact tagging convention (MemoryPage.qml commitAdd():
    # `raw.match(/#[\w-]+/g)`) — "#work #project" tokens are pulled out of the
    # typed text and sent as a separate tags array; the remainder (whitespace
    # collapsed) becomes the memory text.
    _TAG_RE = re.compile(r"#[\w-]+")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="search memory…", id="memory-q")
        yield Input(placeholder="Remember this…  (tag with #work #project)",
                    id="memory-add")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def fetch(self) -> list[dict]:
        q = ""
        try:
            q = self.query_one("#memory-q", Input).value.strip()
        except Exception:
            pass
        if q:
            res = await self.client.call("memory.search", {"q": q, "limit": 50})
        else:
            res = await self.client.call("memory.list", {"limit": 50})
        return list(res.get("memories", res.get("results", [])))

    def to_cells(self, r: dict) -> tuple:
        tags = r.get("tags", [])
        if isinstance(tags, list):
            tags = ",".join(str(t) for t in tags)
        return ((r.get("text") or "")[:100], tags, str(r.get("id", "")))

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "memory-q":
            self.refresh_data()
        elif event.input.id == "memory-add":
            raw = event.value.strip()
            event.input.value = ""
            if not raw:
                return
            tags = [tok[1:] for tok in self._TAG_RE.findall(raw)]
            text = " ".join(self._TAG_RE.sub("", raw).split())
            if not text:
                return
            try:
                await self.client.call("memory.add", {"text": text, "tags": tags})
                self.notify("remembered")
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("memory.remove", {"id": row.get("id")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()


class SkillsPane(TablePane):
    HINT = ("enter: run in Chat · p: pin/unpin · a: archive/restore · x: remove · "
            "v: live/archived view · r: refresh")
    COLUMNS = ("skill", "group", "uses", "📌", "description")

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.archived_view = False

    async def fetch(self) -> list[dict]:
        method = "skills.list_archived" if self.archived_view else "skills.list"
        res = await self.client.call(method, {})
        return list(res.get("skills", []))

    def to_cells(self, r: dict) -> tuple:
        return (r.get("name", ""), r.get("group", ""),
                str(r.get("use_count", 0)),
                "📌" if r.get("pinned") else "",
                (r.get("description") or "")[:70])

    async def on_key(self, event) -> None:
        row = self.selected()
        if event.key == "r":
            self.refresh_data()
        elif event.key == "v":
            self.archived_view = not self.archived_view
            self.notify("archived skills" if self.archived_view else "live skills")
            self.refresh_data()
        elif event.key == "p" and row and not self.archived_view:
            try:
                await self.client.call("skills.pin",
                                       {"name": row.get("name", ""),
                                        "pinned": not row.get("pinned")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "a" and row:
            # Only the RESTORE direction is wired: archiving happens through
            # the daemon's stale sweep (skills.remove would DELETE, not archive).
            if self.archived_view:
                try:
                    await self.client.call("skills.unarchive",
                                           {"name": row.get("name", "")})
                    self.notify(f"restored {row.get('name')}")
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()
            else:
                self.notify("archiving happens via the stale sweep; "
                            "pin (p) protects a skill instead", timeout=5)
        elif event.key == "x" and row:
            # skills.remove is a hard delete (unlike 'a', which only
            # restores from the archive) — wired in BOTH views, matching
            # SkillsPage.qml's own "Remove" button (which lives on the LIVE
            # row delegate, not the archived one — see report).
            name = row.get("name", "")
            try:
                await self.client.call("skills.remove", {"name": name})
                self.notify(f"removed {name}")
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "enter" and row and not self.archived_view:
            await self.app.run_skill(row.get("name", ""))
            event.stop()


class AgentsPane(TablePane):
    """Runtime rows (agents.running) by default, toggling to the saved agent
    DEFINITIONS (agents.list) with 'v' — same live/archived convention as
    SkillsPane's 'v' key.

    Why the toggle exists: agents.running returns SessionRow-shaped rows
    (agent/state/title, keyed by the *running session*) while agents.list
    returns the saved AGENT.md definitions (name/description/brain, no
    runtime state) — two different row shapes for two different questions
    ("what's running" vs "what agents exist"). agents.remove(name) and
    agents.dispatch(agent, task) both act on the DEFINITION by name, so
    'x' (remove) only fires in the defs view where a selected row
    unambiguously names one; dispatch is a free-typed Input (needs no
    selection) and works from either view.
    """

    HINT = ("type 'agent :: task' + enter: dispatch · x: remove (defs view) · "
            "v: running/defs view · r: refresh")
    COLUMNS = ("agent", "state", "task")
    DEFS_COLUMNS = ("agent", "brain", "description")

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.defs_view = False

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="dispatch a task: <agent name> :: <task>",
                    id="agent-dispatch")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    def _set_columns(self) -> None:
        table = self.query_one(DataTable)
        table.clear(columns=True)
        table.add_columns(*(self.DEFS_COLUMNS if self.defs_view else self.COLUMNS))

    async def fetch(self) -> list[dict]:
        # agents.running returns SessionRow-shaped rows (+ live/running flags)
        # for agent-driven sessions — NOT agents.list, which is the saved
        # agent DEFINITIONS (name/description/brain) with no runtime state.
        # Both response shapes use the same top-level "agents" key.
        method = "agents.list" if self.defs_view else "agents.running"
        res = await self.client.call(method, {})
        return list(res.get("agents", []))

    def to_cells(self, r: dict) -> tuple:
        if self.defs_view:
            return (r.get("name", ""), r.get("brain", "") or "-",
                    (r.get("description") or "")[:70])
        state = r.get("state", "")
        style = "yellow" if r.get("running") else             {"done": "green", "error": "red"}.get(state, "bright_black")
        return (r.get("agent", ""), Text(state, style=style),
                (r.get("title") or r.get("goals") or "")[:80])

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        # Mirrors QueuePane's "title :: prompt" convention exactly, except
        # agents.dispatch has no single-field shorthand (queue.add can fall
        # back to using the title as the prompt; a dispatch with no task
        # doesn't mean anything) — both sides of "::" are required here.
        if event.input.id != "agent-dispatch":
            return
        raw = event.value.strip()
        event.input.value = ""
        if not raw:
            return
        name, _, task = raw.partition("::")
        name = name.strip()
        task = task.strip()
        if not name or not task:
            self.notify("usage: <agent name> :: <task>", severity="error")
            return
        try:
            await self.client.call("agents.dispatch", {"agent": name, "task": task})
            self.notify(f"dispatched: {name}")
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
        self.refresh_data()

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "v":
            self.defs_view = not self.defs_view
            self.notify("saved agent definitions" if self.defs_view
                        else "running agent sessions")
            self._set_columns()
            self.refresh_data()
        elif event.key == "x":
            if not self.defs_view:
                self.notify("switch to the definitions view (v) to remove an agent",
                            timeout=4)
                return
            row = self.selected()
            if row:
                name = row.get("name", "")
                try:
                    await self.client.call("agents.remove", {"name": name})
                    self.notify(f"removed {name}")
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()


class QueuePane(TablePane):
    HINT = "type a title to enqueue · enter: add · c: cancel item · r: refresh"
    COLUMNS = ("title", "status", "priority", "id")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="queue a task: <title> :: <prompt>", id="queue-add")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def fetch(self) -> list[dict]:
        res = await self.client.call("queue.list", {})
        return list(res.get("items", []))

    def to_cells(self, r: dict) -> tuple:
        status = r.get("status", "")
        style = {"running": "yellow", "done": "green", "pending": "cyan",
                 "error": "red", "cancelled": "bright_black"}.get(status, "")
        return ((r.get("title") or "")[:50], Text(status, style=style),
                str(r.get("priority", 0)), str(r.get("id", ""))[:12])

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "queue-add":
            return
        raw = event.value.strip()
        event.input.value = ""
        if not raw:
            return
        title, _, prompt = raw.partition("::")
        try:
            await self.client.call("queue.add", {"title": title.strip(),
                                                 "prompt": (prompt or title).strip()})
            self.notify("queued")
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
        self.refresh_data()

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "c":
            row = self.selected()
            if row:
                try:
                    await self.client.call("queue.cancel", {"id": row.get("id", "")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()


class SettingsPane(TablePane):
    """The autonomy/update knobs that make sense from a terminal.

    enter cycles the selected setting through its allowed values and writes it
    back via settings.set immediately (the GUI keeps the fancier pickers).

    'c'/'p'/'e' open the Connectors/Policies/extension-pairing sub-views as
    QuickViewScreen popups (settings_extras.py) — kept out of this class so it
    stays a thin dispatch of key -> popup, matching desktop/qml/
    SettingsPage.qml's CONNECTORS / trust-policy / one-paste-pairing sections."""

    HINT = ("enter: cycle value · c: connectors · p: policies · "
            "e: pair browser extension · r: refresh — changes save immediately")
    COLUMNS = ("setting", "value", "what it does")

    # (key, [values...], description) — cycled in order.
    KNOBS: list[tuple[str, list[Any], str]] = [
        ("agent_mode", ["coworker", "plan", "build"], "how autonomous each turn is"),
        ("permission_level", ["medium", "high", "low"], "how often Jarvis asks first"),
        ("self_improve", ["off", "on"], "learn ONE reusable fact after each turn"),
        ("auto_continue", ["off", "capped", "on"], "re-wake until the goal is done"),
        ("skill_archive_days", [30, 0, 14, 90], "archive unused skills after N days (0=never)"),
        ("api_context_max_tokens", [0, 50000, 100000], "compress API-brain history over N tokens"),
        ("auto_update", [True, False], "check for new releases periodically"),
        ("auto_update_apply", [False, True], "install updates automatically"),
        ("wake_notify", ["ping", "always", "silent"], "how scheduled wakes reach you"),
    ]

    async def fetch(self) -> list[dict]:
        res = await self.client.call("settings.get", {})
        settings = res.get("settings", res)
        rows = []
        for key, values, desc in self.KNOBS:
            rows.append({"key": key, "value": settings.get(key, values[0]),
                         "values": values, "desc": desc})
        return rows

    def to_cells(self, r: dict) -> tuple:
        v = r.get("value")
        shown = {True: "on", False: "off"}.get(v, str(v))
        return (r["key"], Text(shown, style="cyan"), r["desc"])

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "enter":
            row = self.selected()
            if not row:
                return
            values = row["values"]
            cur = row["value"]
            try:
                idx = values.index(cur)
            except ValueError:
                idx = -1
            nxt = values[(idx + 1) % len(values)]
            try:
                await self.client.call("settings.set", {"patch": {row["key"]: nxt}})
                self.notify(f"{row['key']} → {nxt}")
                if row["key"] == "agent_mode":
                    # F3 (app.py's action_cycle_mode) refreshes the topbar's
                    # mode display immediately after writing agent_mode —
                    # this is the SAME setting via a different surface, so it
                    # must not leave the topbar stale either. Narrowly scoped
                    # to agent_mode specifically, not every settings knob.
                    self.app.refresh_mode_display(nxt)
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
            event.stop()
        elif event.key in ("c", "p", "e"):
            # Local import: settings_extras.py imports TablePane FROM this
            # module, so importing it back at module scope here would be a
            # circular import — deferring to call time (same trick chat.py
            # uses for TabbedContent) breaks the cycle.
            from jarvis_cli.tui.quick_view import QuickViewScreen
            from jarvis_cli.tui.settings_extras import (ConnectorsPane, ExtensionPairPane,
                                                         PoliciesPane)
            if event.key == "c":
                self.app.push_screen(QuickViewScreen(
                    "Connectors", lambda: ConnectorsPane(id="connectors-quick")))
            elif event.key == "p":
                self.app.push_screen(QuickViewScreen(
                    "Policies", lambda: PoliciesPane(id="policies-quick")))
            else:
                self.app.push_screen(QuickViewScreen(
                    "Pair browser extension", lambda: ExtensionPairPane(id="extension-quick")))
            event.stop()
