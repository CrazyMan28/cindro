"""Platform/hardware detection + dependency checks for video_setup.

Named platform_info (not platform) so it never shadows the stdlib module
inside the PyInstaller-frozen Windows engine.
"""

from __future__ import annotations

import platform as _stdlib_platform
import shutil
import subprocess
import sys

# RAM -> sensible local whisper model. Mirrors the behavior contract from the
# reference plugin: small machines get small models, 16GB+ gets large-v3.
_MODEL_BY_RAM: tuple[tuple[float, str], ...] = (
    (4, "tiny"),
    (8, "small"),
    (16, "large-v3-turbo"),
)

WHISPER_MODELS = ("tiny", "base", "small", "medium", "large-v3-turbo", "large-v3")


def os_name() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def check_command(name: str) -> str | None:
    """Absolute path of `name` on PATH, or None. shutil.which handles .exe."""
    return shutil.which(name)


def total_ram_gb() -> float:
    try:
        if sys.platform == "win32":
            import ctypes

            class _MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_uint64),
                            ("ullAvailPhys", ctypes.c_uint64),
                            ("ullTotalPageFile", ctypes.c_uint64),
                            ("ullAvailPageFile", ctypes.c_uint64),
                            ("ullTotalVirtual", ctypes.c_uint64),
                            ("ullAvailVirtual", ctypes.c_uint64),
                            ("ullAvailExtendedVirtual", ctypes.c_uint64)]

            st = _MemStatus(dwLength=ctypes.sizeof(_MemStatus))
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            return st.ullTotalPhys / (1024 ** 3)
        import os
        return (os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")) / (1024 ** 3)
    except Exception:  # noqa: BLE001 — detection is best-effort
        return 0.0


def detect_gpu() -> str:
    """'cuda:<name>' when an NVIDIA GPU responds, 'apple-silicon', else ''."""
    if sys.platform == "darwin" and _stdlib_platform.machine() == "arm64":
        return "apple-silicon"
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run(
                [smi, "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=5)
            name = (out.stdout or "").strip().splitlines()
            if out.returncode == 0 and name:
                return f"cuda:{name[0].strip()}"
        except Exception:  # noqa: BLE001
            pass
    return ""


def recommend_whisper_model(ram_gb: float | None = None) -> str:
    ram = total_ram_gb() if ram_gb is None else ram_gb
    for ceiling, model in _MODEL_BY_RAM:
        if ram < ceiling:
            return model
    return "large-v3"


def detect_platform() -> dict:
    return {
        "os": os_name(),
        "arch": _stdlib_platform.machine(),
        "python": _stdlib_platform.python_version(),
        "ram_gb": round(total_ram_gb(), 1),
        "gpu": detect_gpu(),
        "frozen": bool(getattr(sys, "frozen", False)),
    }


def ffmpeg_install_hint() -> str:
    name = os_name()
    if name == "windows":
        return ("winget install Gyan.FFmpeg  (then RESTART Jarvis — winget updates "
                "the user PATH, which running processes don't see; if it still "
                "isn't found, log out and back in)")
    if name == "macos":
        return "brew install ffmpeg"
    return "sudo dnf install ffmpeg   # or: sudo apt install ffmpeg"
