"""SetupWizardScreen — first-run detection (the exact settings.get
``setup_complete`` flag the desktop GUI uses) + the 4-step flow itself."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from harness import MockDaemon  # noqa: E402

from jarvis_cli.tui.app import JarvisTui  # noqa: E402
from jarvis_cli.tui.setup_wizard import SetupWizardScreen  # noqa: E402
from textual.widgets import Button, Input, ListView, Switch  # noqa: E402


@pytest.fixture()
async def daemon(monkeypatch):
    d = await MockDaemon().start()
    monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
    monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
    yield d
    await d.stop()


# -- first-run detection (app.py wiring) --------------------------------------

@pytest.mark.asyncio
async def test_already_onboarded_skips_the_wizard(daemon):
    """MockDaemon defaults setup_complete=True (mirrors a real prior install)
    -> the wizard must never appear."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.4)
        assert not isinstance(app.screen, SetupWizardScreen)
        assert not app.query(SetupWizardScreen)


@pytest.mark.asyncio
async def test_first_run_shows_the_wizard_after_the_lock_gate(daemon):
    """setup_complete=False (a genuinely fresh install) -> the wizard shows.
    daemon.paired defaults False (fail-open, no lock) so this exercises the
    "runs AFTER LockGate" sequencing with the gate resolving instantly."""
    daemon.settings["setup_complete"] = False

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        assert isinstance(app.screen, SetupWizardScreen)
        assert ("settings.get", {}) in [(m, p) for (m, p) in daemon.calls if m == "settings.get"] \
            or any(m == "settings.get" for (m, _p) in daemon.calls)


@pytest.mark.asyncio
async def test_wizard_shown_before_lock_gate_is_never_shown_underneath_it(daemon, monkeypatch):
    """A locked, never-onboarded device: LockGateScreen must be what's on top
    FIRST — the wizard must not race ahead of it and cover it."""
    from jarvis_cli.tui.lock_gate import LockGateScreen

    monkeypatch.setattr(LockGateScreen, "POLL_INTERVAL_S", 0.05)
    daemon.paired = True
    daemon.settings["setup_complete"] = False

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        assert isinstance(app.screen, LockGateScreen)

        daemon.set_auth_state(daemon.last_challenge_id, "approved")
        await pilot.pause(0.5)

        # Only once the lock has resolved does the wizard appear.
        assert isinstance(app.screen, SetupWizardScreen)


@pytest.mark.asyncio
async def test_completing_the_wizard_persists_setup_complete_and_dismisses(daemon):
    daemon.settings["setup_complete"] = False

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        wiz = app.screen
        assert isinstance(wiz, SetupWizardScreen)

        name_field = wiz.query_one("#name-field", Input)
        name_field.value = "Friday"
        wiz.assistant_name = "Friday"

        for _ in range(4):
            wiz.query_one("#wizard-next-btn", Button).press()
            await pilot.pause(0.2)

        assert not isinstance(app.screen, SetupWizardScreen)
        assert daemon.settings["setup_complete"] is True
        assert daemon.settings["assistant_name"] == "Friday"


# -- step-by-step flow (pushed directly, isolated from app-level wiring) -----

@pytest.mark.asyncio
async def test_each_step_advances_and_toggles_the_right_panel(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        wiz = SetupWizardScreen(app.client)
        await app.push_screen(wiz)
        await pilot.pause(0.2)

        assert wiz.step == 0
        assert wiz.query_one("#step-0").display is True
        assert wiz.query_one("#step-1").display is False

        await wiz.action_next()
        assert wiz.step == 1
        assert wiz.query_one("#step-1").display is True
        assert wiz.query_one("#step-0").display is False

        wiz.action_back()
        assert wiz.step == 0
        assert wiz.query_one("#step-0").display is True


@pytest.mark.asyncio
async def test_load_calls_both_settings_get_and_voice_list_voices(daemon):
    """Regression test: _load() must issue BOTH settings.get and
    voice.list_voices (order-independent -- neither depends on the
    other's result) and still render the resulting step content
    (assistant name pulled from settings, voices populated in the list)."""
    daemon.settings["assistant_name"] = "Friday"

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        wiz = SetupWizardScreen(app.client)
        await app.push_screen(wiz)
        await pilot.pause(0.3)

        methods = [m for (m, _p) in daemon.calls]
        assert "settings.get" in methods
        assert "voice.list_voices" in methods

        # settings.get's result landed on the wizard + its step-0 input.
        assert wiz.assistant_name == "Friday"
        assert wiz.query_one("#name-field", Input).value == "Friday"

        # voice.list_voices' result populated the (still-hidden step-1) list.
        lv = wiz.query_one("#voice-list", ListView)
        assert len(lv.children) == len(daemon.voices)


@pytest.mark.asyncio
async def test_load_runs_settings_get_and_voice_list_voices_concurrently(daemon, monkeypatch):
    """Regression test for the fix: settings.get and voice.list_voices must
    run concurrently (via asyncio.gather), not sequentially. Each mocked
    call is delayed by DELAY seconds; sequential awaits would take
    ~2*DELAY, concurrent ones ~1*DELAY."""
    import asyncio
    import time

    DELAY = 0.2

    async def slow_call(method, params=None, timeout=None):
        await asyncio.sleep(DELAY)
        if method == "settings.get":
            return {"settings": dict(daemon.settings)}
        if method == "voice.list_voices":
            return {"voices": list(daemon.voices)}
        return {}

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.2)
        wiz = SetupWizardScreen(app.client)
        monkeypatch.setattr(app.client, "call", slow_call)

        start = time.monotonic()
        await app.push_screen(wiz)
        # push_screen's on_mount (-> _load) is fired as a task; wait for
        # the voice list to actually be populated (proof _load finished).
        for _ in range(50):
            if wiz.voice_list:
                break
            await pilot.pause(0.05)
        elapsed = time.monotonic() - start

        assert wiz.voice_list  # _load did complete
        assert elapsed < DELAY * 1.75


