"""Tests for computer_use_mcp.video.backends — dispatch + the three local
transcription engines. No real model downloads or loads: faster_whisper and
ctranslate2 are faked via sys.modules injection, whisper-cli/whisper CLIs are
faked via subprocess.run monkeypatching that writes the JSON sidecar the
real binaries would produce.
"""

from __future__ import annotations

import json
import sys
import types

import pytest

from computer_use_mcp.video import backends
from computer_use_mcp.video.backends import (
    faster_whisper_backend,
    openai_whisper_backend,
    whisper_cpp_backend,
)


def _base_cfg(**overrides) -> dict:
    cfg = {
        "video_whisper_model": "small",
        "video_whisper_device": "auto",
    }
    cfg.update(overrides)
    return cfg


# ---- dispatch ---------------------------------------------------------------

def test_local_engines_tuple():
    assert backends.LOCAL_ENGINES == ("faster-whisper", "whisper-cpp", "openai-whisper")


def test_get_local_backend_dispatch():
    assert backends.get_local_backend("faster-whisper") is faster_whisper_backend
    assert backends.get_local_backend("whisper-cpp") is whisper_cpp_backend
    assert backends.get_local_backend("openai-whisper") is openai_whisper_backend


def test_get_local_backend_unknown_engine_raises():
    with pytest.raises(ValueError, match="unknown local whisper engine"):
        backends.get_local_backend("gemini-api")


# ---- faster-whisper ----------------------------------------------------------

class _FakeSegment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class _FakeWhisperModel:
    """Records its construction args and returns two canned segments,
    regardless of which wav file it's pointed at."""
    instances: list["_FakeWhisperModel"] = []

    def __init__(self, model_size_or_path, device="auto", compute_type="default", **kwargs):
        self.model_size_or_path = model_size_or_path
        self.device = device
        self.compute_type = compute_type
        self.transcribe_calls = 0
        _FakeWhisperModel.instances.append(self)

    def transcribe(self, wav_path, vad_filter=True):
        self.transcribe_calls += 1
        segments = [
            _FakeSegment(0.0, 3.0, "  red for three seconds  "),
            _FakeSegment(3.0, 6.0, "blue for three more"),
        ]
        info = types.SimpleNamespace(language="en")
        return segments, info


@pytest.fixture(autouse=True)
def _reset_faster_whisper_cache():
    """The module-level model cache must not leak fake instances/state
    between tests that expect a fresh load."""
    faster_whisper_backend._MODEL_CACHE.clear()
    _FakeWhisperModel.instances.clear()
    yield
    faster_whisper_backend._MODEL_CACHE.clear()
    _FakeWhisperModel.instances.clear()


def _install_fake_faster_whisper(monkeypatch):
    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = _FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)


def _install_fake_ctranslate2(monkeypatch, cuda_count=0, raise_exc=None):
    fake_module = types.ModuleType("ctranslate2")

    def _get_cuda_device_count():
        if raise_exc is not None:
            raise raise_exc
        return cuda_count

    fake_module.get_cuda_device_count = _get_cuda_device_count
    monkeypatch.setitem(sys.modules, "ctranslate2", fake_module)


def test_faster_whisper_resolve_model_auto(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.platform_info.recommend_whisper_model",
        lambda: "tiny")
    assert faster_whisper_backend.resolve_model(_base_cfg(video_whisper_model="auto")) == "tiny"
    assert faster_whisper_backend.resolve_model(_base_cfg(video_whisper_model="small")) == "small"


def test_faster_whisper_transcribe_maps_segments(monkeypatch):
    _install_fake_faster_whisper(monkeypatch)
    _install_fake_ctranslate2(monkeypatch, cuda_count=0)

    result = faster_whisper_backend.transcribe("fake.wav", _base_cfg(video_whisper_device="cpu"))

    assert result.transcription_source == "faster-whisper"
    assert len(result.segments) == 2
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 3.0
    assert result.segments[0].text == "red for three seconds"   # stripped
    assert result.segments[1].text == "blue for three more"


def test_faster_whisper_caches_model_instance(monkeypatch):
    _install_fake_faster_whisper(monkeypatch)
    _install_fake_ctranslate2(monkeypatch, cuda_count=0)

    cfg = _base_cfg(video_whisper_device="cpu")
    faster_whisper_backend.transcribe("a.wav", cfg)
    faster_whisper_backend.transcribe("b.wav", cfg)

    # Same (model, device, compute_type) key -> one instance, two transcribe() calls.
    assert len(_FakeWhisperModel.instances) == 1
    assert _FakeWhisperModel.instances[0].transcribe_calls == 2


