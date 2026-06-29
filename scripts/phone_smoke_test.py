#!/usr/bin/env python3
"""Phone subsystem smoke test — runs against the LIVE server on :8801.

Covers the bugs we fixed and the call-path invariants:
  - inbound allowlist gate (the instant-hangup bug)
  - Mistral TTS no-`speed` (the silent-call bug) + custom cloned voice (ref_audio)
  - the full MCP tool surface reaches the gateway
  - wake-on-inbound routing (inbound agent + SMS agent = ext 101)
  - the public Twilio funnel reaches THIS server (voice webhook + media WS)

Usage:  python3 scripts/phone_smoke_test.py
Reads the token from ~/.config/jarvis/phone.env. Exit code = number of failures.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

ENV = os.path.expanduser("~/.config/jarvis/phone.env")
BASE = "http://127.0.0.1:8801"
FUNNEL = "https://fedora-1.taile8eaf7.ts.net"
USER_NUMBER = "+13193898338"

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
fails = 0


def env(key):
    for line in open(ENV):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def check(name, ok, detail=""):
    global fails
    print(f"  [{PASS if ok else FAIL}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails += 1


def http(method, path, token, body=None, base=BASE, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def mcp(tool, args, token):
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
           "params": {"name": tool, "arguments": args}}
    s, d = http("POST", "/mcp", token, rpc)
    return s, d


def main():
    admin = env("ADMIN_TOKEN")
    agent = env("AGENT_TOKEN")
    key = env("MISTRAL_API_KEY")

    print("\n== 1. Server health ==")
    s, _ = http("GET", "/health", admin)
    check("GET /health -> 200", s == 200, f"status {s}")

    print("\n== 2. Wake-on-inbound routing (Jarvis = ext 101) ==")
    s, scr = http("GET", "/api/screening", admin)
    check("inbound call agent == 101", str(scr.get("inbound_extension")) == "101",
          f"got {scr.get('inbound_extension')}")
    s, sms = http("GET", "/api/sms-agent", admin)
    check("SMS agent enabled + ext 101",
          sms.get("enabled") is True and str(sms.get("extension")) == "101",
          f"enabled={sms.get('enabled')} ext={sms.get('extension')}")

    print("\n== 3. Allowlist gate (instant-hangup fix) ==")
    s, al = mcp("twilio_allowlist_list", {}, agent)
    nums = json.dumps(al)
    check("user number is allowlisted", USER_NUMBER in nums,
          "present" if USER_NUMBER in nums else "MISSING from allowlist")

    print("\n== 4. MCP tool surface (all ~56 tools) ==")
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    s, d = http("POST", "/mcp", agent, rpc)
    tools = (d.get("result") or {}).get("tools") or d.get("tools") or []
    names = {t.get("name") for t in tools}
    check("tools/list returns >= 50 tools", len(names) >= 50, f"got {len(names)}")
    for must in ("twilio_sms", "device_sms", "call_user", "twilio_call_and_wait",
                 "twilio_register_inbound_agent", "notify_user"):
        check(f"tool present: {must}", must in names)

    print("\n== 5. TTS silent-call fix + custom cloned voice ==")
    # no `speed` -> 200 + audio
    s, d = http("POST", "/api/audio/tts", agent,
                {"text": "smoke test", "responseFormat": "mp3"}, timeout=40)
    ab = d.get("audioBase64", "")
    check("server TTS returns audio (no-speed fix)", s == 200 and len(ab) > 1000,
          f"status {s}, audio {len(ab)}")
    # Mistral rejects `speed` (proves the bug we removed)
    if key:
        body = json.dumps({"model": env("MISTRAL_TTS_MODEL"), "input": "x",
                           "voice_id": env("MISTRAL_TTS_VOICE_ID"),
                           "speed": 1.25, "response_format": "mp3"}).encode()
        req = urllib.request.Request("https://api.mistral.ai/v1/audio/speech", data=body,
                                     headers={"Authorization": f"Bearer {key}",
                                              "Content-Type": "application/json"})
        code = 0
        try:
            urllib.request.urlopen(req, timeout=20)
            code = 200
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception:
            code = -1
        check("Mistral still rejects `speed` (422)", code == 422, f"got {code}")
    # custom voice wired: ref-audio file configured
    ref = env("MISTRAL_TTS_REF_AUDIO_FILE")
    check("custom cloned voice configured (ref_audio file)",
          bool(ref) and os.path.exists(os.path.expanduser(ref)), ref or "(unset)")

    print("\n== 6. Public Twilio funnel reaches THIS server ==")
    # /twilio/voice -> 403 invalid signature = route reached + validating
    try:
        req = urllib.request.Request(FUNNEL + "/twilio/voice",
                                     data=b"CallSid=smoke&From=%2B1&To=%2B1",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        code = 0
        try:
            urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as e:
            code = e.code
        check("funnel /twilio/voice reaches server (403 sig)", code == 403, f"got {code}")
    except Exception as e:
        check("funnel /twilio/voice reaches server", False, str(e))

    print(f"\n== RESULT: {('ALL PASS' if fails == 0 else str(fails) + ' FAILURE(S)')} ==\n")
    return fails


if __name__ == "__main__":
    sys.exit(main())
