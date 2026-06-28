#!/usr/bin/env python3
"""Contract A full round-trip integration test — live daemon control WS.

Covers: settings.get baseline; settings.set/get round-trip for agent_mode
(plan/build/coworker), wake_notify (silent/ping/always), permission_level
(high/medium/low); invalid values normalise (zzz->default); RESET+CONFIRM;
hooks.add UserPromptSubmit (CTXOK inject), SessionStart (inject), PreToolUse
matcher=Bash (Bash runs / Edit skips); hooks.remove each; bad event -> ok:false.
Leaves hooks.json empty and settings at the captured baseline.

Run:
  env -u PYTHONPATH \\
    /home/user/projects/computer_use/computer-use/.venv/bin/python \\
    scripts/verify_contract_a_full.py
"""

import asyncio
import json
import os
import sys
from typing import Any

try:
    import websockets
except ImportError:
    print(
        "FAIL: websockets not in venv.\n"
        "  env -u PYTHONPATH "
        "/home/user/projects/computer_use/computer-use/.venv/bin/python "
        "scripts/verify_contract_a_full.py",
        file=sys.stderr,
    )
    sys.exit(2)

CONTROL_PORT = 8795
TOKEN_PATH = os.path.expanduser("~/.config/jarvis/control_token")

_passes: list[str] = []
_fails: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> bool:
    if cond:
        _passes.append(label)
        print(f"  PASS  {label}")
    else:
        _fails.append(label)
        print(f"  FAIL  {label}" + (f"  ({detail})" if detail else ""))
    return cond


# ── WebSocket client ───────────────────────────────────────────────────────────