def test_faster_whisper_device_auto_cuda_when_available(monkeypatch):
    _install_fake_ctranslate2(monkeypatch, cuda_count=1)
    device, compute_type = faster_whisper_backend.resolve_device(_base_cfg(video_whisper_device="auto"))
    assert device == "cuda"
    assert compute_type == "float16"


def test_faster_whisper_device_auto_cpu_when_no_cuda(monkeypatch):
    _install_fake_ctranslate2(monkeypatch, cuda_count=0)
    device, compute_type = faster_whisper_backend.resolve_device(_base_cfg(video_whisper_device="auto"))
    assert device == "cpu"
    assert compute_type == "int8"


def test_faster_whisper_device_auto_cpu_when_ctranslate2_raises(monkeypatch):
    _install_fake_ctranslate2(monkeypatch, raise_exc=RuntimeError("no driver"))
    device, compute_type = faster_whisper_backend.resolve_device(_base_cfg(video_whisper_device="auto"))
    assert device == "cpu"
    assert compute_type == "int8"


def test_faster_whisper_device_auto_cpu_when_ctranslate2_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "ctranslate2", None)  # import raises ImportError
    device, compute_type = faster_whisper_backend.resolve_device(_base_cfg(video_whisper_device="auto"))
    assert device == "cpu"
    assert compute_type == "int8"


def test_faster_whisper_explicit_device_bypasses_auto(monkeypatch):
    # No ctranslate2 installed at all — explicit device must not probe CUDA.
    monkeypatch.setitem(sys.modules, "ctranslate2", None)
    device, compute_type = faster_whisper_backend.resolve_device(_base_cfg(video_whisper_device="cpu"))
    assert device == "cpu"
    assert compute_type == "int8"


def test_faster_whisper_cuda_load_failure_falls_back_to_cpu(monkeypatch):
    _install_fake_ctranslate2(monkeypatch, cuda_count=1)  # device auto -> cuda

    calls = []

    class _FlakyWhisperModel(_FakeWhisperModel):
        def __init__(self, model_size_or_path, device="auto", compute_type="default", **kwargs):
            calls.append((device, compute_type))
            if device == "cuda":
                raise RuntimeError("libcudnn not found")
            super().__init__(model_size_or_path, device=device, compute_type=compute_type, **kwargs)

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = _FlakyWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    result = faster_whisper_backend.transcribe("fake.wav", _base_cfg(video_whisper_device="auto"))

    assert result.transcription_source == "faster-whisper"
    assert calls == [("cuda", "float16"), ("cpu", "int8")]


def test_faster_whisper_ensure_model_prewarms_and_returns_name(monkeypatch):
    _install_fake_faster_whisper(monkeypatch)
    _install_fake_ctranslate2(monkeypatch, cuda_count=0)

    name = faster_whisper_backend.ensure_model(_base_cfg(video_whisper_model="small", video_whisper_device="cpu"))

    assert name == "small"
    assert len(_FakeWhisperModel.instances) == 1


def test_faster_whisper_probe_reports_availability(monkeypatch):
    _install_fake_faster_whisper(monkeypatch)
    _install_fake_ctranslate2(monkeypatch, cuda_count=2)

    info = faster_whisper_backend.probe()
    assert info["available"] is True
    assert "CUDA" in info["detail"]


def test_faster_whisper_probe_unavailable_when_not_importable(monkeypatch):
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    info = faster_whisper_backend.probe()
    assert info["available"] is False


# ---- whisper.cpp -------------------------------------------------------------

def test_whisper_cpp_resolve_model_auto(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.platform_info.recommend_whisper_model",
        lambda: "base")
    assert whisper_cpp_backend.resolve_model(_base_cfg(video_whisper_model="auto")) == "base"


def test_whisper_cpp_find_binary_prefers_whisper_cli(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.whisper_cpp_backend.platform_info.check_command",
        lambda name: "/usr/bin/whisper-cli" if name == "whisper-cli" else None)
    assert whisper_cpp_backend._find_binary() == "/usr/bin/whisper-cli"


def test_whisper_cpp_find_binary_falls_back_to_legacy_name(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.whisper_cpp_backend.platform_info.check_command",
        lambda name: "/usr/bin/whisper-cpp" if name == "whisper-cpp" else None)
    assert whisper_cpp_backend._find_binary() == "/usr/bin/whisper-cpp"


def test_whisper_cpp_find_binary_missing_raises(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.whisper_cpp_backend.platform_info.check_command",
        lambda name: None)
    with pytest.raises(FileNotFoundError):
        whisper_cpp_backend._find_binary()


