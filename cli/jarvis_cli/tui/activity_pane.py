"""ActivityPane (audit log tail) + ReplayPane (session event timeline,
step fwd/back — a text translation of the GUI's scrubber)."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.screens import TablePane


class ActivityPane(TablePane):
    HINT = "r: refresh"
    COLUMNS = ("time", "tool", "risk", "ok", "summary")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("audit.list", {"limit": 100})
        return list(res.get("entries", []))

    def to_cells(self, r: dict) -> tuple:
        ok = r.get("ok", True)
        return (r.get("ts", ""), r.get("tool", ""), r.get("risk", ""),
                Text("✓" if ok else "✗", style="green" if ok else "red"),
                (r.get("summary") or "")[:80])

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()


class ReplayPane(Vertical):
    HINT = "type a session id + enter: load · j/k: step fwd/back"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.events: list[dict] = []
        self.cursor = 0

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="session id…", id="replay-session")
        yield Static("", id="replay-line")
        yield Static("", id="replay-pos")

    def current_line(self) -> str:
        if not self.events or not (0 <= self.cursor < len(self.events)):
            return ""
        ev = self.events[self.cursor]
        return f"[{ev.get('kind', ev.get('role', '?'))}] {ev.get('text', ev.get('summary', ''))}"

    def _refresh_display(self) -> None:
        self.query_one("#replay-line", Static).update(self.current_line())
        self.query_one("#replay-pos", Static).update(
            Text(f"{self.cursor + 1}/{len(self.events)}" if self.events else "(none loaded)",
                style="bright_black"))

    def seek(self, index: int) -> None:
        if self.events:
            self.cursor = max(0, min(index, len(self.events) - 1))
        self._refresh_display()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "replay-session":
            return
        session_id = event.value.strip()
        if not session_id:
            return
        try:
            res = await self.client.call("session.history", {"session_id": session_id})
            # session.history events are {seq, ts, ev:{kind,...}} (Bridge.cpp's
            # loadReplay / ControlServer::handleSessionHistory) — unwrap `ev`
            # the same way chat.py's history replay does, so kind/role/text are
            # top-level for current_line() (fall back to the raw item if a
            # future shape flattens it).
            self.events = [e.get("ev", e) for e in res.get("events", [])]
            self.cursor = 0
            self._refresh_display()
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def on_key(self, event) -> None:
        if event.key == "j":
            self.seek(self.cursor + 1)
        elif event.key == "k":
            self.seek(self.cursor - 1)
