"""Tests for jarvis_cli.tui.settings_extras — the Connectors / Policies /
extension-pairing popups reachable from the Settings tab ('c'/'p'/'e').

Two flavors of test here, matching the diff.* precedent in test_tui.py:

  * monkeypatch(app.client, "call", fake_call) tests that assert the RIGHT
    verb/params are sent for list/add/update/remove/set_default and that the
    extension-pairing QR renders from a mocked extension.pair_start reply.

  * tests against the real `daemon` fixture (MockDaemon in harness.py does
    NOT implement connectors.*/policy.*/extension.pair_start, exactly like it
    doesn't implement diff.* yet) proving each of the three verb families
    degrades quietly — a muted inline status line, not an error toast or a
    crash — when the daemon replies "unknown_method".
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from harness import MockDaemon  # noqa: E402

from textual.widgets import Input  # noqa: E402

from jarvis_cli.tui.app import JarvisTui  # noqa: E402
from jarvis_cli.tui.quick_view import QuickViewScreen  # noqa: E402
from jarvis_cli.tui.screens import SettingsPane  # noqa: E402
from jarvis_cli.tui.settings_extras import (ConnectorsPane, ExtensionPairPane,  # noqa: E402
                                            PoliciesPane)


def _key(k: str):
    return type("K", (), {"key": k, "stop": lambda self=None: None})()


def _settings_get_reply() -> dict:
    """A `settings.get` reply with setup_complete already True — tests below
    that replace app.client.call wholesale (rather than using the `daemon`
    fixture, whose MockDaemon.settings already sets this) need this so
    JarvisTui's startup _check_first_run() never races the test's own key
    press with an unrelated SetupWizardScreen popup."""
    return {"settings": {"setup_complete": True}}


@pytest.fixture()
async def daemon(monkeypatch):
    d = await MockDaemon().start()
    monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
    monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
    yield d
    await d.stop()


# ---- Connectors -------------------------------------------------------------

async def test_settings_key_c_opens_connectors_popup_and_lists(monkeypatch):
    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "connectors.list":
            return {"connectors": [{"id": "c1", "name": "google-gmail",
                                    "service": "gmail", "enabled": True,
                                    "risk": "medium", "has_client_id": True,
                                    "has_client_secret": True,
                                    "has_refresh_token": False}]}
        if method == "settings.get":
            return _settings_get_reply()
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("c"))
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)
        pane = app.screen.query_one("#connectors-quick", ConnectorsPane)
        await pilot.pause(0.1)
        assert pane.rows and pane.rows[0]["service"] == "gmail"
        listed = [(m, p) for (m, p) in calls if m == "connectors.list"]
        assert listed


async def test_connectors_add_splits_input_and_calls_connectors_add(monkeypatch):
    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "connectors.list":
            return {"connectors": []}
        if method == "settings.get":
            return _settings_get_reply()
        return {"id": "c2", "name": "google-calendar", "enabled": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("c"))
        await pilot.pause(0.2)
        pane = app.screen.query_one("#connectors-quick", ConnectorsPane)
        field = pane.query_one("#connectors-add", Input)
        field.value = "calendar :: my-client-id :: my-secret :: my-refresh"
        await pane.on_input_submitted(Input.Submitted(field, field.value))
        await pilot.pause(0.2)

        adds = [(m, p) for (m, p) in calls if m == "connectors.add"]
        assert adds
        assert adds[0][1] == {"service": "calendar", "client_id": "my-client-id",
                              "client_secret": "my-secret", "refresh_token": "my-refresh"}


# ---- Policies ----------------------------------------------------------------

async def test_settings_key_p_opens_policies_popup_and_lists(monkeypatch):
    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "policy.list":
            return {"version": 1, "default": "allow",
                    "rules": [{"id": "r1", "tool": "browser_*", "app": "*bank*",
                              "action": "ask", "note": "money stuff"}]}
        if method == "settings.get":
            return _settings_get_reply()
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("p"))
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)
        pane = app.screen.query_one("#policies-quick", PoliciesPane)
        await pilot.pause(0.1)
        assert pane.rows and pane.rows[0]["id"] == "r1"
        assert pane.default_action == "allow"


async def test_policy_add_calls_policy_add_with_split_fields(monkeypatch):
    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "policy.list":
            return {"version": 1, "default": "allow", "rules": []}
        if method == "settings.get":
            return _settings_get_reply()
        return {"id": "r9"}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("p"))
        await pilot.pause(0.2)
        pane = app.screen.query_one("#policies-quick", PoliciesPane)
        field = pane.query_one("#policy-add", Input)
        field.value = "browser_* :: *bank* :: deny :: no banking"
        await pane.on_input_submitted(Input.Submitted(field, field.value))
        await pilot.pause(0.2)

        adds = [(m, p) for (m, p) in calls if m == "policy.add"]
        assert adds
        assert adds[0][1] == {"tool": "browser_*", "app": "*bank*",
                              "action": "deny", "note": "no banking"}


async def test_policy_cycle_action_remove_and_set_default_call_right_verbs(monkeypatch):
    from textual.widgets import DataTable

    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "policy.list":
            return {"version": 1, "default": "allow",
                    "rules": [{"id": "r1", "tool": "browser_*", "app": "*",
                              "action": "allow", "note": ""}]}
        if method == "settings.get":
            return _settings_get_reply()
        return {"ok": True}

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("p"))
        await pilot.pause(0.2)
        pane = app.screen.query_one("#policies-quick", PoliciesPane)
        await pilot.pause(0.1)
        assert pane.rows

        table = pane.query_one(DataTable)
        table.move_cursor(row=0)

        await pane.on_key(_key("a"))  # cycle rule action: allow -> ask
        await pilot.pause(0.1)
        updates = [(m, p) for (m, p) in calls if m == "policy.update"]
        assert updates and updates[-1][1] == {"id": "r1", "action": "ask"}

        await pane.on_key(_key("d"))  # cycle default: allow -> ask
        await pilot.pause(0.1)
        defaults = [(m, p) for (m, p) in calls if m == "policy.set_default"]
        assert defaults and defaults[-1][1] == {"action": "ask"}

        await pane.on_key(_key("x"))  # remove selected rule
        await pilot.pause(0.1)
        removes = [(m, p) for (m, p) in calls if m == "policy.remove"]
        assert removes and removes[-1][1] == {"id": "r1"}


# ---- Extension pairing --------------------------------------------------------

async def test_settings_key_e_opens_extension_pair_popup_and_renders_qr(monkeypatch):
    from jarvis_cli.tui import settings_extras

    app = JarvisTui()
    calls = []

    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "extension.pair_start":
            return {"code": "123456", "expires_at": 1234567890, "control_port": 8794}
        if method == "settings.get":
            return _settings_get_reply()
        return {"ok": True}

    captured = {}

    def fake_ascii_qr(payload: str) -> str:
        captured["payload"] = payload
        return "##QR##"

    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        monkeypatch.setattr(settings_extras, "_ascii_qr", fake_ascii_qr)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("e"))
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)
        pane = app.screen.query_one("#extension-quick", ExtensionPairPane)
        await pilot.pause(0.1)

        starts = [(m, p) for (m, p) in calls if m == "extension.pair_start"]
        assert starts
        # handleExtensionPairStart returns no "payload" field — the QR falls
        # back to encoding the bare code, same fallback phone_pane.py's own
        # 'p' handler already uses.
        assert captured["payload"] == "123456"

        from textual.widgets import Static
        status = pane.query_one("#extension-qr", Static)
        rendered = status.content
        text = rendered.plain if hasattr(rendered, "plain") else str(rendered)
        assert "##QR##" in text
        assert "123456" in text


# ---- unknown_method degrades quietly (matches the diff.* precedent) ---------

async def test_connectors_list_degrades_quietly_on_unknown_method(daemon):
    """MockDaemon doesn't implement connectors.* yet (same shape as the
    diff.* precedent) — the popup must still show up, attempt the call, and
    surface a quiet inline status line instead of an error toast or crash."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("c"))
        await pilot.pause(0.3)
        assert isinstance(app.screen, QuickViewScreen)
        pane = app.screen.query_one("#connectors-quick", ConnectorsPane)
        await pilot.pause(0.2)

        listed = [(m, p) for (m, p) in daemon.calls if m == "connectors.list"]
        assert listed
        assert pane.rows == []

        from textual.widgets import Static
        status = pane.query_one("#connectors-status", Static)
        rendered = status.content
        text = rendered.plain if hasattr(rendered, "plain") else str(rendered)
        assert "not available yet" in text