class WsClient:
    def __init__(self, ws) -> None:
        self.ws = ws
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}

    async def reader(self) -> None:
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if mid is None:
                continue
            fut = self._pending.pop(mid, None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def rpc(self, method: str, params: dict | None = None, timeout: float = 20.0) -> dict:
        self._next_id += 1
        mid = self._next_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self.ws.send(json.dumps({"v": 1, "id": mid, "method": method, "params": params or {}}))
        return await asyncio.wait_for(fut, timeout=timeout)

    def ok(self, r: dict) -> bool:
        return bool(r.get("ok", False))

    def res(self, r: dict) -> dict:
        return r.get("result") or {}

    def err(self, r: dict) -> dict:
        return r.get("error") or {}


# ── Settings tests ─────────────────────────────────────────────────────────────

async def settings_baseline(c: WsClient) -> dict[str, Any]:
    print("\n[settings.get — baseline]")
    resp = await c.rpc("settings.get")
    check("settings.get ok=true", c.ok(resp), repr(resp))
    r = c.res(resp)
    am, wn, pl = r.get("agent_mode"), r.get("wake_notify"), r.get("permission_level")
    check("baseline agent_mode valid", am in ("plan", "build", "coworker"), f"got {am!r}")
    check("baseline wake_notify valid", wn in ("silent", "ping", "always"), f"got {wn!r}")
    check("baseline permission_level valid", pl in ("high", "medium", "low"), f"got {pl!r}")
    return {"agent_mode": am, "wake_notify": wn, "permission_level": pl}


async def settings_roundtrip(c: WsClient, field: str, values: tuple[str, ...]) -> None:
    print(f"\n[settings.set {field} round-trip: {values}]")
    for v in values:
        sr = await c.rpc("settings.set", {"patch": {field: v}})
        check(f"set {field}={v!r} ok=true", c.ok(sr), repr(sr))
        gr = await c.rpc("settings.get")
        got = c.res(gr).get(field)
        check(f"get confirms {field}={v!r}", got == v, f"got {got!r}")


async def settings_normalise(c: WsClient) -> None:
    """Invalid values must be accepted and normalised to the canonical default."""
    print("\n[settings.set — invalid values → normalised defaults]")
    cases = [
        ("agent_mode",      "zzz", "coworker"),
        ("wake_notify",     "zzz", "ping"),
        ("permission_level","zzz", "medium"),
    ]
    for field, bad, want in cases:
        sr = await c.rpc("settings.set", {"patch": {field: bad}})
        check(f"set {field}=zzz accepted", c.ok(sr), repr(sr))
        gr = await c.rpc("settings.get")
        got = c.res(gr).get(field)
        check(f"{field} zzz normalises to {want!r}", got == want, f"got {got!r}")


async def settings_reset(c: WsClient, baseline: dict[str, Any]) -> None:
    print("\n[settings.set — RESET + CONFIRM baseline]")
    r = await c.rpc("settings.set", {"patch": baseline})
    check("reset patch ok=true", c.ok(r), repr(r))
    g = c.res(await c.rpc("settings.get"))
    for key, exp in baseline.items():
        got = g.get(key)
        check(f"confirmed {key}={exp!r}", got == exp, f"got {got!r}")


# ── Hooks helpers ──────────────────────────────────────────────────────────────

async def h_add(c: WsClient, event: str, cmd: str, matcher: str = "") -> dict:
    return await c.rpc("hooks.add", {"event": event, "command": cmd, "matcher": matcher, "timeout": 10})

async def h_remove(c: WsClient, event: str, idx: int) -> dict:
    return await c.rpc("hooks.remove", {"event": event, "index": idx})

async def h_test(c: WsClient, event: str, match_key: str = "") -> dict:
    return await c.rpc("hooks.test", {"event": event, "match_key": match_key, "input": {}})

async def h_list_count(c: WsClient, event: str) -> int:
    r = c.res(await c.rpc("hooks.list"))
    return len((r.get("hooks") or {}).get(event) or [])


# ── Hooks tests ────────────────────────────────────────────────────────────────

async def test_hook_user_prompt_submit(c: WsClient) -> None:
    """UserPromptSubmit hook: injected_context contains CTXOK."""
    print("\n[hooks — UserPromptSubmit additionalContext]")
    CMD = r"""printf '{"additionalContext":"CTXOK"}'"""
    ar = await h_add(c, "UserPromptSubmit", CMD)
    check("hooks.add UserPromptSubmit ok=true", c.ok(ar), repr(ar))

    tr = await h_test(c, "UserPromptSubmit")
    check("hooks.test UserPromptSubmit ok=true", c.ok(tr), repr(tr))
    rv = c.res(tr)
    check("UserPromptSubmit ran_any=true", bool(rv.get("ran_any")), repr(rv))
    ctx = rv.get("injected_context") or ""
    check("UserPromptSubmit injected_context has CTXOK", "CTXOK" in ctx, f"ctx={ctx!r}")

    rr = await h_remove(c, "UserPromptSubmit", 0)
    check("hooks.remove UserPromptSubmit[0] ok=true", c.ok(rr), repr(rr))
    after = c.res(await h_test(c, "UserPromptSubmit"))
    check("after remove: UserPromptSubmit ran_any=false", not after.get("ran_any"), repr(after))


async def test_hook_session_start(c: WsClient) -> None:
    """SessionStart hook: injected_context from inject command."""
    print("\n[hooks — SessionStart inject]")
    CMD = r"""printf '{"additionalContext":"SESSION_CTX_INJECTED"}'"""
    ar = await h_add(c, "SessionStart", CMD)
    check("hooks.add SessionStart ok=true", c.ok(ar), repr(ar))

    tr = await h_test(c, "SessionStart", match_key="startup")
    check("hooks.test SessionStart ok=true", c.ok(tr), repr(tr))
    rv = c.res(tr)
    check("SessionStart ran_any=true", bool(rv.get("ran_any")), repr(rv))
    ctx = rv.get("injected_context") or ""
    check("SessionStart injected_context has SESSION_CTX_INJECTED", "SESSION_CTX_INJECTED" in ctx, f"ctx={ctx!r}")

    rr = await h_remove(c, "SessionStart", 0)
    check("hooks.remove SessionStart[0] ok=true", c.ok(rr), repr(rr))
    after = c.res(await h_test(c, "SessionStart", match_key="startup"))
    check("after remove: SessionStart ran_any=false", not after.get("ran_any"), repr(after))


async def test_hook_pre_tool_use(c: WsClient) -> None:
    """PreToolUse matcher=Bash: runs on Bash, skips on Edit."""
    print("\n[hooks — PreToolUse matcher=Bash vs Edit]")
    CMD = r"""printf '{"additionalContext":"PRETOOL_BASH_OK"}'"""
    ar = await h_add(c, "PreToolUse", CMD, matcher="Bash")
    check("hooks.add PreToolUse matcher=Bash ok=true", c.ok(ar), repr(ar))

    bash_r = c.res(await h_test(c, "PreToolUse", match_key="Bash"))
    check("PreToolUse Bash ran_any=true", bool(bash_r.get("ran_any")), repr(bash_r))
    ctx = bash_r.get("injected_context") or ""
    check("PreToolUse Bash injected_context has PRETOOL_BASH_OK", "PRETOOL_BASH_OK" in ctx, f"ctx={ctx!r}")

    edit_r = c.res(await h_test(c, "PreToolUse", match_key="Edit"))
    check("PreToolUse Edit ran_any=false (matcher mismatch)", not edit_r.get("ran_any"), repr(edit_r))

    rr = await h_remove(c, "PreToolUse", 0)
    check("hooks.remove PreToolUse[0] ok=true", c.ok(rr), repr(rr))
    after = c.res(await h_test(c, "PreToolUse", match_key="Bash"))
    check("after remove: PreToolUse Bash ran_any=false", not after.get("ran_any"), repr(after))


async def test_hook_bad_event(c: WsClient) -> None:
    """hooks.add with unknown event returns ok:false."""
    print("\n[hooks.add — invalid event → ok:false]")
    resp = await h_add(c, "NotAnEvent_zzz", "echo hi")
    check("hooks.add bad event returns ok:false", not c.ok(resp), repr(resp))
    check("hooks.add bad event has error body", bool(c.err(resp)), repr(resp))


async def test_hooks_no_leftovers(c: WsClient) -> None:
    """hooks.list must show no hooks in any event group."""
    print("\n[hooks.list — final leftover guard]")
    resp = await c.rpc("hooks.list")
    check("hooks.list ok=true", c.ok(resp), repr(resp))
    hooks_block = (c.res(resp).get("hooks") or {})
    all_events = ("PreToolUse","PostToolUse","UserPromptSubmit","Notification",
                  "Stop","SubagentStop","SessionStart","SessionEnd","PreCompact")
    dirty = [ev for ev in all_events if hooks_block.get(ev)]
    check("no leftover hooks in any event group", not dirty, f"dirty events: {dirty}")


# ── Orchestrator ───────────────────────────────────────────────────────────────

async def run() -> int:
    try:
        token = open(TOKEN_PATH).read().strip()
    except OSError as exc:
        print(f"FAIL: cannot read {TOKEN_PATH}: {exc}", file=sys.stderr)
        return 2

    print(f"Connecting to ws://127.0.0.1:{CONTROL_PORT}/control/ws?token=***")
    try:
        ws = await asyncio.wait_for(
            websockets.connect(f"ws://127.0.0.1:{CONTROL_PORT}/control/ws?token={token}", max_size=None),
            timeout=10.0,
        )
    except Exception as exc:
        print(f"FAIL: cannot connect to daemon WS: {exc}", file=sys.stderr)
        return 1

    c = WsClient(ws)
    reader_task = asyncio.create_task(c.reader())
    baseline: dict[str, Any] = {}

    try:
        # 1. Capture baseline
        baseline = await settings_baseline(c)

        # 2. Round-trip every legal value for each field
        await settings_roundtrip(c, "agent_mode",      ("plan", "build", "coworker"))
        await settings_roundtrip(c, "wake_notify",     ("silent", "ping", "always"))
        await settings_roundtrip(c, "permission_level",("high", "medium", "low"))

        # 3. Invalid values normalise
        await settings_normalise(c)

        # 4. Reset + confirm baseline
        await settings_reset(c, baseline)

        # 5. Hooks: UserPromptSubmit
        await test_hook_user_prompt_submit(c)

        # 6. Hooks: SessionStart inject
        await test_hook_session_start(c)

        # 7. Hooks: PreToolUse matcher
        await test_hook_pre_tool_use(c)

        # 8. Hooks: bad event name
        await test_hook_bad_event(c)

        # 9. Final no-leftovers guard
        await test_hooks_no_leftovers(c)

    except Exception as exc:
        import traceback
        print(f"\nUNEXPECTED EXCEPTION: {exc}", file=sys.stderr)
        traceback.print_exc()
        _fails.append(f"unexpected_exception: {exc}")
    finally:
        # Best-effort cleanup so daemon is never left dirty
        for ev in ("UserPromptSubmit", "SessionStart", "PreToolUse"):
            try:
                n = await h_list_count(c, ev)
                for i in range(n - 1, -1, -1):
                    await h_remove(c, ev, i)
            except Exception:
                pass
        if baseline:
            try:
                await c.rpc("settings.set", {"patch": baseline})
            except Exception:
                pass
        reader_task.cancel()
        try:
            await asyncio.wait_for(ws.close(), timeout=3.0)
        except Exception:
            pass

    total = len(_passes) + len(_fails)
    print(f"\n{'=' * 60}")
    print(f"SUMMARY: {len(_passes)}/{total} checks passed, {len(_fails)} failed")
    if _fails:
        print("\nFailed checks:")
        for label in _fails:
            print(f"  FAIL  {label}")
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
