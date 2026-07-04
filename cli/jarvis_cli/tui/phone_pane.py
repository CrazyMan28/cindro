"""PhonePane — device pairing (ASCII QR, pure-Python `qrcode`, no system
qrencode binary needed — confirmed absent on dev machines) + device list +
revoke, mirroring the desktop app's Devices section (Bridge.cpp:894-920)."""

from __future__ import annotations

import io

import qrcode
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import DataTable, Static

from jarvis_cli.control import ControlError


def _ascii_qr(payload: str) -> str:
    qr = qrcode.QRCode(border=1)
    qr.add_data(payload)
    qr.make(fit=True)
    buf = io.StringIO()
    qr.print_ascii(out=buf, invert=True)
    return buf.getvalue()


class PhonePane(Vertical):
    HINT = "p: pair a new device · x: revoke · r: refresh"
    COLUMNS = ("device", "id", "last seen")

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.rows: list[dict] = []

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table
        yield Static("", id="phone-qr")

    def on_mount(self) -> None:
        self.refresh_data()

    def refresh_if_stale(self) -> None:
        self.refresh_data()

    async def refresh_data(self) -> None:
        try:
            res = await self.client.call("devices.list", {})
            self.rows = list(res.get("devices", []))
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.rows = []
            self.notify(str(exc), severity="error", timeout=4)
        table = self.query_one(DataTable)
        table.clear()
        for r in self.rows:
            table.add_row(r.get("name", ""), r.get("id", ""), r.get("last_seen", ""))

    def selected(self) -> dict | None:
        table = self.query_one(DataTable)
        if not self.rows or table.cursor_row is None:
            return None
        if 0 <= table.cursor_row < len(self.rows):
            return self.rows[table.cursor_row]
        return None

    async def on_key(self, event) -> None:
        if event.key == "r":
            await self.refresh_data()
        elif event.key == "p":
            try:
                res = await self.client.call("devices.pair_start", {})
                qr_text = _ascii_qr(res.get("payload", res.get("code", "")))
                self.query_one("#phone-qr", Static).update(
                    Text(f"{qr_text}\ncode: {res.get('code', '')} "
                        f"(expires {res.get('expires_at', '?')})"))
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("devices.revoke", {"id": row.get("id", "")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                await self.refresh_data()
