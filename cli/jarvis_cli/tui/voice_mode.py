"""VoiceModeScreen — the terminal analog of desktop/qml/VoiceMode.qml.

The GUI's VoiceMode is a full hands-free duplex conversation: continuous mic
capture, local VAD, and a native QtMultimedia audio pipeline flipping
``bridge.voiceState`` through idle -> listening -> thinking -> speaking. None
of that continuous-capture/VAD machinery has a sane terminal equivalent, so
this recreates the same STATE MACHINE and the same daemon calls
(``voice.stt``/``voice.tts``/``voice.list_voices``) around the standard
terminal-app push-to-talk idiom instead: press Space once to start
recording, press it again to stop and send (a toggle — Textual has no clean
native "key held down" detection).

Flow on stop-and-send:
  1. the recorded microphone buffer is WAV-wrapped and sent to ``voice.stt``
     (grepped from daemon/src/ControlServer.cpp::handleVoiceStt — params
     ``audio_b64``/``mime``, reply ``text``)
  2. the transcript is sent as a normal chat turn on a session THIS screen
     owns (``session.create``/``session.send``, same shapes ChatPane uses)
  3. once the assistant's reply event arrives, it is spoken back via
     ``voice.tts`` (params ``text``/``voice``/``format``, reply
     ``audio_b64``/``mime`` — handleVoiceTts) and played over the speakers.

Real audio hardware I/O is isolated behind ``Recorder``/``Player`` — the ONLY
two places that touch ``sounddevice``/``numpy`` — so the orchestration above
(start/stop/send/receive/render + the brain/model/voice pickers) is fully
unit-testable with fakes standing in for a microphone/speaker
(tests/test_voice_mode.py never touches real audio hardware).

The BRAIN/MODEL picker reuses chat.py's existing ``PickerWidget`` +
``QuickViewScreen`` popup pattern (the same one ``/provider``/``/model``
use) rather than inventing new picker UI. The desktop's third combo,
SPEAKER, physically selects an OS audio-output DEVICE via QtMultimedia
(``bridge.audioOutputs``/``setTtsOutput``) — there is no such call in the
Contract A wire protocol (ControlServer.cpp has no output-device-listing
method), so the practical terminal equivalent offered here is a VOICE
(TTS persona) picker sourced from ``voice.list_voices``, playing the same
"who do I hear" role.
"""

from __future__ import annotations

import asyncio
import base64
import io
import random
import wave
from typing import Optional

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Static

from jarvis_cli.control import ControlClient, ControlError
from jarvis_cli.tui.arc_reactor import ArcReactorWidget
from jarvis_cli.tui.chat import PickerWidget
from jarvis_cli.tui.quick_view import QuickViewScreen

# A curated slice of VoiceMode.qml's WORK_PHRASES-style "thinking" phrases —
# rotated under the orb while a reply is in flight, same whimsical idea, a
# much shorter list (the QML's is ~150 entries; this terminal recreation
# doesn't need that much variety to read as alive).
THINKING_PHRASES = [
    "Conquering the world", "Just chillin", "Pondering the universe", "Cooking",
    "Summoning electrons", "Reticulating splines", "Bending spacetime",
    "Consulting the oracle", "Untangling the matrix", "Herding photons",
    "Computing the meaning of life", "Hacking the mainframe",
    "Aligning the stars", "Locking in", "Bribing the compiler",
    "Feeding the neural net", "Wrangling tensors", "Charging the arc reactor",
    "Tuning the antennae", "Reverse-engineering reality",
]

_STATE_LABELS = {
    "idle": "READY — press space to talk",
    "listening": "LISTENING…",
    "thinking": "THINKING…",
    "speaking": "SPEAKING…",
}


class VoiceTimeout(Exception):
    """Raised by ``_await_assistant_reply`` when no reply arrives in time."""


# ---------------------------------------------------------------------------
# Audio I/O seam — the ONLY two places sounddevice/numpy are touched. Every
# import of the actual libraries is deferred into the methods below (not at
# module level) so this module can be imported, and its orchestration logic
# exercised with fakes, even in an environment with no PortAudio/microphone.
# ---------------------------------------------------------------------------


