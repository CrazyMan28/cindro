"""Unit tests for jarvis_cli.tui.degrade.call_degrading — the ONE shared
helper chat.py's _diff_action, settings_extras.py's _call_degrading, and
phone_pane.py's _phone_mcp/_phone_http all delegate to (see tui/degrade.py's
module docstring for why three independent reinventions got collapsed into
this). These exercise the helper directly against a stub client rather than
the full Textual app — the three call sites' OWN observable behavior is
covered by test_tui.py/test_settings_extras.py, which must stay green
across this refactor."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from jarvis_cli.control import ControlError  # noqa: E402
from jarvis_cli.tui.degrade import call_degrading  # noqa: E402


class _StubClient:
    """A minimal stand-in for ControlClient.call — either returns a canned
    result or raises a canned exception, and records what it was asked."""

    def __init__(self, result=None, raises: Exception | None = None):
        self.result = result
        self.raises = raises
        self.calls: list[tuple[str, dict]] = []

    async def call(self, method, params=None, timeout=60.0):
        self.calls.append((method, params))
        if self.raises is not None:
            raise self.raises
        return self.result


async def test_call_degrading_returns_result_and_fires_on_success():
    client = _StubClient(result={"ok": True, "value": 42})
    seen = []
    res = await call_degrading(client, "some.verb", {"a": 1},
                                on_success=lambda r: seen.append(r))
    assert res == {"ok": True, "value": 42}
    assert seen == [{"ok": True, "value": 42}]
    assert client.calls == [("some.verb", {"a": 1})]


async def test_call_degrading_unknown_method_fires_on_unknown_method_not_on_error():
    client = _StubClient(raises=ControlError("unknown_method", "no such verb"))
    unknown_seen = []
    error_seen = []
    res = await call_degrading(
        client, "some.verb", {},
        on_unknown_method=lambda exc: unknown_seen.append(exc),
        on_error=lambda exc: error_seen.append(exc))
    assert res is None
    assert len(unknown_seen) == 1 and unknown_seen[0].code == "unknown_method"
    assert error_seen == []


async def test_call_degrading_unknown_method_falls_back_to_on_error_when_no_specific_handler():
    """phone_pane.py's use doesn't distinguish unknown_method — it only
    passes wrap_error, no on_unknown_method/on_error at all, so this also
    covers the "neither given" no-op path."""
    client = _StubClient(raises=ControlError("unknown_method", "no such verb"))
    error_seen = []
    res = await call_degrading(client, "some.verb", {},
                                on_error=lambda exc: error_seen.append(exc))
    assert res is None
    assert len(error_seen) == 1


async def test_call_degrading_other_control_error_calls_on_error_not_on_unknown_method():
    client = _StubClient(raises=ControlError("bad_request", "nope"))
    unknown_seen = []
    error_seen = []
    res = await call_degrading(
        client, "some.verb", {},
        on_unknown_method=lambda exc: unknown_seen.append(exc),
        on_error=lambda exc: error_seen.append(exc))
    assert res is None
    assert unknown_seen == []
    assert len(error_seen) == 1 and error_seen[0].code == "bad_request"


async def test_call_degrading_connection_error_calls_on_error():
    client = _StubClient(raises=ConnectionError("daemon unreachable"))
    error_seen = []
    res = await call_degrading(client, "some.verb", {},
                                on_error=lambda exc: error_seen.append(exc))
    assert res is None
    assert len(error_seen) == 1


async def test_call_degrading_timeout_error_calls_on_error():
    client = _StubClient(raises=TimeoutError("took too long"))
    error_seen = []
    res = await call_degrading(client, "some.verb", {},
                                on_error=lambda exc: error_seen.append(exc))
    assert res is None
    assert len(error_seen) == 1


async def test_call_degrading_wrap_error_returns_custom_value_instead_of_none():
    """phone_pane.py's _phone_mcp/_phone_http precedent: on ANY failure
    (including unknown_method), return a wrapped error dict instead of bare
    None, with no side-effecting callbacks at all."""
    client = _StubClient(raises=ControlError("unknown_method", "nope"))
    res = await call_degrading(
        client, "phone.mcp", {"name": "call_user"},
        wrap_error=lambda exc: {"tool": "call_user",
                                "error": {"code": "transport_error", "message": str(exc)}})
    assert res == {"tool": "call_user",
                   "error": {"code": "transport_error",
                            "message": "unknown_method: nope"}}

    client2 = _StubClient(raises=ConnectionError("down"))
    res2 = await call_degrading(
        client2, "phone.http", {"method": "GET", "path": "/x"},
        wrap_error=lambda exc: {"status": 0,
                                "error": {"code": "transport_error", "message": str(exc)}})
    assert res2 == {"status": 0,
                    "error": {"code": "transport_error", "message": "down"}}


async def test_call_degrading_success_does_not_call_wrap_error_or_error_callbacks():
    client = _StubClient(result={"ok": True})
    calls = []
    res = await call_degrading(
        client, "some.verb", {},
        on_error=lambda exc: calls.append("error"),
        on_unknown_method=lambda exc: calls.append("unknown"),
        wrap_error=lambda exc: calls.append("wrap") or {"never": True})
    assert res == {"ok": True}
    assert calls == []
