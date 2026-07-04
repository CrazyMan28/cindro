"""Settings sub-views reachable from the Settings tab as QuickViewScreen
popups (SettingsPane's 'c'/'p'/'e' keys) — Connectors, Policies (trust
rules), and browser-extension pairing. Mirrors desktop/qml/SettingsPage.qml's
CONNECTORS section (~line 2175+, bridge.connectorsList/connectorAdd), the
trust-policy card (~line 1660+, bridge.policyList/policyAdd/policyUpdate/
policyRemove/policySetDefault), and the one-paste extension pairing flow
(~line 2113+, bridge.extensionPairStart).

daemon/src/ControlServer.cpp DOES implement all three verb families today
(handleConnectorsList/Add, handlePolicyList/Add/Update/Remove/SetDefault,
handleExtensionPairStart all exist and are wired into isConfigMethod/
dispatchConfigMethod) — unlike the diff.* verbs, these are not
forward-built-ahead-of-the-daemon. Even so, every call here goes through
``_call_degrading`` so a daemon that predates these verbs (or a future verb
this file doesn't know about yet) degrades the same quiet way diff.* does
in chat.py's _diff_action: an inline muted status line, not a crash or an
error-toast.
"""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import DataTable, Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.phone_pane import _ascii_qr
from jarvis_cli.tui.screens import TablePane

_ACTIONS = ("allow", "ask", "deny")


def _next_action(current: str) -> str:
    try:
        idx = _ACTIONS.index(current)
    except ValueError:
        idx = -1
    return _ACTIONS[(idx + 1) % len(_ACTIONS)]


async def _call_degrading(pane, method: str, params: dict, status_id: str):
    """Call a daemon verb that might not be implemented yet, mirroring
    ChatPane._diff_action's degrade-on-"unknown_method" precedent: on
    "unknown_method" this writes a quiet muted line into the `status_id`
    Static (falling back to a non-error notify if that widget isn't mounted)
    instead of an error toast or a crash. Any OTHER failure still surfaces
    as a normal error notify, same as every other pane in this file's
    sibling modules (system_panes.py, screens.py). Returns the result dict
    on success, None on any failure (caller treats None as "didn't happen")."""
    try:
        status = pane.query_one(f"#{status_id}", Static)
    except Exception:
        status = None
    try:
        res = await pane.client.call(method, params)
        if status is not None:
            status.update("")
        return res
    except ControlError as exc:
        if exc.code == "unknown_method":
            msg = f"{method} is not available yet"
            if status is not None:
                status.update(Text(msg, style="yellow"))
            else:
                pane.notify(msg, severity="warning")
        else:
            pane.notify(str(exc), severity="error")
        return None
    except (ConnectionError, TimeoutError) as exc:
        pane.notify(str(exc), severity="error")
        return None


class ConnectorsPane(TablePane):
    """Google connector rows (connectors.list/add) — mirrors SettingsPage.qml's
    CONNECTORS card. Only has_* booleans are ever shown for creds; the secrets
    themselves never round-trip back from the daemon (ControlServer.cpp:
    handleConnectorsList)."""

    HINT = ("type 'service :: client_id :: client_secret :: refresh_token' + enter: add · "
            "r: refresh  (services: calendar, docs, drive, gmail)")
    COLUMNS = ("service", "name", "enabled", "risk", "creds")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="service :: client_id :: client_secret :: refresh_token",
                    id="connectors-add")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table
        yield Static("", id="connectors-status")

    async def fetch(self) -> list[dict]:
        res = await _call_degrading(self, "connectors.list", {}, "connectors-status")
        if res is None:
            return []
        return list(res.get("connectors", []))

    def to_cells(self, r: dict) -> tuple:
        enabled = bool(r.get("enabled"))
        creds = "".join((
            "C" if r.get("has_client_id") else "-",
            "S" if r.get("has_client_secret") else "-",
            "T" if r.get("has_refresh_token") else "-",
        ))
        return (r.get("service", ""), r.get("name", ""),
                Text("on" if enabled else "off", style="green" if enabled else "bright_black"),
                r.get("risk", ""), creds)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "connectors-add":
            return
        raw = event.value.strip()
        event.input.value = ""
        if not raw:
            return
        parts = [p.strip() for p in raw.split("::")]
        service = parts[0] if parts else ""
        client_id = parts[1] if len(parts) > 1 else ""
        client_secret = parts[2] if len(parts) > 2 else ""
        refresh_token = parts[3] if len(parts) > 3 else ""
        if not service:
            self.notify("usage: service :: client_id :: client_secret :: refresh_token",
                        severity="error")
            return
        res = await _call_degrading(
            self, "connectors.add",
            {"service": service, "client_id": client_id,
             "client_secret": client_secret, "refresh_token": refresh_token},
            "connectors-status")
        if res is not None:
            self.notify(f"added {res.get('name', service)}")
        self.refresh_data()

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()


