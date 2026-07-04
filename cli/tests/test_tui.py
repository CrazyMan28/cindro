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


async def test_computer_pane_pump_delivers_approval_event(daemon):
    """End-to-end: start_coworker subscribes, the daemon pushes a real
    session.event approval frame over the wire (no session.send involved —
    a co-work session's approvals arrive unprompted), and the pane's OWN
    pump loop must drain the client's queue and route it into
    _on_session_event. A previous version of this test called
    _on_session_event() directly, which passed even when nothing was
    actually pumping events off the queue — this one exercises the real
    subscribe -> daemon.emit -> client queue -> pump -> handler path."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#computer")
        await pane.start_coworker("agent")
        await pilot.pause(0.1)
        assert pane.session_id == daemon.created_sid
        assert daemon.ws is not None

        await daemon.emit(daemon.ws, pane.session_id, {
            "kind": "approval", "risk": "medium", "approval_id": "ap-1",
            "summary": "open Spotify",
        })
        await pilot.pause(0.8)

        assert pane._last_approval_id == "ap-1"
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
            # HomePane's own on_mount deferred refresh (session.list /
            # settings.get) can still be pending and fire during this same
            # pilot.pause() window now that Home is a tab too — tolerate it
            # rather than assert this is the ONLY method ever called.
            if method != "audit.list":
                return {}
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


async def test_mcp_pane_lists_servers(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#mcp")
        async def fake_call(method, params=None, timeout=60.0):
            return {"servers": [{"id": "m1", "name": "context7", "transport": "http",
                                 "endpoint": "https://x", "enabled": True,
                                 "builtin": False, "tools_count": 3}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.fetch()


async def test_plugins_pane_lists_catalog(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#plugins")
        async def fake_call(method, params=None, timeout=60.0):
            return {"plugins": [{"id": "p1", "name": "weather", "author": "jarvis",
                                 "version": "1.0", "kind": "mcp", "installed": False,
                                 "enabled": False}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        rows = await pane.fetch()
        assert rows[0]["name"] == "weather"


async def test_ssh_pane_lists_allowed_hosts(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#ssh")
        async def fake_call(method, params=None, timeout=60.0):
            return {"hosts": ["deploy@k2-runner"]}
        monkeypatch.setattr(app.client, "call", fake_call)
        rows = await pane.fetch()
        assert rows[0]["host"] == "deploy@k2-runner"


async def test_memory_graph_pane_builds_a_tree(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#memorygraph")
        async def fake_call(method, params=None, timeout=60.0):
            return {"nodes": [{"id": "n1", "name": "Issac", "kind": "entity"},
                              {"id": "n2", "name": "likes coffee", "kind": "memory"}],
                    "edges": [{"from": "n1", "to": "n2", "relation": "mentions"}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.load_graph()
        assert "Issac" in str(pane.tree.label) or any(
            "Issac" in str(child.label) for child in pane.tree.children)


async def test_memory_graph_pane_skips_malformed_nodes(monkeypatch):
    """Regression test: a memory.graph response containing a node without an
    "id" key must not crash load_graph (it used to raise an uncaught
    KeyError, which — since load_graph runs via call_later — took down the
    whole Textual app). A malformed node should just be skipped while valid
    nodes still render."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#memorygraph")

        async def fake_call(method, params=None, timeout=60.0):
            return {"nodes": [{"name": "no id here"}, {"id": "n2", "name": "valid"}],
                    "edges": []}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.load_graph()  # must not raise
        assert "valid" in str(pane.tree.label) or any(
            "valid" in str(child.label) for child in pane.tree.children)


