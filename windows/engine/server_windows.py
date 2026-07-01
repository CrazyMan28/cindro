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

# The engine imports Linux-only modules at MODULE-LOAD time on the desktop-tools path
# (dbus_fast via kwin_bridge.py, evdev via input.py, pywayland, ...). They aren't
# installed on Windows and PyInstaller excludes them, so the import chain
# ModuleNotFoundErrors before our Win32 backend patches can take effect (observed:
# kwin_bridge.py -> `import dbus_fast`). Install a meta-path finder that fabricates a
# lazy stub for any of those roots and their submodules, so the imports succeed. The
# Win32 backend is monkeypatched over the primitives that actually run, so these stubs
# are import-satisfiers only — never edited under computer-use/.
if sys.platform == "win32":
    import importlib.abc as _ilabc
    import importlib.machinery as _ilmach
    import types as _types

    _LINUX_ONLY_ROOTS = {
        "dbus_fast", "evdev", "pywayland", "pydbus", "gi", "Xlib", "uinput",
        "dbus_next", "jeepney",
    }

    def _is_dunder(name):
        return name.startswith("__") and name.endswith("__")

    # A stub that works in every way the engine's Linux modules use these symbols:
    # as a class (used as a base, e.g. `class X(dbus_fast.service.ServiceInterface)`),
    # as a constructor (`MessageBus(...)`), as a decorator factory (`@method()`), and
    # as an attribute chain (`dbus_fast.aio.MessageBus`). The metaclass routes
    # attribute access to fresh stub classes and makes `Stub(callable)` a no-op
    # decorator passthrough; instances accept any __init__ args (for super().__init__).
    class _StubMeta(type):
        def __getattr__(cls, name):
            if _is_dunder(name):
                raise AttributeError(name)
            return _stub_class(f"{cls.__name__}.{name}")

        def __call__(cls, *a, **k):
            if len(a) == 1 and callable(a[0]) and not k:  # @decorator() -> fn
                return a[0]
            return super().__call__(*a, **k)

    def _inst_init(self, *a, **k):
        pass

    def _inst_getattr(self, name):
        if _is_dunder(name):
            raise AttributeError(name)
        return _stub_class(name)

    def _inst_call(self, *a, **k):
        if len(a) == 1 and callable(a[0]) and not k:
            return a[0]
        return _stub_class("stub")()

    def _stub_class(name):
        return _StubMeta(name, (), {
            "__init__": _inst_init,
            "__getattr__": _inst_getattr,
            "__call__": _inst_call,
        })

    class _StubModule(_types.ModuleType):
        __path__: list = []  # marks it as a package so submodule imports proceed

        def __getattr__(self, name):
            if _is_dunder(name):
                raise AttributeError(name)
            return _stub_class(f"{self.__name__}.{name}")

    class _StubFinder(_ilabc.MetaPathFinder, _ilabc.Loader):
        def find_spec(self, fullname, path=None, target=None):
            if fullname.split(".")[0] in _LINUX_ONLY_ROOTS:
                return _ilmach.ModuleSpec(fullname, self, is_package=True)
            return None

        def create_module(self, spec):
            return _StubModule(spec.name)

        def exec_module(self, module):
            pass

    sys.meta_path.insert(0, _StubFinder())

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


# ── Windows fix: the live-widget supervisor is written for Linux ─────────────
# computer_use_mcp.live_widgets.ensure_supervisor() (run from the server's
# lifespan startup) spawns a detached child with
#   subprocess.Popen([sys.executable, "-m", "computer_use_mcp.live_widgets",
#                     "--supervise"], start_new_session=True)
# Two Linux-isms break a FROZEN Windows build, and the engine never stays up:
#   1. sys.executable is THIS engine .exe (not a Python interpreter), so the
#      "-m computer_use_mcp.live_widgets" form re-launches a whole SECOND ENGINE
#      instead of the supervisor module.
#   2. start_new_session=True is a POSIX no-op on Windows, so that child stays in
#      the engine's CONSOLE PROCESS GROUP. When the child starts/exits, a
#      Ctrl-C / Ctrl-Break console event is delivered to the WHOLE group, and
#      uvicorn's signal handler shuts the PARENT engine down — a graceful exit 0
#      one breath after "Uvicorn running on 0.0.0.0:8794". (Verified: the engine
#      survives only when fully isolated from a console.)
# Also live_widgets._alive() probes with os.kill(pid, 0), which on Windows
# TERMINATES the target process instead of checking it.
#
# Fix (Windows-only, no edits under computer-use/): rebind both to Windows-correct
# versions. The supervisor is relaunched from THIS exe with a "--supervise" flag
# (handled in main() below) using DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, so
# it has no console and its own group and can never signal the engine. Liveness
# is probed with OpenProcess + GetExitCodeProcess.
if sys.platform == "win32":
    import ctypes as _ct
    import subprocess as _sp

    from computer_use_mcp import live_widgets as _lw

    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _STILL_ACTIVE = 259
    # DETACHED_PROCESS (no console) | CREATE_NEW_PROCESS_GROUP (own ctrl group).
    _DETACHED_NEW_GROUP = 0x00000008 | 0x00000200

    def _win_alive(pid: int) -> bool:
        if not pid:
            return False
        k32 = _ct.windll.kernel32
        handle = k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            code = _ct.c_ulong()
            if not k32.GetExitCodeProcess(handle, _ct.byref(code)):
                return False
            return code.value == _STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)

    def _win_ensure_supervisor() -> int:
        """Windows port of ensure_supervisor(): spawn the supervisor as a fully
        DETACHED child of this frozen exe (own console group, no shared console)
        so it can never console-signal the engine. Idempotent via the pid-file."""
        try:
            pf = _lw._supervisor_pidfile()
            pf.parent.mkdir(parents=True, exist_ok=True)
            pid = _lw._read_pid(pf)
            if pid and _win_alive(pid):
                return pid
            proc = _sp.Popen(
                [sys.executable, "--supervise"],
                stdin=_sp.DEVNULL, stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
                creationflags=_DETACHED_NEW_GROUP, close_fds=True,
            )
            try:
                pf.write_text(str(proc.pid), encoding="utf-8")
            except OSError:
                pass
            return proc.pid
        except Exception:
            return 0

    _lw._alive = _win_alive
    _lw.ensure_supervisor = _win_ensure_supervisor


def main() -> None:
    # Windows supervisor mode: _win_ensure_supervisor() (above) relaunches THIS
    # exe with "--supervise"; run the live-widget supervisor loop, not the server.
    if "--supervise" in sys.argv[1:]:
        from computer_use_mcp import live_widgets as _lw
        _lw._supervise_loop()
        return
    # Import the heavy server lazily (after patching) so merely importing this
    # module for tests doesn't pull in uvicorn/fastapi/the full tool surface.
    from computer_use_mcp.server import main as _engine_main
    _engine_main()


if __name__ == "__main__":
    main()