class PoliciesPane(TablePane):
    """Trust-policy rules (policy.list/add/update/remove/set_default) —
    mirrors SettingsPage.qml's "Trust policies" card. Unlike the advisory
    permission_level knob in SettingsPane, these are enforced on every tool
    call (deny fails it, ask pops an approval)."""

    HINT = ("type 'tool :: app :: action :: note' + enter: add rule · "
            "a: cycle selected rule's action · x: remove rule · d: cycle default · r: refresh")
    COLUMNS = ("action", "tool", "app", "note", "id")

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.default_action = "allow"

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Static("", id="policies-default")
        yield Input(placeholder="tool glob (browser_*) :: app glob (*bank*) :: action :: note",
                    id="policy-add")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table
        yield Static("", id="policies-status")

    async def fetch(self) -> list[dict]:
        res = await _call_degrading(self, "policy.list", {}, "policies-status")
        if res is None:
            return []
        self.default_action = res.get("default", "allow")
        try:
            self.query_one("#policies-default", Static).update(
                Text(f"default (no rule matches): {self.default_action.upper()}", style="cyan"))
        except Exception:
            pass
        return list(res.get("rules", []))

    def to_cells(self, r: dict) -> tuple:
        return (r.get("action", ""), r.get("tool", ""), r.get("app", ""),
                r.get("note", "") or "", r.get("id", ""))

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "policy-add":
            return
        raw = event.value.strip()
        event.input.value = ""
        if not raw:
            return
        parts = [p.strip() for p in raw.split("::")]
        tool = parts[0] if parts else ""
        app = parts[1] if len(parts) > 1 and parts[1] else "*"
        action = parts[2] if len(parts) > 2 and parts[2] in _ACTIONS else "ask"
        note = parts[3] if len(parts) > 3 else ""
        if not tool:
            self.notify("usage: tool :: app :: action :: note", severity="error")
            return
        res = await _call_degrading(
            self, "policy.add",
            {"tool": tool, "app": app, "action": action, "note": note},
            "policies-status")
        if res is not None:
            self.notify("rule added")
        self.refresh_data()

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "d":
            nxt = _next_action(self.default_action)
            res = await _call_degrading(self, "policy.set_default", {"action": nxt},
                                        "policies-status")
            if res is not None:
                self.notify(f"default → {nxt}")
            self.refresh_data()
        elif event.key == "a":
            row = self.selected()
            if row:
                nxt = _next_action(row.get("action", "ask"))
                res = await _call_degrading(
                    self, "policy.update", {"id": row.get("id"), "action": nxt},
                    "policies-status")
                if res is not None:
                    self.notify(f"{row.get('id')} → {nxt}")
                self.refresh_data()
        elif event.key == "x":
            row = self.selected()
            if row:
                res = await _call_degrading(self, "policy.remove", {"id": row.get("id")},
                                            "policies-status")
                if res is not None:
                    self.notify("rule removed")
                self.refresh_data()


class ExtensionPairPane(Vertical):
    """One-paste browser-extension pairing (extension.pair_start) rendered
    as an ASCII QR — reuses phone_pane.py's `_ascii_qr` helper rather than
    duplicating it. Unlike devices.pair_start (which returns a payload +
    qr_svg), handleExtensionPairStart only returns {code, expires_at,
    control_port} — no payload/qr_svg field — so `_ascii_qr` encodes the
    bare code, same fallback phone_pane.py's own 'p' handler already uses
    (`res.get("payload", res.get("code", ""))`)."""

    HINT = "g: generate/regenerate a pairing code"

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Static("", id="extension-qr")

    def on_mount(self) -> None:
        self.call_later(self.generate)

    async def generate(self) -> None:
        res = await _call_degrading(self, "extension.pair_start", {}, "extension-qr")
        if res is None:
            return
        qr_text = _ascii_qr(res.get("payload", res.get("code", "")))
        self.query_one("#extension-qr", Static).update(
            Text(f"{qr_text}\ncode: {res.get('code', '')} "
                f"(expires {res.get('expires_at', '?')})"))

    async def on_key(self, event) -> None:
        if event.key == "g":
            await self.generate()
