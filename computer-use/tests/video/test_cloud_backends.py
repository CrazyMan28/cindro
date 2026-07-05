"""Tests for the cloud transcription backends (gemini_api_backend, openai_api_backend).

Every SDK object is faked — no network, no real google-genai/openai SDKs.
Fakes are injected via monkeypatch.setitem(sys.modules, ...) so the lazy
imports inside the backend modules pick them up instead of whatever might
actually be pip-installed.
"""

from __future__ import annotations

import sys
import types

import pytest

from computer_use_mcp.video.backends import gemini_api_backend, openai_api_backend

# ---- shared test fixtures ---------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    """Neither cloud key is set unless a test opts in."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


class _FakeClock:
    """Monotonic clock double: advances only when the sleeper tells it to."""

    def __init__(self, start: float = 0.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def sleep(self, dt: float) -> None:
        self.now += dt


# ============================================================================
# gemini_api_backend
# ============================================================================


def test_gemini_missing_key_raises_helpful_message(monkeypatch):
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        gemini_api_backend.transcribe("audio.wav", {})


def test_gemini_probe_missing_key():
    result = gemini_api_backend.probe()
    assert result == {"available": False, "detail": "GEMINI_API_KEY not set"}


def test_gemini_probe_sdk_not_importable(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    # None in sys.modules is the documented way to make an import raise
    # ImportError, without touching whatever google.genai may really be
    # installed in this environment.
    monkeypatch.setitem(sys.modules, "google", None)
    monkeypatch.setitem(sys.modules, "google.genai", None)
    result = gemini_api_backend.probe()
    assert result["available"] is False
    assert "not importable" in result["detail"]


def test_gemini_probe_available(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    fake_google, fake_genai = _install_fake_genai(monkeypatch, files_api=None, models_api=None)
    result = gemini_api_backend.probe()
    assert result["available"] is True


class _FakeFile:
    def __init__(self, name: str, state: str):
        self.name = name
        self.state = state


class _FakeFilesAPI:
    """files.upload / files.get / files.delete double.

    `states` is the sequence of states returned by successive .get() calls;
    the last entry repeats once exhausted so tests can poll indefinitely.
    """

    def __init__(self, states: list[str], upload_name: str = "files/fake-123"):
        self.states = states
        self.upload_name = upload_name
        self.get_calls = 0
        self.deleted: list[str] = []

    def upload(self, file):  # noqa: ARG002 — file path unused by the fake
        return _FakeFile(self.upload_name, state="PROCESSING")

    def get(self, name: str):
        idx = min(self.get_calls, len(self.states) - 1)
        state = self.states[idx]
        self.get_calls += 1
        return _FakeFile(name, state=state)

    def delete(self, name: str):
        self.deleted.append(name)


class _FakeResponse:
    def __init__(self, text: str):
        self.text = text


class _FakeModelsAPI:
    def __init__(self, text: str | None = None, raise_exc: Exception | None = None):
        self.text = text
        self.raise_exc = raise_exc
        self.calls: list[dict] = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.raise_exc is not None:
            raise self.raise_exc
        return _FakeResponse(self.text or "{}")


class _FakeClient:
    def __init__(self, files_api, models_api):
        self.files = files_api
        self.models = models_api


def _install_fake_genai(monkeypatch, files_api, models_api):
    """Wire sys.modules so `from google import genai` resolves to a fake
    module whose Client() returns a client wrapping the given fakes."""
    fake_client = _FakeClient(files_api, models_api)

    fake_genai = types.ModuleType("google.genai")
    fake_genai.Client = lambda *a, **kw: fake_client  # noqa: ARG005

    fake_google = types.ModuleType("google")
    fake_google.genai = fake_genai

    monkeypatch.setitem(sys.modules, "google", fake_google)
    monkeypatch.setitem(sys.modules, "google.genai", fake_genai)
    return fake_google, fake_genai


def test_wait_for_file_active_returns_after_n_polls():
    files_api = _FakeFilesAPI(states=["PROCESSING", "PROCESSING", "ACTIVE"])
    client = _FakeClient(files_api, models_api=None)
    clock = _FakeClock()

    result = gemini_api_backend.wait_for_file_active(
        client, "files/fake-123", timeout=100.0, interval=2.0,
        sleeper=clock.sleep, clock=clock)

    assert result.state == "ACTIVE"
    assert files_api.get_calls == 3


def test_wait_for_file_active_raises_on_failed():
    files_api = _FakeFilesAPI(states=["PROCESSING", "FAILED"])
    client = _FakeClient(files_api, models_api=None)
    clock = _FakeClock()

    with pytest.raises(RuntimeError, match="failed"):
        gemini_api_backend.wait_for_file_active(
            client, "files/fake-123", timeout=100.0, interval=2.0,
            sleeper=clock.sleep, clock=clock)


def test_wait_for_file_active_raises_timeout_past_deadline():
    files_api = _FakeFilesAPI(states=["PROCESSING"])
    client = _FakeClient(files_api, models_api=None)
    clock = _FakeClock()

    with pytest.raises(TimeoutError):
        gemini_api_backend.wait_for_file_active(
            client, "files/fake-123", timeout=5.0, interval=2.0,
            sleeper=clock.sleep, clock=clock)


def test_gemini_transcribe_happy_path_maps_transcription_and_tags(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    payload = (
        '{"transcription": [{"start": 0.0, "end": 1.5, "text": "hello there"}], '
        '"audio_tags": [{"start": 1.5, "end": 3.0, "tag": "music"}]}'
    )
    files_api = _FakeFilesAPI(states=["ACTIVE"])
    models_api = _FakeModelsAPI(text=payload)
    _install_fake_genai(monkeypatch, files_api, models_api)

    result = gemini_api_backend.transcribe("audio.wav", {"video_gemini_model": "gemini-3-flash-preview"})

    assert result.transcription_source == "gemini-api"
    assert len(result.segments) == 1
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 1.5
    assert result.segments[0].text == "hello there"
    assert len(result.audio_tags) == 1
    assert result.audio_tags[0].tag == "music"
    # File was cleaned up server-side.
    assert files_api.deleted == [files_api.upload_name]


def test_gemini_transcribe_falls_back_on_type_error(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    payload = '{"transcription": [], "audio_tags": []}'
    files_api = _FakeFilesAPI(states=["ACTIVE"])

    calls = {"n": 0}

    class _FlakyModelsAPI:
        def generate_content(self, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise TypeError("unexpected keyword argument 'response_schema'")
            return _FakeResponse(payload)

    _install_fake_genai(monkeypatch, files_api, _FlakyModelsAPI())

    result = gemini_api_backend.transcribe("audio.wav", {})

    assert result.transcription_source == "gemini-api"
    assert calls["n"] == 2
    assert files_api.deleted == [files_api.upload_name]


def test_gemini_transcribe_deletes_uploaded_file_even_when_generate_content_raises(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    files_api = _FakeFilesAPI(states=["ACTIVE"])
    models_api = _FakeModelsAPI(raise_exc=RuntimeError("upstream boom"))
    _install_fake_genai(monkeypatch, files_api, models_api)

    with pytest.raises(RuntimeError, match="upstream boom"):
        gemini_api_backend.transcribe("audio.wav", {})

    assert files_api.deleted == [files_api.upload_name]


def test_gemini_transcribe_with_retry_retries_exactly_once(monkeypatch):
    calls = {"n": 0}

    def fake_transcribe(wav_path, cfg):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return "OK"

    monkeypatch.setattr(gemini_api_backend, "transcribe", fake_transcribe)

    result = gemini_api_backend.transcribe_with_retry("audio.wav", {})

    assert result == "OK"
    assert calls["n"] == 2


def test_gemini_transcribe_with_retry_raises_after_final_failure(monkeypatch):
    calls = {"n": 0}

    def fake_transcribe(wav_path, cfg):
        calls["n"] += 1
        raise RuntimeError(f"attempt {calls['n']}")

    monkeypatch.setattr(gemini_api_backend, "transcribe", fake_transcribe)

    with pytest.raises(RuntimeError, match="attempt 2"):
        gemini_api_backend.transcribe_with_retry("audio.wav", {})

    assert calls["n"] == 2


# ============================================================================
# openai_api_backend
# ============================================================================


class _FakeOpenAIClient:
    def __init__(self, response):
        self.audio = types.SimpleNamespace(
            transcriptions=types.SimpleNamespace(create=lambda **kw: response))


def _install_fake_openai(monkeypatch, response):
    fake_openai = types.ModuleType("openai")
    fake_openai.OpenAI = lambda **kw: _FakeOpenAIClient(response)  # noqa: ARG005
    monkeypatch.setitem(sys.modules, "openai", fake_openai)
    return fake_openai


def test_openai_missing_key_raises_helpful_message():
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        openai_api_backend.transcribe("audio.wav", {})


def test_openai_probe_missing_key():
    result = openai_api_backend.probe()
    assert result == {"available": False, "detail": "OPENAI_API_KEY not set"}


def test_openai_probe_available(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    _install_fake_openai(monkeypatch, response=None)
    result = openai_api_backend.probe()
    assert result["available"] is True


def test_openai_transcribe_maps_attr_style_segments(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    wav = tmp_path / "audio.wav"
    wav.write_bytes(b"fake-wav-bytes")

    segment = types.SimpleNamespace(start=0.0, end=2.5, text="hi there")
    response = types.SimpleNamespace(segments=[segment])
    _install_fake_openai(monkeypatch, response)

    result = openai_api_backend.transcribe(str(wav), {})

    assert result.transcription_source == "openai-api"
    assert result.audio_tags == []
    assert len(result.segments) == 1
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 2.5
    assert result.segments[0].text == "hi there"


def test_openai_transcribe_maps_dict_style_segments(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    wav = tmp_path / "audio.wav"
    wav.write_bytes(b"fake-wav-bytes")

    response = {"segments": [{"start": 1.0, "end": 3.25, "text": "second segment"}]}
    _install_fake_openai(monkeypatch, response)

    result = openai_api_backend.transcribe(str(wav), {})

    assert result.transcription_source == "openai-api"
    assert result.audio_tags == []
    assert len(result.segments) == 1
    assert result.segments[0].start == 1.0
    assert result.segments[0].end == 3.25
    assert result.segments[0].text == "second segment"
