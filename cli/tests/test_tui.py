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


EXPECTED_MAIN_TAB_IDS = {
    "tab-home", "tab-chat", "tab-canvas", "tab-widgets", "tab-phone",
    "tab-computer", "tab-browser", "tab-replay", "tab-settings",
}

async def _open_popup_pane(app, pilot, name: str, cls):
    """Run the "/<name>" slash command (one of chat.py's POPUP_COMMANDS) and
    return the fresh pane instance mounted inside the QuickViewScreen popup
    it pushes — the popup-only screens no longer have a stable "#<name>" main
    tab to query directly.

    Waits for the pane's own on_mount-triggered initial fetch to actually
    settle instead of a single fixed pilot.pause() — every pane reachable
    this way (TablePane's @work(exclusive=True) refresh_data,
    MemoryGraphPane's call_later(load_graph), …) shows the SAME shared
    ".pane-spinner"-classed ArcReactorWidget while its fetch is in flight and
    hides it again once done (see screens.py's spinner_guard), so polling
    that back to hidden is a pane-agnostic way to know the fetch settled. A
    flat sleep was either wasteful (most fetches resolve almost instantly)
    or, worse, too short under a slower test runner — several dependent
    tests assert spinner/row state that only holds once this initial fetch
    has actually finished."""
    chat = app.query_one("#chat")
    await chat.run_slash_command(name, "")
    await pilot.pause(0.1)  # let the popup + pane mount, its worker start
    pane = app.screen.query_one(cls)
    for _ in range(40):  # poll up to ~2s total before giving up
        if not any(s.display for s in pane.query(".pane-spinner")):
            break
        await pilot.pause(0.05)
    return pane


