"""SetupWizardScreen — the terminal analog of desktop/qml/SetupWizard.qml.

Same four core steps, same ``settings.get``/``settings.set``/
``voice.list_voices`` calls, and — critically — the SAME first-run flag:
``settings.get``'s ``setup_complete`` boolean (ControlServer.cpp's
``handleSettingsGet``/``handleSettingsSet``, persisted via
``SettingsStore::setupComplete()``). There is deliberately NO separate
TUI-only "have I onboarded" marker: finishing the wizard in either front-end
persists ``setup_complete=true`` on the shared daemon, so completing it in
the GUI skips it in the TUI and vice versa — they can never desync.

The TUI ADDS a 5th step SetupWizard.qml doesn't have: Phone/Twilio, backed by
the daemon's ``phone.config`` control verb (``ControlServer.cpp``'s
``handlePhoneConfig`` — see ``phone_pane.py``'s module docstring for why this
is a control-channel verb, not an HTTP/MCP proxy call like ``phone.mcp``/
``phone.http``). Entirely optional — skip it and phone calling just stays
unconfigured, same as never touching ``phone_pane.py``'s Config tab.

Steps (mirrors SetupWizard.qml's ``[ "Welcome", "Voice", "Brain",
"Permissions" ][wiz.step]``, plus the TUI-only 5th):
  0. assistant name + the user's own name (``Input`` fields)
  1. TTS voice (a ``ListView`` populated from ``voice.list_voices``)
  2. brain/key status + an optional Mistral API key (``Input``, masked)
  3. permission level (``ListView``) + the auto-update toggle (``Switch``)
  4. Twilio Account SID / Auth Token (``Input``, masked) + From Number +
     inbound/screening extensions, plus a "Test connection" button that
     calls ``phone.config`` ``action:"test"`` (a real reachability probe,
     not a fake always-success)

"Next" advances (Enter in a text ``Input`` does the same); the last step's
button reads "Finish" and calls ``settings.set`` with the exact patch shape
SetupWizard.qml's own ``finish()`` builds, then — if the Twilio fields were
actually touched — a SEPARATE ``phone.config`` ``action:"set"`` call (a
failure there is non-fatal: Twilio setup is optional and can always be
retried from ``phone_pane.py``'s Config tab, so it must never block
finishing onboarding the way a failed ``settings.set`` does), then dismisses.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, ListItem, ListView, Static, Switch

from jarvis_cli.control import ControlClient
from jarvis_cli.tui.arc_reactor import ArcReactorWidget
from jarvis_cli.tui.modal_base import modal_box_css, modal_screen_css

STEP_TITLES = ["Welcome", "Voice", "Brain", "Permissions", "Phone"]
STEP_COUNT = len(STEP_TITLES)

PERMISSION_OPTIONS = [
    ("high", "Cautious — ask before HIGH + MEDIUM"),
    ("medium", "Balanced — ask before HIGH only"),
    ("low", "Autonomous — only confirm the worst"),
]


class SetupWizardScreen(ModalScreen[None]):
    """First-launch onboarding overlay. Pushed by ``JarvisTui.on_mount`` (see
    ``_check_first_run`` in app.py) when ``settings.get``'s ``setup_complete``
    is falsy — AFTER the LockGate has already resolved."""

    DEFAULT_CSS = modal_screen_css("SetupWizardScreen") + modal_box_css(
        "SetupWizardScreen", "wizard-box") + """
    SetupWizardScreen > #wizard-box {
        width: 74;
        max-height: 90%;
        border: round #1b3242;
    }
    SetupWizardScreen #wizard-reactor {
        margin: 0 0 1 0;
        align-horizontal: center;
        width: 100%;
    }
    SetupWizardScreen #wizard-eyebrow {
        color: #35c8f0;
        text-style: bold;
        width: 100%;
    }
    SetupWizardScreen #wizard-step-title {
        color: #c9d6e3;
        text-style: bold;
        width: 100%;
        margin-bottom: 1;
    }
    SetupWizardScreen ListView {
        height: auto;
        max-height: 8;
        background: #0a1017;
        border: round #1b3242;
    }
    SetupWizardScreen Input {
        margin-top: 1;
    }
    SetupWizardScreen #auto-update-row {
        height: auto;
        margin-top: 1;
    }
    SetupWizardScreen #twilio-status {
        color: #9fb3c8;
        margin-top: 1;
    }
    SetupWizardScreen #twilio-ext-row {
        height: auto;
        margin-top: 1;
    }
    SetupWizardScreen #twilio-ext-row Input {
        width: 1fr;
        margin-top: 0;
    }
    SetupWizardScreen #twilio-ext-row Input:first-of-type {
        margin-right: 1;
    }
    SetupWizardScreen #twilio-test-row {
        height: auto;
        margin-top: 1;
    }
    SetupWizardScreen #twilio-test-result {
        color: #9fb3c8;
        margin-top: 1;
    }
    SetupWizardScreen #wizard-progress {
        color: #7f8ea0;
        width: 100%;
        margin-top: 1;
    }
    SetupWizardScreen #wizard-footer {
        height: auto;
        margin-top: 1;
        align-horizontal: right;
    }
    """

    def __init__(self, client: ControlClient) -> None:
        super().__init__()
        self.client = client

        self.step = 0
        self.assistant_name = "Jarvis"
        self.user_name = ""
        self.tts_voice = ""
        self.voice_list: list[dict] = []
        self.permission_level = "medium"
        self.auto_update = True
        self.has_cli = True
        self.mistral_key_set = False
        self.mistral_key = ""
        self.saving = False

        # -- Phone/Twilio (step 4) -- see the "phone.config" calls in _load()/
        # _finish()/_test_twilio() below. from_number/inbound_extension/
        # screening_extension are NOT secrets (phone.config echoes them back
        # directly on "get"); account_sid/auth_token ARE (only has_* booleans
        # come back, matching every other masked-secret field in this file).
        self.twilio_account_sid = ""
        self.twilio_auth_token = ""
        self.twilio_from_number = ""
        self.twilio_inbound_extension = ""
        self.twilio_screening_extension = ""
        self.twilio_has_account_sid = False
        self.twilio_has_auth_token = False
        self.twilio_configured = False
        # Snapshot of the non-secret fields AS LOADED — _build_phone_patch
        # only resends one of these if it was actually edited, so finishing
        # the wizard without touching step 4 never fires a no-op phone.config
        # set (e.g. re-sending the daemon's own "101" inbound-extension
        # default right back at it).
        self._twilio_loaded = {"from_number": "", "inbound_extension": "",
                               "screening_extension": ""}

    # -- layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:
        with Vertical(id="wizard-box"):
            yield ArcReactorWidget(size=9, spinning=True, thinking=False,
                                   id="wizard-reactor")
            yield Static("FIRST-TIME SETUP", id="wizard-eyebrow")
            yield Static("", id="wizard-step-title")

            with Vertical(id="step-0"):
                yield Static("Let's get you set up. This only takes a moment.")
                yield Static("What should I call myself?")
                yield Input(placeholder="Jarvis", id="name-field")
                yield Static("And what should I call you? (optional)")
                yield Input(placeholder="Your name", id="username-field")

            with Vertical(id="step-1"):
                yield Static("Pick the voice I speak with.")
                yield ListView(id="voice-list")

            with Vertical(id="step-2"):
                yield Static("", id="cli-status")
                yield Static("", id="mistral-status")
                yield Input(placeholder="Paste your Mistral API key…",
                           password=True, id="mistral-key-field")

            with Vertical(id="step-3"):
                yield Static("How cautious should Jarvis be before risky actions?")
                yield ListView(id="permission-list")
                with Horizontal(id="auto-update-row"):
                    yield Static("Keep Jarvis up to date automatically  ")
                    yield Switch(id="auto-update-switch")

            with Vertical(id="step-4"):
                yield Static("Set up phone calling with Twilio (optional — skip anytime).")
                yield Static("", id="twilio-status")
                yield Input(placeholder="Twilio Account SID", password=True,
                           id="twilio-sid-field")
                yield Input(placeholder="Twilio Auth Token", password=True,
                           id="twilio-auth-field")
                yield Input(placeholder="From number, e.g. +15551234567",
                           id="twilio-from-field")
                with Horizontal(id="twilio-ext-row"):
                    yield Input(placeholder="Inbound ext (101)", id="twilio-inbound-field")
                    yield Input(placeholder="Screening ext", id="twilio-screening-field")
                with Horizontal(id="twilio-test-row"):
                    yield Button("Test connection", id="twilio-test-btn")
                yield Static("", id="twilio-test-result")

            yield Static("", id="wizard-progress")
            with Horizontal(id="wizard-footer"):
                yield Button("Back", id="wizard-back-btn")
                yield Button("Next", id="wizard-next-btn", variant="primary")

    async def on_mount(self) -> None:
        self._populate_permission_list()
        self._update_step_display()
        await self._load()

    # -- daemon round-trips (mirrors SetupWizard.qml's load()/onSettingsLoaded/
    # onVoicesListed) -------------------------------------------------------------
    async def _load(self) -> None:
        # None of the three calls depends on another's result -- fire them
        # concurrently. Each has its own independent fallback (settings
        # failing must not blank the voice list, phone.config failing must
        # not touch either), so return_exceptions=True is required here --
        # unlike a plain gather(), it keeps one call's failure from
        # cancelling/aborting the others and lets each branch handle its own
        # error exactly as it did when the awaits were sequential. phone.config
        # is deliberately allowed to fail quietly (unknown_method on an older
        # daemon, or any transport error) -- step 4 is optional, so a daemon
        # that predates it must not break the rest of onboarding.
        settings_result, voices_result, phone_result = await asyncio.gather(
            self.client.call("settings.get", {}, timeout=15),
            self.client.call("voice.list_voices", {}, timeout=15),
            self.client.call("phone.config", {"action": "get"}, timeout=15),
            return_exceptions=True,
        )

        res = None if isinstance(settings_result, Exception) else settings_result
        if res is not None:
            settings = res.get("settings", res)
            available = settings.get("available_brains") or {}
            self.has_cli = bool(available.get("codex")) or bool(available.get("claude"))
            api_keys_set = settings.get("api_keys_set") or {}
            self.mistral_key_set = bool(api_keys_set.get("mistral"))
            if settings.get("assistant_name"):
                self.assistant_name = str(settings["assistant_name"])
            if settings.get("user_name"):
                self.user_name = str(settings["user_name"])
            if "tts_voice" in settings:
                self.tts_voice = str(settings.get("tts_voice") or "")
            pl = settings.get("permission_level")
            self.permission_level = pl if pl in ("high", "medium", "low") else "medium"
            au = settings.get("auto_update")
            self.auto_update = True if au is None else bool(au)
            self._apply_loaded_values_to_inputs()

        if isinstance(voices_result, Exception):
            self.voice_list = []
        else:
            self.voice_list = voices_result.get("voices") or []
        self._populate_voice_list()

        pres = None if isinstance(phone_result, Exception) else phone_result
        if pres is not None:
            tw = pres.get("twilio") or {}
            self.twilio_has_account_sid = bool(tw.get("has_account_sid"))
            self.twilio_has_auth_token = bool(tw.get("has_auth_token"))
            self.twilio_configured = bool(tw.get("configured"))
            self.twilio_from_number = str(tw.get("from_number") or "")
            self.twilio_inbound_extension = str(tw.get("inbound_extension") or "")
            self.twilio_screening_extension = str(tw.get("screening_extension") or "")
            self._twilio_loaded = {
                "from_number": self.twilio_from_number,
                "inbound_extension": self.twilio_inbound_extension,
                "screening_extension": self.twilio_screening_extension,
            }
            self._apply_phone_values_to_inputs()
        self._update_twilio_status()

        self._update_step_display()

    def _apply_loaded_values_to_inputs(self) -> None:
        try:
            self.query_one("#name-field", Input).value = self.assistant_name
        except Exception:
            pass
        try:
            self.query_one("#username-field", Input).value = self.user_name
        except Exception:
            pass
        try:
            self.query_one("#auto-update-switch", Switch).value = self.auto_update
        except Exception:
            pass

    def _apply_phone_values_to_inputs(self) -> None:
        # account_sid/auth_token are secrets -- only has_* comes back from
        # phone.config, so the ONLY thing loading can do to those two fields
        # is repaint their placeholder (never their value, per the "never a
        # real value" rule). from_number/the extensions are NOT secrets
        # (phone.config echoes them back directly), so those get their real
        # current value prefilled, same as name-field/username-field above.
        try:
            self.query_one("#twilio-sid-field", Input).placeholder = (
                "•••• set — leave blank to keep" if self.twilio_has_account_sid
                else "Twilio Account SID")
        except Exception:
            pass
        try:
            self.query_one("#twilio-auth-field", Input).placeholder = (
                "•••• set — leave blank to keep" if self.twilio_has_auth_token
                else "Twilio Auth Token")
        except Exception:
            pass
        try:
            self.query_one("#twilio-from-field", Input).value = self.twilio_from_number
        except Exception:
            pass
        try:
            self.query_one("#twilio-inbound-field", Input).value = self.twilio_inbound_extension
        except Exception:
            pass
        try:
            self.query_one("#twilio-screening-field", Input).value = self.twilio_screening_extension
        except Exception:
            pass

    def _update_twilio_status(self) -> None:
        try:
            self.query_one("#twilio-status", Static).update(
                "✓ Twilio already configured" if self.twilio_configured
                else "Optional — add Twilio credentials to enable phone calling")
        except Exception:
            pass

    def _populate_voice_list(self) -> None:
        try:
            lv = self.query_one("#voice-list", ListView)
        except Exception:
            return
        lv.clear()
        options = []
        for v in self.voice_list:
            vid = str(v.get("id", ""))
            label = str(v.get("label") or vid)
            options.append((vid, label))
        if not options:
            options = [(self.tts_voice, "Default voice")]
        for vid, label in options:
            item = ListItem(Static(label))
            item.voice_value = vid
            lv.append(item)

    def _populate_permission_list(self) -> None:
        try:
            lv = self.query_one("#permission-list", ListView)
        except Exception:
            return
        lv.clear()
        for key, label in PERMISSION_OPTIONS:
            item = ListItem(Static(label))
            item.permission_value = key
            lv.append(item)

    # -- input wiring -------------------------------------------------------------
    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "name-field":
            self.assistant_name = event.value
        elif event.input.id == "username-field":
            self.user_name = event.value
        elif event.input.id == "mistral-key-field":
            self.mistral_key = event.value
        elif event.input.id == "twilio-sid-field":
            self.twilio_account_sid = event.value
        elif event.input.id == "twilio-auth-field":
            self.twilio_auth_token = event.value
        elif event.input.id == "twilio-from-field":
            self.twilio_from_number = event.value
        elif event.input.id == "twilio-inbound-field":
            self.twilio_inbound_extension = event.value
        elif event.input.id == "twilio-screening-field":
            self.twilio_screening_extension = event.value

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id in ("name-field", "username-field", "mistral-key-field",
                              "twilio-sid-field", "twilio-auth-field", "twilio-from-field",
                              "twilio-inbound-field", "twilio-screening-field"):
            await self.action_next()

    def on_switch_changed(self, event: Switch.Changed) -> None:
        if event.switch.id == "auto-update-switch":
            self.auto_update = event.value

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        if event.list_view.id == "voice-list":
            value = getattr(event.item, "voice_value", None)
            if value is not None:
                self.tts_voice = value
        elif event.list_view.id == "permission-list":
            value = getattr(event.item, "permission_value", None)
            if value is not None:
                self.permission_level = value

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "wizard-back-btn":
            self.action_back()
        elif event.button.id == "wizard-next-btn":
            self.run_worker(self.action_next())
        elif event.button.id == "twilio-test-btn":
            self.run_worker(self._test_twilio())

    async def _test_twilio(self) -> None:
        """A REAL connectivity probe (phone.config action:"test" -> the
        daemon actually calls the phone server), not a fake always-success —
        mirrors what phone_pane.py's Config tab wires up for the same verb."""
        try:
            result = self.query_one("#twilio-test-result", Static)
        except Exception:
            result = None
        if result is not None:
            result.update("Testing…")
        try:
            res = await self.client.call("phone.config", {"action": "test"}, timeout=15)
        except Exception as exc:
            msg = f"Error: {exc}"
            if result is not None:
                result.update(msg)
            else:
                self.notify(msg, severity="error")
            return
        reachable = bool(res.get("reachable"))
        tw_ok = bool(res.get("twilio_configured"))
        msg = (("✓ phone server reachable" if reachable else "✗ phone server unreachable")
               + ("  ·  Twilio configured" if tw_ok else "  ·  Twilio not configured"))
        if result is not None:
            result.update(msg)
        else:
            self.notify(msg)

    # -- step navigation ------------------------------------------------------
    async def action_next(self) -> None:
        if self.saving:
            return
        if self.step < STEP_COUNT - 1:
            self.step += 1
            self._update_step_display()
        else:
            await self._finish()

    def action_back(self) -> None:
        if self.saving or self.step <= 0:
            return
        self.step -= 1
        self._update_step_display()

    async def _finish(self) -> None:
        self.saving = True
        self._update_step_display()
        name = self.assistant_name.strip()
        patch = {
            "setup_complete": True,
            "assistant_name": name if name else "Jarvis",
            "user_name": self.user_name.strip(),
            "tts_voice": self.tts_voice,
            "permission_level": self.permission_level,
            "auto_update": self.auto_update,
        }
        # Mirrors SetupWizard.qml's finish(): only send a Mistral key when one
        # was typed and none is already set — never overwrite an existing key
        # with an empty one.
        if not self.mistral_key_set and self.mistral_key.strip():
            patch["api_keys"] = {"mistral": self.mistral_key.strip()}
        try:
            await self.client.call("settings.set", {"patch": patch}, timeout=20)
        except Exception as exc:
            self.saving = False
            self._update_step_display()
            self.notify(f"setup failed: {exc}", severity="error")
            return

        phone_patch = self._build_phone_patch()
        if phone_patch:
            try:
                await self.client.call(
                    "phone.config", {"action": "set", "patch": phone_patch}, timeout=20)
            except Exception as exc:
                # Phone/Twilio setup is OPTIONAL, unlike the settings.set
                # above -- a failure here must not block finishing onboarding.
                # The user can always retry from phone_pane.py's Config tab.
                self.notify(f"phone setup not saved: {exc}", severity="warning")
        self.dismiss()

    def _build_phone_patch(self) -> dict:
        """Only includes a key the user actually changed: account_sid/
        auth_token (secrets) are sent whenever typed — unlike the Mistral key
        above, Twilio credentials are allowed to overwrite an already-set one
        (rotating a token is a normal thing to do), so there's no
        already-set gate, just "was something typed". The three non-secret
        fields are compared against ``_twilio_loaded`` (the value phone.config
        get returned) so leaving step 4 untouched never resends the daemon's
        own defaults back at it as a no-op write."""
        patch: dict[str, str] = {}
        if self.twilio_account_sid.strip():
            patch["twilio_account_sid"] = self.twilio_account_sid.strip()
        if self.twilio_auth_token.strip():
            patch["twilio_auth_token"] = self.twilio_auth_token.strip()
        if self.twilio_from_number.strip() != self._twilio_loaded.get("from_number", ""):
            patch["twilio_from_number"] = self.twilio_from_number.strip()
        if (self.twilio_inbound_extension.strip()
                != self._twilio_loaded.get("inbound_extension", "")):
            patch["twilio_inbound_extension"] = self.twilio_inbound_extension.strip()
        if (self.twilio_screening_extension.strip()
                != self._twilio_loaded.get("screening_extension", "")):
            patch["twilio_screening_extension"] = self.twilio_screening_extension.strip()
        return patch

    # -- rendering ----------------------------------------------------------------
    def _update_step_display(self) -> None:
        try:
            self.query_one("#wizard-step-title", Static).update(STEP_TITLES[self.step])
        except Exception:
            pass
        for i in range(STEP_COUNT):
            try:
                self.query_one(f"#step-{i}").display = (i == self.step)
            except Exception:
                pass
        try:
            self.query_one("#wizard-progress", Static).update(
                f"Step {self.step + 1} / {STEP_COUNT}")
        except Exception:
            pass
        try:
            self.query_one("#wizard-back-btn", Button).display = self.step > 0
        except Exception:
            pass
        try:
            next_btn = self.query_one("#wizard-next-btn", Button)
            is_last = self.step == STEP_COUNT - 1
            next_btn.label = ("Finishing…" if self.saving else "Finish") if is_last else "Next"
            next_btn.disabled = self.saving
        except Exception:
            pass
        try:
            self.query_one("#cli-status", Static).update(
                "✓ Codex / Claude CLI detected" if self.has_cli
                else "No Codex or Claude CLI found")
        except Exception:
            pass
        try:
            self.query_one("#mistral-status", Static).update(
                "✓ Mistral API key already set" if self.mistral_key_set
                else ("Add a Mistral key for voice + vision (optional)" if self.has_cli
                      else "Add a Mistral API key to get started"))
        except Exception:
            pass
