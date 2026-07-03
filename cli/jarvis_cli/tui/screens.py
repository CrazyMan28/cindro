"""The non-chat tabs: Sessions, Memory, Skills, Agents, Queue, Settings.

Each pane is a DataTable-first mirror of its GUI page, refreshed when its tab
activates. Keyboard verbs are shown in each pane's hint line and mirror the
GUI's buttons (open/delete session, forget memory, pin/archive skill, cancel
queue item, cycle a setting).
"""

from __future__ import annotations

from typing import Any

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import DataTable, Input, Static

from jarvis_cli.control import ControlError


class TablePane(Vertical):
    """Shared skeleton: hint line + DataTable + optional input, async refresh."""

    HINT = ""
    COLUMNS: tuple[str, ...] = ()

    # Tab activation re-refreshes a pane, but on_mount already fetched and
    # rapid tab-hopping shouldn't hammer the daemon — skip refreshes closer
    # together than this.
    REFRESH_THROTTLE_S = 3.0

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

    def on_mount(self) -> None:
        self.refresh_data()

    @work(exclusive=True)
    async def refresh_data(self) -> None:
        import time
        self._last_refresh = time.monotonic()
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
    HINT = "type to search · enter: search · x: forget · r: refresh"
    COLUMNS = ("memory", "tags", "id")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="search memory…", id="memory-q")
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
    HINT = ("enter: run in Chat · p: pin/unpin · a: archive · "
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
        elif event.key == "enter" and row and not self.archived_view:
            await self.app.run_skill(row.get("name", ""))
            event.stop()


class AgentsPane(TablePane):
    HINT = "background agent sessions (agents.running) · r: refresh"
    COLUMNS = ("agent", "state", "task")

    async def fetch(self) -> list[dict]:
        # agents.running returns SessionRow-shaped rows (+ live/running flags)
        # for agent-driven sessions — NOT agents.list, which is the saved
        # agent DEFINITIONS (name/description/brain) with no runtime state.
        res = await self.client.call("agents.running", {})
        return list(res.get("agents", []))

    def to_cells(self, r: dict) -> tuple:
        state = r.get("state", "")
        style = "yellow" if r.get("running") else             {"done": "green", "error": "red"}.get(state, "bright_black")
        return (r.get("agent", ""), Text(state, style=style),
                (r.get("title") or r.get("goals") or "")[:80])

    async def on_key(self, event) -> None:
        if event.key == "r":
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
    back via settings.set immediately (the GUI keeps the fancier pickers)."""

    HINT = "enter: cycle value · r: refresh — changes save immediately"
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
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
            event.stop()