class Recorder:
    """Real microphone capture via ``sounddevice.InputStream``."""

    def __init__(self, samplerate: int = 16000, channels: int = 1) -> None:
        self.samplerate = samplerate
        self.channels = channels
        self._stream = None
        self._frames: list = []

    def start(self) -> None:
        import sounddevice as sd  # noqa: PLC0415 — see module docstring

        self._frames = []

        def _callback(indata, frames, time_info, status) -> None:  # noqa: ARG001
            self._frames.append(indata.copy())

        self._stream = sd.InputStream(
            samplerate=self.samplerate, channels=self.channels,
            dtype="int16", callback=_callback,
        )
        self._stream.start()

    def stop(self) -> bytes:
        """Stop the stream and return the captured audio as raw PCM16 bytes
        (mono/stereo per ``self.channels``, little-endian, interleaved)."""
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        if not self._frames:
            return b""
        import numpy as np  # noqa: PLC0415

        data = np.concatenate(self._frames, axis=0)
        self._frames = []
        return data.tobytes()


class Player:
    """Real playback via ``sounddevice.play``."""

    def play(self, pcm: bytes, samplerate: int, channels: int = 1) -> None:
        if not pcm:
            return
        import sounddevice as sd  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415

        data = np.frombuffer(pcm, dtype="int16")
        if channels > 1:
            data = data.reshape(-1, channels)
        sd.play(data, samplerate)
        sd.wait()


# ---------------------------------------------------------------------------
# WAV packaging — plain stdlib, fully unit-testable on its own.
# ---------------------------------------------------------------------------


def pcm_to_wav(pcm: bytes, *, samplerate: int = 16000, channels: int = 1,
              sampwidth: int = 2) -> bytes:
    """Wrap raw PCM16 samples in a WAV container. ``voice.stt`` (Mistral
    Voxtral, per VoiceProvider) wants a real audio file, not a bare sample
    buffer — WAV is the simplest format Python can produce with no extra
    dependency (stdlib ``wave``)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(samplerate)
        w.writeframes(pcm)
    return buf.getvalue()


def wav_to_pcm(wav_bytes: bytes) -> tuple[bytes, int, int]:
    """Unwrap a WAV blob (``voice.tts``'s ``audio_b64``, requested with
    ``format: "wav"``) back into ``(pcm16_bytes, samplerate, channels)``
    ready for ``Player.play``."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as w:
        channels = w.getnchannels()
        samplerate = w.getframerate()
        pcm = w.readframes(w.getnframes())
    return pcm, samplerate, channels


