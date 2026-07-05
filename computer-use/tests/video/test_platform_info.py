"""OS/GPU/RAM detection + whisper-model recommendation.

Boundaries for recommend_whisper_model are pinned against the CODE (the
_MODEL_BY_RAM ladder), not the plain-English gloss, since "< ceiling" makes the
ceiling values themselves fall through to the NEXT tier.
"""

from __future__ import annotations

import pytest

from computer_use_mcp.video import platform_info


# ---- recommend_whisper_model --------------------------------------------------

@pytest.mark.parametrize("ram_gb, expected", [
    (0, "tiny"),
    (3.9, "tiny"),          # < 4
    (4, "small"),           # not < 4, but < 8
    (7.9, "small"),         # < 8
    (8, "large-v3-turbo"),  # not < 8, but < 16
    (15.9, "large-v3-turbo"),
    (16, "large-v3"),       # not < 16 -> falls off the ladder
    (64, "large-v3"),
])
def test_recommend_whisper_model_boundaries(ram_gb, expected):
    assert platform_info.recommend_whisper_model(ram_gb) == expected


def test_recommend_whisper_model_uses_detected_ram_when_omitted(monkeypatch):
    monkeypatch.setattr(platform_info, "total_ram_gb", lambda: 2.0)
    assert platform_info.recommend_whisper_model() == "tiny"


# ---- check_command -------------------------------------------------------------

def test_check_command_found(monkeypatch):
    monkeypatch.setattr(platform_info.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert platform_info.check_command("ffmpeg") == "/usr/bin/ffmpeg"


def test_check_command_missing(monkeypatch):
    monkeypatch.setattr(platform_info.shutil, "which", lambda name: None)
    assert platform_info.check_command("ffmpeg") is None


# ---- os_name ---------------------------------------------------------------------

def test_os_name_on_this_box():
    # This test suite runs on Linux CI/dev boxes; sys.platform is "linux".
    assert platform_info.os_name() == "linux"


# ---- detect_platform --------------------------------------------------------------

def test_detect_platform_has_all_keys_with_sane_types():
    info = platform_info.detect_platform()
    assert set(info.keys()) == {"os", "arch", "python", "ram_gb", "gpu", "frozen"}
    assert isinstance(info["os"], str)
    assert isinstance(info["arch"], str)
    assert isinstance(info["python"], str)
    assert isinstance(info["ram_gb"], float)
    assert isinstance(info["gpu"], str)   # empty string is a valid "no gpu" value
    assert isinstance(info["frozen"], bool)
    assert info["os"] == "linux"
    assert info["frozen"] is False