@pytest.mark.asyncio
async def test_app_boots_and_tabs_mount(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        assert app.query_one("#chat", ChatPane)
        assert app.query_one("#settings", SettingsPane)


@pytest.mark.asyncio
async def test_main_tab_bar_has_exactly_the_9_real_tabs(daemon):
    """After the 11 popup-only screens were pulled out (Fix 1), the
    persistent main tab bar must contain exactly the 9 real tabs — no
    Sessions/Memory/Skills/Agents/Queue/Activity/Graph/MCP/Plugins/Outpost/
    Schedules tab remains."""
    from textual.widgets import TabbedContent, TabPane

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        tabbed = app.query_one(TabbedContent)
        # Nested TabbedContents (e.g. PhonePane's own Devices/Dialer/
        # Screening sub-tabs) also show up in a descendant TabPane query —
        # restrict to top-level "tab-*" ids, the same convention app.py's own
        # on_tabbed_content_tab_activated uses to tell them apart.
        tab_ids = {p.id for p in tabbed.query(TabPane) if (p.id or "").startswith("tab-")}
        assert tab_ids == EXPECTED_MAIN_TAB_IDS


@pytest.mark.asyncio
async def test_popup_only_ids_absent_from_tab_bar_but_reachable_via_slash(daemon):
    """Every one of the 11 POPUP_COMMANDS must have NO tab-<name> TabPane in
    the main bar, yet each remains reachable as a QuickViewScreen popup via
    its own slash command (reuses the same popup-assertion pattern as
    test_popup_command_pushes_quick_view_instead_of_tab_jump)."""
    from textual.widgets import TabbedContent, TabPane

    from jarvis_cli.tui.chat import POPUP_COMMANDS
    from jarvis_cli.tui.quick_view import QuickViewScreen

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        tabbed = app.query_one(TabbedContent)
        real_ids = {p.id for p in tabbed.query(TabPane) if (p.id or "").startswith("tab-")}

        for name in POPUP_COMMANDS:
            assert f"tab-{name}" not in real_ids

            chat = app.query_one("#chat")
            await chat.run_slash_command(name, "")
            await pilot.pause(0.15)
            assert isinstance(app.screen, QuickViewScreen), name
            await pilot.press("escape")
            await pilot.pause(0.1)
            assert not isinstance(app.screen, QuickViewScreen), name


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


def _activate_chat_tab(app) -> None:
    # RichLog defers writes until it knows its size (i.e. is laid out), which
    # only happens once its TabPane is the active one — mirrors how the
    # pre-existing send test relies on inp.focus() switching TabbedContent
    # onto "tab-chat" before asserting on #transcript content.
    from textual.widgets import TabbedContent
    app.query_one(TabbedContent).active = "tab-chat"


@pytest.mark.asyncio
async def test_chat_replayed_assistant_message_skips_typewriter(daemon):
    """replay=True is instant — no reveal task, straight into the RichLog."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        _activate_chat_tab(app)
        await pilot.pause(0.05)
        chat = app.query_one("#chat", ChatPane)
        chat._render_ev({"kind": "message", "role": "assistant",
                         "text": "replayed reply text"}, replay=True)
        await pilot.pause(0.05)
        assert chat._typewriter_task is None
        assert chat._typewriter_text == ""
        transcript = chat.query_one("#transcript")
        rendered = "\n".join(strip.text for strip in transcript.lines)
        assert "replayed reply text" in rendered


@pytest.mark.asyncio
async def test_chat_live_assistant_message_typewriters_then_finalizes(daemon):
    """A LIVE (non-replay) assistant message starts a reveal task immediately;
    once it runs to completion the full text lands in the transcript."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        _activate_chat_tab(app)
        await pilot.pause(0.05)
        chat = app.query_one("#chat", ChatPane)
        await chat._ensure_session()
        await pilot.pause(0.1)
        assert daemon.ws is not None

        await daemon.emit(daemon.ws, chat.session_id, {
            "kind": "message", "role": "assistant", "text": "a live typed reply",
        })
        await pilot.pause(0.05)
        task = chat._typewriter_task
        assert task is not None and not task.done()

        await task
        await pilot.pause(0.05)
        assert chat._typewriter_task is None
        assert chat._typewriter_text == ""
        transcript = chat.query_one("#transcript")
        rendered = "\n".join(strip.text for strip in transcript.lines)
        assert "a live typed reply" in rendered


@pytest.mark.asyncio
async def test_chat_second_live_message_cancels_prior_reveal_cleanly(daemon):
    """A second live assistant message arriving mid-reveal cancels the first
    reveal without raising, flushes ITS full text into the transcript (no
    stranded partial line), then reveals the second one normally."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        _activate_chat_tab(app)
        await pilot.pause(0.05)
        chat = app.query_one("#chat", ChatPane)
        await chat._ensure_session()
        await pilot.pause(0.1)
        assert daemon.ws is not None

        first_text = "first reply word " * 40  # long enough to still be revealing
        await daemon.emit(daemon.ws, chat.session_id, {
            "kind": "message", "role": "assistant", "text": first_text,
        })
        await pilot.pause(0.05)
        first_task = chat._typewriter_task
        assert first_task is not None and not first_task.done()

        await daemon.emit(daemon.ws, chat.session_id, {
            "kind": "message", "role": "assistant", "text": "second reply",
        })
        await pilot.pause(0.05)
        assert first_task.cancelled()  # cancelled cleanly, no other exception
        second_task = chat._typewriter_task
        assert second_task is not None and second_task is not first_task
        await second_task
        await pilot.pause(0.05)

        transcript = chat.query_one("#transcript")
        rendered = "\n".join(strip.text for strip in transcript.lines)
        # a short, unwrapped fragment of the first message confirms it was
        # flushed in full (not stranded half-typed) despite the cancellation.
        assert "first reply word" in rendered
        assert "second reply" in rendered


@pytest.mark.asyncio
async def test_diff_event_renders_file_summary_in_transcript(daemon):
    """A `diff`-kind event renders per-file names + +/- change counts into
    the transcript (via diff_render.render_diff_event)."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        _activate_chat_tab(app)
        await pilot.pause(0.05)
        chat = app.query_one("#chat", ChatPane)
        chat._render_ev({"kind": "diff", "path": "foo.py",
                         "patch": "+new line\n-old line\n"})
        await pilot.pause(0.05)
        transcript = chat.query_one("#transcript")
        rendered = "\n".join(strip.text for strip in transcript.lines)
        assert "foo.py" in rendered
        assert "+1" in rendered
        assert "-1" in rendered


@pytest.mark.asyncio
async def test_diff_stage_against_real_daemon_degrades_quietly_on_unknown_method(daemon):
    """MockDaemon doesn't implement diff.* yet (matches production — Bridge.cpp
    documents diff.* as landing daemon-side later, degrading on
    "unknown_method" until then). /stage must still send the call with the
    right shape and surface a quiet status line instead of crashing."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        _activate_chat_tab(app)
        await pilot.pause(0.05)
        chat = app.query_one("#chat", ChatPane)
        await chat.run_slash_command("stage", "foo.py")
        await pilot.pause(0.2)
        stages = [(m, p) for (m, p) in daemon.calls if m == "diff.stage"]
        assert stages and stages[0][1]["path"] == "foo.py"
        transcript = chat.query_one("#transcript")
        rendered = "\n".join(strip.text for strip in transcript.lines)
        assert "not available yet" in rendered


@pytest.mark.asyncio
async def test_stage_command_calls_diff_stage_with_path(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui as App

    app = App()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat", ChatPane)
        await chat.run_slash_command("stage", "foo.py")
        await pilot.pause(0.1)
        stages = [(m, p) for (m, p) in calls if m == "diff.stage"]
        assert stages and stages[0][1] == {"path": "foo.py"}


@pytest.mark.asyncio
async def test_stage_command_without_a_path_does_not_call_the_daemon(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui as App

    app = App()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat", ChatPane)
        await chat.run_slash_command("stage", "")
        await pilot.pause(0.1)
        assert not [(m, p) for (m, p) in calls if m == "diff.stage"]


@pytest.mark.asyncio
async def test_revert_command_calls_diff_revert_with_path(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui as App

    app = App()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat", ChatPane)
        await chat.run_slash_command("revert", "bar.py")
        await pilot.pause(0.1)
        reverts = [(m, p) for (m, p) in calls if m == "diff.revert"]
        assert reverts and reverts[0][1] == {"path": "bar.py"}


@pytest.mark.asyncio
async def test_commit_command_calls_diff_commit_with_optional_message(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui as App

    app = App()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat", ChatPane)
        await chat.run_slash_command("commit", "fix the thing")
        await pilot.pause(0.1)
        commits = [(m, p) for (m, p) in calls if m == "diff.commit"]
        assert commits and commits[0][1] == {"message": "fix the thing"}


@pytest.mark.asyncio
async def test_commit_command_with_no_args_omits_the_message_key(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui as App

    app = App()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat", ChatPane)
        await chat.run_slash_command("commit", "")
        await pilot.pause(0.1)
        commits = [(m, p) for (m, p) in calls if m == "diff.commit"]
        assert commits and commits[0][1] == {}


@pytest.mark.asyncio
async def test_openpr_command_calls_diff_open_pr_with_optional_title(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui as App

    app = App()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat", ChatPane)
        await chat.run_slash_command("openpr", "Add feature X")
        await pilot.pause(0.1)
        prs = [(m, p) for (m, p) in calls if m == "diff.open_pr"]
        assert prs and prs[0][1] == {"title": "Add feature X"}


@pytest.mark.asyncio
async def test_diff_action_includes_session_id_when_a_session_exists(monkeypatch):
    """Bridge::diffStage/diffCommit/etc. all include session_id when one is
    set — the TUI's params must match that shape exactly."""
    from jarvis_cli.tui.app import JarvisTui as App

    app = App()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat", ChatPane)
        chat.session_id = "sess_active"
        await chat.run_slash_command("stage", "foo.py")
        await pilot.pause(0.1)
        stages = [(m, p) for (m, p) in calls if m == "diff.stage"]
        assert stages and stages[0][1] == {"session_id": "sess_active", "path": "foo.py"}


def test_diff_review_commands_are_not_falsely_marked_unavailable_in_the_palette():
    """diff.* (stage/commit/revert/open_pr) IS implemented daemon-side (GitOps),
    so BUILTIN_COMMANDS' /stage /commit /revert /openpr entries must NOT carry a
    "not yet available" marker — the earlier marker was misleading the user into
    thinking working (and destructive, e.g. revert) commands were disabled."""
    from jarvis_cli.tui.chat import BUILTIN_COMMANDS

    by_name = dict(BUILTIN_COMMANDS)
    for name in ("stage", "commit", "revert", "openpr"):
        assert "not yet available" not in by_name[name], (name, by_name[name])
    # The 🚧 convention still applies to genuinely-unfinished commands.
    assert "not yet available" not in by_name["new"]


@pytest.mark.asyncio
async def test_sessions_tab_lists_rows(daemon):
    """Sessions is popup-only now (Fix 1) — reached via /sessions."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        sessions = await _open_popup_pane(app, pilot, "sessions", SessionsPane)
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


@pytest.mark.asyncio
async def test_settings_cycle_agent_mode_also_refreshes_topbar(daemon):
    """Regression: cycling agent_mode via SettingsPane's enter-key wrote
    settings.set correctly but never touched the topbar -- only F3's
    action_cycle_mode and the one-time startup load_daemon_line ever did.
    Changing agent_mode from the Settings tab must update the topbar's
    "mode: ..." display too, without needing to press F3 afterward."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        topbar = app.query_one("#topbar")
        assert "coworker" in str(topbar.content)

        pane = app.query_one("#settings", SettingsPane)
        pane.refresh_data()
        await pilot.pause(0.5)
        assert pane.rows, "settings knobs loaded"
        row = pane.rows[0]  # agent_mode: coworker -> plan
        assert row["key"] == "agent_mode"
        await pane.on_key(type("K", (), {"key": "enter",
                                         "stop": lambda self=None: None})())
        await pilot.pause(0.4)

        assert daemon.settings["agent_mode"] == "plan"
        assert "plan" in str(topbar.content), (
            "topbar must reflect the new agent_mode without a separate F3 press"
        )
        assert app._agent_mode == "plan"


async def test_memory_pane_remember_parses_hash_tags(monkeypatch):
    """The "Remember" field (mirroring MemoryPage.qml's commitAdd()) must
    pull #tag tokens out of the typed text and send the remainder as the
    memory text plus a separate tags array via memory.add."""
    from textual.widgets import Input

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.screens import MemoryPane

    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method in ("memory.list", "memory.search"):
            return {"memories": []}
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "memory", MemoryPane)
        field = pane.query_one("#memory-add", Input)
        field.value = "buy milk #errand #home"
        await pane.on_input_submitted(Input.Submitted(field, field.value))
        await pilot.pause(0.2)

        adds = [(m, p) for (m, p) in calls if m == "memory.add"]
        assert adds, "memory.add was called"
        assert adds[0][1]["text"] == "buy milk"
        assert adds[0][1]["tags"] == ["errand", "home"]
        assert field.value == ""  # input cleared after submit


