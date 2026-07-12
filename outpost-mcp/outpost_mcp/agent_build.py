"""On-demand build of the outpost-agent Go binaries.

The compiled agents live in ``outpost-mcp/agent-bin/`` (gitignored) and were
historically produced ONLY by a human running ``outpost-agent/build.sh`` by
hand. A freshly-checked-out outpost-mcp hub therefore had an empty ``agent-bin/``
and served ``404 agent_binary_unavailable`` for every pairing — the whole reason
"creating a new outpost on a fresh box" failed while the original dev box worked.

This module lets the server build the one target it needs on demand (when a Go
toolchain + the outpost-agent source are present), so a from-source hub just
works. ``packaging/install.sh`` and CI also pre-populate ``agent-bin/`` so the
build cost is paid once, not per pairing.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from . import config

# The exact targets outpost-agent/build.sh cross-compiles. Requests outside this
# set are rejected (an allow-list also prevents a caller-supplied os_name/arch
# from injecting into GOOS/GOARCH or the on-disk filename/path).
KNOWN_TARGETS = {
    ("linux", "amd64"),
    ("linux", "arm64"),
    ("darwin", "amd64"),
    ("darwin", "arm64"),
    ("windows", "amd64"),
    ("windows", "386"),
}


def is_known_target(os_name: str, arch: str) -> bool:
    return (os_name, arch) in KNOWN_TARGETS


def binary_name(os_name: str, arch: str) -> str:
    ext = ".exe" if os_name == "windows" else ""
    return f"outpost-agent-{os_name}-{arch}{ext}"


def _agent_src_dir() -> Path | None:
    """Locate the outpost-agent Go source dir (sibling of the outpost-mcp pkg)."""
    pkg = Path(config.__file__).resolve().parent            # .../outpost-mcp/outpost_mcp
    for cand in (pkg.parent.parent / "outpost-agent",       # <repo>/outpost-agent
                 pkg.parent / "outpost-agent"):
        if (cand / "go.mod").exists() or (cand / "build.sh").exists() \
                or any(cand.glob("*.go")):
            return cand
    return None


def ensure_agent_binary(os_name: str, arch: str) -> Path | None:
    """Path to the outpost-agent binary for (os_name, arch), building it on
    demand from source if it's missing and a Go toolchain is available. Returns
    None if the target is unknown, or it can't be produced (no source / no Go /
    build failure) — the caller then serves a clear 404.
    """
    if not is_known_target(os_name, arch):
        return None
    dest = config.agent_bin_dir() / binary_name(os_name, arch)
    if dest.exists():
        return dest
    src = _agent_src_dir()
    if src is None or shutil.which("go") is None:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "CGO_ENABLED": "0", "GOOS": os_name, "GOARCH": arch}
    try:
        subprocess.run(
            ["go", "build", "-trimpath", "-ldflags=-s -w", "-o", str(dest), "."],
            cwd=str(src), env=env, check=True, capture_output=True, timeout=300,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if dest.exists():
        try:
            dest.chmod(0o755)
        except OSError:
            pass
        return dest
    return None
