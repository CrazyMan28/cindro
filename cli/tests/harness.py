"""A scriptable fake Contract A daemon for jarvis-cli tests (adapted from
acp-bridge's MockDaemon — same wire dialect, wider method table: the CLI
touches settings/memory/skills/agents/queue/search too).

Tests are plain sync functions calling ``run(coro)`` — no pytest-asyncio
required (though it is installed in the cli venv).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import re
import threading
import wave
from typing import Any, Awaitable, Callable, Optional

import websockets


def run(coro: Awaitable) -> Any:
    return asyncio.run(coro)


def _silent_wav_b64(seconds: float = 0.1, samplerate: int = 16000) -> str:
    """A tiny valid (silent) WAV blob, base64-encoded — stands in for
    voice.tts's audio_b64 reply so tests can round-trip it through
    voice_mode.wav_to_pcm exactly like a real Voxtral response."""
    n_frames = int(seconds * samplerate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(samplerate)
        w.writeframes(b"\x00\x00" * n_frames)
    return base64.b64encode(buf.getvalue()).decode("ascii")


class MockDaemon:
    def __init__(self):
        self.server = None
        self.host = "127.0.0.1"
        self.port = 0
        self.token = "mock-control-token"
        self.created_sid = "sess_cli_1"
        self.calls: list[tuple[str, dict]] = []
        self.subscribed: list[str] = []
        self.ws = None  # the most recent client connection — tests that need
                        # to push a session.event out-of-band (e.g. an
                        # approval arriving without a session.send) use this
                        # directly with .emit() instead of the on_send hook.
        self.settings: dict = {
            "version": "9.9.9", "git_sha": "abc1234",
            "default_brain": "codex", "default_model": "",
            "brains": ["codex", "claude", "api"],
            "available_brains": {"codex": True, "claude": True, "api": True},
            "self_improve": "off", "auto_continue": "off",
            "auto_update": True, "auto_update_apply": False,
            "has_desktop_pin": False,
            # First-run onboarding (SetupWizardScreen) defaults to ALREADY
            # onboarded — same precedent as `paired = False` below for
            # LockGate — so the broad test suite (which isn't testing
            # onboarding) never sees an unexpected wizard overlay. Tests that
            # DO want to exercise the wizard flip this False explicitly
            # (see test_setup_wizard.py).
            "setup_complete": True,
            "assistant_name": "Jarvis", "user_name": "",
            "tts_voice": "", "permission_level": "medium",
            "api_keys_set": {"mistral": False},
        }
        self.voices: list = [
            {"id": "en_paul_neutral", "label": "Paul — neutral (EN)", "custom": False},
            {"id": "en_emma_neutral", "label": "Emma — neutral (EN)", "custom": False},
        ]
        # voice.stt/voice.tts canned replies (see handleVoiceStt/handleVoiceTts
        # in daemon/src/ControlServer.cpp) — tests override these directly.
        self.stt_text = "hello jarvis"
        self.tts_audio_b64 = _silent_wav_b64()
        self.tts_mime = "audio/wav"
        self.voice_calls: list[tuple[str, dict]] = []
        self.models_by_brain: dict = {
            "codex": ["gpt-5.5", "gpt-5.5-mini"],
            "claude": ["claude-sonnet-5", "claude-haiku-4-5"],
            "api": ["mistral-small-latest"],
        }
        self.sessions: list[dict] = [
            {"id": "s1", "title": "hello world", "brain": "codex", "state": "idle"},
        ]
        self.memories: list[dict] = [
            {"id": "m1", "text": "user likes cyan", "tags": ["auto"]},
        ]
        self.skills: list[dict] = [
            {"name": "deploy", "group": "self", "description": "ship it",
             "use_count": 3, "pinned": False},
        ]
        self.queue_items: list[dict] = []
        self.on_send: Optional[Callable[["MockDaemon", Any, dict],
                                        Awaitable[None]]] = None
        self._bg: set[asyncio.Task] = set()
        # ---- 2FA / fingerprint cross-device unlock (LockGate, jarvis auth.*) --
        # Defaults to "no phone paired" (fail-open) — matches the realistic
        # default for a fresh install; tests that want to exercise the actual
        # waiting/PIN flow flip `paired = True` (and set `desktop_pin`) BEFORE
        # mounting the app so its startup auth.request sees it.
        self.paired = False
        self.desktop_pin: Optional[str] = None
        self._auth_challenges: dict[str, str] = {}
        self._auth_seq = 0
        self.last_challenge_id = ""
        # ---- phone.mcp / phone.http (Contract-A phone proxy verbs) -------------
        # phone_verbs_supported=False makes _dispatch return None for BOTH
        # verbs (a real "unknown_method" wire error) — simulates an older
        # daemon build that predates these verbs. phone_configured=False
        # simulates a daemon that HAS the verbs but no phone.env yet (the
        # real handlePhoneMcp/handlePhoneHttp's "phone_not_configured").
        self.phone_verbs_supported = True
        self.phone_configured = True
        self.active_calls: list[dict] = []
        self.screening_status: dict = {"active": False}
        self.call_transcripts: dict[str, dict] = {}
        self.phone_calls: list[tuple[str, dict]] = []  # (tool_or_http_path, args)
        self._call_seq = 0
        # ---- phone.config (Contract-A phone/Twilio config verb, control-only) --
        # Mirrors daemon/src/ControlServer.cpp's PhoneEnv + handlePhoneConfig:
        # secrets (account_sid/auth_token) live ONLY in phone_env, "get" never
        # echoes them back (only has_* below); "set" writes whichever keys are
        # present in the patch (empty string clears). phone_config_supported
        # mirrors phone_verbs_supported's precedent for an older daemon build.
        self.phone_config_supported = True
        self.phone_config_reachable = True
        self.phone_env: dict = {
            "server_port": "8801",
            "server_url": "http://127.0.0.1:8801",
            "has_admin_token": True,
            "has_device_token": True,
            "has_agent_token": True,
            "twilio_account_sid": "",
            "twilio_auth_token": "",
            "twilio_from_number": "",
            "twilio_public_base_url": "",
            "twilio_inbound_extension": "101",
            "twilio_screening_extension": "",
        }

    async def _handler(self, ws):
        self.ws = ws
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            rid = msg.get("id", 0)
            method = msg.get("method", "")
            params = msg.get("params") or {}
            self.calls.append((method, params))
            result = await self._dispatch(ws, method, params)
            if result is None:
                resp = {"v": 1, "id": rid, "ok": False,
                        "error": {"code": "unknown_method", "message": method}}
            else:
                resp = {"v": 1, "id": rid, "ok": True, "result": result}
            await ws.send(json.dumps(resp))

    async def _dispatch(self, ws, method, params):
        if method == "ping":
            return {"pong": True}
        if method == "settings.get":
            return {"settings": dict(self.settings)}
        if method == "settings.set":
            self.settings.update(params.get("patch") or {})
            return {"ok": True}
        if method == "model.list":
            brain = params.get("brain") or self.settings.get("default_brain", "codex")
            return {"brain": brain, "models": list(self.models_by_brain.get(brain, []))}
        if method == "session.create":
            return {"session_id": self.created_sid}
        if method == "session.subscribe":
            self.subscribed = list(params.get("session_ids") or [])
            return {"subscribed": self.subscribed}
        if method == "session.send":
            if self.on_send is not None:
                self._spawn(self.on_send(self, ws, params))
            return {"ok": True}
        if method == "session.cancel":
            return {"ok": True}
        if method == "session.list":
            return {"sessions": list(self.sessions)}
        if method == "session.delete":
            self.sessions = [s for s in self.sessions
                             if s.get("id") != params.get("session_id")]
            return {"ok": True}
        if method == "session.history":
            return {"events": [
                {"seq": 1, "ts": 0,
                 "ev": {"kind": "message", "role": "user", "text": "hi"}},
                {"seq": 2, "ts": 0,
                 "ev": {"kind": "message", "role": "assistant", "text": "hello"}},
            ]}
        if method == "session.search":
            return {"hits": [{"session_id": "s1", "session_title": "hello world",
                              "seq": 2, "ts": 0, "score": 1.5,
                              "ev": {"kind": "message", "role": "assistant",
                                     "text": "hello"},
                              "context": []}]}
        if method == "session.set_goals":
            return {"ok": True}
        if method == "approval.respond":
            self._spawn(self.emit(ws, params.get("session_id"), {"kind": "final"}))
            return {"ok": True}
        if method == "memory.list" or method == "memory.search":
            return {"memories": list(self.memories)}
        if method == "memory.remove":
            self.memories = [m for m in self.memories
                             if m.get("id") != params.get("id")]
            return {"ok": True}
        if method == "skills.list":
            return {"skills": list(self.skills)}
        if method == "skills.list_archived":
            return {"skills": []}
        if method == "skills.pin":
            for sk in self.skills:
                if sk["name"] == params.get("name"):
                    sk["pinned"] = bool(params.get("pinned"))
            return {"ok": True}
        if method == "agents.running":
            # SessionRow-shaped (like the real handleAgentsRunning) + flags.
            return {"agents": [{"id": "s9", "agent": "researcher",
                                "title": "sort downloads", "state": "running",
                                "live": True, "running": True}]}
        if method == "queue.list":
            return {"items": list(self.queue_items)}
        if method == "queue.add":
            item = {"id": f"q{len(self.queue_items) + 1}",
                    "title": params.get("title", ""), "status": "pending",
                    "priority": params.get("priority", 0)}
            self.queue_items.append(item)
            return {"id": item["id"]}
        if method == "queue.cancel":
            for it in self.queue_items:
                if it["id"] == params.get("id"):
                    it["status"] = "cancelled"
            return {"ok": True}
        if method == "voice.stt":
            self.voice_calls.append((method, params))
            return {"text": self.stt_text}
        if method == "voice.tts":
            self.voice_calls.append((method, params))
            return {"audio_b64": self.tts_audio_b64, "mime": self.tts_mime}
        if method == "voice.list_voices":
            self.voice_calls.append((method, params))
            return {"voices": list(self.voices),
                    "default": self.settings.get("tts_voice", "")}
        if method == "phone.event.subscribe":
            return {"subscribed": True, "bridge_connected": False}
        if method == "phone.mcp":
            if not self.phone_verbs_supported:
                return None  # real "unknown_method" wire error
            return self._handle_phone_mcp(params)
        if method == "phone.http":
            if not self.phone_verbs_supported:
                return None  # real "unknown_method" wire error
            return self._handle_phone_http(params)
        if method == "phone.config":
            if not self.phone_config_supported:
                return None  # real "unknown_method" wire error
            return self._handle_phone_config(params)
        if method == "auth.request":
            if not self.paired:
                return {"challenge_id": "", "state": "approved", "paired": False}
            self._auth_seq += 1
            cid = f"ch{self._auth_seq}"
            self._auth_challenges[cid] = "pending"
            self.last_challenge_id = cid
            return {"challenge_id": cid, "state": "pending", "paired": True}
        if method == "auth.status":
            cid = params.get("challenge_id", "")
            return {"challenge_id": cid,
                    "state": self._auth_challenges.get(cid, "expired")}
        if method == "auth.deny":
            cid = params.get("challenge_id", "")
            if cid in self._auth_challenges:
                self._auth_challenges[cid] = "denied"
            return {"ok": True}
        if method == "auth.verify_pin":
            cid = params.get("challenge_id", "")
            pin = params.get("pin")
            if self.desktop_pin is not None and pin == self.desktop_pin:
                self._auth_challenges[cid] = "approved"
                return {"challenge_id": cid, "state": "approved"}
            return None  # ok:false -> the client treats this as a wrong PIN.
        return None

    def set_auth_state(self, challenge_id: str, state: str) -> None:
        """Test convenience: flip a minted challenge's state (as if the
        paired phone/extension had just approved/denied/expired it)."""
        self._auth_challenges[challenge_id] = state

    # ---- phone.mcp / phone.http (mirrors daemon/src/ControlServer.cpp's
    # handlePhoneMcp/handlePhoneHttp response shapes) --------------------------
    def _handle_phone_mcp(self, params: dict) -> dict:
        name = params.get("name", "")
        args = params.get("arguments") or {}
        self.phone_calls.append((name, args))
        if not self.phone_configured:
            return {"tool": name, "error": {"code": "phone_not_configured",
                                            "message": "phone subsystem is not set up (no phone.env)"}}
        if name == "list_active_calls":
            return {"tool": name, "data": list(self.active_calls)}
        if name == "call_extension":
            self._call_seq += 1
            cid = f"call{self._call_seq}"
            self.active_calls.append({
                "id": cid, "state": "active",
                "from_extension": args.get("from_extension", ""),
                "to_extension": args.get("extension", ""), "reason": "",
            })
            return {"tool": name, "data": {"call_id": cid, "id": cid}}
        if name == "call_user":
            self._call_seq += 1
            cid = f"call{self._call_seq}"
            self.active_calls.append({
                "id": cid, "state": "ringing", "from_extension": "100",
                "to_extension": "user", "reason": args.get("reason", ""),
            })
            return {"tool": name, "data": {"call_id": cid, "id": cid}}
        if name == "end_call":
            cid = args.get("call_id", "")
            self.active_calls = [c for c in self.active_calls if c.get("id") != cid]
            return {"tool": name, "data": {"ok": True}}
        if name == "get_call_transcript":
            cid = args.get("call_id", "")
            return {"tool": name, "data": self.call_transcripts.get(cid, {"messages": []})}
        if name == "get_screening_status":
            return {"tool": name, "data": dict(self.screening_status)}
        return {"tool": name, "error": {"code": "unknown_tool", "message": f"no such phone tool {name}"}}

    def _handle_phone_http(self, params: dict) -> dict:
        method = str(params.get("method", "GET")).upper()
        path = params.get("path", "")
        body = params.get("body") or {}
        self.phone_calls.append((f"{method} {path}", body))
        if not self.phone_configured:
            return {"status": 503, "data": {"error": "phone subsystem is not set up"}}
        m = re.match(r"^/api/calls/([^/]+)/(accept|reject)$", path)
        if m and method == "POST":
            cid, action = m.group(1), m.group(2)
            if action == "accept":
                for c in self.active_calls:
                    if c.get("id") == cid:
                        c["state"] = "active"
                return {"status": 200, "data": {"ok": True}}
            self.active_calls = [c for c in self.active_calls if c.get("id") != cid]
            return {"status": 200, "data": {"ok": True}}
        return {"status": 404, "data": {}}

    # ---- phone.config (mirrors daemon/src/ControlServer.cpp's handlePhoneConfig) --
    def _handle_phone_config(self, params: dict) -> dict:
        action = params.get("action", "get")
        env = self.phone_env
        if action == "get":
            tw = {
                "has_account_sid": bool(env.get("twilio_account_sid")),
                "has_auth_token": bool(env.get("twilio_auth_token")),
                "from_number": env.get("twilio_from_number", ""),
                "public_base_url": env.get("twilio_public_base_url", ""),
                "inbound_extension": env.get("twilio_inbound_extension") or "101",
                "screening_extension": env.get("twilio_screening_extension", ""),
                "configured": bool(env.get("twilio_account_sid"))
                             and bool(env.get("twilio_auth_token"))
                             and bool(env.get("twilio_from_number")),
            }
            return {
                "configured": bool(env.get("has_admin_token")) or bool(env.get("has_agent_token")),
                "server_port": env.get("server_port", "8801"),
                "server_url": env.get("server_url", "http://127.0.0.1:8801"),
                "has_admin_token": bool(env.get("has_admin_token")),
                "has_device_token": bool(env.get("has_device_token")),
                "has_agent_token": bool(env.get("has_agent_token")),
                "twilio": tw,
            }
        if action == "set":
            patch = params.get("patch") or {}
            for key in ("server_port", "twilio_account_sid", "twilio_auth_token",
                       "twilio_from_number", "twilio_public_base_url",
                       "twilio_inbound_extension", "twilio_screening_extension"):
                if key in patch:
                    env[key] = patch[key]
            for tok_key, has_key in (("admin_token", "has_admin_token"),
                                     ("device_token", "has_device_token"),
                                     ("agent_token", "has_agent_token")):
                if tok_key in patch:
                    env[has_key] = bool(patch[tok_key])
            return {"ok": True, "restarted": False, "note": "phone.env updated (mock)"}
        if action == "test":
            return {
                "reachable": self.phone_config_reachable,
                "twilio_configured": bool(env.get("twilio_account_sid"))
                                     and bool(env.get("twilio_auth_token"))
                                     and bool(env.get("twilio_from_number")),
            }
        return None

    def _spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    async def emit(self, ws, session_id, ev):
        frame = {"v": 1, "event": "session.event",
                 "data": {"session_id": session_id, "ev": ev}}
        await ws.send(json.dumps(frame))

    async def broadcast(self, ws, event, data):
        await ws.send(json.dumps({"v": 1, "event": event, "data": data}))

    async def start(self):
        self.server = await websockets.serve(self._handler, self.host, 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        for t in list(self._bg):
            t.cancel()
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    @property
    def url(self):
        return f"ws://{self.host}:{self.port}/control/ws?token={self.token}"


class DaemonThread:
    """MockDaemon on its OWN event loop in a background thread — for tests of
    sync entry points (cmd_ask/cmd_status/main) that call asyncio.run
    themselves: the daemon must outlive multiple foreground loops."""

    def __init__(self, on_send=None):
        self.daemon = MockDaemon()
        if on_send is not None:
            self.daemon.on_send = on_send
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def __enter__(self):
        self._thread.start()
        asyncio.run_coroutine_threadsafe(self.daemon.start(), self.loop).result(10)
        return self.daemon

    def __exit__(self, *exc):
        asyncio.run_coroutine_threadsafe(self.daemon.stop(), self.loop).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(10)
        self.loop.close()