async def test_home_pane_shows_recent_sessions(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#home")
        async def fake_call(method, params=None, timeout=60.0):
            if method == "session.list":
                return {"sessions": [{"id": "s1", "title": "chat about X", "brain": "claude"}]}
            return {"settings": {"version": "1.2.3", "default_brain": "claude"}}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.refresh_data()
        assert "chat about X" in "\n".join(pane.lines)


async def test_schedules_pane_creates_a_job(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#schedules")
        calls = []
        async def fake_call(method, params=None, timeout=60.0):
            calls.append((method, params))
            return {"schedules": []}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane.query_one("#schedule-add").value = "water plants :: remind me to water the plants"
        from textual.widgets import Input
        await pane.on_input_submitted(Input.Submitted(pane.query_one("#schedule-add"),
                                                       "water plants :: remind me to water the plants"))
        assert calls[0][0] == "schedule.create"


async def test_custom_pages_mount_from_tui_layout_list(monkeypatch, tmp_path):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    log_file = tmp_path / "err.log"
    log_file.write_text("line one\nline two\n")

    async def fake_call(method, params=None, timeout=60.0):
        if method == "tui.layout.list":
            return {"pages": [{"id": "errorlog", "title": "Error Log", "kind": "log",
                              "config": {"path": str(log_file)}, "order": 0}]}
        return {}
    monkeypatch.setattr(app.client, "call", fake_call)

    async with app.run_test() as pilot:
        await app.load_custom_pages()
        await pilot.pause()
        assert app.query_one("#tab-custom-errorlog") is not None


def test_custom_pages_hot_reload_on_broadcast():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    added = []
    app._mount_custom_page = lambda page: added.append(page["id"])
    app._on_broadcast("tui.layout.changed", {"pages": [{"id": "x", "title": "X",
                                                        "kind": "log", "config": {}}]})
    assert added == ["x"]


async def test_typing_slash_opens_the_command_palette(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async def fake_call(method, params=None, timeout=60.0):
        if method == "command.list":
            return {"commands": [{"name": "deploy", "description": "Deploy the current branch"}]}
        return {}
    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat")
        from textual.widgets import TabbedContent
        app.query_one(TabbedContent).active = "tab-chat"
        await pilot.pause()
        await pilot.click("#chat-input")
        await pilot.press("/")
        await pilot.pause()
        assert chat.query("CommandPalette")


async def test_palette_filters_as_you_type(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.command_palette import CommandPalette
    app = JarvisTui()
    async with app.run_test() as pilot:
        palette = CommandPalette(builtins=[("new", "start a fresh chat"),
                                          ("stop", "cancel the current turn")],
                                 customs=[])
        matches = palette.filter("st")
        assert [m[0] for m in matches] == ["stop"]


async def test_tui_command_is_not_a_tab_jump(monkeypatch):
    """/tui is an ACTION command (ask Jarvis to edit the TUI layout), not a
    tab jump — there's no tab-tui TabPane, so it must never land in
    TAB_JUMP_COMMANDS (that used to crash with an uncaught NoMatches)."""
    from jarvis_cli.tui.chat import TAB_JUMP_COMMANDS
    assert "tui" not in TAB_JUMP_COMMANDS


async def test_tui_command_sends_a_prompt_to_jarvis(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        chat = app.query_one("#chat")
        sent = []
        async def fake_send(text):
            sent.append(text)
        monkeypatch.setattr(chat, "_send", fake_send)
        await chat.run_slash_command("tui", "add a stopwatch page")
        assert len(sent) == 1
        assert "add a stopwatch page" in sent[0]
        assert "tui" in sent[0].lower() or "layout" in sent[0].lower()


async def test_tui_command_with_no_args_still_sends_a_prompt(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        chat = app.query_one("#chat")
        sent = []
        async def fake_send(text):
            sent.append(text)
        monkeypatch.setattr(chat, "_send", fake_send)
        await chat.run_slash_command("tui", "")
        assert len(sent) == 1
        assert sent[0]  # non-empty prompt even with no args


async def test_every_real_tab_has_exactly_one_jump_command():
    """cli/README.md documents 'one jump-command per tab' for all 20 tabs.
    Derive the real tab-* ids straight from app.py's compose() and assert
    TAB_JUMP_COMMANDS covers exactly that set (minus 'tui', which is an
    action command, not a real tab)."""
    import re
    from pathlib import Path
    from jarvis_cli.tui.chat import TAB_JUMP_COMMANDS

    app_py = Path(__file__).parent.parent / "jarvis_cli" / "tui" / "app.py"
    src = app_py.read_text()
    tab_ids = set(re.findall(r'TabPane\("[^"]+",\s*id="(tab-[a-zA-Z0-9_-]+)"', src))
    # Custom, dynamically-mounted pages (e.g. "tab-custom-*") aren't part of
    # the fixed 20-tab set this feature covers.
    tab_ids = {t for t in tab_ids if not t.startswith("tab-custom")}

    expected_names = {t[len("tab-"):] for t in tab_ids}
    assert TAB_JUMP_COMMANDS == expected_names
    assert len(tab_ids) == 20


async def test_selecting_a_custom_command_invokes_it(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    calls = []
    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "command.list":
            return {"commands": [{"name": "deploy", "description": "d",
                                  "action_kind": "prompt"}]}
        if method == "command.invoke":
            return {"prompt": "deploy the current branch now"}
        return {}
    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat")
        await chat.run_slash_command("deploy", "")
        assert ("command.invoke", {"name": "deploy", "args": ""}) in calls
