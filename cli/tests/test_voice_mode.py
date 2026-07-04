"""VoiceModeScreen — orchestration tests (start/stop/send/receive/render +
the brain/model/voice pickers), with the audio hardware seam
(Recorder/Player) replaced by fakes so nothing here ever touches a real
microphone or speaker.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from harness import MockDaemon  # noqa: E402

from jarvis_cli.tui.app import JarvisTui  # noqa: E402
from jarvis_cli.tui.quick_view import QuickViewScreen  # noqa: E402
from jarvis_cli.tui.voice_mode import (MAX_RECORD_SECONDS, Recorder,  # noqa: E402
                                       VoiceModeScreen, VoiceTimeout,
                                       pcm_to_wav, wav_to_pcm)


class FakeRecorder:
    """Stands in for voice_mode.Recorder — never touches sounddevice."""

    def __init__(self, pcm: bytes = b"\x01\x00\x02\x00" * 100,
                samplerate: int = 16000, channels: int = 1) -> None:
        self.samplerate = samplerate
        self.channels = channels
        self._pcm = pcm
        self.started = False
        self.stopped = False
        self.start_error: Exception | None = None

    def start(self) -> None:
        if self.start_error is not None:
            raise self.start_error
        self.started = True

    def stop(self) -> bytes:
        self.stopped = True
        return self._pcm


class FakePlayer:
    """Stands in for voice_mode.Player — records what it would have played."""

    def __init__(self) -> None:
        self.calls: list[tuple[bytes, int, int]] = []

    def play(self, pcm: bytes, samplerate: int, channels: int) -> None:
        self.calls.append((pcm, samplerate, channels))


@pytest.fixture()
async def daemon(monkeypatch):
    d = await MockDaemon().start()
    monkeypatch.setenv("JARVIS_CONTROL_WS", d.url.split("?")[0])
    monkeypatch.setenv("JARVIS_CONTROL_TOKEN", d.token)
    yield d
    await d.stop()


def _reply_on_send(text: str):
    async def send_events(d, ws, params):
        sid = params["session_id"]
        await d.emit(ws, sid, {"kind": "message", "role": "assistant", "text": text})
    return send_events


# -- pure WAV packaging (no daemon, no app) -----------------------------------

def test_pcm_wav_round_trip():
    pcm = b"\x01\x00\x02\x00\x03\x00\x04\x00"
    wav_bytes = pcm_to_wav(pcm, samplerate=16000, channels=1)
    out_pcm, sr, ch = wav_to_pcm(wav_bytes)
    assert out_pcm == pcm
    assert sr == 16000
    assert ch == 1


# -- push-to-talk state machine -----------------------------------------------

@pytest.mark.asyncio
async def test_toggle_starts_recording(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        recorder = FakeRecorder()
        screen = VoiceModeScreen(app.client, recorder=recorder, player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await screen.action_toggle_record()
        assert screen.state == "listening"
        assert recorder.started is True


@pytest.mark.asyncio
async def test_mic_start_failure_surfaces_error_and_stays_idle(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        recorder = FakeRecorder()
        recorder.start_error = OSError("no default input device")
        screen = VoiceModeScreen(app.client, recorder=recorder, player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await screen.action_toggle_record()
        assert screen.state == "idle"
        assert "no default input device" in screen.voice_error


@pytest.mark.asyncio
async def test_stop_and_send_full_round_trip(daemon):
    """start -> stop -> voice.stt -> session.send -> assistant reply ->
    voice.tts -> playback, ending back at idle."""
    daemon.stt_text = "what's the weather"
    daemon.on_send = _reply_on_send("it's sunny")

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        recorder = FakeRecorder()
        player = FakePlayer()
        screen = VoiceModeScreen(app.client, recorder=recorder, player=player)
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await screen.action_toggle_record()  # start
        assert screen.state == "listening"
        await screen.action_toggle_record()  # stop + send
        await pilot.pause(0.5)

        assert recorder.stopped is True
        stt_calls = [(m, p) for (m, p) in daemon.voice_calls if m == "voice.stt"]
        assert stt_calls and "audio_b64" in stt_calls[0][1]
        assert stt_calls[0][1]["mime"] == "audio/wav"
        assert screen.heard_text == "what's the weather"

        sends = [(m, p) for (m, p) in daemon.calls if m == "session.send"]
        assert sends and sends[0][1]["text"] == "what's the weather"

        assert screen.reply_text == "it's sunny"
        tts_calls = [(m, p) for (m, p) in daemon.voice_calls if m == "voice.tts"]
        assert tts_calls and tts_calls[0][1]["text"] == "it's sunny"

        assert len(player.calls) == 1
        pcm, sr, ch = player.calls[0]
        assert isinstance(pcm, bytes) and len(pcm) > 0
        assert sr > 0 and ch >= 1

        assert screen.state == "idle"


@pytest.mark.asyncio
async def test_no_audio_captured_never_calls_stt(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        recorder = FakeRecorder(pcm=b"")
        screen = VoiceModeScreen(app.client, recorder=recorder, player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await screen.action_toggle_record()
        await screen.action_toggle_record()
        await pilot.pause(0.2)

        assert screen.state == "idle"
        assert screen.voice_error == "no audio captured"
        assert not [c for c in daemon.voice_calls if c[0] == "voice.stt"]


@pytest.mark.asyncio
async def test_busy_state_ignores_extra_toggle(daemon):
    """A stray extra Space press mid-pipeline (state == "thinking"/"speaking")
    must not start a second recording."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        recorder = FakeRecorder()
        screen = VoiceModeScreen(app.client, recorder=recorder, player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        screen.state = "thinking"
        await screen.action_toggle_record()
        assert screen.state == "thinking"
        assert recorder.started is False


@pytest.mark.asyncio
async def test_unmount_unsubscribes_owned_session(daemon):
    """VoiceModeScreen must not leak an abandoned session + queue
    subscription on repeated F2 (Voice Mode) invocations — unmounting it
    should unsubscribe from whatever session it created, mirroring
    ChatPane.new_session's explicit unsubscribe-before-abandon."""
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        screen = VoiceModeScreen(app.client, recorder=FakeRecorder(), player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        sid = await screen._ensure_session()
        assert sid and sid in app.client._subscribed

        unsub_calls = []
        orig_unsubscribe = app.client.unsubscribe

        async def spy_unsubscribe(session_id: str) -> None:
            unsub_calls.append(session_id)
            await orig_unsubscribe(session_id)

        app.client.unsubscribe = spy_unsubscribe

        await pilot.press("escape")  # pops the screen -> on_unmount fires
        await pilot.pause(0.2)

        assert unsub_calls == [sid]
        assert sid not in app.client._subscribed
        assert app.client.queue_for(sid) is None


@pytest.mark.asyncio
async def test_record_cap_auto_stops_and_sends(daemon):
    """A recording that hits MAX_RECORD_SECONDS must auto-stop-and-send —
    the same flow a manual "press Space again" triggers, just fired by the
    elapsed-time cap instead of a keypress."""
    daemon.stt_text = "auto stopped after the cap"
    daemon.on_send = _reply_on_send("got it")

    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        recorder = FakeRecorder()
        player = FakePlayer()
        screen = VoiceModeScreen(app.client, recorder=recorder, player=player)
        await app.push_screen(screen)
        await pilot.pause(0.1)

        fake_now = [1_000_000.0]
        screen._clock = lambda: fake_now[0]

        screen._start_recording()
        assert screen.state == "listening"
        assert recorder.started is True

        # Simulate MAX_RECORD_SECONDS elapsing without ever pressing Space
        # again, then let the cap-check timer tick (as it would every 1s).
        fake_now[0] += MAX_RECORD_SECONDS + 1
        screen._check_record_cap()
        await pilot.pause(0.5)

        assert recorder.stopped is True
        stt_calls = [(m, p) for (m, p) in daemon.voice_calls if m == "voice.stt"]
        assert stt_calls and "audio_b64" in stt_calls[0][1]
        assert screen.heard_text == "auto stopped after the cap"
        assert screen.reply_text == "got it"
        assert screen.state == "idle"


def test_record_cap_bounds_recorder_frame_buffer():
    """Recorder itself must stop appending new chunks once the captured
    audio hits max_seconds worth of samples — a hard backstop under the
    screen-level elapsed-time auto-stop, so a stuck/never-stopped recording
    can't grow the buffer without bound."""
    import numpy as np

    samplerate = 100
    rec = Recorder(samplerate=samplerate, channels=1, max_seconds=1.0)
    chunk = np.zeros((10, 1), dtype="int16")  # 0.1s per chunk @ 100Hz

    for _ in range(50):  # push in 5.0s worth of audio against a 1.0s cap
        rec._append_chunk(chunk.copy())

    max_samples = int(rec.max_seconds * samplerate)
    assert rec._n_samples <= max_samples
    assert sum(len(c) for c in rec._frames) <= max_samples


@pytest.mark.asyncio
async def test_await_assistant_reply_times_out(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        screen = VoiceModeScreen(app.client, recorder=FakeRecorder(), player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        with pytest.raises(VoiceTimeout):
            await screen._await_assistant_reply("no-such-session", timeout=0.2)


# -- brain/model/voice pickers reuse chat.py's PickerWidget/QuickViewScreen ---

@pytest.mark.asyncio
async def test_brain_picker_reuses_chat_picker_widget(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        screen = VoiceModeScreen(app.client, recorder=FakeRecorder(), player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await screen.action_pick_brain()
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)

        from textual.widgets import ListView
        lv = app.screen.query_one("#picker-list", ListView)
        lv.index = 1  # brains == ["codex", "claude", "api"] -> "claude"
        lv.action_select_cursor()
        await pilot.pause(0.2)

        assert screen.brain == "claude"
        assert not isinstance(app.screen, QuickViewScreen)


@pytest.mark.asyncio
async def test_model_picker_sets_model_and_resets_session(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        screen = VoiceModeScreen(app.client, recorder=FakeRecorder(), player=FakePlayer())
        screen.session_id = "stale-session"
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await screen.action_pick_model()
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)

        from textual.widgets import ListView
        lv = app.screen.query_one("#picker-list", ListView)
        lv.index = 0  # daemon.models_by_brain["codex"][0] == "gpt-5.5"
        lv.action_select_cursor()
        await pilot.pause(0.2)

        assert screen.model == "gpt-5.5"
        assert screen.session_id == ""  # a model change invalidates the old session


@pytest.mark.asyncio
async def test_voice_picker_sets_voice_from_list_voices(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        screen = VoiceModeScreen(app.client, recorder=FakeRecorder(), player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await screen.action_pick_voice()
        await pilot.pause(0.2)
        assert isinstance(app.screen, QuickViewScreen)

        from textual.widgets import ListView
        lv = app.screen.query_one("#picker-list", ListView)
        lv.index = 1  # daemon.voices[1] == "en_emma_neutral"
        lv.action_select_cursor()
        await pilot.pause(0.2)

        assert screen.voice == "en_emma_neutral"


@pytest.mark.asyncio
async def test_escape_closes_voice_mode(daemon):
    app = JarvisTui()
    async with app.run_test(size=(100, 30)) as pilot:
        await pilot.pause(0.3)
        screen = VoiceModeScreen(app.client, recorder=FakeRecorder(), player=FakePlayer())
        await app.push_screen(screen)
        await pilot.pause(0.1)
        assert isinstance(app.screen, VoiceModeScreen)

        await pilot.press("escape")
        await pilot.pause(0.2)
        assert not isinstance(app.screen, VoiceModeScreen)