async def test_policy_add_degrades_quietly_on_unknown_method(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("p"))
        await pilot.pause(0.3)
        pane = app.screen.query_one("#policies-quick", PoliciesPane)
        await pilot.pause(0.2)

        field = pane.query_one("#policy-add", Input)
        field.value = "browser_* :: * :: deny :: nope"
        await pane.on_input_submitted(Input.Submitted(field, field.value))
        await pilot.pause(0.2)

        adds = [(m, p) for (m, p) in daemon.calls if m == "policy.add"]
        assert adds  # the call was attempted with the right shape

        from textual.widgets import Static
        status = pane.query_one("#policies-status", Static)
        rendered = status.content
        text = rendered.plain if hasattr(rendered, "plain") else str(rendered)
        assert "not available yet" in text
        assert isinstance(app.screen, QuickViewScreen), "must not crash back out"


async def test_extension_pair_start_degrades_quietly_on_unknown_method(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        settings = app.query_one("#settings", SettingsPane)
        await settings.on_key(_key("e"))
        await pilot.pause(0.3)
        pane = app.screen.query_one("#extension-quick", ExtensionPairPane)
        await pilot.pause(0.2)

        starts = [(m, p) for (m, p) in daemon.calls if m == "extension.pair_start"]
        assert starts

        from textual.widgets import Static
        status = pane.query_one("#extension-qr", Static)
        rendered = status.content
        text = rendered.plain if hasattr(rendered, "plain") else str(rendered)
        assert "not available yet" in text
        assert isinstance(app.screen, QuickViewScreen), "must not crash back out"
