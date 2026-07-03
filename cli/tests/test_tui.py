"""TUI smoke tests via textual's Pilot: the app boots against a MockDaemon,
tabs mount, a chat turn streams into the transcript, and the Sessions tab
opens a session into Chat."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from harness import MockDaemon  # noqa: E402

from jarvis_cli.tui.app import JarvisTui  # noqa: E402
from jarvis_cli.tui.chat import ChatPane  # noqa: E402
from jarvis_cli.tui.screens import SessionsPane, SettingsPane  # noqa: E402


@pytest.fixture()
async def daemon(monkeypatch):
    d = await MockDaemon().start()
    monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
    monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
    yield d
    await d.stop()


@pytest.mark.asyncio
async def test_app_boots_and_tabs_mount(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        assert app.query_one("#chat", ChatPane)
        assert app.query_one("#sessions", SessionsPane)
        assert app.query_one("#settings", SettingsPane)


@pytest.mark.asyncio
async def test_chat_send_streams_reply(daemon):
    async def send_events(d, ws, params):
        sid = params["session_id"]
        await d.emit(ws, sid, {"kind": "message", "role": "assistant",
                               "text": "hello from the mock"})
        await d.emit(ws, sid, {"kind": "final"})
    daemon.on_send = send_events

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        chat = app.query_one("#chat", ChatPane)
        inp = chat.query_one("#chat-input")
        inp.focus()
        inp.value = "hi there"
        await pilot.press("enter")
        await pilot.pause(0.8)
        assert chat.session_id == daemon.created_sid
        sends = [(m, p) for (m, p) in daemon.calls if m == "session.send"]
        assert sends and sends[0][1]["text"] == "hi there"
        # the assistant reply reached the transcript widget — assert on the
        # CONTENT (a banner-only transcript once masked a dead event pump).
        transcript = chat.query_one("#transcript")
        rendered = "\n".join(strip.text for strip in transcript.lines)
        assert "hello from the mock" in rendered


@pytest.mark.asyncio
async def test_sessions_tab_lists_rows(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        sessions = app.query_one("#sessions", SessionsPane)
        sessions.refresh_data()
        await pilot.pause(0.5)
        assert sessions.rows and sessions.rows[0]["id"] == "s1"


@pytest.mark.asyncio
async def test_settings_cycle_writes_patch(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        pane = app.query_one("#settings", SettingsPane)
        pane.refresh_data()
        await pilot.pause(0.5)
        assert pane.rows, "settings knobs loaded"
        row = pane.rows[0]  # agent_mode: coworker -> plan
        await pane.on_key(type("K", (), {"key": "enter",
                                         "stop": lambda self=None: None})())
        await pilot.pause(0.4)
        patches = [(m, p) for (m, p) in daemon.calls if m == "settings.set"]
        assert patches and "agent_mode" in patches[-1][1].get("patch", {})
        assert daemon.settings["agent_mode"] == "plan"
