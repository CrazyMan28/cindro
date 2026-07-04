"""PhonePane — device pairing (ASCII QR, pure-Python `qrcode`, no system
qrencode binary needed — confirmed absent on dev machines) + device list +
revoke, mirroring the desktop app's Devices section (Bridge.cpp:894-920).

ADDS (this module still owns pairing/QR unchanged, see the "Devices" sub-tab
below): a dialer, an active-calls list, a call-screening view, and an
incoming-call alert banner — the terminal analogs of desktop/qml's
PhoneDialerTab.qml, PhoneScreeningTab.qml and PhoneCallOverlay.qml.

Wire protocol note (traced through desktop/src/Bridge.cpp +
daemon/src/ControlServer.cpp): despite the name, ``phone.http`` is NOT a raw
HTTP endpoint reachable directly by a client — jarvisd's control server is a
QWebSocketServer with no HTTP listener at all (ControlServer.cpp only ever
calls ``m_wsServer->listen(...)``). Bridge.cpp's ``phoneHttp()`` just sends a
``phone.http`` *control-channel* request over the very same socket
``phoneMcp()`` uses (``request(QStringLiteral("phone.http"), params,
callId)``); the daemon's ``handlePhoneHttp`` then makes the actual outbound
HTTP call to the local phone server on the caller's behalf (the phone
subsystem's bearer token "never leaves the daemon" — see the comment above
``PhoneEnv`` in ControlServer.cpp). So there is no per-session-engine (or
direct daemon REST) endpoint to hit with httpx here — both ``phone.mcp`` and
``phone.http`` are called exactly like every other Contract-A verb, via
``ControlClient.call(method, params)`` (the same client devices.list/
devices.pair_start already use). ``resolve_engine_endpoint`` + httpx (as used
by browser_pane.py) is for a DIFFERENT thing — a per-session computer-use
engine's own local REST API — and doesn't apply to the phone subsystem.

Both ``phone.mcp`` and ``phone.http`` ARE implemented daemon-side today
(ControlServer.cpp's dispatch table routes them to handlePhoneMcp/
handlePhoneHttp) — this is not forward-built scaffolding. Even so, every call
site here still degrades quietly on an ``unknown_method`` (or any other
``ControlError``/``ConnectionError``/``TimeoutError``) instead of raising, in
case of daemon/client version skew.
"""

from __future__ import annotations

import io
import re

import qrcode
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, DataTable, Input, Static, TabbedContent, TabPane

from jarvis_cli.control import ControlError
from jarvis_cli.tui.degrade import call_degrading

# Extensions are short numeric dial strings (mirrors PhoneDialerTab.qml's
# `/^\d{1,6}$/.test(target)` — numeric-only means "dial this extension",
# anything else means "place an in-app call to the user with this as the
# reason").
_EXTENSION_RE = re.compile(r"^\d{1,6}$")

# States PhoneCallOverlay.qml treats as "ringing, needs an answer" vs.
# "already connected".
_RINGING_STATES = ("ringing", "created")
_ACTIVE_STATES = ("active", "accepted")


def _ascii_qr(payload: str) -> str:
    qr = qrcode.QRCode(border=1)
    qr.add_data(payload)
    qr.make(fit=True)
    buf = io.StringIO()
    qr.print_ascii(out=buf, invert=True)
    return buf.getvalue()


