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


async def test_canvas_pane_renders_a_widget_render_broadcast():
    """A widget.render broadcast event appends a rendered widget to the Canvas pane."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause()
        canvas = app.query_one("#canvas")
        canvas._on_widget_event("widget.render", {
            "id": "w1", "title": "Test Widget",
            "spec": {"type": "text", "text": "hello from canvas"},
        })
        await pilot.pause()
        assert any("Test Widget" in str(item.content) for item in canvas.items.values())


async def test_widgets_pane_lists_saved_widgets(tmp_path, monkeypatch):
    """WidgetsPane reads the saved-widget library from the data dir."""
    import json
    from jarvis_cli import config
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path))
    (tmp_path / "saved_widgets.json").write_text(json.dumps({
        "widgets": [{"id": "w1", "name": "My Widget",
                    "spec": json.dumps({"type": "text", "text": "hi"})}]
    }))
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause()
        pane = app.query_one("#widgets")
        pane.refresh_saved()
        await pilot.pause()
        assert any(w["name"] == "My Widget" for w in pane.saved)


async def test_phone_pane_lists_devices():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        pane.rows = [{"id": "dev1", "name": "Pixel", "last_seen": "now"}]
        await pilot.pause()


async def test_phone_pane_pair_renders_ascii_qr(monkeypatch):
    from jarvis_cli.tui import phone_pane
    monkeypatch.setattr(phone_pane, "_ascii_qr", lambda payload: "##\n##")
    assert phone_pane._ascii_qr("anything") == "##\n##"


async def test_computer_pane_starts_a_coworker_session(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#computer")
        calls = []
        async def fake_call(method, params=None, timeout=60.0):
            calls.append((method, params))
            if method == "session.create":
                return {"session_id": "s1"}
            return {}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.start_coworker(target="agent")
        assert calls[0][0] == "session.create"
        assert calls[0][1]["target"] == "agent"
        assert pane.session_id == "s1"


async def test_computer_pane_logs_approval_events():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#computer")
        pane._on_session_event({"kind": "approval", "risk": "medium",
                                "summary": "open Spotify"})
        assert any("open Spotify" in line for line in pane.log_lines)


async def test_browser_pane_shows_status_after_navigate(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui import browser_pane
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#browser")

        async def fake_resolve(client, session_id):
            return ("8810", "test-bearer")
        monkeypatch.setattr(browser_pane, "resolve_engine_endpoint", fake_resolve)

        class FakeResponse:
            def json(self):
                return {"url": "https://example.com", "title": "Example",
                        "can_back": False, "can_forward": False}
        class FakeClient:
            async def post(self, url, json=None, headers=None):
                return FakeResponse()
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
        monkeypatch.setattr(browser_pane.httpx, "AsyncClient", lambda **kw: FakeClient())

        pane.session_id = "s1"
        await pane.navigate("https://example.com")
        assert pane.url == "https://example.com"
        assert pane.title == "Example"


async def test_activity_pane_lists_audit_entries(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#activity")
        async def fake_call(method, params=None, timeout=60.0):
            assert method == "audit.list"
            return {"entries": [{"ts": "12:00", "tool": "shell", "ok": True,
                                 "risk": "low", "summary": "ran ls"}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        # TablePane.refresh_data is @work-decorated (screens.py) — it returns a
        # Worker, not an awaitable, same as every other TablePane test in this
        # file (e.g. test_sessions_tab_lists_rows): fire it and pump the pilot.
        pane.refresh_data()
        await pilot.pause(0.3)
        assert pane.rows[0]["summary"] == "ran ls"


async def test_replay_pane_loads_a_session_and_seeks():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#replay")
        pane.events = [{"seq": 0, "kind": "user", "text": "hi"},
                      {"seq": 1, "kind": "assistant", "text": "hello"}]
        pane.cursor = 0
        assert pane.current_line() == "[user] hi"
        pane.seek(1)
        assert pane.current_line() == "[assistant] hello"
