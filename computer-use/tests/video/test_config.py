"""Video settings bridge (jarvisd merge-over-DEFAULTS) + storage directories.

daemon_client.call is monkeypatched on the module object imported into
config.py (`config.daemon_client`) — that's the same object as
computer_use_mcp.daemon_client, so patching its `call` attribute intercepts
every call config.py makes without touching a real jarvisd.
"""

from __future__ import annotations

import pytest

from computer_use_mcp.video import config


# ---- DEFAULTS ------------------------------------------------------------------

def test_defaults_has_all_19_keys():
    assert len(config.DEFAULTS) == 19


def test_defaults_documented_values():
    assert config.DEFAULTS["video_backend"] == "local"
    assert config.DEFAULTS["video_whisper_model"] == "large-v3"
    assert config.DEFAULTS["video_frame_resolution"] == 512
    assert config.DEFAULTS["video_max_frames"] == 100
    assert config.DEFAULTS["video_enable_index"] is False


# ---- load_video_config -----------------------------------------------------------

def test_load_video_config_coerces_and_ignores_unrelated(monkeypatch):
    monkeypatch.setattr(config.daemon_client, "call", lambda method, params=None,
                         timeout=5: {"video_frame_resolution": "1024",
                                     "video_enable_index": 1,
                                     "video_backend": "gemini-api",
                                     "unrelated": "x"})
    cfg = config.load_video_config()
    assert cfg["video_frame_resolution"] == 1024
    assert isinstance(cfg["video_frame_resolution"], int)
    assert cfg["video_enable_index"] is True
    assert isinstance(cfg["video_enable_index"], bool)
    assert cfg["video_backend"] == "gemini-api"
    assert isinstance(cfg["video_backend"], str)
    assert "unrelated" not in cfg
    # Untouched keys keep their DEFAULTS value.
    assert cfg["video_whisper_model"] == config.DEFAULTS["video_whisper_model"]


def test_load_video_config_pure_defaults_when_daemon_unreachable(monkeypatch):
    def _raise(method, params=None, timeout=5):
        raise RuntimeError("jarvisd not running")
    monkeypatch.setattr(config.daemon_client, "call", _raise)
    assert config.load_video_config() == config.DEFAULTS


# ---- update_video_config -----------------------------------------------------------

def test_update_video_config_filters_non_video_keys(monkeypatch):
    calls = []

    def _fake(method, params=None, timeout=5):
        calls.append((method, params, timeout))
        if method == "settings.get":
            return {}
        return {}
    monkeypatch.setattr(config.daemon_client, "call", _fake)

    config.update_video_config({"video_frame_resolution": 600, "unrelated": "nope"})

    set_calls = [c for c in calls if c[0] == "settings.set"]
    assert len(set_calls) == 1
    assert set_calls[0][1] == {"patch": {"video_frame_resolution": 600}}
    assert set_calls[0][2] == 10


def test_update_video_config_raises_when_daemon_unreachable(monkeypatch):
    def _raise(method, params=None, timeout=5):
        raise RuntimeError("jarvisd not running")
    monkeypatch.setattr(config.daemon_client, "call", _raise)
    with pytest.raises(RuntimeError):
        config.update_video_config({"video_backend": "local"})


def test_update_video_config_empty_patch_skips_daemon_write(monkeypatch):
    calls = []

    def _fake(method, params=None, timeout=5):
        calls.append(method)
        if method == "settings.get":
            return {}
        return {}
    monkeypatch.setattr(config.daemon_client, "call", _fake)

    result = config.update_video_config({"unrelated": "x"})

    assert "settings.set" not in calls
    assert result == config.DEFAULTS


# ---- storage dirs -----------------------------------------------------------------

@pytest.fixture
def data_root(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path))
    return tmp_path


def test_data_dir_honors_jarvis_data_dir(data_root):
    assert config.data_dir() == data_root


def test_downloads_sessions_models_dirs_autocreate(data_root):
    downloads = config.downloads_dir()
    sessions = config.sessions_dir()
    models = config.models_dir()
    # JARVIS_DATA_DIR IS the jarvis root (unlike the XDG fallback, which
    # appends "jarvis" itself) — see config.data_dir().
    assert downloads == data_root / "video" / "downloads"
    assert sessions == data_root / "video" / "sessions"
    assert models == data_root / "video" / "models"
    assert downloads.is_dir()
    assert sessions.is_dir()
    assert models.is_dir()


def test_clear_sessions_deletes_and_counts(data_root):
    sessions = config.sessions_dir()
    (sessions / "session-a").mkdir()
    (sessions / "session-b").mkdir()
    (sessions / "stray-file.txt").write_text("not a dir")

    count = config.clear_sessions()

    assert count == 2
    assert not sessions.is_dir()


def test_clear_sessions_returns_zero_when_no_sessions_dir(data_root):
    assert config.clear_sessions() == 0
