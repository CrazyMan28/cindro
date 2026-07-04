"""SetupWizardScreen — the terminal analog of desktop/qml/SetupWizard.qml.

Same four steps, same ``settings.get``/``settings.set``/``voice.list_voices``
calls, and — critically — the SAME first-run flag: ``settings.get``'s
``setup_complete`` boolean (ControlServer.cpp's ``handleSettingsGet``/
``handleSettingsSet``, persisted via ``SettingsStore::setupComplete()``).
There is deliberately NO separate TUI-only "have I onboarded" marker: finishing
the wizard in either front-end persists ``setup_complete=true`` on the shared
daemon, so completing it in the GUI skips it in the TUI and vice versa — they
can never desync.

Steps (mirrors SetupWizard.qml's ``[ "Welcome", "Voice", "Brain",
"Permissions" ][wiz.step]``):
  0. assistant name + the user's own name (``Input`` fields)
  1. TTS voice (a ``ListView`` populated from ``voice.list_voices``)
  2. brain/key status + an optional Mistral API key (``Input``, masked)
  3. permission level (``ListView``) + the auto-update toggle (``Switch``)

"Next" advances (Enter in a text ``Input`` does the same); the last step's
button reads "Finish" and calls ``settings.set`` with the exact patch shape
SetupWizard.qml's own ``finish()`` builds, then dismisses.
"""

from __future__ import annotations

from typing import Optional

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, ListItem, ListView, Static, Switch

from jarvis_cli.control import ControlClient
from jarvis_cli.tui.arc_reactor import ArcReactorWidget

STEP_TITLES = ["Welcome", "Voice", "Brain", "Permissions"]
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

    DEFAULT_CSS = """
    SetupWizardScreen {
        align: center middle;
        background: #06090d;
    }
    SetupWizardScreen > #wizard-box {
        width: 74;
        height: auto;
        max-height: 90%;
        padding: 1 2;
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
        try:
            res = await self.client.call("settings.get", {}, timeout=15)
        except Exception:
            res = None
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

        try:
            vres = await self.client.call("voice.list_voices", {}, timeout=15)
            self.voice_list = vres.get("voices") or []
        except Exception:
            self.voice_list = []
        self._populate_voice_list()
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

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id in ("name-field", "username-field", "mistral-key-field"):
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
        self.dismiss()

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