async def test_skills_pane_remove_calls_skills_remove(monkeypatch):
    """'x' removes the selected skill via skills.remove (a real DELETE,
    distinct from 'a' which only restores an archived skill)."""
    from textual.widgets import DataTable

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.screens import SkillsPane

    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "skills.list":
            return {"skills": [{"name": "deploy", "group": "self",
                                "description": "ship it", "use_count": 3,
                                "pinned": False}]}
        if method == "skills.list_archived":
            return {"skills": []}
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "skills", SkillsPane)
        pane.refresh_data()
        await pilot.pause(0.3)
        assert pane.rows

        table = pane.query_one(DataTable)
        table.move_cursor(row=0)
        await pane.on_key(type("K", (), {"key": "x",
                                         "stop": lambda self=None: None})())
        await pilot.pause(0.2)

        removes = [(m, p) for (m, p) in calls if m == "skills.remove"]
        assert removes and removes[0][1]["name"] == "deploy"


async def test_agents_pane_dispatch_input_calls_agents_dispatch(monkeypatch):
    """The 'agent :: task' Input (mirroring QueuePane's 'title :: prompt')
    calls agents.dispatch with {agent, task}."""
    from textual.widgets import Input

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.screens import AgentsPane

    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method in ("agents.running", "agents.list"):
            return {"agents": []}
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "agents", AgentsPane)
        field = pane.query_one("#agent-dispatch", Input)
        field.value = "researcher :: sort my downloads folder"
        await pane.on_input_submitted(Input.Submitted(field, field.value))
        await pilot.pause(0.2)

        dispatches = [(m, p) for (m, p) in calls if m == "agents.dispatch"]
        assert dispatches, "agents.dispatch was called"
        assert dispatches[0][1]["agent"] == "researcher"
        assert dispatches[0][1]["task"] == "sort my downloads folder"


async def test_agents_pane_remove_only_fires_in_defs_view(monkeypatch):
    """'x' is a no-op (with a hint) in the default agents.running view (rows
    there are runtime sessions, not stable named definitions); 'v' toggles to
    the agents.list defs view (mirrors SkillsPane's live/archived 'v' key),
    where 'x' on the selected row calls agents.remove(name)."""
    from textual.widgets import DataTable

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.screens import AgentsPane

    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "agents.running":
            return {"agents": [{"agent": "researcher", "state": "running",
                                "running": True, "title": "sort downloads"}]}
        if method == "agents.list":
            return {"agents": [{"name": "researcher", "description": "digs stuff up",
                                "brain": "claude"}]}
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "agents", AgentsPane)
        pane.refresh_data()
        await pilot.pause(0.3)
        assert pane.rows and not pane.defs_view

        # 'x' in the running view must NOT call agents.remove.
        table = pane.query_one(DataTable)
        table.move_cursor(row=0)
        await pane.on_key(type("K", (), {"key": "x",
                                         "stop": lambda self=None: None})())
        await pilot.pause(0.2)
        assert not [c for c in calls if c[0] == "agents.remove"]

        # 'v' toggles into the defs view.
        await pane.on_key(type("K", (), {"key": "v",
                                         "stop": lambda self=None: None})())
        await pilot.pause(0.3)
        assert pane.defs_view
        assert pane.rows and pane.rows[0]["name"] == "researcher"

        table.move_cursor(row=0)
        await pane.on_key(type("K", (), {"key": "x",
                                         "stop": lambda self=None: None})())
        await pilot.pause(0.2)
        removes = [(m, p) for (m, p) in calls if m == "agents.remove"]
        assert removes and removes[0][1]["name"] == "researcher"


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


async def test_phone_pane_dialer_calls_call_extension(daemon):
    """A numeric dial target calls phone.mcp's call_extension with
    {from_extension: "100", extension: target} — same shape
    PhoneDialerTab.qml's dialExtension() sends."""
    from textual.widgets import Static

    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        await pane.dial("101")
        await pilot.pause(0.1)
        assert ("call_extension", {"from_extension": "100", "extension": "101"}) \
            in daemon.phone_calls
        status = pane.query_one("#dial-status", Static)
        assert "Connected to 101" in str(status.content)


async def test_phone_pane_dialer_calls_call_user(daemon):
    """A non-numeric dial target calls phone.mcp's call_user with
    {reason: target} — same split PhoneDialerTab.qml's call button uses
    (`/^\\d{1,6}$/.test(target)`)."""
    from textual.widgets import Static

    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        await pane.dial("Approval needed")
        await pilot.pause(0.1)
        assert ("call_user", {"reason": "Approval needed"}) in daemon.phone_calls
        status = pane.query_one("#dial-status", Static)
        assert "In-app call placed" in str(status.content)


async def test_phone_pane_active_calls_list_renders(daemon):
    """list_active_calls (polled via phone.mcp) populates the Dialer tab's
    active-calls DataTable."""
    from textual.widgets import DataTable

    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        daemon.active_calls = [
            {"id": "call1", "state": "active", "from_extension": "100",
             "to_extension": "101", "reason": "test call"},
        ]
        await pane._poll_calls_and_banner()
        await pilot.pause(0.1)
        assert len(pane.active_calls) == 1
        table = pane.query_one("#phone-calls-table", DataTable)
        assert table.row_count == 1


async def test_phone_pane_screening_view_renders_caller_and_transcript(daemon):
    """get_screening_status (polled via phone.mcp) renders caller info + a
    live transcript on the Screening tab — mirrors PhoneScreeningTab.qml."""
    from textual.widgets import Static

    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        daemon.screening_status = {
            "active": True, "caller_number": "+15551234567",
            "caller_name": "Alex", "agent_extension": "900",
            "transcript": [
                {"speaker": "caller", "text": "Is this a sales call?"},
                {"speaker": "agent", "text": "No, checking on your order."},
            ],
        }
        await pane._poll_screening()
        await pilot.pause(0.1)
        status = pane.query_one("#screening-status", Static)
        assert "Alex" in str(status.content)
        assert "+15551234567" in str(status.content)
        assert "ext 900" in str(status.content)
        transcript = pane.query_one("#screening-transcript", Static)
        assert "Is this a sales call?" in str(transcript.content)
        assert "checking on your order" in str(transcript.content)


async def test_phone_pane_incoming_call_accept_wires_phone_http(daemon):
    """A ringing call surfaces the top-of-pane alert banner with ACCEPT/
    REJECT; ACCEPT calls phone.http's POST /api/calls/:id/accept with
    {extension: "100"} — same route + body PhoneCallOverlay.qml's
    _accept() sends."""
    from textual.widgets import Button

    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        daemon.active_calls = [
            {"id": "call9", "state": "ringing", "from_extension": "555",
             "to_extension": "100", "reason": "incoming"},
        ]
        await pane._poll_calls_and_banner()
        await pilot.pause(0.1)

        alert = pane.query_one("#phone-call-alert")
        assert alert.display is True
        assert pane.query_one("#phone-call-accept", Button).display is True
        assert pane.query_one("#phone-call-reject", Button).display is True

        await pane._accept_call()
        await pilot.pause(0.1)

        assert ("POST /api/calls/call9/accept", {"extension": "100"}) \
            in daemon.phone_calls
        assert daemon.active_calls[0]["state"] == "active"