@pytest.mark.asyncio
async def test_load_tolerates_voice_list_voices_failing(daemon, monkeypatch):
    """Each call keeps its own independent error handling after the
    gather(): a failing voice.list_voices must not blank out settings
    that DID load successfully (return_exceptions=True, not a shared
    try/except)."""
    daemon.settings["assistant_name"] = "Friday"

    async def flaky_call(method, params=None, timeout=None):
        if method == "voice.list_voices":
            raise RuntimeError("boom")
        if method == "settings.get":
            return {"settings": dict(daemon.settings)}
        return {}

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.2)
        wiz = SetupWizardScreen(app.client)
        monkeypatch.setattr(app.client, "call", flaky_call)
        await app.push_screen(wiz)
        await pilot.pause(0.3)

        # settings.get's result still landed despite voice_list_voices raising.
        assert wiz.assistant_name == "Friday"
        assert wiz.voice_list == []


@pytest.mark.asyncio
async def test_voice_list_populated_from_voice_list_voices(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        wiz = SetupWizardScreen(app.client)
        await app.push_screen(wiz)
        await pilot.pause(0.3)

        lv = wiz.query_one("#voice-list", ListView)
        assert len(lv.children) == len(daemon.voices)
        ids = {getattr(item, "voice_value", None) for item in lv.children}
        assert ids == {v["id"] for v in daemon.voices}


@pytest.mark.asyncio
async def test_selecting_a_voice_sets_tts_voice(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        wiz = SetupWizardScreen(app.client)
        await app.push_screen(wiz)
        await pilot.pause(0.3)

        lv = wiz.query_one("#voice-list", ListView)
        lv.index = 1  # daemon.voices[1]["id"] == "en_emma_neutral"
        lv.action_select_cursor()
        await pilot.pause(0.2)

        assert wiz.tts_voice == "en_emma_neutral"


@pytest.mark.asyncio
async def test_permission_and_auto_update_land_in_the_finish_patch(daemon):
    daemon.settings["setup_complete"] = False

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        wiz = app.screen
        assert isinstance(wiz, SetupWizardScreen)

        wiz.step = 3
        wiz._update_step_display()
        await pilot.pause(0.1)

        lv = wiz.query_one("#permission-list", ListView)
        lv.index = 2  # PERMISSION_OPTIONS[2] == ("low", ...)
        lv.action_select_cursor()
        await pilot.pause(0.1)

        switch = wiz.query_one("#auto-update-switch", Switch)
        switch.value = False
        await pilot.pause(0.1)

        await wiz.action_next()  # last step -> finish()
        await pilot.pause(0.3)

        assert daemon.settings["permission_level"] == "low"
        assert daemon.settings["auto_update"] is False


@pytest.mark.asyncio
async def test_mistral_key_omitted_when_already_set(daemon):
    daemon.settings["setup_complete"] = False
    daemon.settings["api_keys_set"] = {"mistral": True}

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        wiz = app.screen
        assert isinstance(wiz, SetupWizardScreen)
        assert wiz.mistral_key_set is True

        wiz.mistral_key = "sk-should-not-be-sent"
        for _ in range(4):
            wiz.query_one("#wizard-next-btn", Button).press()
            await pilot.pause(0.2)

        assert "api_keys" not in daemon.settings  # never overwritten by the patch


@pytest.mark.asyncio
async def test_mistral_key_included_when_typed_and_not_already_set(daemon):
    daemon.settings["setup_complete"] = False
    daemon.settings["api_keys_set"] = {"mistral": False}

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.5)
        wiz = app.screen
        assert isinstance(wiz, SetupWizardScreen)

        key_field = wiz.query_one("#mistral-key-field", Input)
        key_field.value = "sk-secret"
        wiz.mistral_key = "sk-secret"

        for _ in range(4):
            wiz.query_one("#wizard-next-btn", Button).press()
            await pilot.pause(0.2)

        patches = [p for (m, p) in daemon.calls if m == "settings.set"]
        assert any(p.get("patch", {}).get("api_keys") == {"mistral": "sk-secret"}
                  for p in patches)
