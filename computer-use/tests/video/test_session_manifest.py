"""Pure-function tests for computer_use_mcp.video.session.manifest — no disk,
no config, no fixtures beyond plain dicts."""

from __future__ import annotations

from datetime import datetime

from computer_use_mcp.video.session import manifest as m


def test_new_manifest_shape():
    man = m.new_manifest("abc123def456", "/videos/clip.mp4")
    assert man["video_hash"] == "abc123def456"
    assert man["video_path"] == "/videos/clip.mp4"
    assert man["resolutions"] == {}
    # created_at is ISO-8601 and timezone-aware.
    parsed = datetime.fromisoformat(man["created_at"])
    assert parsed.tzinfo is not None


def test_cache_key():
    assert m.cache_key(512, "jpeg") == "512/jpeg"
    assert m.cache_key(1024, "png") == "1024/png"


def test_frame_filename_colons_become_dashes():
    assert m.frame_filename("00:01:30", "jpeg") == "00-01-30.jpeg"
    assert m.frame_filename("01:02:03", "png") == "01-02-03.png"


def test_merge_frames_dedup_by_exact_timestamp():
    man = m.new_manifest("h", "/v.mp4")
    m.merge_frames(man, 512, "jpeg", [
        {"timestamp": "00:00:03", "file": "00-00-03.jpeg"},
        {"timestamp": "00:00:01", "file": "00-00-01.jpeg"},
    ])
    # Second call with an overlapping timestamp overwrites, not duplicates.
    m.merge_frames(man, 512, "jpeg", [
        {"timestamp": "00:00:01", "file": "00-00-01-v2.jpeg"},
        {"timestamp": "00:00:02", "file": "00-00-02.jpeg"},
    ])
    frames = man["resolutions"]["512/jpeg"]["frames"]
    assert [f["timestamp"] for f in frames] == ["00:00:01", "00:00:02", "00:00:03"]
    # The overwrite won, not the original.
    assert frames[0]["file"] == "00-00-01-v2.jpeg"


def test_merge_frames_keeps_resolutions_independent():
    man = m.new_manifest("h", "/v.mp4")
    m.merge_frames(man, 512, "jpeg", [{"timestamp": "00:00:01", "file": "a.jpeg"}])
    m.merge_frames(man, 1024, "jpeg", [{"timestamp": "00:00:01", "file": "b.jpeg"}])
    assert man["resolutions"]["512/jpeg"]["frames"][0]["file"] == "a.jpeg"
    assert man["resolutions"]["1024/jpeg"]["frames"][0]["file"] == "b.jpeg"


def test_uncached_timestamps_no_bucket_yet():
    man = m.new_manifest("h", "/v.mp4")
    wanted = ["00:00:01", "00:00:02", "00:00:03"]
    assert m.uncached_timestamps(man, 512, "jpeg", wanted) == wanted


def test_uncached_timestamps_preserves_order_and_filters_hits():
    man = m.new_manifest("h", "/v.mp4")
    m.merge_frames(man, 512, "jpeg", [{"timestamp": "00:00:02", "file": "b.jpeg"}])
    wanted = ["00:00:03", "00:00:02", "00:00:01"]
    assert m.uncached_timestamps(man, 512, "jpeg", wanted) == ["00:00:03", "00:00:01"]


def test_sample_indices_zero_total():
    assert m.sample_indices(0, 5) == []


def test_sample_indices_n_le_zero_returns_all():
    assert m.sample_indices(5, 0) == [0, 1, 2, 3, 4]
    assert m.sample_indices(5, -1) == [0, 1, 2, 3, 4]


def test_sample_indices_n_ge_total_returns_all():
    assert m.sample_indices(5, 5) == [0, 1, 2, 3, 4]
    assert m.sample_indices(5, 10) == [0, 1, 2, 3, 4]


def test_sample_indices_n_equals_one():
    assert m.sample_indices(10, 1) == [0]


def test_sample_indices_evenly_spaced_3_of_10():
    result = m.sample_indices(10, 3)
    assert len(result) == 3
    assert result[0] == 0
    assert result[-1] == 9
    # Strictly increasing and within range.
    assert all(0 <= i < 10 for i in result)
    assert result == sorted(result)
    assert len(set(result)) == 3


def test_viewable_pool_prefers_highest_resolution_for_duplicate_timestamp():
    man = m.new_manifest("h", "/v.mp4")
    m.merge_frames(man, 512, "jpeg", [
        {"timestamp": "00:00:01", "file": "512/00-00-01.jpeg"},
        {"timestamp": "00:00:02", "file": "512/00-00-02.jpeg"},
    ])
    m.merge_frames(man, 1024, "jpeg", [
        {"timestamp": "00:00:01", "file": "1024/00-00-01.jpeg"},
    ])
    pool = m.viewable_pool(man, "jpeg")
    by_ts = {f["timestamp"]: f for f in pool}
    assert by_ts["00:00:01"]["resolution"] == 1024
    assert by_ts["00:00:01"]["file"] == "1024/00-00-01.jpeg"
    assert by_ts["00:00:02"]["resolution"] == 512
    assert [f["timestamp"] for f in pool] == ["00:00:01", "00:00:02"]


def test_viewable_pool_ignores_other_formats():
    man = m.new_manifest("h", "/v.mp4")
    m.merge_frames(man, 512, "jpeg", [{"timestamp": "00:00:01", "file": "a.jpeg"}])
    m.merge_frames(man, 512, "png", [{"timestamp": "00:00:02", "file": "b.png"}])
    pool = m.viewable_pool(man, "jpeg")
    assert [f["timestamp"] for f in pool] == ["00:00:01"]


def test_viewable_pool_empty_manifest():
    man = m.new_manifest("h", "/v.mp4")
    assert m.viewable_pool(man, "jpeg") == []