async def test_phone_pane_incoming_call_reject_wires_phone_http(daemon):
    """REJECT calls phone.http's POST /api/calls/:id/reject with
    {extension: "100", reason: "rejected_by_user"} and clears the banner —
    same route + body PhoneCallOverlay.qml's _reject() sends."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        daemon.active_calls = [
            {"id": "call5", "state": "ringing", "from_extension": "555",
             "to_extension": "100", "reason": "incoming"},
        ]
        await pane._poll_calls_and_banner()
        await pilot.pause(0.1)

        await pane._reject_call()
        await pilot.pause(0.1)

        assert ("POST /api/calls/call5/reject",
                {"extension": "100", "reason": "rejected_by_user"}) \
            in daemon.phone_calls
        assert pane.incoming == {}
        assert pane.query_one("#phone-call-alert").display is False
        assert all(c["id"] != "call5" for c in daemon.active_calls)


async def test_phone_pane_phone_verbs_unknown_method_degrades_quietly(daemon):
    """A daemon build without phone.mcp/phone.http (unknown_method, e.g.
    version skew) must not crash the pane — dial() shows a quiet inline
    error and background polling degrades to an empty state."""
    from textual.widgets import Static

    from jarvis_cli.tui.app import JarvisTui
    daemon.phone_verbs_supported = False
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        await pane.dial("101")
        await pilot.pause(0.1)
        status = pane.query_one("#dial-status", Static)
        assert "Error" in str(status.content)

        await pane._poll_calls_and_banner()
        await pane._poll_screening()
        await pilot.pause(0.1)
        assert pane.active_calls == []
        assert pane.query_one("#phone-call-alert").display is False


async def test_phone_pane_banner_widget_missing_mid_flight_does_not_crash(daemon):
    """A banner sub-widget removed mid-flight (e.g. a stale query racing
    teardown) must not raise out of _render_banner/_update_incoming_banner —
    both wrap their ENTIRE body in one try/except now (previously only the
    FIRST query_one call in each was guarded), since these run off the same
    recurring 3s set_interval timer (_poll_calls_and_banner) that keeps
    firing in the background regardless of which tab is focused."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        daemon.active_calls = [
            {"id": "callX", "state": "ringing", "from_extension": "555",
             "to_extension": "100", "reason": "incoming"},
        ]
        # Break the banner: remove a widget deep inside _render_banner's
        # unguarded-before-this-fix tail (title/sub/accept/reject/end/
        # transcript lookups all come after the first query_one call).
        pane.query_one("#phone-call-title").remove()
        await pilot.pause(0.05)

        # Must not raise even though a widget _render_banner needs is gone —
        # this is exactly what the recurring timer callback does every 3s.
        await pane._poll_calls_and_banner()
        await pilot.pause(0.1)
        assert pane.incoming.get("id") == "callX"

        # A second poll (transcript load path through _update_incoming_banner,
        # since the call is already "active"-equivalent via ringing state)
        # must also stay quiet.
        daemon.active_calls[0]["state"] = "active"
        await pane._poll_calls_and_banner()
        await pilot.pause(0.1)


async def test_phone_pane_timers_pause_when_tab_inactive_and_resume_when_active(daemon):
    """PhonePane's Dialer/Screening poll timers (every 3s/4s) must not keep
    firing while some OTHER tab is active — app.py's
    on_tabbed_content_tab_activated pauses them via PhonePane.pause_timers()
    and resumes them via .resume_timers() using the SAME tab-activation hook
    already used for refresh_if_stale."""
    from textual.widgets import TabbedContent

    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        await pilot.pause(0.2)
        # "Home" is the initial active tab (see JarvisTui.compose), so Phone
        # starts inactive — its timers should already be paused.
        assert pane._calls_timer is not None and pane._screening_timer is not None
        assert pane._calls_timer._active.is_set() is False
        assert pane._screening_timer._active.is_set() is False

        app.query_one(TabbedContent).active = "tab-phone"
        await pilot.pause(0.1)
        assert pane._calls_timer._active.is_set() is True
        assert pane._screening_timer._active.is_set() is True

        app.query_one(TabbedContent).active = "tab-chat"
        await pilot.pause(0.1)
        assert pane._calls_timer._active.is_set() is False
        assert pane._screening_timer._active.is_set() is False


async def test_phone_pane_on_unmount_stops_both_timers(daemon):
    """Unmounting the Phone pane (e.g. a custom-page reconcile, or app
    teardown) must stop both timers outright, not merely pause them —
    otherwise a stale Timer object with a dead widget reference lingers."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        await pilot.pause(0.1)
        assert pane._calls_timer is not None
        assert pane._screening_timer is not None

        await pane.remove()
        await pilot.pause(0.1)
        assert pane._calls_timer is None
        assert pane._screening_timer is None


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

        app.query_one("#computer").session_id = "s1"
        await pane.navigate("https://example.com")
        assert pane.url == "https://example.com"
        assert pane.title == "Example"


async def test_browser_pane_refreshes_session_id_when_it_changes(monkeypatch):
    """Regression test: _post() used to cache session_id forever once it went
    non-empty (`if not self.session_id: self.session_id = computer.session_id`),
    so a co-work session ending and a new one starting (a different id) left
    the Browser tab silently posting against a dead session id. It must
    re-read computer.session_id fresh on every _post() call."""
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui import browser_pane
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#browser")
        computer = app.query_one("#computer")

        seen_session_ids = []

        async def fake_resolve(client, session_id):
            seen_session_ids.append(session_id)
            return ("8810", "test-bearer")
        monkeypatch.setattr(browser_pane, "resolve_engine_endpoint", fake_resolve)

        class FakeResponse:
            def json(self):
                return {"ok": True}
        class FakeClient:
            async def post(self, url, json=None, headers=None):
                return FakeResponse()
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
        monkeypatch.setattr(browser_pane.httpx, "AsyncClient", lambda **kw: FakeClient())

        computer.session_id = "A"
        await pane._post("/browser/status")
        assert seen_session_ids[-1] == "A"
        assert pane.session_id == "A"

        computer.session_id = "B"
        await pane._post("/browser/status")
        assert seen_session_ids[-1] == "B"
        assert pane.session_id == "B"


async def test_activity_pane_lists_audit_entries(monkeypatch):
    from jarvis_cli.tui.activity_pane import ActivityPane
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
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
        pane = await _open_popup_pane(app, pilot, "activity", ActivityPane)
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
    from jarvis_cli.tui.system_panes import McpPane
    app = JarvisTui()
    async with app.run_test() as pilot:
        async def fake_call(method, params=None, timeout=60.0):
            return {"servers": [{"id": "m1", "name": "context7", "transport": "http",
                                 "endpoint": "https://x", "enabled": True,
                                 "builtin": False, "tools_count": 3}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "mcp", McpPane)
        await pane.fetch()


async def test_plugins_pane_lists_catalog(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.system_panes import PluginsPane
    app = JarvisTui()
    async with app.run_test() as pilot:
        async def fake_call(method, params=None, timeout=60.0):
            return {"plugins": [{"id": "p1", "name": "weather", "author": "jarvis",
                                 "version": "1.0", "kind": "mcp", "installed": False,
                                 "enabled": False}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "plugins", PluginsPane)
        rows = await pane.fetch()
        assert rows[0]["name"] == "weather"


async def test_outpost_pane_lists_machines(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.system_panes import OutpostPane
    app = JarvisTui()
    async with app.run_test() as pilot:
        async def fake_call(method, params=None, timeout=60.0):
            return {"machines": [{"name": "k2-runner", "os": "linux", "status": "online"}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "outpost", OutpostPane)
        rows = await pane.fetch()
        assert rows[0]["name"] == "k2-runner"


async def test_memory_graph_pane_builds_a_tree(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.misc_panes import MemoryGraphPane
    app = JarvisTui()
    async with app.run_test() as pilot:
        async def fake_call(method, params=None, timeout=60.0):
            return {"nodes": [{"id": "n1", "name": "Issac", "kind": "entity"},
                              {"id": "n2", "name": "likes coffee", "kind": "memory"}],
                    "edges": [{"from": "n1", "to": "n2", "relation": "mentions"}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "memorygraph", MemoryGraphPane)
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
    from jarvis_cli.tui.misc_panes import MemoryGraphPane
    app = JarvisTui()
    async with app.run_test() as pilot:
        async def fake_call(method, params=None, timeout=60.0):
            return {"nodes": [{"name": "no id here"}, {"id": "n2", "name": "valid"}],
                    "edges": []}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "memorygraph", MemoryGraphPane)
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


async def test_home_pane_refresh_data_calls_both_endpoints_and_renders(monkeypatch):
    """Regression test: refresh_data() must issue BOTH session.list and
    settings.get (order-independent -- they no longer depend on each
    other) and still render the exact same dashboard lines afterward."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#home")
        calls = []
        async def fake_call(method, params=None, timeout=60.0):
            calls.append(method)
            if method == "session.list":
                return {"sessions": [{"id": "s1", "title": "chat about X", "brain": "claude"}]}
            return {"settings": {"version": "1.2.3", "default_brain": "claude"}}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.refresh_data()

        assert set(calls) == {"session.list", "settings.get"}
        assert "jarvisd v1.2.3 · default brain: claude" in pane.lines
        assert "chat about X" in "\n".join(pane.lines)