def _fake_subprocess_run_writing_json(json_payload):
    """Returns a fake subprocess.run() that ignores the real whisper-cli
    invocation and instead writes the JSON the CLI would have produced to
    <out_prefix>.json, taken from the "-of" argv entry."""

    def _run(argv, **kwargs):
        out_prefix = argv[argv.index("-of") + 1]
        with open(f"{out_prefix}.json", "w", encoding="utf-8") as f:
            json.dump(json_payload, f)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    return _run


def test_whisper_cpp_transcribe_handles_offsets_shape(monkeypatch, tmp_path):
    monkeypatch.setattr(whisper_cpp_backend, "_find_binary", lambda: "/usr/bin/whisper-cli")
    monkeypatch.setattr(whisper_cpp_backend, "ensure_model_file", lambda model: str(tmp_path / "ggml-small.bin"))
    payload = {
        "transcription": [
            {"offsets": {"from": 0, "to": 3000}, "text": " red segment "},
            {"offsets": {"from": 3000, "to": 6000}, "text": "blue segment"},
        ]
    }
    monkeypatch.setattr(whisper_cpp_backend.subprocess, "run", _fake_subprocess_run_writing_json(payload))

    result = whisper_cpp_backend.transcribe("fake.wav", _base_cfg())

    assert result.transcription_source == "whisper-cpp"
    assert [s.start for s in result.segments] == [0.0, 3.0]
    assert [s.end for s in result.segments] == [3.0, 6.0]
    assert result.segments[0].text == "red segment"


def test_whisper_cpp_transcribe_handles_flat_from_to_shape(monkeypatch, tmp_path):
    monkeypatch.setattr(whisper_cpp_backend, "_find_binary", lambda: "/usr/bin/whisper-cli")
    monkeypatch.setattr(whisper_cpp_backend, "ensure_model_file", lambda model: str(tmp_path / "ggml-small.bin"))
    payload = {
        "transcription": [
            {"from": 0, "to": 1500, "text": "hello"},
        ]
    }
    monkeypatch.setattr(whisper_cpp_backend.subprocess, "run", _fake_subprocess_run_writing_json(payload))

    result = whisper_cpp_backend.transcribe("fake.wav", _base_cfg())

    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 1.5
    assert result.segments[0].text == "hello"


def test_whisper_cpp_download_model_validates_and_atomically_replaces(monkeypatch, tmp_path):
    """No real 10MB download in a test — lower the validation floor instead
    and feed a small fake payload through a fake urlopen."""
    monkeypatch.setattr(whisper_cpp_backend, "_MIN_PLAUSIBLE_BYTES", 4)
    monkeypatch.setattr(
        whisper_cpp_backend, "config",
        types.SimpleNamespace(models_dir=lambda: tmp_path))

    fake_body = b"ggml-fake-payload"

    class _FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, n=-1):
            nonlocal fake_body
            chunk, fake_body = fake_body[:n if n != -1 else len(fake_body)], fake_body[n if n != -1 else len(fake_body):]
            return chunk

    monkeypatch.setattr(whisper_cpp_backend.urllib.request, "urlopen", lambda url, timeout=30: _FakeResponse())

    path = whisper_cpp_backend.ensure_model_file("tiny")

    assert path == str(tmp_path / "ggml-tiny.bin")
    with open(path, "rb") as f:
        assert f.read() == b"ggml-fake-payload"
    assert not (tmp_path / "ggml-tiny.bin.part").exists()


def test_whisper_cpp_download_model_rejects_implausible_payload(monkeypatch, tmp_path):
    monkeypatch.setattr(whisper_cpp_backend, "_MIN_PLAUSIBLE_BYTES", 10 * 1024 * 1024)
    monkeypatch.setattr(
        whisper_cpp_backend, "config",
        types.SimpleNamespace(models_dir=lambda: tmp_path))

    fake_body = b"<html>not a model</html>"

    class _FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, n=-1):
            nonlocal fake_body
            chunk, fake_body = fake_body[:n if n != -1 else len(fake_body)], fake_body[n if n != -1 else len(fake_body):]
            return chunk

    monkeypatch.setattr(whisper_cpp_backend.urllib.request, "urlopen", lambda url, timeout=30: _FakeResponse())

    with pytest.raises(RuntimeError, match="failed validation"):
        whisper_cpp_backend.ensure_model_file("tiny")
    assert not (tmp_path / "ggml-tiny.bin").exists()
    assert not (tmp_path / "ggml-tiny.bin.part").exists()


