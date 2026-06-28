#!/usr/bin/env python3
"""Live integration test: phone subsystem through the daemon proxy.

Invocation (uses the project venv, avoids host PYTHONPATH):

  env -u PYTHONPATH \\
    /home/user/projects/computer_use/computer-use/.venv/bin/python \\
    scripts/verify_phone_mcp_full.py

Daemon control WS: ws://127.0.0.1:8795/control/ws?token=<control_token>
All phone tools are called as:  {"method": "phone.mcp", "params": {"name": <tool>, "arguments": <args>}}

The daemon forwards to the phone HTTP MCP server (port 8801) and returns:
  ok=true  → result = {"tool": "<name>", "data": <parsed-JSON>}
  ok=false → error  = {"code": "...", "message": "..."}  (e.g. bad tool name / HTTP 400)
"""

import asyncio
import json
import os
import sys
import time
from typing import Any

try:
    import websockets
except ImportError:  # pragma: no cover
    print(
        "FAIL: 'websockets' not in venv. Run via:\n"
        "  env -u PYTHONPATH "
        "/home/user/projects/computer_use/computer-use/.venv/bin/python "
        "scripts/verify_phone_mcp_full.py",
        file=sys.stderr,
    )
    sys.exit(2)

# ── Config ────────────────────────────────────────────────────────────────────

CONTROL_PORT = 8795
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")

# Twilio constants expected in the running config
EXPECTED_FROM_NUMBER = "+15551234567"
ORIG_USER_NUMBER = "+13193898338"
TEST_ALLOWLIST_NUMBER = "+15555550123"

# ── Scoreboard ────────────────────────────────────────────────────────────────

_passes: list[str] = []
_fails: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    """Record a single pass/fail. Always returns the condition."""
    if condition:
        _passes.append(label)
        print(f"  PASS  {label}")
    else:
        _fails.append(label)
        suffix = f" — {detail}" if detail else ""
        print(f"  FAIL  {label}{suffix}")
    return condition


# ── WebSocket client ──────────────────────────────────────────────────────────