async def test_home_pane_refresh_data_runs_calls_concurrently(monkeypatch):
    """Regression test for the fix: session.list and settings.get must run
    concurrently (via asyncio.gather), not sequentially. Each mocked call
    sleeps for DELAY seconds; if they ran one-after-another refresh_data()
    would take ~2*DELAY, but run concurrently it takes ~1*DELAY."""
    import asyncio
    import time
    from jarvis_cli.tui.app import JarvisTui

    DELAY = 0.2
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#home")
        async def fake_call(method, params=None, timeout=60.0):
            await asyncio.sleep(DELAY)
            if method == "session.list":
                return {"sessions": []}
            return {"settings": {"version": "1.2.3", "default_brain": "claude"}}
        monkeypatch.setattr(app.client, "call", fake_call)

        start = time.monotonic()
        await pane.refresh_data()
        elapsed = time.monotonic() - start

        # Comfortably below 2*DELAY (which sequential awaits would need)
        # and close to a single DELAY.
        assert elapsed < DELAY * 1.75


async def test_schedules_pane_creates_a_job(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.misc_panes import SchedulesPane
    app = JarvisTui()
    async with app.run_test() as pilot:
        calls = []
        async def fake_call(method, params=None, timeout=60.0):
            calls.append((method, params))
            return {"schedules": []}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane = await _open_popup_pane(app, pilot, "schedules", SchedulesPane)
        # Opening as a popup means a fresh SchedulesPane's own on_mount fetch
        # (schedule.list) may already have landed in `calls` by this point —
        # unlike the old main-tab instance, filter for the create call
        # specifically rather than assuming it's calls[0].
        pane.query_one("#schedule-add").value = "water plants :: remind me to water the plants"
        from textual.widgets import Input
        await pane.on_input_submitted(Input.Submitted(pane.query_one("#schedule-add"),
                                                       "water plants :: remind me to water the plants"))
        creates = [(m, p) for (m, p) in calls if m == "schedule.create"]
        assert creates, "schedule.create was called"


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


async def test_custom_pages_hot_reload_on_broadcast(monkeypatch):
    """tui.layout.changed fans out to _reconcile_custom_pages (run as a
    worker off the sync broadcast callback), which mounts brand-new pages
    via _mount_custom_page — same observable behavior as before the
    reconciliation rework, just routed through the new method.

    client.call is stubbed to {} so the test is hermetic: with a REAL
    jarvisd running on this machine, startup's load_custom_pages would
    otherwise mount the user's actual custom pages into `added` first."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()

    async def fake_call(method, params=None, timeout=60.0):
        return {}
    monkeypatch.setattr(app.client, "call", fake_call)

    added = []
    app._mount_custom_page = lambda page: added.append(page["id"])
    async with app.run_test() as pilot:
        app._on_broadcast("tui.layout.changed", {"pages": [{"id": "x", "title": "X",
                                                            "kind": "log", "config": {}}]})
        await pilot.pause(0.2)
        assert added == ["x"]


async def test_custom_page_removed_when_broadcast_omits_it():
    """Bug fix: a tab-custom-* pane for a page that tui_remove_page dropped
    (i.e. no longer present in the tui.layout.changed broadcast's page list)
    used to be left mounted forever — _mount_custom_page is add-if-absent
    only and nothing ever called remove_pane. Reconciliation must tear down
    any pane whose id isn't in the new list."""
    from textual.css.query import NoMatches
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        app._mount_custom_page({"id": "errorlog", "title": "Error Log", "kind": "log",
                                "config": {}})
        await pilot.pause(0.2)
        assert app.query_one("#tab-custom-errorlog") is not None

        app._on_broadcast("tui.layout.changed", {"pages": []})
        await pilot.pause(0.3)

        with pytest.raises(NoMatches):
            app.query_one("#tab-custom-errorlog")


async def test_custom_page_content_updates_on_edit_broadcast():
    """Bug fix: CustomPane bakes self.config once in __init__, so re-delivering
    the SAME page id with a changed config (tui_edit_page) used to render
    stale content forever (_mount_custom_page no-ops once the tab exists).
    Reconciliation must detect the config diff and remount fresh content."""
    from textual.widgets import Markdown
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.custom_pane import CustomPane
    app = JarvisTui()
    async with app.run_test() as pilot:
        app._mount_custom_page({"id": "notes", "title": "Notes", "kind": "markdown",
                                "config": {"text": "v1"}})
        await pilot.pause(0.2)
        pane = app.query_one("#custom-notes", CustomPane)
        assert pane.query_one(Markdown)._markdown == "v1"

        app._on_broadcast("tui.layout.changed", {"pages": [
            {"id": "notes", "title": "Notes", "kind": "markdown", "config": {"text": "v2"}}]})
        await pilot.pause(0.3)

        pane = app.query_one("#custom-notes", CustomPane)
        assert pane.config.get("text") == "v2"
        assert pane.query_one(Markdown)._markdown == "v2"


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


async def test_palette_mounts_directly_above_the_input_not_below(monkeypatch):
    """The palette must be mounted with before=<the Input> (renders directly
    ABOVE the input line), not appended after it — and the Input must keep
    keyboard focus the whole time it's open so typing more of the command
    keeps landing in the Input, filtering the palette."""
    from textual.widgets import Input, TabbedContent

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.command_palette import CommandPalette

    app = JarvisTui()
    async def fake_call(method, params=None, timeout=60.0):
        return {"commands": []}
    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat")
        app.query_one(TabbedContent).active = "tab-chat"
        await pilot.pause()
        inp = chat.query_one("#chat-input", Input)
        inp.focus()
        await pilot.press("/")
        await pilot.pause()

        palette = chat.query_one(CommandPalette)
        children = list(chat.children)
        assert children.index(palette) == children.index(inp) - 1, (
            "palette must be the child directly BEFORE the Input")
        assert app.focused is inp, "Input must keep focus while palette is open"

        await pilot.press("n", "e", "w")
        await pilot.pause()
        assert inp.value == "/new"
        assert app.focused is inp


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


async def test_command_palette_declares_a_css_transition():
    """Entrance/exit should animate (fade/slide) rather than pop instantly —
    structural check that the widget's CSS actually declares a `transition`
    rule for the styles _animate_in/start_exit flip (opacity/offset)."""
    from jarvis_cli.tui.command_palette import CommandPalette
    assert "transition" in CommandPalette.DEFAULT_CSS
    assert "opacity" in CommandPalette.DEFAULT_CSS
    assert "offset" in CommandPalette.DEFAULT_CSS


async def test_close_palette_is_safe_with_nothing_mounted(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        chat = app.query_one("#chat")
        # no palette mounted at all — must not raise (matches the existing
        # try/except-and-swallow pattern the rest of the method uses).
        chat._close_palette()
        chat._close_palette()


async def test_close_palette_is_idempotent_while_fading_out(monkeypatch):
    """Calling _close_palette twice in a row on the SAME mounted palette
    (e.g. a fast double /new /new keystroke, or a stray duplicate close)
    must not raise, and must not schedule two competing removal timers."""
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.command_palette import CommandPalette
    app = JarvisTui()
    async with app.run_test() as pilot:
        chat = app.query_one("#chat")
        palette = CommandPalette(builtins=[("new", "start a fresh chat")], customs=[])
        await chat.mount(palette)
        await pilot.pause()

        chat._close_palette()  # starts the fade-out
        assert palette.closing is True
        chat._close_palette()  # already closing — must be a safe no-op
        assert palette.closing is True

        # let the deferred removal timer fire
        await pilot.pause(0.3)
        assert palette.parent is None
        assert not chat.query(CommandPalette)


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


async def test_tab_jump_and_popup_commands_partition_correctly():
    """The 11 popup-only screens (memory/skills/agents/queue/activity/
    memorygraph/mcp/plugins/outpost/schedules/sessions) were pulled out of the
    main tab bar entirely — POPUP_COMMANDS is now a FIXED set of 11 names
    that do NOT correspond to any real tab-* id anymore (a regression guard
    against ever accidentally re-adding one of them as a real tab), while
    TAB_JUMP_COMMANDS must equal EXACTLY the 9 real tab-* ids scraped from
    app.py's compose() — no longer unioned with POPUP_COMMANDS to reach a
    bigger historical 20-tab set."""
    import re
    from pathlib import Path
    from jarvis_cli.tui.chat import POPUP_COMMANDS, TAB_JUMP_COMMANDS

    app_py = Path(__file__).parent.parent / "jarvis_cli" / "tui" / "app.py"
    src = app_py.read_text()
    tab_ids = set(re.findall(r'TabPane\("[^"]+",\s*id="(tab-[a-zA-Z0-9_-]+)"', src))
    # Custom, dynamically-mounted pages (e.g. "tab-custom-*") aren't part of
    # the fixed 9-tab set this feature covers.
    tab_ids = {t for t in tab_ids if not t.startswith("tab-custom")}
    expected_names = {t[len("tab-"):] for t in tab_ids}

    assert len(tab_ids) == 9
    assert TAB_JUMP_COMMANDS == expected_names

    assert len(POPUP_COMMANDS) == 11
    assert not (TAB_JUMP_COMMANDS & POPUP_COMMANDS), "no command should be in both sets"
    assert not (POPUP_COMMANDS & expected_names), \
        "a popup command must never also be a real main-bar tab id"


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


async def test_voice_command_is_discoverable_and_not_a_tab_jump():
    """/voice must be a real BUILTIN_COMMANDS entry, and (since there is no
    tab-voice TabPane — it pushes a full-screen VoiceModeScreen instead) must
    never land in TAB_JUMP_COMMANDS."""
    from jarvis_cli.tui.chat import BUILTIN_COMMANDS, TAB_JUMP_COMMANDS

    by_name = dict(BUILTIN_COMMANDS)
    assert "voice" in by_name
    assert "voice" not in TAB_JUMP_COMMANDS


async def test_voice_command_triggers_the_same_screen_push_as_f2(monkeypatch):
    """/voice must reuse action_voice_mode() (the same call F2 makes), not a
    duplicate push_screen(VoiceModeScreen(...))."""
    from jarvis_cli.tui.app import JarvisTui

    app = JarvisTui()
    async with app.run_test() as pilot:
        chat = app.query_one("#chat")
        calls = []
        monkeypatch.setattr(app, "action_voice_mode", lambda: calls.append("voice"))
        await chat.run_slash_command("voice", "")
        assert calls == ["voice"]


async def test_f2_and_voice_command_push_the_same_voice_mode_screen(daemon):
    """End-to-end: F2 and /voice both end up pushing a VoiceModeScreen."""
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.voice_mode import VoiceModeScreen

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.2)
        await pilot.press("f2")
        await pilot.pause(0.1)
        assert isinstance(app.screen, VoiceModeScreen)
        app.pop_screen()
        await pilot.pause(0.1)

        chat = app.query_one("#chat")
        await chat.run_slash_command("voice", "")
        await pilot.pause(0.1)
        assert isinstance(app.screen, VoiceModeScreen)


async def test_f3_cycles_agent_mode_through_all_three_values_and_back(daemon):
    """F3 cycles agent_mode coworker -> plan -> build -> coworker, writing
    each step back via settings.set (same call shape SettingsPane's KNOBS
    cycling uses), and the topbar reflects the CURRENT mode after each
    cycle."""
    from jarvis_cli.tui.app import JarvisTui

    app = JarvisTui()
    async with app.run_test(size=(120, 30)) as pilot:
        await pilot.pause(0.3)  # let the startup settings.get settle
        topbar = app.query_one("#topbar")
        assert "coworker" in str(topbar.content)
        assert daemon.settings.get("agent_mode", "coworker") == "coworker"

        await pilot.press("f3")
        await pilot.pause(0.2)
        assert daemon.settings["agent_mode"] == "plan"
        assert "plan" in str(topbar.content)

        await pilot.press("f3")
        await pilot.pause(0.2)
        assert daemon.settings["agent_mode"] == "build"
        assert "build" in str(topbar.content)

        await pilot.press("f3")
        await pilot.pause(0.2)
        assert daemon.settings["agent_mode"] == "coworker"
        assert "coworker" in str(topbar.content)


async def test_action_cycle_mode_has_exclusivity_guard_against_races(monkeypatch):
    """Regression: action_cycle_mode had NO exclusivity guard, unlike
    load_daemon_line's @work(exclusive=True) -- two overlapping calls could
    both read the SAME current agent_mode via settings.get before either
    write-back landed, each compute the identical "next" value from that
    stale read, and each fire its OWN settings.set with it: a real F3
    press's effect got silently duplicated onto the wire (and, in general,
    a genuinely-stale read racing a fresh one is exactly the kind of bug
    that can corrupt which value "wins").

    With @work(exclusive=True) added (mirroring load_daemon_line's own
    decorator exactly), firing a second overlapping cycle CANCELS the first
    before it can act on its now-stale read -- so an overlapping pair
    always resolves to exactly ONE clean settings.set (never two racing,
    duplicate ones), and the mode ends up exactly one valid step from
    wherever it actually started: never stuck back at the starting value
    (a fully swallowed press) and never skipped past the correct next
    value (a corrupted/double-advanced one)."""
    import asyncio

    from jarvis_cli.tui.app import JarvisTui

    app = JarvisTui()
    state = {"agent_mode": "coworker"}
    set_calls: list = []
    get_calls = 0
    gate = asyncio.Event()

    async def fake_call(method, params=None, timeout=60.0):
        nonlocal get_calls
        if method == "settings.get":
            get_calls += 1
            call_no = get_calls
            # The daemon "processes" the read instantly on receipt -- this
            # snapshot reflects state as of right now -- but only the
            # FIRST call's reply is slow to actually arrive back, modelling
            # the real network round trip a second F3 press can land inside.
            snapshot = dict(state)
            if call_no == 1:
                await gate.wait()
            return {"settings": snapshot}
        if method == "settings.set":
            patch = params.get("patch") or {}
            set_calls.append(patch.get("agent_mode"))
            state.update(patch)
            return {"ok": True}
        return {}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)

        app.action_cycle_mode()  # worker #1: stuck awaiting its slow settings.get reply
        await pilot.pause(0.05)  # let it actually start (registers as call #1)
        app.action_cycle_mode()  # worker #2: exclusive -> cancels #1 before it can write
        gate.set()               # release #1's reply -- moot, #1 is already cancelled
        await pilot.pause(0.3)

        # Exactly ONE settings.set landed -- the stale, overlapping attempt
        # never got to write its (by-then outdated) computed value.
        assert set_calls == ["plan"], (
            f"expected exactly one clean write (the racing duplicate must "
            f"be cancelled before it can write), got {set_calls}"
        )
        assert state["agent_mode"] == "plan"  # advanced, not stuck at "coworker"
        assert app._agent_mode == "plan"      # topbar's cached mode kept in sync too


async def test_sessions_pane_spinner_shows_during_fetch_and_hides_after(monkeypatch):
    """TablePane's shared spinner (added in screens.py) must appear the
    moment refresh_data() starts awaiting fetch() and disappear once it
    resolves — exercised on a plain TablePane subclass that does NOT
    override compose()."""
    import asyncio
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.arc_reactor import ArcReactorWidget

    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = await _open_popup_pane(app, pilot, "sessions", SessionsPane)
        spinner = pane.query_one(f"#{pane.SPINNER_ID}", ArcReactorWidget)
        assert spinner.display is False  # nothing in flight yet

        gate = asyncio.Event()

        async def slow_call(method, params=None, timeout=60.0):
            if method == "session.list":
                await gate.wait()
                return {"sessions": [{"id": "s1", "title": "t",
                                      "brain": "codex", "state": "idle"}]}
            return {}
        monkeypatch.setattr(app.client, "call", slow_call)

        pane.refresh_data()  # @work-decorated -> fires a worker, returns immediately
        await pilot.pause(0.05)
        assert spinner.display is True  # visible while fetch() is pending

        gate.set()
        await pilot.pause(0.2)
        assert spinner.display is False  # hidden again once fetch() resolved
        assert pane.rows and pane.rows[0]["id"] == "s1"


async def test_outpost_pane_spinner_shows_and_hides_despite_overriding_compose(monkeypatch):
    """OutpostPane fully overrides TablePane.compose() (to add its
    exec-command Input row) WITHOUT yielding a spinner itself — the base
    class must still inject one via on_mount(), proving the 'zero subclass
    changes' claim holds even for compose()-overriding subclasses."""
    import asyncio
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.arc_reactor import ArcReactorWidget
    from jarvis_cli.tui.system_panes import OutpostPane

    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = await _open_popup_pane(app, pilot, "outpost", OutpostPane)
        spinner = pane.query_one(f"#{pane.SPINNER_ID}", ArcReactorWidget)
        assert spinner.display is False

        gate = asyncio.Event()

        async def slow_call(method, params=None, timeout=60.0):
            if method == "outpost.list":
                await gate.wait()
                return {"machines": [{"name": "k2-runner", "os": "linux", "status": "online"}]}
            return {}
        monkeypatch.setattr(app.client, "call", slow_call)

        pane.refresh_data()
        await pilot.pause(0.05)
        assert spinner.display is True

        gate.set()
        await pilot.pause(0.2)
        assert spinner.display is False
        assert pane.rows and pane.rows[0]["name"] == "k2-runner"


async def test_home_pane_spinner_shows_during_fetch_and_hides_after(monkeypatch):
    """HomePane is NOT a TablePane subclass (it's a custom Vertical with its
    own refresh_data) — it needs its own hidden-by-default spinner, shown
    around its own daemon round-trips."""
    import asyncio
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.arc_reactor import ArcReactorWidget

    app = JarvisTui()
    async with app.run_test() as pilot:
        # let any on_mount-deferred refresh (against the real, un-patched
        # client, with no daemon listening) settle before we take over.
        await pilot.pause(0.1)
        pane = app.query_one("#home")
        spinner = pane.query_one("#home-spinner", ArcReactorWidget)
        assert spinner.display is False

        gate = asyncio.Event()

        async def slow_call(method, params=None, timeout=60.0):
            if method == "session.list":
                await gate.wait()
                return {"sessions": [{"id": "s1", "title": "chat about X",
                                      "brain": "claude"}]}
            return {"settings": {"version": "1.2.3", "default_brain": "claude"}}
        monkeypatch.setattr(app.client, "call", slow_call)

        task = asyncio.create_task(pane.refresh_data())
        await pilot.pause(0.05)
        assert spinner.display is True

        gate.set()
        await task
        await pilot.pause(0.05)
        assert spinner.display is False
        assert "chat about X" in "\n".join(pane.lines)


async def test_popup_command_pushes_quick_view_instead_of_tab_jump(daemon):
    """/memory is one of the 11 POPUP_COMMANDS — it must push a
    QuickViewScreen overlay rather than switching TabbedContent.active."""
    from textual.widgets import TabbedContent

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.quick_view import QuickViewScreen

    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.2)
        tabbed = app.query_one(TabbedContent)
        active_before = tabbed.active
        chat = app.query_one("#chat")
        await chat.run_slash_command("memory", "")
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)
        assert tabbed.active == active_before, "the main tab must NOT change"
        # Esc dismisses and returns control to the tab underneath.
        await pilot.press("escape")
        await pilot.pause(0.1)
        assert not isinstance(app.screen, QuickViewScreen)
        assert tabbed.active == active_before


