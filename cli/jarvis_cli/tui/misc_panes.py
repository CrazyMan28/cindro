"""MemoryGraphPane (Rich Tree translation of the GUI's node graph) +
HomePane (read-only status/recent-sessions dashboard) + SchedulesPane
(cron jobs, distinct backend from the Queue kanban)."""

from __future__ import annotations

from rich.text import Text
from rich.tree import Tree
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Input, Static, Tree as TextualTree

from jarvis_cli.control import ControlError
from jarvis_cli.tui.arc_reactor import ArcReactorWidget
from jarvis_cli.tui.screens import TablePane


class MemoryGraphPane(Vertical):
    HINT = "type a root entity id + enter: recenter · r: refresh (depth 2)"

    # Textual's Widget already defines a read-only `tree` property (the DOM
    # debug tree — see Widget.tree). Shadow it with a plain class attribute so
    # our own `self.tree` (the rendered rich.tree.Tree) can be assigned in
    # __init__ instead of hitting that property's missing setter.
    tree: Tree | None = None

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.tree = Tree("memory graph")

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield ArcReactorWidget(size=5, thinking=True, id="graph-spinner",
                               classes="pane-spinner")
        yield Input(placeholder="root entity id (blank = everything)", id="graph-root")
        yield Static(id="graph-view")

    def on_mount(self) -> None:
        self.query_one("#graph-spinner", ArcReactorWidget).display = False
        self.call_later(self.load_graph)

    def refresh_if_stale(self) -> None:
        self.call_later(self.load_graph)

    async def load_graph(self) -> None:
        root = ""
        try:
            root = self.query_one("#graph-root", Input).value.strip()
        except Exception:
            pass
        try:
            spinner = self.query_one("#graph-spinner", ArcReactorWidget)
        except Exception:
            spinner = None
        if spinner is not None:
            spinner.display = True
        try:
            res = await self.client.call("memory.graph", {"root": root, "depth": 2})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        finally:
            if spinner is not None:
                spinner.display = False
        raw_nodes = res.get("nodes", [])
        nodes = {n["id"]: n for n in raw_nodes if "id" in n}
        if len(nodes) != len(raw_nodes):
            self.notify("some memory graph nodes were malformed and skipped", severity="warning")
        edges = res.get("edges", [])
        self.tree = Tree("memory graph")
        added: set[str] = set()
        by_from: dict[str, list[dict]] = {}
        for e in edges:
            by_from.setdefault(e.get("from", ""), []).append(e)
        roots = [n for n in nodes.values() if n["id"] not in {e.get("to") for e in edges}]
        for n in roots or list(nodes.values())[:1]:
            self._add_node(self.tree, n, nodes, by_from, added)
        self.query_one("#graph-view", Static).update(self.tree)

    def _add_node(self, parent, node, nodes, by_from, added) -> None:
        node_id = node.get("id")
        if node_id is None or node_id in added:
            return
        added.add(node_id)
        label = node.get("name") or node.get("text", "")[:40] or node_id
        branch = parent.add(label)
        for edge in by_from.get(node_id, []):
            child = nodes.get(edge.get("to"))
            if child:
                self._add_node(branch, child, nodes, by_from, added)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "graph-root":
            await self.load_graph()


class HomePane(Vertical):
    HINT = "r: refresh"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.lines: list[str] = []

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield ArcReactorWidget(size=5, thinking=True, id="home-spinner",
                               classes="pane-spinner")
        yield Static(id="home-view")

    def on_mount(self) -> None:
        self.query_one("#home-spinner", ArcReactorWidget).display = False
        self.call_later(self.refresh_data)

    def refresh_if_stale(self) -> None:
        self.call_later(self.refresh_data)

    async def refresh_data(self) -> None:
        try:
            spinner = self.query_one("#home-spinner", ArcReactorWidget)
        except Exception:
            spinner = None
        if spinner is not None:
            spinner.display = True
        try:
            sessions = (await self.client.call("session.list", {})).get("sessions", [])
            settings = (await self.client.call("settings.get", {})).get("settings", {})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        finally:
            if spinner is not None:
                spinner.display = False
        self.lines = [
            f"jarvisd v{settings.get('version', '?')} · default brain: "
            f"{settings.get('default_brain', '?')}",
            "",
            "recent sessions:",
        ] + [f"  {s.get('title') or '(untitled)'} [{s.get('brain', '')}]" for s in sessions[:10]]
        self.query_one("#home-view", Static).update("\n".join(self.lines))

    async def on_key(self, event) -> None:
        if event.key == "r":
            await self.refresh_data()


class SchedulesPane(TablePane):
    HINT = "type 'name :: prompt' + enter: schedule · enter on a row: enable/disable · g: run now · x: remove · r: refresh"
    COLUMNS = ("name", "cron/when", "next run", "enabled")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="name :: prompt (runs once 'now'; edit cron via the GUI for cadences)",
                   id="schedule-add")
        from textual.widgets import DataTable
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def fetch(self) -> list[dict]:
        res = await self.client.call("schedule.list", {})
        return list(res.get("schedules", []))

    def to_cells(self, r: dict) -> tuple:
        return (r.get("name", ""), r.get("cron") or r.get("when", ""),
                r.get("next_run", ""), "on" if r.get("enabled") else "off")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "schedule-add":
            return
        raw = event.value.strip()
        event.input.value = ""
        if not raw:
            return
        name, _, prompt = raw.partition("::")
        try:
            await self.client.call("schedule.create", {
                "name": name.strip(), "prompt": (prompt or name).strip(), "enabled": True,
            })
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
        self.refresh_data()

    async def on_key(self, event) -> None:
        row = self.selected()
        if event.key == "r":
            self.refresh_data()
        elif event.key == "enter" and row:
            try:
                await self.client.call("schedule.set_enabled",
                                       {"id": row.get("id"), "enabled": not row.get("enabled")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "g" and row:
            try:
                await self.client.call("schedule.run_now", {"id": row.get("id")})
                self.notify("triggered")
            except ControlError as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "x" and row:
            try:
                await self.client.call("schedule.remove", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
