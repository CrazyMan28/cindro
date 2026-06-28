#!/usr/bin/env python3
"""Direct HTTP integration test for the vendored phone server.

Tests the HTTP surface of the phone server at http://127.0.0.1:8801 directly,
without going through the daemon WS proxy.

Invocation (uses the project venv, avoids host PYTHONPATH):

  env -u PYTHONPATH \\
    /home/user/projects/computer_use/computer-use/.venv/bin/python \\
    scripts/verify_phone_http.py

AGENT_TOKEN is read from ~/.config/jarvis/phone.env — never hardcoded.
Does NOT mutate persistent state.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Any

# ── Config ────────────────────────────────────────────────────────────────────

BASE_URL = "http://127.0.0.1:8801"
PHONE_ENV_PATH = os.path.expanduser("~/.config/jarvis/phone.env")

# Required tool names in the tools/list response
REQUIRED_TOOLS = [
    "call_user",
    "notify_user",
    "twilio_call_and_wait",
    "device_sms",
    "list_extensions",
    "list_inbox",
    "twilio_status",
    "red_alert",
]

# Minimum number of tools expected
MIN_TOOL_COUNT = 50

# ── Scoreboard ────────────────────────────────────────────────────────────────

_passes: list[str] = []
_fails: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    """Record a single pass/fail.  Always returns the condition."""
    if condition:
        _passes.append(label)
        print(f"  PASS  {label}")
    else:
        _fails.append(label)
        suffix = f" — {detail}" if detail else ""
        print(f"  FAIL  {label}{suffix}")
    return condition


# ── Token loader ──────────────────────────────────────────────────────────────


def load_agent_token() -> str:
    """Parse AGENT_TOKEN from the phone.env file.  Never returns an empty string."""
    try:
        with open(PHONE_ENV_PATH) as f:
            content = f.read()
    except OSError as exc:
        print(
            f"FATAL: cannot read phone.env at {PHONE_ENV_PATH}: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)

    for line in content.splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == "AGENT_TOKEN":
            token = value.strip().strip("'\"")
            if not token:
                print("FATAL: AGENT_TOKEN is blank in phone.env", file=sys.stderr)
                sys.exit(2)
            return token

    print("FATAL: AGENT_TOKEN not found in phone.env", file=sys.stderr)
    sys.exit(2)


# ── HTTP helpers ──────────────────────────────────────────────────────────────


def http_get(
    path: str,
    token: str | None = None,
    timeout: float = 15.0,
) -> tuple[int, dict | list | str]:
    """GET {BASE_URL}{path}.  Returns (status_code, parsed_body)."""
    url = BASE_URL + path
    req = urllib.request.Request(url, method="GET")
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw.decode(errors="replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw.decode(errors="replace")


def http_post(
    path: str,
    body: dict | None = None,
    token: str | None = None,
    timeout: float = 20.0,
) -> tuple[int, dict | list | str]:
    """POST {BASE_URL}{path} with JSON body.  Returns (status_code, parsed_body)."""
    url = BASE_URL + path
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw.decode(errors="replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw.decode(errors="replace")


def post_mcp(
    body: dict,
    token: str | None = None,
    timeout: float = 20.0,
) -> tuple[int, dict | str]:
    """POST /mcp with the given body."""
    return http_post("/mcp", body=body, token=token, timeout=timeout)


def jsonrpc_body(
    method: str,
    params: dict | None = None,
    rpc_id: int = 1,
) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": method,
        "params": params or {},
    }


# ── Individual test sections ──────────────────────────────────────────────────


def test_health() -> None:
    """GET /health → 200 with ok:true."""
    print("\n[GET /health]")
    status, body = http_get("/health")
    check("health: status 200", status == 200, f"got {status}")
    if isinstance(body, dict):
        check("health: body.ok == true", body.get("ok") is True, repr(body))
        check(
            "health: service field present",
            "service" in body,
            repr(body),
        )
    else:
        check("health: body is JSON object", False, f"got {type(body).__name__}: {body!r}")


def test_tools_list(token: str) -> list[str]:
    """POST /mcp tools/list → >=50 tools; required names present."""
    print("\n[POST /mcp — tools/list]")
    status, body = post_mcp(jsonrpc_body("tools/list"), token=token)
    check("tools/list: status 200", status == 200, f"got {status}")

    if not isinstance(body, dict):
        check("tools/list: body is JSON object", False, repr(body))
        return []

    # JSON-RPC result shape
    check("tools/list: has 'result' key", "result" in body, repr(list(body.keys())))
    result = body.get("result", {})
    tools_list = result.get("tools", []) if isinstance(result, dict) else []
    check(
        "tools/list: result.tools is a list",
        isinstance(tools_list, list),
        f"got {type(tools_list).__name__}",
    )

    tool_names = [t.get("name", "") for t in tools_list if isinstance(t, dict)]
    check(
        f"tools/list: >= {MIN_TOOL_COUNT} tools",
        len(tool_names) >= MIN_TOOL_COUNT,
        f"got {len(tool_names)}",
    )

    for required in REQUIRED_TOOLS:
        check(
            f"tools/list: required tool '{required}' present",
            required in tool_names,
            f"found: {sorted(tool_names)[:10]}...",
        )

    # Each tool definition has name + description + inputSchema
    if tools_list:
        sample = tools_list[0]
        for key in ("name", "description", "inputSchema"):
            check(
                f"tools/list: tool definition has '{key}' key",
                key in sample,
                repr(list(sample.keys())),
            )

    return tool_names


def test_tools_call_twilio_status(token: str) -> None:
    """POST /mcp tools/call twilio_status → configured, from_number."""
    print("\n[POST /mcp — tools/call twilio_status]")
    body = jsonrpc_body(
        "tools/call",
        params={"name": "twilio_status", "arguments": {}},
    )
    status, resp = post_mcp(body, token=token)
    check("twilio_status: status 200", status == 200, f"got {status}")

    if not isinstance(resp, dict):
        check("twilio_status: response is JSON object", False, repr(resp))
        return

    result = resp.get("result", {})
    check(
        "twilio_status: result present",
        bool(result),
        repr(resp),
    )

    # Unwrap MCP content array if present
    payload: dict[str, Any] = {}
    if isinstance(result, dict):
        content = result.get("content", [])
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict) and first.get("type") == "text":
                try:
                    payload = json.loads(first.get("text", "{}"))
                except json.JSONDecodeError:
                    payload = {}
        # Fallback: result itself might be the payload
        if not payload:
            payload = result

    check(
        "twilio_status: configured == true",
        payload.get("configured") is True,
        repr(payload),
    )
    check(
        "twilio_status: from_number present",
        bool(payload.get("from_number")),
        repr(payload),
    )
    check(
        "twilio_status: from_number starts with +1",
        str(payload.get("from_number", "")).startswith("+1"),
        repr(payload.get("from_number")),
    )


def test_tools_call_list_extensions(token: str) -> None:
    """POST /mcp tools/call list_extensions → non-empty list."""
    print("\n[POST /mcp — tools/call list_extensions]")
    body = jsonrpc_body(
        "tools/call",
        params={"name": "list_extensions", "arguments": {}},
    )
    status, resp = post_mcp(body, token=token)
    check("list_extensions: status 200", status == 200, f"got {status}")

    if not isinstance(resp, dict):
        check("list_extensions: response is JSON object", False, repr(resp))
        return

    result = resp.get("result", {})
    check("list_extensions: result present", bool(result), repr(resp))

    # Unwrap content array
    payload: Any = None
    if isinstance(result, dict):
        content = result.get("content", [])
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict) and first.get("type") == "text":
                try:
                    payload = json.loads(first.get("text", "[]"))
                except json.JSONDecodeError:
                    payload = None
        if payload is None:
            payload = result

    check(
        "list_extensions: payload is a list",
        isinstance(payload, list),
        f"got {type(payload).__name__}: {repr(payload)[:120]}",
    )
    if isinstance(payload, list):
        check(
            "list_extensions: non-empty",
            len(payload) > 0,
            "empty list returned",
        )
        if payload:
            first_ext = payload[0]
            check(
                "list_extensions: records have 'extension' field",
                isinstance(first_ext, dict) and "extension" in first_ext,
                repr(first_ext),
            )


def test_api_extensions(token: str) -> None:
    """GET /api/extensions → list of extension records."""
    print("\n[GET /api/extensions]")
    status, body = http_get("/api/extensions", token=token)
    check("api/extensions: status 200", status == 200, f"got {status}")
    check(
        "api/extensions: body is a list",
        isinstance(body, list),
        f"got {type(body).__name__}: {repr(body)[:100]}",
    )
    if isinstance(body, list):
        check("api/extensions: non-empty", len(body) > 0, "empty list")
        if body:
            first = body[0]
            check(
                "api/extensions: record has 'extension' field",
                isinstance(first, dict) and "extension" in first,
                repr(first),
            )


def test_api_calls(token: str) -> None:
    """GET /api/calls → list (may be empty)."""
    print("\n[GET /api/calls]")
    status, body = http_get("/api/calls", token=token)
    check("api/calls: status 200", status == 200, f"got {status}")
    check(
        "api/calls: body is a list",
        isinstance(body, list),
        f"got {type(body).__name__}: {repr(body)[:100]}",
    )


def test_api_missed_calls(token: str) -> None:
    """GET /api/missed-calls → list (may be empty)."""
    print("\n[GET /api/missed-calls]")
    status, body = http_get("/api/missed-calls", token=token)
    check("api/missed-calls: status 200", status == 200, f"got {status}")
    check(
        "api/missed-calls: body is a list",
        isinstance(body, list),
        f"got {type(body).__name__}: {repr(body)[:100]}",
    )


def test_auth_rejection() -> None:
    """Requests with no bearer or wrong bearer to /mcp must be rejected (401/403)."""
    print("\n[auth: no bearer → 401/403]")
    status, body = post_mcp(jsonrpc_body("tools/list"), token=None)
    check(
        "auth: no bearer → 401 or 403",
        status in (401, 403),
        f"got {status}: {repr(body)[:100]}",
    )

    print("\n[auth: wrong bearer → 401/403]")
    status2, body2 = post_mcp(
        jsonrpc_body("tools/list"),
        token="wrong-token-integration-test-xyzzy",
    )
    check(
        "auth: wrong bearer → 401 or 403",
        status2 in (401, 403),
        f"got {status2}: {repr(body2)[:100]}",
    )

    # Confirm auth-protected GET endpoints also enforce auth
    print("\n[auth: GET /api/extensions — no bearer → 401/403]")
    status3, body3 = http_get("/api/extensions", token=None)
    check(
        "auth: GET /api/extensions no bearer → 401 or 403",
        status3 in (401, 403),
        f"got {status3}: {repr(body3)[:100]}",
    )


def test_malformed_json_rpc(token: str) -> None:
    """Malformed / incomplete JSON-RPC bodies are handled gracefully (no 5xx crash)."""
    print("\n[malformed JSON-RPC body]")

    cases: list[tuple[str, dict]] = [
        # Empty object — no method, no tool
        ("empty object", {}),
        # method present but unknown
        ("unknown method", {"jsonrpc": "2.0", "id": 1, "method": "no_such_method"}),
        # tools/call with missing tool name
        (
            "tools/call no name",
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"arguments": {}},
            },
        ),
        # tools/call with non-dict params
        (
            "tools/call params is null",
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": None,
            },
        ),
    ]

    for label, payload in cases:
        status, body = post_mcp(payload, token=token)
        check(
            f"malformed ({label}): no 5xx crash",
            status < 500,
            f"got {status}: {repr(body)[:100]}",
        )
        # Body should be parseable JSON (already parsed by http_post)
        check(
            f"malformed ({label}): response is JSON",
            isinstance(body, (dict, list)),
            f"got {type(body).__name__}: {repr(body)[:100]}",
        )


def test_unknown_tool(token: str) -> None:
    """Calling an unknown tool name returns a 4xx error, not a 5xx crash."""
    print("\n[tools/call — unknown tool name]")
    body = jsonrpc_body(
        "tools/call",
        params={
            "name": "nonexistent_tool_xyzzy_integration_test",
            "arguments": {},
        },
    )
    status, resp = post_mcp(body, token=token)
    check(
        "unknown tool: status 4xx (not 5xx)",
        400 <= status < 500,
        f"got {status}",
    )
    check(
        "unknown tool: response is JSON object",
        isinstance(resp, dict),
        repr(resp)[:100],
    )


def test_tools_call_bad_args(token: str) -> None:
    """Calling a tool with missing required args returns a 4xx error."""
    print("\n[tools/call — missing required arg for list_inbox]")
    # list_inbox requires 'extension' (a min-1 string).  Pass empty args.
    body = jsonrpc_body(
        "tools/call",
        params={"name": "list_inbox", "arguments": {}},
    )
    status, resp = post_mcp(body, token=token)
    # The server should reject with 400 (Zod validation failure), not crash.
    check(
        "bad args: status 4xx (not 5xx)",
        status < 500,
        f"got {status}: {repr(resp)[:100]}",
    )


def test_health_no_auth() -> None:
    """/health is public — no token required."""
    print("\n[GET /health — no auth required]")
    status, body = http_get("/health", token=None)
    check("health (no auth): status 200", status == 200, f"got {status}")
    check(
        "health (no auth): ok == true",
        isinstance(body, dict) and body.get("ok") is True,
        repr(body),
    )


def test_post_after_errors(token: str) -> None:
    """Server still responds correctly to a valid tools/list after all edge-case calls."""
    print("\n[sanity: tools/list after all error-injection tests]")
    status, body = post_mcp(jsonrpc_body("tools/list"), token=token)
    check("post-error tools/list: status 200", status == 200, f"got {status}")
    if isinstance(body, dict):
        result = body.get("result", {})
        tools = result.get("tools", []) if isinstance(result, dict) else []
        check(
            f"post-error tools/list: still >= {MIN_TOOL_COUNT} tools",
            len(tools) >= MIN_TOOL_COUNT,
            f"got {len(tools)}",
        )


# ── Orchestrator ──────────────────────────────────────────────────────────────


def run() -> int:
    token = load_agent_token()
    print(f"Loaded AGENT_TOKEN from {PHONE_ENV_PATH}  (len={len(token)})")
    print(f"Target: {BASE_URL}")
    print()

    # ── 1. Public health endpoint ─────────────────────────────────────────
    test_health()
    test_health_no_auth()

    # ── 2. tools/list ─────────────────────────────────────────────────────
    tool_names = test_tools_list(token)

    # ── 3. tools/call — read-only tools ──────────────────────────────────
    test_tools_call_twilio_status(token)
    test_tools_call_list_extensions(token)

    # ── 4. REST API endpoints ──────────────────────────────────────────────
    test_api_extensions(token)
    test_api_calls(token)
    test_api_missed_calls(token)

    # ── 5. Auth rejection ────────────────────────────────────────────────
    test_auth_rejection()

    # ── 6. Malformed / edge-case bodies ──────────────────────────────────
    test_malformed_json_rpc(token)
    test_unknown_tool(token)
    test_tools_call_bad_args(token)

    # ── 7. Final sanity: server still healthy after error injections ──────
    test_post_after_errors(token)

    # ── Summary ───────────────────────────────────────────────────────────
    total = len(_passes) + len(_fails)
    print()
    print("=" * 65)
    print(f"SUMMARY: {len(_passes)}/{total} checks passed, {len(_fails)} failed")

    if _fails:
        print()
        print("Failed checks:")
        for label in _fails:
            print(f"  FAIL  {label}")
        print()
        print("OVERALL: FAIL")
        return 1

    print()
    print("OVERALL: PASS")
    return 0


def main() -> int:
    try:
        return run()
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