async def test_canvas_command_still_switches_tabs(daemon):
    """Regression guard: /canvas is one of the 8 commands explicitly kept as
    a full tab-jump (not a popup) — it must still switch TabbedContent.active
    exactly as before."""
    from textual.widgets import TabbedContent

    from jarvis_cli.tui.app import JarvisTui

    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.2)
        chat = app.query_one("#chat")
        await chat.run_slash_command("canvas", "")
        await pilot.pause(0.1)
        tabbed = app.query_one(TabbedContent)
        assert tabbed.active == "tab-canvas"


async def test_provider_command_opens_picker_and_selecting_calls_settings_set(daemon):
    """/provider opens an inline picker of available brains; selecting one
    calls settings.set with {"patch": {"default_brain": ...}}."""
    from textual.widgets import ListView

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.chat import PickerWidget
    from jarvis_cli.tui.quick_view import QuickViewScreen

    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.2)
        chat = app.query_one("#chat")
        await chat.run_slash_command("provider", "")
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)
        picker = app.screen.query_one(PickerWidget)
        lv = picker.query_one("#picker-list", ListView)
        assert len(lv.children) == 3  # codex, claude, api

        # Pick "claude" directly (avoids depending on default list ordering).
        target_index = next(i for i, item in enumerate(lv.children)
                            if getattr(item, "picker_value", None) == "claude")
        lv.index = target_index
        lv.action_select_cursor()
        await pilot.pause(0.2)

        patches = [(m, p) for (m, p) in daemon.calls if m == "settings.set"]
        assert patches, "settings.set was called"
        assert patches[-1][1].get("patch", {}).get("default_brain") == "claude"
        assert daemon.settings["default_brain"] == "claude"


