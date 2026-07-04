"""LockGateScreen — the TUI's 2FA + fingerprint cross-device unlock overlay.

Mirrors desktop/qml/LockGate.qml + desktop/src/Bridge.cpp (lines ~920-955) as
closely as a terminal allows:

  1) JarvisTui.on_mount calls ``auth.request(origin="desktop")`` ONCE, before
     this screen ever exists (see app.py's ``_check_lock_gate``). The daemon
     mints a challenge and FCM-pushes the paired phone.
  2) FAIL-OPEN: if that call errors for ANY reason (daemon unreachable, an
     older daemon without auth.* -> "unknown_method", ...) OR the reply says
     no phone is paired (``paired=False``) OR the challenge is already
     approved, the gate is skipped entirely — this screen is never pushed
     and the app proceeds immediately. This is deliberate: a user with no
     paired device must never be locked out, and startup/tests must never
     block on a challenge nobody will ever answer.
  3) Otherwise THIS screen is pushed already holding a live challenge_id, in
     the "waiting" phase: an ArcReactorWidget(thinking=True) + "Approve on
     your phone…", polling ``auth.status`` every POLL_INTERVAL_S until it
     reports approved/denied/expired, or TIMEOUT_S (130s, matching the GUI)
     elapses -> "Timed out — Retry" (Retry re-calls auth.request for a fresh
     challenge, same as the GUI's Retry button).
  4) A PIN fallback (``settings.get``'s ``has_desktop_pin``) submits to
     ``auth.verify_pin`` — success dismisses the gate immediately, matching
     Bridge.cpp's local "authStateChanged(...,'approved')" shortcut; any
     failure is treated as a wrong PIN (shown inline, field cleared) exactly
     like the GUI's unconditional ``pinRejected()`` on any ``!ok`` reply.

Approval (from the poll OR the PIN) simply calls ``self.dismiss()`` — the
screen underneath (the main JarvisTui UI) was already fully mounted the
whole time, so dismissing just lets the user get back to it.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Static

from jarvis_cli.control import ControlClient
from jarvis_cli.tui.arc_reactor import ArcReactorWidget

# Message text per phase — lifted straight from LockGate.qml's `text: { ... }`.
_PHASE_MESSAGES = {
    "starting": "Requesting unlock…",
    "waiting": "Approve on your phone — tap the notification and confirm "
               "with your fingerprint.",
    "denied": "Sign-in was denied on your phone.",
    "expired": "The unlock request expired.",
    "timeout": "Timed out waiting for approval.",
}
_RETRYABLE_PHASES = ("denied", "expired", "timeout")


class LockGateScreen(ModalScreen[None]):
    """Full-screen unlock gate. Swallows all input underneath until it
    dismisses itself (approved, via either the phone poll or a correct PIN)."""

    # Poll/timeout as CLASS attributes (not just module constants) so tests
    # can monkeypatch them down for fast, deterministic polling.
    POLL_INTERVAL_S: float = 1.5
    TIMEOUT_S: float = 130.0

    BINDINGS = [
        Binding("r", "retry", "Retry", show=False),
    ]

    DEFAULT_CSS = """
    LockGateScreen {
        align: center middle;
        background: #06090d;
    }
    LockGateScreen > #lock-box {
        width: 56;
        height: auto;
        padding: 1 2;
    }
    LockGateScreen #lock-reactor {
        margin: 0 0 1 0;
        align-horizontal: center;
        width: 100%;
    }
    LockGateScreen #lock-title {
        color: #35c8f0;
        text-style: bold;
        text-align: center;
        width: 100%;
    }
    LockGateScreen #lock-message {
        color: #9fb3c8;
        text-align: center;
        width: 100%;
        margin: 1 0;
    }
    LockGateScreen #lock-pin-row {
        align-horizontal: center;
        height: auto;
        margin-top: 1;
        display: none;
    }
    LockGateScreen #lock-pin-label {
        text-align: center;
        width: 100%;
        color: #7f8ea0;
    }
    LockGateScreen #lock-pin {
        width: 26;
        background: #0a1017;
        border: round #1b3242;
    }
    LockGateScreen #lock-retry-row {
        align-horizontal: center;
        height: auto;
        margin-top: 1;
        display: none;
    }
    """

    def __init__(
        self,
        client: ControlClient,
        challenge_id: str = "",
        *,
        origin: str = "desktop",
    ) -> None:
        """``challenge_id`` is normally already-minted (JarvisTui's own
        startup ``auth.request`` — see app.py) so this screen starts straight
        in "waiting" and doesn't fire a second, redundant request. Passing no
        challenge_id (e.g. constructing this screen standalone) makes it mint
        its own on mount, starting in "starting"."""
        super().__init__()
        self.client = client
        self.challenge_id = challenge_id
        self.origin = origin
        self.has_pin = False
        self.pin_error = False
        # "starting" | "waiting" | "denied" | "expired" | "timeout"
        self.phase = "waiting" if challenge_id else "starting"
        self._lock_task: Optional[asyncio.Task] = None
        self._pin_task: Optional[asyncio.Task] = None
        self._pin_setting_task: Optional[asyncio.Task] = None
        # Guards against a race between the poll loop and a concurrent PIN
        # submit both resolving to "approved": dismiss() must only ever be
        # called once — a second self.app.pop_screen() would pop whatever
        # screen is now on top instead (the main UI, or the last screen).
        self._dismissed = False

    def compose(self) -> ComposeResult:
        with Vertical(id="lock-box"):
            yield ArcReactorWidget(size=13, thinking=True, id="lock-reactor")
            yield Static("JARVIS LOCKED", id="lock-title")
            yield Static("", id="lock-message")
            with Vertical(id="lock-pin-row"):
                yield Static("OR UNLOCK WITH YOUR PIN", id="lock-pin-label")
                yield Input(placeholder="PIN", password=True, id="lock-pin")
            with Vertical(id="lock-retry-row"):
                yield Button("RETRY", id="lock-retry-btn", variant="primary")

    async def on_mount(self) -> None:
        self._sync_widgets()
        self._fetch_pin_setting()
        self._start()

    def on_unmount(self) -> None:
        self._cancel()
        for task in (self._pin_task, self._pin_setting_task):
            if task is not None and not task.done():
                task.cancel()

    # -- request / poll lifecycle ---------------------------------------------
    def _start(self) -> None:
        self._cancel()
        self._lock_task = asyncio.create_task(self._run())

    def _cancel(self) -> None:
        if self._lock_task is not None and not self._lock_task.done():
            self._lock_task.cancel()
        self._lock_task = None

    def _approve_and_dismiss(self) -> None:
        """The ONE path to a successful unlock (phone poll OR PIN) — see the
        race note on ``self._dismissed`` in __init__."""
        if self._dismissed:
            return
        self._dismissed = True
        self._cancel()
        self.dismiss()

    async def _run(self) -> None:
        try:
            if not self.challenge_id:
                self.phase = "starting"
                self._sync_widgets()
                try:
                    result = await self.client.call(
                        "auth.request", {"origin": self.origin}, timeout=15)
                except Exception:
                    self._approve_and_dismiss()  # fail-open: never lock out.
                    return
                if not result.get("paired") or result.get("state") == "approved":
                    self._approve_and_dismiss()  # fail-open / already approved.
                    return
                self.challenge_id = result.get("challenge_id", "")
                self.phase = "waiting"
                self._sync_widgets()

            deadline = asyncio.get_event_loop().time() + self.TIMEOUT_S
            while self.phase == "waiting":
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    self.phase = "timeout"
                    self._sync_widgets()
                    return
                await asyncio.sleep(min(self.POLL_INTERVAL_S, remaining))
                if self.phase != "waiting":
                    return
                try:
                    result = await self.client.call(
                        "auth.status", {"challenge_id": self.challenge_id},
                        timeout=10)
                except Exception:
                    continue  # transient — keep polling until the hard timeout.
                state = result.get("state")
                if state == "approved":
                    self._approve_and_dismiss()
                    return
                if state in ("denied", "expired"):
                    self.phase = state
                    self._sync_widgets()
                    return
        except asyncio.CancelledError:
            pass

    # -- PIN fallback -----------------------------------------------------------
    def _fetch_pin_setting(self) -> None:
        # Reference kept on self — an unreferenced asyncio.create_task() is
        # only weakly held by the loop and can be garbage-collected (and
        # silently cancelled) mid-flight.
        self._pin_setting_task = asyncio.create_task(self._load_pin_setting())

    async def _load_pin_setting(self) -> None:
        try:
            result = await self.client.call("settings.get", {}, timeout=10)
        except Exception:
            return
        settings = result.get("settings", result)
        self.has_pin = bool(settings.get("has_desktop_pin"))
        self._sync_widgets()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "lock-pin":
            return
        pin = event.value.strip()
        if pin:
            self._pin_task = asyncio.create_task(self._verify_pin(pin))

    async def _verify_pin(self, pin: str) -> None:
        try:
            result = await self.client.call(
                "auth.verify_pin",
                {"challenge_id": self.challenge_id, "pin": pin}, timeout=15)
        except Exception:
            result = {}
        if result.get("state") == "approved":
            self._approve_and_dismiss()
            return
        # Any non-approved reply (or a raised error) is a wrong PIN — matches
        # Bridge.cpp's unconditional pinRejected() on !ok for auth.verify_pin.
        self.pin_error = True
        self._sync_widgets()
        try:
            self.query_one("#lock-pin", Input).value = ""
        except Exception:
            pass

    # -- retry --------------------------------------------------------------
    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "lock-retry-btn":
            self.action_retry()

    def action_retry(self) -> None:
        self.pin_error = False
        self.challenge_id = ""
        self.phase = "starting"
        self._sync_widgets()
        self._start()

    # -- rendering --------------------------------------------------------------
    def _sync_widgets(self) -> None:
        try:
            self.query_one("#lock-reactor", ArcReactorWidget).thinking = (
                self.phase in ("starting", "waiting"))
        except Exception:
            pass
        try:
            self.query_one("#lock-message", Static).update(
                _PHASE_MESSAGES.get(self.phase, ""))
        except Exception:
            pass
        try:
            self.query_one("#lock-retry-row").display = (
                self.phase in _RETRYABLE_PHASES)
        except Exception:
            pass
        try:
            self.query_one("#lock-pin-row").display = (
                self.has_pin and self.phase != "starting")
            label = self.query_one("#lock-pin-label", Static)
            label.update("WRONG PIN — TRY AGAIN" if self.pin_error
                         else "OR UNLOCK WITH YOUR PIN")
        except Exception:
            pass