def test_whisper_cpp_ensure_model_file_skips_download_when_cached(monkeypatch, tmp_path):
    existing = tmp_path / "ggml-small.bin"
    existing.write_bytes(b"already here")
    monkeypatch.setattr(
        whisper_cpp_backend, "config",
        types.SimpleNamespace(models_dir=lambda: tmp_path))

    def _boom(model_name, dest):
        raise AssertionError("should not download when the model file already exists")

    monkeypatch.setattr(whisper_cpp_backend, "_download_model", _boom)

    assert whisper_cpp_backend.ensure_model_file("small") == str(existing)


def test_whisper_cpp_probe_unavailable_without_binary(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.whisper_cpp_backend.platform_info.check_command",
        lambda name: None)
    info = whisper_cpp_backend.probe()
    assert info["available"] is False


def test_whisper_cpp_probe_available_reports_binary(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.whisper_cpp_backend.platform_info.check_command",
        lambda name: "/usr/bin/whisper-cli" if name == "whisper-cli" else None)
    monkeypatch.setattr(
        whisper_cpp_backend, "config",
        types.SimpleNamespace(models_dir=lambda: tmp_path))
    info = whisper_cpp_backend.probe()
    assert info["available"] is True
    assert "whisper-cli" in info["detail"]


# ---- openai-whisper ----------------------------------------------------------

def test_openai_whisper_find_binary_prefers_whisper_at(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.openai_whisper_backend.platform_info.check_command",
        lambda name: "/usr/bin/whisper-at" if name == "whisper-at" else "/usr/bin/whisper")
    exe, is_whisper_at = openai_whisper_backend._find_binary()
    assert exe == "/usr/bin/whisper-at"
    assert is_whisper_at is True


def test_openai_whisper_find_binary_falls_back_to_plain_whisper(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.openai_whisper_backend.platform_info.check_command",
        lambda name: "/usr/bin/whisper" if name == "whisper" else None)
    exe, is_whisper_at = openai_whisper_backend._find_binary()
    assert exe == "/usr/bin/whisper"
    assert is_whisper_at is False


def test_openai_whisper_find_binary_missing_raises(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.openai_whisper_backend.platform_info.check_command",
        lambda name: None)
    with pytest.raises(FileNotFoundError):
        openai_whisper_backend._find_binary()


def test_openai_whisper_transcribe_argv_has_no_language_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(openai_whisper_backend, "_find_binary", lambda: ("/usr/bin/whisper", False))
    captured_argv = {}

    def _run(argv, **kwargs):
        captured_argv["argv"] = argv
        out_dir = argv[argv.index("--output_dir") + 1]
        stem = "fake"
        payload = {"segments": [{"start": 0.0, "end": 3.0, "text": " hi there "}]}
        with open(f"{out_dir}/{stem}.json", "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(openai_whisper_backend.subprocess, "run", _run)

    result = openai_whisper_backend.transcribe("fake.wav", _base_cfg())

    assert "--language" not in captured_argv["argv"]
    assert result.transcription_source == "openai-whisper"
    assert result.segments[0].start == 0.0
    assert result.segments[0].end == 3.0
    assert result.segments[0].text == "hi there"
    assert result.audio_tags == []


def test_openai_whisper_whisper_at_parses_audio_tags(monkeypatch):
    monkeypatch.setattr(openai_whisper_backend, "_find_binary", lambda: ("/usr/bin/whisper-at", True))

    def _run(argv, **kwargs):
        out_dir = argv[argv.index("--output_dir") + 1]
        payload = {
            "segments": [{"start": 0.0, "end": 3.0, "text": "hello"}],
            "audio_tags": [{"start": 1.0, "end": 2.0, "tag": "music"}],
        }
        with open(f"{out_dir}/fake.json", "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(openai_whisper_backend.subprocess, "run", _run)

    result = openai_whisper_backend.transcribe("fake.wav", _base_cfg())

    assert len(result.audio_tags) == 1
    assert result.audio_tags[0].tag == "music"
    assert result.audio_tags[0].start == 1.0
    assert result.audio_tags[0].end == 2.0


def test_openai_whisper_probe_reports_whisper_at_when_present(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.openai_whisper_backend.platform_info.check_command",
        lambda name: "/usr/bin/whisper-at" if name == "whisper-at" else None)
    info = openai_whisper_backend.probe()
    assert info["available"] is True
    assert "whisper-at" in info["detail"]


def test_openai_whisper_probe_unavailable_without_binary(monkeypatch):
    monkeypatch.setattr(
        "computer_use_mcp.video.backends.openai_whisper_backend.platform_info.check_command",
        lambda name: None)
    info = openai_whisper_backend.probe()
    assert info["available"] is False