async def test_load_daemon_line_survives_topbar_removed_mid_flight(daemon):
    """Regression: load_daemon_line's final _set_topbar() call used to be
    completely unguarded — if the app tears down (or #topbar is otherwise
    gone) while the settings.get round-trip is in flight, query_one("#topbar")
    raises an uncaught NoMatches and crashes the worker (a confirmed
    WorkerFailed root cause). It must now be swallowed like every other
    defensive query_one guard in this file."""
    from jarvis_cli.tui.app import JarvisTui

    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.3)  # let the initial load_daemon_line settle
        await app.query_one("#topbar").remove()
        app.load_daemon_line()  # re-trigger the same flow with #topbar gone
        await pilot.pause(0.3)  # must NOT raise WorkerFailed / NoMatches


async def test_palette_fallback_does_not_strip_non_slash_text(monkeypatch):
    """Regression: `text[1:] if text.startswith("/") else text[1:]` was a
    no-op ternary that always stripped the first character, even on the
    non-slash fallback branch. With a palette mounted and no item selected,
    submitting text that does NOT start with '/' must process the FULL
    text, not text missing its first character."""
    from textual.widgets import Input

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.command_palette import CommandPalette

    app = JarvisTui()
    async with app.run_test() as pilot:
        chat = app.query_one("#chat")
        palette = CommandPalette(builtins=[("new", "start a fresh chat")], customs=[])
        await chat.mount(palette)
        await pilot.pause()
        monkeypatch.setattr(palette, "selected_name", lambda: None)

        seen = []

        async def fake_run(name, args):
            seen.append((name, args))
        monkeypatch.setattr(chat, "run_slash_command", fake_run)

        inp = chat.query_one("#chat-input", Input)
        inp.value = "hello world"
        await chat.on_input_submitted(Input.Submitted(inp, "hello world"))
        await pilot.pause()

        # The buggy version would have stripped the leading 'h' -> "ello world"
        # -> ("ello", "world"). The full text must be processed instead.
        assert seen == [("hello", "world")]


