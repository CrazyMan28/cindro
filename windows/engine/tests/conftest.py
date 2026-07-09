"""Make the engine package and the Windows backend importable for the tests.

Normally run on LINUX (Win32 absent): mss/pywin32 are import-guarded in
backend_windows, and the engine modules import fine on Linux (os.getuid
exists) -- this cross-validates the Windows-only backend logic without needing
a real Windows box. Also runnable directly on a genuine Windows dev box: the
engine's session.py/config.py call os.getuid() at import time, which Windows
lacks, so mirror server_windows.py's shim here too (no-op where it already
exists, i.e. on Linux).
"""

from __future__ import annotations

import os
import sys

if not hasattr(os, "getuid"):
    os.getuid = lambda: 0  # type: ignore[attr-defined]

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_DIR = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "computer-use"))
_WIN_ENGINE = os.path.normpath(os.path.join(_HERE, ".."))

for p in (_ENGINE_DIR, _WIN_ENGINE):
    if p not in sys.path:
        sys.path.insert(0, p)
