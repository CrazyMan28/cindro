"""McpPane + PluginsPane + OutpostPane — the SYSTEM group's config/admin
screens, all thin TablePane subclasses over existing Contract-A verbs."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.widgets import Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.screens import TablePane


class McpPane(TablePane):
    HINT = "enter: enable/disable · r: refresh"
    COLUMNS = ("name", "transport", "tools", "enabled")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("mcp.list", {})
        return list(res.get("servers", []))

    def to_cells(self, r: dict) -> tuple:
        enabled = r.get("enabled", False)
        return (r.get("name", ""), r.get("transport", ""), str(r.get("tools_count", 0)),
                Text("on" if enabled else "off", style="green" if enabled else "bright_black"))

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "enter":
            row = self.selected()
            if row:
                try:
                    await self.client.call("mcp.set_enabled",
                                           {"id": row.get("id"), "enabled": not row.get("enabled")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()


class PluginsPane(TablePane):
    HINT = "i: install · enter: enable/disable · x: remove · r: refresh"
    COLUMNS = ("name", "kind", "version", "installed", "enabled")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("plugins.catalog", {})
        return list(res.get("plugins", []))

    def to_cells(self, r: dict) -> tuple:
        return (r.get("name", ""), r.get("kind", ""), r.get("version", ""),
                "✓" if r.get("installed") else "", "on" if r.get("enabled") else "off")

    async def on_key(self, event) -> None:
        row = self.selected()
        if event.key == "r":
            self.refresh_data()
        elif event.key == "i" and row:
            try:
                await self.client.call("plugins.install", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "enter" and row:
            try:
                await self.client.call("plugins.set_enabled",
                                       {"id": row.get("id"), "enabled": not row.get("enabled")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "x" and row:
            try:
                await self.client.call("plugins.remove", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()


class OutpostPane(TablePane):
    HINT = "type a command + enter: run on selected · p: pair · x: revoke · r: refresh"
    COLUMNS = ("machine", "os", "status")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="command to run on the selected machine", id="outpost-exec")
        from textual.widgets import DataTable
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def fetch(self) -> list[dict]:
        res = await self.client.call("outpost.list", {})
        return list(res.get("machines", []))

    def to_cells(self, r: dict) -> tuple:
        status = r.get("status", "")
        return (r.get("name", ""), r.get("os", ""),
                Text(status, style="green" if status == "online" else "bright_black"))

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "outpost-exec":
            return
        cmd = event.value.strip()
        event.input.value = ""
        row = self.selected()
        if not cmd or not row:
            return
        try:
            res = await self.client.call("outpost.exec",
                                         {"machine": row["name"], "cmd": cmd})
            out = res.get("output") or res.get("error") or "(no output)"
            self.notify(f"[{row['name']}] {str(out)[:400]}", timeout=12)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "p":
            try:
                res = await self.client.call("outpost.pair_start", {})
                self.notify("Linux: " + res.get("install_cmd_linux", "")
                            + "  |  Windows: " + res.get("install_cmd_windows", ""),
                            timeout=20)
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("outpost.revoke", {"machine": row["name"]})
                except (ControlError, ConnectionError, TimeoutError) as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()
