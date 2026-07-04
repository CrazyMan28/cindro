"""ComputerPane — start/stop a co-work session (agent desktop or real
take-over), approval prompts, and a scrolling action-log tail. The video
feed itself has no lossless terminal path without an image-protocol
terminal, so this mirrors the GUI's status + approval + action-log surface
rather than the pixels — a deliberate, documented translation."""

from __future__ import annotations

import asyncio
from typing import Optional

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
        self._pump_task: Optional[asyncio.Task] = None

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
            self._cancel_pump()  # a previous co-work session's pump must not
                                 # keep delivering into the new session's log.
            self.session_id = res.get("session_id", "")
            self._last_approval_id = ""
            self.query_one("#computer-status", Static).update(
                Text(f"co-work session {self.session_id} ({target})", style="cyan"))
            self._append(f"started co-work on {target}")
            if self.session_id:
                await self.client.subscribe(self.session_id)
                self._ensure_pump()
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def stop_coworker(self) -> None:
        if not self.session_id:
            return
        self._cancel_pump()
        try:
            await self.client.call("session.cancel", {"session_id": self.session_id})
            self._append("stopped")
        except ControlError as exc:
            self.notify(str(exc), severity="error")
        self.session_id = ""
        self._last_approval_id = ""
        self.query_one("#computer-status", Static).update(
            Text("no active co-work session", style="bright_black"))

    def _ensure_pump(self) -> None:
        if self._pump_task is None or self._pump_task.done():
            self._pump_task = asyncio.create_task(self._pump())

    def _cancel_pump(self) -> None:
        # A pump parked in q.get() on a stopped/replaced session's queue
        # would never see the change — kill it; the next _ensure_pump
        # (from a fresh start_coworker) begins clean.
        if self._pump_task is not None and not self._pump_task.done():
            self._pump_task.cancel()
        self._pump_task = None

    async def _pump(self) -> None:
        """Forward the active co-work session's events (approvals, action
        log lines, ...) from the client's per-session queue into
        _on_session_event. Bounded waits so a stop is picked up promptly
        even while parked on the queue."""
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
                if sid != self.session_id:
                    continue  # stale delivery from a session we've left
                self._on_session_event(ev)
        except asyncio.CancelledError:
            pass

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