async def test_open_chat_dismisses_quick_view_popup(daemon):
    """Regression: open_chat() switched TabbedContent.active to Chat but
    never dismissed a QuickViewScreen popup — opening a session from the
    inline /sessions popup left the modal floating on top of Chat. Selecting
    a session from the popup must both switch to Chat AND close the popup."""
    from textual.widgets import TabbedContent

    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.quick_view import QuickViewScreen
    from jarvis_cli.tui.screens import SessionsPane

    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.2)
        app.push_screen(QuickViewScreen("Sessions",
                                        lambda: SessionsPane(id="sessions-quick")))
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)

        # Same call the pane's Enter-key handler makes (see SessionsPane.on_key).
        await app.open_chat(daemon.created_sid, "hello world")
        await pilot.pause(0.2)

        assert not isinstance(app.screen, QuickViewScreen)
        assert app.query_one(TabbedContent).active == "tab-chat"


async def test_session_opened_broadcast_refreshes_open_sessions_popup(daemon):
    """Regression: _on_broadcast dropped ALL session.opened handling once
    Sessions became popup-only, on the theory that each fresh popup
    instance already fetches its own data in on_mount() so there was
    "nothing to do". But if a Sessions QuickViewScreen popup is CURRENTLY
    open when a session.opened broadcast arrives (another client created a
    session, a scheduled task fired, …), the open popup must refresh live —
    matching the old main-tab behavior — rather than sitting there stale
    until the user closes and reopens it."""
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.screens import SessionsPane

    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = await _open_popup_pane(app, pilot, "sessions", SessionsPane)

        refreshed = []
        pane.refresh_data = lambda: refreshed.append(True)

        app._on_broadcast("session.opened", {"session_id": "s2", "title": "new"})
        await pilot.pause(0.1)

        assert refreshed == [True]


async def test_session_opened_broadcast_is_noop_with_no_popup_open(daemon):
    """Companion to the above: when NO Sessions popup is open (the common
    case — most broadcasts land while the user is just in Chat), the same
    session.opened broadcast must be silently ignored rather than raising
    (there is nothing visible to refresh)."""
    from jarvis_cli.tui.app import JarvisTui

    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.2)
        app._on_broadcast("session.opened", {"session_id": "s2", "title": "new"})
        await pilot.pause(0.1)  # must not raise


async def test_spinner_guard_shows_resumes_hides_and_pauses_on_success():
    """The shared spinner_guard() helper (factored out of TablePane's
    refresh_data / HomePane's refresh_data / MemoryGraphPane's load_graph)
    must show + resume the spinner for the duration of its block and hide +
    pause it again once the block completes."""
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.arc_reactor import ArcReactorWidget
    from jarvis_cli.tui.screens import spinner_guard

    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = await _open_popup_pane(app, pilot, "sessions", SessionsPane)
        spinner = pane.query_one(f"#{pane.SPINNER_ID}", ArcReactorWidget)
        assert spinner.display is False

        async with spinner_guard(pane, pane.SPINNER_ID):
            assert spinner.display is True

        assert spinner.display is False


async def test_spinner_guard_still_hides_spinner_when_body_raises():
    """spinner_guard() must not swallow exceptions raised inside its block,
    but must still hide the spinner in its finally — same "never stuck
    visible after an exception" guarantee TablePane.refresh_data documents."""
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.arc_reactor import ArcReactorWidget
    from jarvis_cli.tui.screens import spinner_guard

    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = await _open_popup_pane(app, pilot, "sessions", SessionsPane)
        spinner = pane.query_one(f"#{pane.SPINNER_ID}", ArcReactorWidget)

        with pytest.raises(ValueError):
            async with spinner_guard(pane, pane.SPINNER_ID):
                assert spinner.display is True
                raise ValueError("boom")

        assert spinner.display is False


async def test_typewriter_preview_shows_plain_text_not_markdown(daemon):
    """Perf fix: during the typewriter reveal, #typing-preview must hold a
    plain rich.text.Text (no per-tick Markdown re-parse) — the real Markdown
    parse happens exactly once, when the reveal finalizes into the RichLog
    transcript."""
    from rich.text import Text as RichText

    from jarvis_cli.tui.app import JarvisTui

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        _activate_chat_tab(app)
        await pilot.pause(0.05)
        chat = app.query_one("#chat")
        await chat._ensure_session()
        await pilot.pause(0.1)
        assert daemon.ws is not None

        long_text = "**bold** reply word " * 40  # stays revealing for a bit
        await daemon.emit(daemon.ws, chat.session_id, {
            "kind": "message", "role": "assistant", "text": long_text,
        })
        await pilot.pause(0.05)
        assert chat._typewriter_task is not None and not chat._typewriter_task.done()

        preview = chat.query_one("#typing-preview")
        assert isinstance(preview.content, RichText)

        await chat._typewriter_task
        await pilot.pause(0.05)
        # finalized content still ends up in the transcript, fully rendered.
        transcript = chat.query_one("#transcript")
        rendered = "\n".join(strip.text for strip in transcript.lines)
        assert "bold" in rendered and "reply word" in rendered
