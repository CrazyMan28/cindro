"""Make the engine package and the Windows backend importable for the tests.

These tests run on LINUX (Win32 absent): mss/pywin32 are import-guarded in
backend_windows, and the engine modules import fine on Linux (os.getuid exists).
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_DIR = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "computer-use"))
_WIN_ENGINE = os.path.normpath(os.path.join(_HERE, ".."))

for p in (_ENGINE_DIR, _WIN_ENGINE):
    if p not in sys.path:
        sys.path.insert(0, p)
