"""LockGateScreen — the TUI's 2FA/fingerprint cross-device unlock overlay.

Covers the three behaviors that matter most:
  1) FAIL-OPEN — no phone paired (the MockDaemon's default) -> the app
     proceeds without LockGateScreen ever being shown.
  2) A phone IS paired -> LockGateScreen shows and polls auth.status until
     approved, then dismisses.
  3) The inline PIN fallback -> auth.verify_pin with the right PIN dismisses
     it too.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from harness import MockDaemon  # noqa: E402

from jarvis_cli.tui.app import JarvisTui  # noqa: E402
from jarvis_cli.tui.lock_gate import LockGateScreen  # noqa: E402
from textual.widgets import Input  # noqa: E402


@pytest.fixture()
async def daemon(monkeypatch):
    d = await MockDaemon().start()
    monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
    monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
    yield d
    await d.stop()


@pytest.mark.asyncio
async def test_fail_open_when_no_phone_paired(daemon):
    """daemon.paired defaults to False -> auth.request answers
    {paired: False, state: "approved"} -> LockGateScreen must never be
    pushed and the main UI is usable immediately."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        assert ("auth.request", {"origin": "desktop"}) in daemon.calls
        assert not app.query(LockGateScreen)
        assert not isinstance(app.screen, LockGateScreen)


@pytest.mark.asyncio
async def test_lock_gate_shown_and_dismissed_on_phone_approval(daemon, monkeypatch):
    """A paired phone -> the gate shows and polls auth.status; once the
    (simulated) phone approves the challenge, the gate dismisses itself."""
    monkeypatch.setattr(LockGateScreen, "POLL_INTERVAL_S", 0.05)
    daemon.paired = True

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        assert isinstance(app.screen, LockGateScreen)
        assert daemon.last_challenge_id

        daemon.set_auth_state(daemon.last_challenge_id, "approved")
        await pilot.pause(0.5)

        assert not isinstance(app.screen, LockGateScreen)
        assert not app.query(LockGateScreen)


@pytest.mark.asyncio
async def test_pin_entry_verifies_and_dismisses(daemon, monkeypatch):
    """The inline PIN fallback: submitting the correct PIN calls
    auth.verify_pin and dismisses the gate without ever needing the phone."""
    monkeypatch.setattr(LockGateScreen, "POLL_INTERVAL_S", 0.05)
    daemon.paired = True
    daemon.desktop_pin = "1234"
    daemon.settings["has_desktop_pin"] = True

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)  # settle auth.request + the settings.get PIN check
        assert isinstance(app.screen, LockGateScreen)

        pin_input = app.screen.query_one("#lock-pin", Input)
        pin_input.focus()
        pin_input.value = "1234"
        await pilot.press("enter")
        await pilot.pause(0.3)

        assert not isinstance(app.screen, LockGateScreen)
        verify_calls = [(m, p) for (m, p) in daemon.calls if m == "auth.verify_pin"]
        assert verify_calls and verify_calls[0][1]["pin"] == "1234"


@pytest.mark.asyncio
async def test_wrong_pin_shows_error_and_does_not_dismiss(daemon, monkeypatch):
    monkeypatch.setattr(LockGateScreen, "POLL_INTERVAL_S", 0.05)
    daemon.paired = True
    daemon.desktop_pin = "1234"
    daemon.settings["has_desktop_pin"] = True

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        gate = app.screen
        assert isinstance(gate, LockGateScreen)

        pin_input = gate.query_one("#lock-pin", Input)
        pin_input.focus()
        pin_input.value = "0000"
        await pilot.press("enter")
        await pilot.pause(0.3)

        assert isinstance(app.screen, LockGateScreen)
        assert gate.pin_error is True


@pytest.mark.asyncio
async def test_retry_re_requests_a_fresh_challenge(daemon, monkeypatch):
    monkeypatch.setattr(LockGateScreen, "POLL_INTERVAL_S", 0.05)
    daemon.paired = True

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        gate = app.screen
        assert isinstance(gate, LockGateScreen)
        first_id = daemon.last_challenge_id
        daemon.set_auth_state(first_id, "denied")
        await pilot.pause(0.2)
        assert gate.phase == "denied"

        gate.action_retry()
        await pilot.pause(0.3)
        assert daemon.last_challenge_id != first_id
        assert gate.phase == "waiting"