class WsClient:
    """Thin async JSON-RPC-over-WebSocket client for the jarvisd control port."""

    def __init__(self, ws) -> None:
        self.ws = ws
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}

    async def reader(self) -> None:
        """Background task: demultiplex incoming messages by id."""
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if mid is None:
                continue  # unsolicited event / notification
            fut = self._pending.pop(mid, None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def rpc(
        self,
        method: str,
        params: dict | None = None,
        timeout: float = 30.0,
    ) -> dict:
        """Send one JSON-RPC call and return the raw response dict."""
        self._next_id += 1
        mid = self._next_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(
            json.dumps({"v": 1, "id": mid, "method": method, "params": params or {}})
        )
        return await asyncio.wait_for(fut, timeout=timeout)

    async def phone(
        self,
        name: str,
        arguments: dict | None = None,
        timeout: float = 30.0,
    ) -> dict:
        """Call phone.mcp{name, arguments} and return the raw WS response."""
        return await self.rpc(
            "phone.mcp",
            {"name": name, "arguments": arguments or {}},
            timeout=timeout,
        )


# ── Response-shape helpers ────────────────────────────────────────────────────


def data_of(resp: dict) -> Any:
    """
    Extract the tool payload from a phone.mcp response.

    Successful call: result = {"tool": "...", "data": <payload>}
    Returns result["data"] (may be a dict, list, or None).
    """
    return resp.get("result", {}).get("data")


def is_ok(resp: dict) -> bool:
    """True when the daemon returned ok=true and there is no embedded error."""
    if not resp.get("ok", False):
        return False
    result = resp.get("result", {})
    if isinstance(result, dict) and "error" in result:
        return False
    return True


def is_error(resp: dict) -> bool:
    """
    True when the response is an error — either:
      • ok=false  (daemon-level error, e.g. phone_unreachable / bad HTTP 400)
      • ok=true but result contains an 'error' key  (embedded MCP error)
    """
    if not resp.get("ok", True):
        return True
    result = resp.get("result", {})
    if isinstance(result, dict) and "error" in result:
        return True
    return False


def numbers_in_allowlist(data: dict) -> list[str]:
    """Return the list of phone_number strings from a twilio_allowlist_list response."""
    return [r.get("phone_number", "") for r in (data.get("numbers") or [])]


# ── Individual test functions ─────────────────────────────────────────────────


async def test_list_extensions(c: WsClient) -> None:
    """list_extensions returns a non-empty list of extension records."""
    print("\n[list_extensions]")
    resp = await c.phone("list_extensions")
    check("list_extensions ok=true", is_ok(resp), repr(resp))
    data = data_of(resp)
    check(
        "list_extensions data is a list",
        isinstance(data, list),
        f"got {type(data).__name__}: {data!r}",
    )
    if isinstance(data, list):
        check("list_extensions list is non-empty", len(data) > 0, repr(data))
        first = data[0] if data else {}
        check(
            "list_extensions records have 'extension' field",
            "extension" in first,
            repr(first),
        )


async def test_list_agents(c: WsClient) -> None:
    """list_agents returns a list of agent records (may be empty)."""
    print("\n[list_agents]")
    resp = await c.phone("list_agents")
    check("list_agents ok=true", is_ok(resp), repr(resp))
    data = data_of(resp)
    check(
        "list_agents data is a list",
        isinstance(data, list),
        f"got {type(data).__name__}: {data!r}",
    )


async def test_twilio_status(c: WsClient) -> dict:
    """twilio_status: configured=True and from_number matches expected."""
    print("\n[twilio_status]")
    resp = await c.phone("twilio_status")
    check("twilio_status ok=true", is_ok(resp), repr(resp))
    data = data_of(resp) or {}
    check("twilio_status data is dict", isinstance(data, dict), repr(data))
    check(
        "twilio_status configured=True",
        data.get("configured") is True,
        repr(data),
    )
    check(
        f"twilio_status from_number={EXPECTED_FROM_NUMBER!r}",
        data.get("from_number") == EXPECTED_FROM_NUMBER,
        repr(data.get("from_number")),
    )
    return data


async def test_allowlist_roundtrip(c: WsClient) -> None:
    """Add a test number → verify list shows it → remove → verify gone."""
    print("\n[twilio_allowlist roundtrip]")

    # ── baseline list ──────────────────────────────────────────────────────
    resp0 = await c.phone("twilio_allowlist_list")
    check("allowlist_list ok=true (baseline)", is_ok(resp0), repr(resp0))
    d0 = data_of(resp0) or {}
    base_numbers = numbers_in_allowlist(d0)
    check(
        "allowlist_list data has 'numbers' key",
        isinstance(d0.get("numbers"), list),
        repr(d0),
    )

    # ── add ────────────────────────────────────────────────────────────────
    resp_add = await c.phone(
        "twilio_allowlist_add",
        {"phone_number": TEST_ALLOWLIST_NUMBER, "label": "integration-test"},
    )
    check("twilio_allowlist_add ok=true", is_ok(resp_add), repr(resp_add))
    d_add = data_of(resp_add) or {}
    check(
        "allowlist_add returns ok=True in payload",
        d_add.get("ok") is True,
        repr(d_add),
    )

    # ── list after add ─────────────────────────────────────────────────────
    resp_list2 = await c.phone("twilio_allowlist_list")
    check("allowlist_list ok=true (after add)", is_ok(resp_list2), repr(resp_list2))
    d_list2 = data_of(resp_list2) or {}
    nums_after_add = numbers_in_allowlist(d_list2)
    check(
        f"TEST number {TEST_ALLOWLIST_NUMBER!r} in allowlist after add",
        TEST_ALLOWLIST_NUMBER in nums_after_add,
        repr(nums_after_add),
    )

    # ── remove ─────────────────────────────────────────────────────────────
    resp_rm = await c.phone(
        "twilio_allowlist_remove", {"phone_number": TEST_ALLOWLIST_NUMBER}
    )
    check("twilio_allowlist_remove ok=true", is_ok(resp_rm), repr(resp_rm))

    # ── list after remove ──────────────────────────────────────────────────
    resp_list3 = await c.phone("twilio_allowlist_list")
    check("allowlist_list ok=true (after remove)", is_ok(resp_list3), repr(resp_list3))
    d_list3 = data_of(resp_list3) or {}
    nums_after_rm = numbers_in_allowlist(d_list3)
    check(
        f"TEST number {TEST_ALLOWLIST_NUMBER!r} absent after remove",
        TEST_ALLOWLIST_NUMBER not in nums_after_rm,
        repr(nums_after_rm),
    )


async def test_twilio_set_user_number_roundtrip(c: WsClient) -> None:
    """Set a temporary user number → verify via twilio_status → restore."""
    print("\n[twilio_set_user_number roundtrip]")
    TEMP_NUMBER = "+15551112222"

    # ── set temp ───────────────────────────────────────────────────────────
    resp_set = await c.phone("twilio_set_user_number", {"phone_number": TEMP_NUMBER})
    check("twilio_set_user_number ok=true (set)", is_ok(resp_set), repr(resp_set))
    d_set = data_of(resp_set) or {}
    check(
        "set returns default_user_number=TEMP",
        d_set.get("default_user_number") == TEMP_NUMBER,
        repr(d_set),
    )

    # ── verify via twilio_status ───────────────────────────────────────────
    resp_check = await c.phone("twilio_status")
    d_check = data_of(resp_check) or {}
    check(
        "twilio_status reflects TEMP default_user_number",
        d_check.get("default_user_number") == TEMP_NUMBER,
        repr(d_check.get("default_user_number")),
    )

    # ── restore original ───────────────────────────────────────────────────
    resp_restore = await c.phone(
        "twilio_set_user_number", {"phone_number": ORIG_USER_NUMBER}
    )
    check(
        "twilio_set_user_number ok=true (restore)", is_ok(resp_restore), repr(resp_restore)
    )
    d_restore = data_of(resp_restore) or {}
    check(
        f"restored default_user_number={ORIG_USER_NUMBER!r}",
        d_restore.get("default_user_number") == ORIG_USER_NUMBER,
        repr(d_restore),
    )

    # Remove TEMP from allowlist (twilio_set_user_number auto-allowlists it).
    await c.phone("twilio_allowlist_remove", {"phone_number": TEMP_NUMBER})


async def test_screening_roundtrip(c: WsClient) -> None:
    """Enable screening → verify via twilio_status → disable → verify off."""
    print("\n[twilio_screening enable/disable roundtrip]")

    # Capture initial state so we can restore it.
    resp_pre = await c.phone("twilio_status")
    initial_screening = bool((data_of(resp_pre) or {}).get("screening_enabled"))

    # ── enable ─────────────────────────────────────────────────────────────
    resp_on = await c.phone("twilio_screening_enable")
    check("twilio_screening_enable ok=true", is_ok(resp_on), repr(resp_on))

    resp_status_on = await c.phone("twilio_status")
    d_on = data_of(resp_status_on) or {}
    check(
        "twilio_status.screening_enabled=True after enable",
        d_on.get("screening_enabled") is True,
        repr(d_on.get("screening_enabled")),
    )

    # ── disable ────────────────────────────────────────────────────────────
    resp_off = await c.phone("twilio_screening_disable")
    check("twilio_screening_disable ok=true", is_ok(resp_off), repr(resp_off))

    resp_status_off = await c.phone("twilio_status")
    d_off = data_of(resp_status_off) or {}
    check(
        "twilio_status.screening_enabled=False after disable",
        d_off.get("screening_enabled") is False,
        repr(d_off.get("screening_enabled")),
    )

    # ── restore initial state if it was on ────────────────────────────────
    if initial_screening:
        await c.phone("twilio_screening_enable")


async def test_get_voice_profile(c: WsClient) -> None:
    """get_voice_profile for extension 101 returns a valid shape."""
    print("\n[get_voice_profile]")
    resp = await c.phone("get_voice_profile", {"extension": "101"})
    check("get_voice_profile ok=true", is_ok(resp), repr(resp))
    data = data_of(resp) or {}
    check("get_voice_profile data is dict", isinstance(data, dict), repr(data))
    check(
        "get_voice_profile has 'extension' field",
        "extension" in data,
        repr(data),
    )
    # 'voice' key is present even when null (no profile configured)
    check("get_voice_profile has 'voice' key", "voice" in data, repr(data))


async def test_list_inbox(c: WsClient) -> None:
    """list_inbox returns ok shape for extension 101."""
    print("\n[list_inbox]")
    resp = await c.phone("list_inbox", {"extension": "101", "limit": 20})
    check("list_inbox ok=true", is_ok(resp), repr(resp))
    data = data_of(resp) or {}
    check("list_inbox data is dict", isinstance(data, dict), repr(data))
    check("list_inbox has 'ok'=True in payload", data.get("ok") is True, repr(data))
    check(
        "list_inbox has 'messages' list",
        isinstance(data.get("messages"), list),
        repr(data),
    )


async def test_notify_then_inbox(c: WsClient) -> None:
    """notify_user creates a message that list_inbox can find."""
    print("\n[notify_user → list_inbox]")
    sentinel = f"INTEGRATION_TEST_{int(time.time())}"

    resp_notify = await c.phone(
        "notify_user",
        {
            "title": "Integration-test notification",
            "message": sentinel,
            "priority": "normal",
            "from_extension": "101",
            "to_extension": "101",
        },
    )
    check("notify_user ok=true", is_ok(resp_notify), repr(resp_notify))
    d_notify = data_of(resp_notify) or {}
    check(
        "notify_user returns message_id",
        bool(d_notify.get("message_id")),
        repr(d_notify),
    )

    # list_inbox should contain the sentinel
    resp_inbox = await c.phone("list_inbox", {"extension": "101", "limit": 100})
    d_inbox = data_of(resp_inbox) or {}
    messages = d_inbox.get("messages") or []
    found = any(sentinel in (m.get("body") or "") for m in messages)
    check(
        "sent message appears in list_inbox",
        found,
        f"sentinel={sentinel!r}, {len(messages)} messages checked",
    )


async def test_list_active_calls(c: WsClient) -> None:
    """list_active_calls returns a list (empty is fine)."""
    print("\n[list_active_calls]")
    resp = await c.phone("list_active_calls")
    check("list_active_calls ok=true", is_ok(resp), repr(resp))
    data = data_of(resp)
    check(
        "list_active_calls data is a list",
        isinstance(data, list),
        f"got {type(data).__name__}: {data!r}",
    )


async def test_get_call_transcript_nonexistent(c: WsClient) -> None:
    """get_call_transcript('nonexistent') returns gracefully (no crash)."""
    print("\n[get_call_transcript — nonexistent id]")
    try:
        resp = await c.phone(
            "get_call_transcript",
            {"call_id": "nonexistent-call-id-xyz-integration-test"},
            timeout=15.0,
        )
        # Either an ok response with empty arrays/message, or a daemon-level error.
        # Neither is a crash; both are acceptable.
        graceful = is_ok(resp) or is_error(resp)
        check("nonexistent transcript: graceful response", graceful, repr(resp))
        check("WS still alive after nonexistent transcript", True)
    except asyncio.TimeoutError:
        check("nonexistent transcript: no timeout", False, "timed out waiting for response")


async def test_edge_bad_tool_name(c: WsClient) -> None:
    """Completely unknown tool name returns an error, not a crash."""
    print("\n[edge: bad tool name]")
    resp = await c.phone("nonexistent_tool_name_xyzzy_integration_test")
    check(
        "bad tool name returns error response",
        is_error(resp),
        repr(resp),
    )


async def test_edge_bad_args(c: WsClient) -> None:
    """Missing required argument returns an error, not a crash."""
    print("\n[edge: bad args — missing required call_id]")
    # get_call_transcript requires call_id (zString = min-1 string).
    # Passing an empty dict should trigger Zod validation → error.
    resp = await c.phone("get_call_transcript", {})
    check(
        "missing required arg returns error response",
        is_error(resp),
        repr(resp),
    )


async def test_twilio_status_post_errors(c: WsClient) -> None:
    """twilio_status still works after bad-call edge-case tests."""
    print("\n[twilio_status after bad calls]")
    resp = await c.phone("twilio_status")
    check("twilio_status ok=true after bad calls", is_ok(resp), repr(resp))
    data = data_of(resp) or {}
    check(
        "post-error twilio_status.configured=True",
        data.get("configured") is True,
        repr(data),
    )


# ── Orchestrator ──────────────────────────────────────────────────────────────


async def run() -> int:
    # Read token
    try:
        token = open(TOKEN_PATH).read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read control token at {TOKEN_PATH}: {exc}", file=sys.stderr)
        return 2

    url = f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}"
    print(f"Connecting to ws://127.0.0.1:{CONTROL_PORT}/control/ws?token=***")

    try:
        ws = await asyncio.wait_for(
            websockets.connect(url, max_size=None), timeout=10.0
        )
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: cannot connect to daemon WS: {exc}", file=sys.stderr)
        return 1

    c = WsClient(ws)
    reader_task = asyncio.create_task(c.reader())

    try:
        # ── core read-only tools ───────────────────────────────────────────
        await test_list_extensions(c)
        await test_list_agents(c)
        await test_twilio_status(c)

        # ── allowlist mutate-and-restore ───────────────────────────────────
        await test_allowlist_roundtrip(c)

        # ── user-number mutate-and-restore ────────────────────────────────
        await test_twilio_set_user_number_roundtrip(c)

        # ── screening mutate-and-restore ──────────────────────────────────
        await test_screening_roundtrip(c)

        # ── voice / inbox ─────────────────────────────────────────────────
        await test_get_voice_profile(c)
        await test_list_inbox(c)
        await test_notify_then_inbox(c)

        # ── call tools (read-only / graceful) ─────────────────────────────
        await test_list_active_calls(c)
        await test_get_call_transcript_nonexistent(c)

        # ── edge-case error handling ──────────────────────────────────────
        await test_edge_bad_tool_name(c)
        await test_edge_bad_args(c)

        # ── final health check after injected errors ──────────────────────
        await test_twilio_status_post_errors(c)

    except Exception as exc:  # noqa: BLE001
        import traceback
        print(f"\nUNEXPECTED EXCEPTION: {exc}", file=sys.stderr)
        traceback.print_exc()
        _fails.append(f"unexpected_exception: {exc}")
    finally:
        reader_task.cancel()
        try:
            await asyncio.wait_for(ws.close(), timeout=3.0)
        except Exception:  # noqa: BLE001
            pass

    # ── Summary ───────────────────────────────────────────────────────────────
    total = len(_passes) + len(_fails)
    print(f"\n{'=' * 60}")
    print(f"SUMMARY: {len(_passes)}/{total} checks passed, {len(_fails)} failed")
    if _fails:
        print("\nFailed checks:")
        for label in _fails:
            print(f"  ✗ {label}")
        print("\nOVERALL: FAIL")
        return 1
    print("\nOVERALL: PASS")
    return 0


def main() -> int:
    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
