"""Tests for computer_use_mcp.video.session.manager — content hashing, the
on-disk manifest cache, and expiry sweeping. Every test points JARVIS_DATA_DIR
at a tmp dir so the real ~/.local/share/jarvis is never touched."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from computer_use_mcp.video.session import manager


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path))
    yield tmp_path


def _write(path: Path, data: bytes) -> None:
    path.write_bytes(data)


# ---- compute_video_hash -----------------------------------------------------

def test_hash_stable_across_two_reads(tmp_path):
    video = tmp_path / "clip.mp4"
    _write(video, b"x" * 200_000)
    first = manager.compute_video_hash(str(video))
    second = manager.compute_video_hash(str(video))
    assert first == second
    assert len(first) == 12


def test_hash_same_prefix_and_size_collide_even_if_tail_differs(tmp_path):
    """Documented trade-off: only the first 64KB + total size are hashed, so
    a byte changed beyond 64KB (with size unchanged) keeps the same hash —
    fast on huge files; a moved-but-identical file keeps its cache."""
    prefix = b"a" * (64 * 1024)
    tail_a = b"A" * 1024
    tail_b = b"B" * 1024
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    _write(video_a, prefix + tail_a)
    _write(video_b, prefix + tail_b)
    assert manager.compute_video_hash(str(video_a)) == manager.compute_video_hash(str(video_b))


def test_hash_different_size_gives_different_hash(tmp_path):
    prefix = b"a" * (64 * 1024)
    video_a = tmp_path / "a.mp4"
    video_b = tmp_path / "b.mp4"
    _write(video_a, prefix)
    _write(video_b, prefix + b"extra")
    assert manager.compute_video_hash(str(video_a)) != manager.compute_video_hash(str(video_b))


def test_hash_small_file_under_64kb(tmp_path):
    video = tmp_path / "tiny.mp4"
    _write(video, b"tiny content")
    h = manager.compute_video_hash(str(video))
    assert len(h) == 12


# ---- session_dir -------------------------------------------------------------

def test_session_dir_created_on_demand(tmp_path):
    d = manager.session_dir("abc123")
    assert d.is_dir()
    assert d.name == "abc123"


# ---- load/save manifest -------------------------------------------------------

def test_save_and_load_manifest_round_trip():
    manifest = {"video_hash": "h1", "video_path": "/v.mp4", "resolutions": {}}
    manager.save_manifest("h1", manifest)
    loaded = manager.load_manifest("h1")
    assert loaded == manifest


def test_save_manifest_is_atomic_no_tmp_file_left_behind():
    manager.save_manifest("h2", {"video_hash": "h2"})
    d = manager.session_dir("h2")
    leftovers = [p for p in d.iterdir() if p.name.startswith(".")]
    assert leftovers == []
    assert (d / "manifest.json").exists()


def test_load_manifest_missing_returns_none():
    assert manager.load_manifest("does-not-exist") is None


def test_load_manifest_corrupt_json_returns_none():
    d = manager.session_dir("corrupt")
    (d / "manifest.json").write_text("{not valid json", encoding="utf-8")
    assert manager.load_manifest("corrupt") is None


# ---- clean_expired_sessions ----------------------------------------------------

def _make_session(sessions_root: Path, video_hash: str, created_at: datetime) -> Path:
    d = sessions_root / video_hash
    d.mkdir(parents=True)
    manifest = {
        "video_hash": video_hash,
        "video_path": "/v.mp4",
        "created_at": created_at.isoformat(),
        "resolutions": {},
    }
    (d / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return d


def test_clean_expired_sessions_removes_old_keeps_fresh(tmp_path):
    from computer_use_mcp.video import config

    root = config.sessions_dir()
    now = datetime.now(timezone.utc)
    old_dir = _make_session(root, "old", now - timedelta(days=30))
    fresh_dir = _make_session(root, "fresh", now - timedelta(hours=1))

    removed = manager.clean_expired_sessions(max_age_days=7)

    assert removed == 1
    assert not old_dir.exists()
    assert fresh_dir.exists()


def test_clean_expired_sessions_survives_garbage_dirs(tmp_path):
    from computer_use_mcp.video import config

    root = config.sessions_dir()
    now = datetime.now(timezone.utc)
    # A garbage dir: no manifest at all, but old mtime -> should be swept.
    garbage = root / "garbage"
    garbage.mkdir(parents=True)
    old_time = (now - timedelta(days=30)).timestamp()
    os.utime(garbage, (old_time, old_time))

    # A dir with a corrupt manifest but a fresh mtime -> should survive.
    corrupt_fresh = root / "corrupt-fresh"
    corrupt_fresh.mkdir(parents=True)
    (corrupt_fresh / "manifest.json").write_text("{broken", encoding="utf-8")

    fresh = _make_session(root, "fresh", now - timedelta(hours=1))

    removed = manager.clean_expired_sessions(max_age_days=7)

    assert not garbage.exists()
    assert corrupt_fresh.exists()
    assert fresh.exists()
    assert removed == 1


def test_clean_expired_sessions_no_sessions_dir_returns_zero(tmp_path, monkeypatch):
    # Point at a data dir whose video/sessions subtree doesn't exist yet,
    # and don't touch config.sessions_dir() (which would create it).
    empty_root = tmp_path / "totally-empty"
    monkeypatch.setenv("JARVIS_DATA_DIR", str(empty_root))
    assert manager.clean_expired_sessions(max_age_days=7) == 0


def test_clean_expired_sessions_never_raises_on_unreadable_entry(tmp_path):
    from computer_use_mcp.video import config

    root = config.sessions_dir()
    # A "session dir" that's actually a file masquerading — is_dir() filters
    # this out before any stat/rmtree is attempted.
    (root / "not-a-dir").write_text("oops", encoding="utf-8")
    removed = manager.clean_expired_sessions(max_age_days=7)
    assert removed == 0
