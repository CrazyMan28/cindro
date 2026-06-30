"""Windows entry point for the Jarvis computer-use engine.

Runs the UNCHANGED engine server, but first monkeypatches the Win32 primitives
from ``backend_windows`` onto the engine's ``input`` / ``screen`` / ``session``
modules. The engine calls every primitive by MODULE ATTRIBUTE at call time
(``inp.move(...)``, ``screen.take_screenshot(...)``, ``session.get_session(...)``,
and ``grab_jpeg_frame(...)`` as a module-global inside ``screen.video_source``),
so rebinding those attributes routes everything to the Windows backend without a
single edit under ``computer-use/``.

Run it (from this directory) on Windows::

    pip install -e ..\\..\\computer-use          # the engine package
    pip install -r requirements-windows.txt      # pywin32 + mss (pillow via engine)
    python server_windows.py

Delete ``windows/`` and the Linux engine is completely unaffected.
"""

from __future__ import annotations

import os
import sys

# The engine's session.py / config.py call os.getuid() AT IMPORT TIME, which does
# not exist on Windows. We cannot edit the engine, so install a Windows-only shim
# BEFORE importing it. (No-op on Linux: the sys.platform guard skips it.)
if sys.platform == "win32" and not hasattr(os, "getuid"):
    os.getuid = lambda: 0  # type: ignore[attr-defined]

# Make `import backend_windows` work no matter the cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from computer_use_mcp import input as _i  # noqa: E402
from computer_use_mcp import screen as _s  # noqa: E402
from computer_use_mcp import session as _se  # noqa: E402

import backend_windows as bw  # noqa: E402

# Primitive names patched onto each engine module (verified against the engine:
# every caller reads these as module attributes, and nothing does
# `from computer_use_mcp.input import move`).
_INPUT_PRIMS = ("move", "click", "drag", "scroll", "key_press", "type_text")
_SCREEN_PRIMS = ("take_screenshot", "grab_jpeg_frame")
_SESSION_PRIMS = ("detect", "get_session", "compositor_hint")


def apply_patches() -> None:
    """Rebind the engine's primitives to the Windows backend (idempotent)."""
    for n in _INPUT_PRIMS:
        setattr(_i, n, getattr(bw, n))
    for n in _SCREEN_PRIMS:
        setattr(_s, n, getattr(bw, n))
    for n in _SESSION_PRIMS:
        setattr(_se, n, getattr(bw, n))


# Apply at import so the engine is already Windows-routed once this module loads.
apply_patches()


def main() -> None:
    # Import the heavy server lazily (after patching) so merely importing this
    # module for tests doesn't pull in uvicorn/fastapi/the full tool surface.
    from computer_use_mcp.server import main as _engine_main
    _engine_main()


if __name__ == "__main__":
    main()