class VoiceModeScreen(ModalScreen[None]):
    """Full-screen push-to-talk voice UI. Pushed by ``JarvisTui.action_voice_mode``
    (bound to F2 in app.py)."""

    BINDINGS = [
        Binding("space", "toggle_record", "Talk/Send"),
        Binding("escape", "close_voice", "Close"),
        Binding("b", "pick_brain", "Brain"),
        Binding("m", "pick_model", "Model"),
        Binding("v", "pick_voice", "Voice"),
    ]

    DEFAULT_CSS = """
    VoiceModeScreen {
        align: center middle;
        background: #06090d;
    }
    VoiceModeScreen > #voice-box {
        width: 70;
        height: auto;
        padding: 1 2;
    }
    VoiceModeScreen #voice-reactor {
        margin: 0 0 1 0;
        align-horizontal: center;
        width: 100%;
    }
    VoiceModeScreen #voice-state {
        color: #35c8f0;
        text-style: bold;
        text-align: center;
        width: 100%;
    }
    VoiceModeScreen #voice-heard {
        color: #9fb3c8;
        text-style: italic;
        text-align: center;
        width: 100%;
        margin-top: 1;
    }
    VoiceModeScreen #voice-reply {
        color: #c9d6e3;
        text-align: center;
        width: 100%;
        margin-top: 1;
    }
    VoiceModeScreen #voice-error {
        color: #e05a5a;
        text-align: center;
        width: 100%;
        margin-top: 1;
    }
    VoiceModeScreen #voice-prefs {
        color: #7f8ea0;
        text-align: center;
        width: 100%;
        margin-top: 1;
    }
    VoiceModeScreen #voice-hint {
        color: #556676;
        text-align: center;
        width: 100%;
        margin-top: 1;
    }
    """

    def __init__(
        self,
        client: ControlClient,
        *,
        recorder: Optional[Recorder] = None,
        player: Optional[Player] = None,
    ) -> None:
        super().__init__()
        self.client = client
        self.recorder = recorder if recorder is not None else Recorder()
        self.player = player if player is not None else Player()

        # "idle" | "listening" | "thinking" | "speaking"
        self.state = "idle"
        self.heard_text = ""
        self.reply_text = ""
        self.voice_error = ""
        # empty => use the daemon's default_brain/default_model/tts_voice.
        self.brain = ""
        self.model = ""
        self.voice = ""
        self.session_id = ""
        self._phrase_timer = None

    # -- layout ----------------------------------------------------------------
    def compose(self) -> ComposeResult:
        with Vertical(id="voice-box"):
            yield ArcReactorWidget(size=21, spinning=True, thinking=False,
                                   id="voice-reactor")
            yield Static(_STATE_LABELS["idle"], id="voice-state")
            yield Static("", id="voice-heard")
            yield Static("", id="voice-reply")
            yield Static("", id="voice-error")
            yield Static(self._prefs_line(), id="voice-prefs")
            yield Static("SPACE talk/send  ·  b brain  ·  m model  ·  "
                        "v voice  ·  Esc close", id="voice-hint")

    def on_mount(self) -> None:
        self._phrase_timer = self.set_interval(2.5, self._rotate_phrase)

    def on_unmount(self) -> None:
        if self._phrase_timer is not None:
            self._phrase_timer.stop()
        # Never leave a mic stream open behind us.
        if self.state == "listening":
            try:
                self.recorder.stop()
            except Exception:
                pass

    def action_close_voice(self) -> None:
        self.dismiss()

    # -- push-to-talk toggle -----------------------------------------------------
    async def action_toggle_record(self) -> None:
        if self.state == "idle":
            self._start_recording()
        elif self.state == "listening":
            await self._stop_and_send()
        # busy (thinking/speaking) — ignore extra presses.

    def _start_recording(self) -> None:
        self.voice_error = ""
        try:
            self.recorder.start()
        except Exception as exc:
            self.voice_error = f"mic error: {exc}"
            self._sync_widgets()
            return
        self.heard_text = ""
        self.reply_text = ""
        self.state = "listening"
        self._sync_widgets()

    async def _stop_and_send(self) -> None:
        self.state = "thinking"
        self._sync_widgets()
        self._rotate_phrase()  # don't leave a stale "LISTENING…" label up to
                               # 2.5s until the next scheduled rotation tick
        try:
            pcm = self.recorder.stop()
        except Exception as exc:
            self._fail(f"mic error: {exc}")
            return
        if not pcm:
            self._fail("no audio captured")
            return

        wav_bytes = pcm_to_wav(pcm, samplerate=self.recorder.samplerate,
                               channels=self.recorder.channels)
        audio_b64 = base64.b64encode(wav_bytes).decode("ascii")
        try:
            stt_res = await self.client.call(
                "voice.stt", {"audio_b64": audio_b64, "mime": "audio/wav"},
                timeout=30)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self._fail(str(exc))
            return

        text = (stt_res.get("text") or "").strip()
        self.heard_text = text
        self._sync_widgets()
        if not text:
            self.state = "idle"
            self._sync_widgets()
            return

        await self._send_and_speak(text)

    async def _send_and_speak(self, text: str) -> None:
        try:
            sid = await self._ensure_session()
            await self.client.call("session.send",
                                   {"session_id": sid, "text": text}, timeout=30)
            reply = await self._await_assistant_reply(sid)
        except (ControlError, ConnectionError, TimeoutError, VoiceTimeout) as exc:
            self._fail(str(exc))
            return

        self.reply_text = reply
        self.state = "speaking"
        self._sync_widgets()
        await self._speak(reply)
        self.state = "idle"
        self._sync_widgets()

    def _fail(self, message: str) -> None:
        self.voice_error = message
        self.state = "idle"
        self._sync_widgets()

    # -- session plumbing (mirrors ChatPane's _ensure_session) -------------------
    async def _ensure_session(self) -> str:
        if self.session_id:
            return self.session_id
        params: dict = {"profile": "coworker"}
        if self.brain:
            params["brain"] = self.brain
        if self.model:
            params["model"] = self.model
        res = await self.client.call("session.create", params, timeout=20)
        self.session_id = res.get("session_id", "")
        if not self.session_id:
            raise ControlError("bad_reply", "session.create returned no session_id")
        await self.client.subscribe(self.session_id)
        return self.session_id

    async def _await_assistant_reply(self, session_id: str,
                                     timeout: float = 30.0) -> str:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise VoiceTimeout("timed out waiting for a reply")
            q = self.client.queue_for(session_id)
            if q is None:
                await asyncio.sleep(min(0.05, remaining))
                continue
            try:
                ev = await asyncio.wait_for(q.get(), timeout=min(0.5, remaining))
            except asyncio.TimeoutError:
                continue
            if ev.get("kind") == "message" and ev.get("role", "assistant") == "assistant":
                text = (ev.get("text") or "").strip()
                if text:
                    return text

    async def _speak(self, text: str) -> None:
        params: dict = {"text": text, "format": "wav"}
        if self.voice:
            params["voice"] = self.voice
        try:
            res = await self.client.call("voice.tts", params, timeout=30)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.voice_error = str(exc)
            self._sync_widgets()
            return
        audio_b64 = res.get("audio_b64", "")
        if not audio_b64:
            return
        try:
            raw = base64.b64decode(audio_b64)
            pcm, samplerate, channels = wav_to_pcm(raw)
        except Exception:
            return  # unplayable payload — the transcript/reply text still shows
        try:
            await asyncio.to_thread(self.player.play, pcm, samplerate, channels)
        except Exception as exc:
            self.voice_error = f"playback error: {exc}"
            self._sync_widgets()

    # -- brain / model / voice pickers -------------------------------------------
    # Reuses chat.py's PickerWidget + QuickViewScreen popup pattern (the same
    # one /provider and /model use) instead of inventing new picker UI.
    async def action_pick_brain(self) -> None:
        try:
            res = await self.client.call("settings.get", {}, timeout=15)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        settings = res.get("settings", res)
        brains = settings.get("brains") or ["codex", "claude", "api"]
        available = settings.get("available_brains") or {}
        current = self.brain or settings.get("default_brain", "")
        options = []
        for b in brains:
            usable = available.get(b, True)
            label = b + (" (current)" if b == current else "") + \
                    ("" if usable else " (unavailable)")
            options.append((b, label))

        async def on_pick(value: str) -> None:
            self.brain = value
            self.model = ""  # a brain change invalidates any picked model
            self.session_id = ""  # next turn starts a session with the new brain
            self._sync_widgets()

        self.app.push_screen(QuickViewScreen(
            "Brain", lambda: PickerWidget(options, on_pick)))

    async def action_pick_model(self) -> None:
        try:
            mres = await self.client.call(
                "model.list", {"brain": self.brain} if self.brain else {},
                timeout=15)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        models = mres.get("models") or []
        if not models:
            self.notify("no models available", severity="warning")
            return
        options = [(m, m + (" (current)" if m == self.model else ""))
                  for m in models]

        async def on_pick(value: str) -> None:
            self.model = value
            self.session_id = ""
            self._sync_widgets()

        self.app.push_screen(QuickViewScreen(
            "Model", lambda: PickerWidget(options, on_pick)))

    async def action_pick_voice(self) -> None:
        try:
            vres = await self.client.call("voice.list_voices", {}, timeout=15)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        voices = vres.get("voices") or []
        options = []
        for v in voices:
            vid = str(v.get("id", ""))
            label = str(v.get("label") or vid)
            if vid == self.voice:
                label += " (current)"
            options.append((vid, label))
        if not options:
            self.notify("no voices available", severity="warning")
            return

        async def on_pick(value: str) -> None:
            self.voice = value
            self._sync_widgets()

        self.app.push_screen(QuickViewScreen(
            "Voice", lambda: PickerWidget(options, on_pick)))

    # -- whimsical "thinking" phrase rotation ------------------------------------
    def _rotate_phrase(self) -> None:
        if self.state != "thinking":
            return
        try:
            self.query_one("#voice-state", Static).update(
                random.choice(THINKING_PHRASES).upper() + "…")
        except Exception:
            pass

    # -- rendering ----------------------------------------------------------------
    def _prefs_line(self) -> str:
        return (f"BRAIN {self.brain or 'default'}  ·  "
               f"MODEL {self.model or 'default'}  ·  "
               f"VOICE {self.voice or 'default'}")

    def _sync_widgets(self) -> None:
        try:
            self.query_one("#voice-reactor", ArcReactorWidget).thinking = (
                self.state in ("listening", "thinking"))
        except Exception:
            pass
        try:
            if self.state != "thinking":
                self.query_one("#voice-state", Static).update(
                    _STATE_LABELS.get(self.state, ""))
        except Exception:
            pass
        try:
            self.query_one("#voice-heard", Static).update(
                f"“{self.heard_text}”" if self.heard_text else "")
        except Exception:
            pass
        try:
            self.query_one("#voice-reply", Static).update(self.reply_text)
        except Exception:
            pass
        try:
            self.query_one("#voice-error", Static).update(
                f"⚠ {self.voice_error}" if self.voice_error else "")
        except Exception:
            pass
        try:
            self.query_one("#voice-prefs", Static).update(self._prefs_line())
        except Exception:
            pass
