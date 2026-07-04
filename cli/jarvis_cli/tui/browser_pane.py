"""BrowserPane — the per-session in-app browser (Bridge.cpp:2339-2408's
REST surface: status/navigate/back/forward/reload/snapshot/click), text-
only DOM snapshot instead of a screenshot (no lossless terminal image path)."""

from __future__ import annotations

import httpx
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.engine_endpoint import resolve_engine_endpoint


class BrowserPane(Vertical):
    HINT = "type a URL + enter: navigate · b: back · f: forward · r: reload/refresh snapshot"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.session_id = ""
        self.url = ""
        self.title = ""
        self.nodes: list[dict] = []

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="https://…", id="browser-url")
        yield Static("no active computer-use session", id="browser-status")
        yield Static("", id="browser-snapshot")

    async def _post(self, path: str, payload: dict | None = None) -> dict:
        if not self.session_id:
            computer = self.app.query_one("#computer")
            self.session_id = computer.session_id
        if not self.session_id:
            raise ControlError("no active computer-use session — start one in the Computer tab")
        port, bearer = await resolve_engine_endpoint(self.client, self.session_id)
        async with httpx.AsyncClient(timeout=10) as http:
            resp = await http.post(f"http://127.0.0.1:{port}{path}", json=payload or {},
                                   headers={"Authorization": f"Bearer {bearer}"})
            return resp.json()

    def _apply_status(self, data: dict) -> None:
        self.url = data.get("url", self.url)
        self.title = data.get("title", self.title)
        self.query_one("#browser-status", Static).update(
            Text(f"{self.title or '(no title)'} — {self.url}", style="cyan"))

    async def navigate(self, url: str) -> None:
        try:
            data = await self._post("/browser/navigate", {"url": url})
            self._apply_status(data)
        except (ControlError, Exception) as exc:
            self.notify(str(exc), severity="error")

    async def refresh_snapshot(self) -> None:
        try:
            data = await self._post("/browser/snapshot")
            self.nodes = list(data.get("nodes", []))
            lines = [f"[{n.get('ref', '')}] {n.get('role', '')}: {n.get('name', '')}"
                    for n in self.nodes]
            self.query_one("#browser-snapshot", Static).update("\n".join(lines[:60]))
        except Exception as exc:
            self.notify(str(exc), severity="error")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "browser-url" and event.value.strip():
            await self.navigate(event.value.strip())

    async def on_key(self, event) -> None:
        if event.key == "b":
            try:
                self._apply_status(await self._post("/browser/back"))
            except Exception as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "f":
            try:
                self._apply_status(await self._post("/browser/forward"))
            except Exception as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "r":
            await self.refresh_snapshot()