class PhonePane(Vertical):
    HINT = "p: pair a new device · x: revoke · r: refresh"
    DIAL_HINT = "type an extension (e.g. 101) or free text + enter: call · r: refresh calls"
    COLUMNS = ("device", "id", "last seen")
    CALL_COLUMNS = ("call", "state", "route", "reason")

    DEFAULT_CSS = """
    PhonePane #phone-call-alert {
        display: none;
        border: round #35c8f0;
        padding: 1 2;
        margin-bottom: 1;
        height: auto;
    }
    PhonePane #phone-call-alert.ringing {
        border: round #e8b339;
    }
    PhonePane #phone-call-title {
        text-style: bold;
    }
    PhonePane #phone-call-sub {
        color: #9fb3c8;
    }
    PhonePane #phone-call-transcript {
        color: #9fb3c8;
        margin-top: 1;
        height: auto;
        max-height: 8;
    }
    PhonePane #phone-call-actions {
        height: auto;
        margin-top: 1;
    }
    PhonePane #phone-call-actions Button {
        margin-right: 1;
    }
    """

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.rows: list[dict] = []
        self.active_calls: list[dict] = []
        self.screening: dict = {}
        self.incoming: dict = {}  # the ringing/active call the banner shows, or {}
        self._calls_timer = None
        self._screening_timer = None

    @property
    def client(self):
        return self.app.client

    # -- composition -------------------------------------------------------------
    def compose(self) -> ComposeResult:
        with Vertical(id="phone-call-alert"):
            yield Static("", id="phone-call-title")
            yield Static("", id="phone-call-sub")
            yield Static("", id="phone-call-transcript")
            with Horizontal(id="phone-call-actions"):
                yield Button("ACCEPT", id="phone-call-accept", variant="success")
                yield Button("REJECT", id="phone-call-reject", variant="error")
                yield Button("END CALL", id="phone-call-end", variant="error")

        with TabbedContent(id="phone-subtabs"):
            with TabPane("Devices", id="phone-tab-devices"):
                yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
                table = DataTable(cursor_type="row", id="phone-devices-table")
                table.add_columns(*self.COLUMNS)
                yield table
                yield Static("", id="phone-qr")
            with TabPane("Dialer", id="phone-tab-dialer"):
                yield Static(Text(self.DIAL_HINT, style="bright_black"), classes="pane-hint")
                yield Input(placeholder="extension (e.g. 101) or free text to call the user",
                            id="dial-target")
                yield Static("", id="dial-status")
                yield Static(Text("ACTIVE CALLS", style="bright_black"), classes="pane-hint")
                calls_table = DataTable(cursor_type="row", id="phone-calls-table")
                calls_table.add_columns(*self.CALL_COLUMNS)
                yield calls_table
            with TabPane("Screening", id="phone-tab-screening"):
                yield Static("No active screening session", id="screening-status")
                yield Static("", id="screening-transcript")

    def on_mount(self) -> None:
        # refresh_data is a plain async method (no @work decorator, unlike
        # TablePane's), so calling it bare would only create a coroutine
        # object and drop it unawaited (RuntimeWarning, no actual fetch) —
        # call_later is how MemoryGraphPane/HomePane schedule the same shape
        # of method from a sync callback.
        self.call_later(self.refresh_data)
        self.call_later(self._poll_calls_and_banner)
        self.call_later(self._poll_screening)
        # Poll-based (not event-driven): ControlClient.on_broadcast_extra is a
        # SINGLE slot already claimed by CanvasPane (tui/canvas_pane.py) for
        # widget.* broadcasts — a second claimant here would silently clobber
        # it depending on tab mount order. So, unlike the desktop GUI's
        # phone.event-pushed overlay, this polls list_active_calls /
        # get_screening_status on a plain timer — the same role the QML's
        # "SLOW safety net" poll plays when its event bridge is down.
        self._calls_timer = self.set_interval(3.0, self._poll_calls_and_banner)
        self._screening_timer = self.set_interval(4.0, self._poll_screening)

    def on_unmount(self) -> None:
        """Stop both polling timers outright — they're recreated fresh by
        the next on_mount, so there's nothing to resume into after this."""
        if self._calls_timer is not None:
            self._calls_timer.stop()
            self._calls_timer = None
        if self._screening_timer is not None:
            self._screening_timer.stop()
            self._screening_timer = None

    def pause_timers(self) -> None:
        """Pause the calls/screening poll timers — called by app.py's
        on_tabbed_content_tab_activated whenever some OTHER tab becomes
        active, so the Dialer/Screening round trips (every 3-4s) don't keep
        firing while the Phone tab isn't even visible. Same
        ArcReactorWidget.pause()/.resume() convention already used
        elsewhere in this codebase for gating background ticks on
        visibility."""
        if self._calls_timer is not None:
            self._calls_timer.pause()
        if self._screening_timer is not None:
            self._screening_timer.pause()

    def resume_timers(self) -> None:
        """Resume the calls/screening poll timers — called when the Phone
        tab becomes active again."""
        if self._calls_timer is not None:
            self._calls_timer.resume()
        if self._screening_timer is not None:
            self._screening_timer.resume()

    def refresh_if_stale(self) -> None:
        self.call_later(self.refresh_data)
        self.call_later(self._poll_calls_and_banner)
        self.call_later(self._poll_screening)

    # -- Devices (unchanged behavior) --------------------------------------------
    async def refresh_data(self) -> None:
        try:
            res = await self.client.call("devices.list", {})
            self.rows = list(res.get("devices", []))
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.rows = []
            self.notify(str(exc), severity="error", timeout=4)
        table = self.query_one("#phone-devices-table", DataTable)
        table.clear()
        for r in self.rows:
            table.add_row(r.get("name", ""), r.get("id", ""), r.get("last_seen", ""))

    def selected(self) -> dict | None:
        table = self.query_one("#phone-devices-table", DataTable)
        if not self.rows or table.cursor_row is None:
            return None
        if 0 <= table.cursor_row < len(self.rows):
            return self.rows[table.cursor_row]
        return None

    # -- Dialer: call_extension / call_user (phone.mcp) --------------------------
    async def _phone_mcp(self, name: str, arguments: dict | None = None) -> dict:
        """Call a phone MCP tool via the daemon's phone.mcp proxy verb.
        Returns the {tool, data?, text?, error?} payload Bridge.cpp/QML
        expect — never raises: transport failures are folded into the same
        `{"error": {...}}` shape callers already check for (via the shared
        call_degrading helper in tui/degrade.py — unlike chat.py/
        settings_extras.py this doesn't special-case "unknown_method", every
        failure folds into the same wrap_error() shape)."""
        return await call_degrading(
            self.client, "phone.mcp", {"name": name, "arguments": arguments or {}},
            wrap_error=lambda exc: {
                "tool": name, "error": {"code": "transport_error", "message": str(exc)}})

    async def _phone_http(self, method: str, path: str, body: dict | None = None) -> dict:
        """Call a phone REST route via the daemon's phone.http proxy verb
        (see the module docstring for why this is a control-channel call,
        not an httpx request). Never raises, same convention as _phone_mcp."""
        return await call_degrading(
            self.client, "phone.http",
            {"method": method, "path": path, "body": body or {}},
            wrap_error=lambda exc: {
                "status": 0, "error": {"code": "transport_error", "message": str(exc)}})

    async def dial(self, target: str) -> None:
        """Numeric -> call_extension(from_extension="100", extension=target);
        anything else -> call_user(reason=target) — same split as
        PhoneDialerTab.qml's primary call button."""
        target = target.strip()
        if not target:
            return
        status = self.query_one("#dial-status", Static)
        if _EXTENSION_RE.match(target):
            status.update(f"Ringing {target}…")
            res = await self._phone_mcp(
                "call_extension", {"from_extension": "100", "extension": target})
            if res.get("error"):
                status.update(f"Error: {res['error'].get('message', 'failed')}")
            else:
                status.update(f"Connected to {target}")
        else:
            status.update("Calling user…")
            res = await self._phone_mcp("call_user", {"reason": target})
            if res.get("error"):
                status.update(f"Error: {res['error'].get('message', 'failed')}")
            else:
                status.update("In-app call placed")
        await self._poll_calls_and_banner()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "dial-target":
            target = event.value
            event.input.value = ""
            await self.dial(target)

    # -- active calls list (Dialer tab) + incoming-call banner -------------------
    async def _poll_calls_and_banner(self) -> None:
        if not self.client.connected:
            return
        res = await self._phone_mcp("list_active_calls")
        if res.get("error"):
            return  # quiet degrade — unknown_method / phone_not_configured / transport
        data = res.get("data")
        self.active_calls = data if isinstance(data, list) else []
        self._render_active_calls()
        await self._update_incoming_banner(self.active_calls)

    def _render_active_calls(self) -> None:
        try:
            table = self.query_one("#phone-calls-table", DataTable)
        except Exception:
            return
        table.clear()
        for c in self.active_calls:
            route = f"{c.get('from_extension', '—')} → {c.get('to_extension', '—')}"
            table.add_row(str(c.get("id", "")), c.get("state", "unknown"),
                          route, c.get("reason", "") or "")

    async def _update_incoming_banner(self, calls: list[dict]) -> None:
        # This whole body is wrapped in one try/except (rather than only
        # guarding the first widget lookup) because it's driven by a
        # recurring 3s set_interval timer (see on_mount) — a transient
        # NoMatches on ANY of the widget lookups below (mid-teardown, or a
        # test that removed one) must never bubble out of a background timer
        # callback and crash the whole app. Same convention as
        # _render_banner below and app.py's `_set_topbar` fix.
        try:
            found = None
            for c in calls:
                if c.get("state") in _RINGING_STATES:
                    found = c
                    break
            if found is None:
                for c in calls:
                    if c.get("state") in _ACTIVE_STATES:
                        found = c
                        break

            prev_id = str(self.incoming.get("id", "")) if self.incoming else ""
            new_id = str(found.get("id", "")) if found else ""
            self.incoming = dict(found) if found else {}
            self._render_banner()

            if found and found.get("state") in _ACTIVE_STATES:
                if new_id != prev_id:
                    self.query_one("#phone-call-transcript", Static).update("Awaiting transcript…")
                await self._load_call_transcript(new_id)
            elif not found:
                self.query_one("#phone-call-transcript", Static).update("")
        except Exception:
            return

    async def _load_call_transcript(self, call_id: str) -> None:
        if not call_id:
            return
        res = await self._phone_mcp("get_call_transcript", {"call_id": call_id})
        if res.get("error"):
            return
        data = res.get("data") or {}
        texts = data.get("transcripts") if isinstance(data.get("transcripts"), list) else []
        msgs = data.get("messages") if isinstance(data.get("messages"), list) else []
        lines = []
        for t in texts:
            who = f"ext {t.get('from_extension')}" if t.get("from_extension") is not None else "caller"
            lines.append(f"[{who}] {t.get('text', '')}")
        for m in msgs:
            who = f"ext {m.get('from_extension')}" if m.get("from_extension") is not None else "agent"
            lines.append(f"[{who}] {m.get('content') or m.get('text') or ''}")
        try:
            self.query_one("#phone-call-transcript", Static).update(
                "\n".join(lines) if lines else "(no messages yet)")
        except Exception:
            pass

    def _render_banner(self) -> None:
        # Entire body wrapped in one try/except — this runs off the same
        # recurring 3s timer as _update_incoming_banner above (via
        # _poll_calls_and_banner), so any of these widget lookups hitting a
        # transient NoMatches must degrade quietly instead of crashing the
        # app from a background timer callback.
        try:
            alert = self.query_one("#phone-call-alert")
            if not self.incoming:
                alert.display = False
                alert.remove_class("ringing")
                return
            alert.display = True
            state = self.incoming.get("state", "")
            ringing = state in _RINGING_STATES
            alert.set_class(ringing, "ringing")

            self.query_one("#phone-call-title", Static).update(
                Text("INCOMING CALL" if ringing else "ACTIVE CALL",
                     style="bold #e8b339" if ringing else "bold #35c8f0"))

            from_ext = self.incoming.get("from_extension", "—")
            to_ext = self.incoming.get("to_extension", "—")
            reason = self.incoming.get("reason", "")
            sub_text = f"ext {from_ext} → {to_ext}"
            if reason:
                sub_text += f"  ·  {reason}"
            self.query_one("#phone-call-sub", Static).update(sub_text)

            self.query_one("#phone-call-accept", Button).display = ringing
            self.query_one("#phone-call-reject", Button).display = ringing
            self.query_one("#phone-call-end", Button).display = not ringing
            self.query_one("#phone-call-transcript", Static).display = not ringing
        except Exception:
            return

    # -- incoming-call actions (phone.http POST /api/calls/:id/accept|reject) ---
    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid == "phone-call-accept":
            self.run_worker(self._accept_call())
        elif bid == "phone-call-reject":
            self.run_worker(self._reject_call())
        elif bid == "phone-call-end":
            self.run_worker(self._end_call())

    async def _accept_call(self) -> None:
        call_id = str(self.incoming.get("id", ""))
        if not call_id:
            return
        res = await self._phone_http(
            "POST", f"/api/calls/{call_id}/accept", {"extension": "100"})
        if res.get("error"):
            self.notify(res["error"].get("message", "accept failed"), severity="error")
        await self._poll_calls_and_banner()

    async def _reject_call(self) -> None:
        call_id = str(self.incoming.get("id", ""))
        if not call_id:
            return
        res = await self._phone_http(
            "POST", f"/api/calls/{call_id}/reject",
            {"extension": "100", "reason": "rejected_by_user"})
        if res.get("error"):
            self.notify(res["error"].get("message", "reject failed"), severity="error")
        self.incoming = {}
        self._render_banner()
        await self._poll_calls_and_banner()

    async def _end_call(self) -> None:
        call_id = str(self.incoming.get("id", ""))
        if not call_id:
            return
        res = await self._phone_mcp("end_call", {"call_id": call_id})
        if res.get("error"):
            self.notify(res["error"].get("message", "end call failed"), severity="error")
        self.incoming = {}
        self._render_banner()
        await self._poll_calls_and_banner()

    # -- Screening (phone.mcp get_screening_status) ------------------------------
    async def _poll_screening(self) -> None:
        if not self.client.connected:
            return
        res = await self._phone_mcp("get_screening_status")
        if res.get("error"):
            return  # quiet degrade
        data = res.get("data") or {}
        self.screening = data
        self._render_screening(data)

    def _render_screening(self, data: dict) -> None:
        active = bool(data.get("active"))
        caller_num = str(data.get("caller_number") or "")
        caller_name = str(data.get("caller_name") or "")
        agent_ext = str(data.get("agent_extension") or "")

        try:
            status_widget = self.query_one("#screening-status", Static)
        except Exception:
            return
        if active:
            caller = f"{caller_name}  {caller_num}".strip() if caller_name else (caller_num or "Unknown")
            status_widget.update(
                f"Screening in progress — caller: {caller} — "
                f"agent: {'ext ' + agent_ext if agent_ext else '—'}")
        else:
            status_widget.update("No active screening session")

        msgs = data.get("transcript") if isinstance(data.get("transcript"), list) else []
        lines = []
        for m in msgs:
            speaker = m.get("speaker")
            if not speaker:
                speaker = f"ext {m.get('from_extension')}" if m.get("from_extension") is not None else "?"
            body = m.get("text") or m.get("content") or m.get("message") or ""
            lines.append(f"[{speaker}] {body}")
        try:
            transcript_widget = self.query_one("#screening-transcript", Static)
        except Exception:
            return
        if lines:
            transcript_widget.update("\n".join(lines))
        else:
            transcript_widget.update("Awaiting transcript…" if active else "")

    # -- key handling (gated by which sub-tab is active) -------------------------
    async def on_key(self, event) -> None:
        try:
            active = self.query_one("#phone-subtabs", TabbedContent).active
        except Exception:
            active = "phone-tab-devices"

        if active == "phone-tab-devices":
            if event.key == "r":
                await self.refresh_data()
            elif event.key == "p":
                try:
                    res = await self.client.call("devices.pair_start", {})
                    qr_text = _ascii_qr(res.get("payload", res.get("code", "")))
                    self.query_one("#phone-qr", Static).update(
                        Text(f"{qr_text}\ncode: {res.get('code', '')} "
                            f"(expires {res.get('expires_at', '?')})"))
                except (ControlError, ConnectionError, TimeoutError) as exc:
                    self.notify(str(exc), severity="error")
            elif event.key == "x":
                row = self.selected()
                if row:
                    try:
                        await self.client.call("devices.revoke", {"id": row.get("id", "")})
                    except ControlError as exc:
                        self.notify(str(exc), severity="error")
                    await self.refresh_data()
        elif active == "phone-tab-dialer":
            if event.key == "r":
                await self._poll_calls_and_banner()
        elif active == "phone-tab-screening":
            if event.key == "r":
                await self._poll_screening()
