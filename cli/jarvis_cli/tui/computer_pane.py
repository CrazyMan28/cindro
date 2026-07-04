"""ComputerPane — start/stop a co-work session (agent desktop or real
take-over), approval prompts, and a scrolling action-log tail. The video
feed itself has no lossless terminal path without an image-protocol
terminal, so this mirrors the GUI's status + approval + action-log surface
rather than the pixels — a deliberate, documented translation."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Static

from jarvis_cli.control import ControlError


class ComputerPane(Vertical):
    HINT = "a: start on agent desktop · w: start on your REAL screen · s: stop · y/n: approve/deny last"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.session_id: str = ""
        self.log_lines: list[str] = []
        self._last_approval_id: str = ""

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Static(Text("no active co-work session", style="bright_black"), id="computer-status")
        yield Static("", id="computer-log")

    def _append(self, line: str) -> None:
        self.log_lines.append(line)
        self.log_lines = self.log_lines[-200:]
        self.query_one("#computer-log", Static).update("\n".join(self.log_lines))

    async def start_coworker(self, target: str) -> None:
        try:
            res = await self.client.call("session.create", {
                "profile": "coworker", "target": target,
            })
            self.session_id = res.get("session_id", "")
            self.query_one("#computer-status", Static).update(
                Text(f"co-work session {self.session_id} ({target})", style="cyan"))
            self._append(f"started co-work on {target}")
            if self.session_id:
                await self.app.client.subscribe(self.session_id)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def stop_coworker(self) -> None:
        if not self.session_id:
            return
        try:
            await self.client.call("session.cancel", {"session_id": self.session_id})
            self._append("stopped")
        except ControlError as exc:
            self.notify(str(exc), severity="error")
        self.session_id = ""
        self.query_one("#computer-status", Static).update(
            Text("no active co-work session", style="bright_black"))

    def _on_session_event(self, ev: dict) -> None:
        kind = ev.get("kind", "")
        if kind == "approval":
            self._last_approval_id = ev.get("approval_id", "")
            self._append(f"[approval:{ev.get('risk', '?')}] {ev.get('summary', '')}")
        else:
            self._append(f"{kind}: {ev.get('summary') or ev.get('text') or ''}")

    async def on_key(self, event) -> None:
        if event.key == "a":
            await self.start_coworker("agent")
        elif event.key == "w":
            await self.start_coworker("real")
        elif event.key == "s":
            await self.stop_coworker()
        elif event.key in ("y", "n") and self._last_approval_id and self.session_id:
            try:
                await self.client.call("approval.respond", {
                    "session_id": self.session_id, "approval_id": self._last_approval_id,
                    "decision": "approve" if event.key == "y" else "deny",
                })
                self._append(f"approval {'approved' if event.key == 'y' else 'denied'}")
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self._last_approval_id = ""
