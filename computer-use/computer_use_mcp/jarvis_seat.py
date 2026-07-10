"""Drive KWin's INDEPENDENT "jarvis" seat (the forked KWin's
org.kde.KWin.JarvisSeat DBus iface) so the agent acts on the REAL KDE screen with
its OWN pointer + keyboard focus — no mixing with the user's seat0.

Available ONLY when the forked KWin (multi-seat) is the running compositor. On
stock KWin the iface is absent and `available()` is False, so input.py falls back
to the shared-seat uinput path. Uses `qdbus` (type-coercing via introspection)
with a `gdbus` fallback; no python dbus dependency.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
import time

_SVC = "org.kde.KWin"
_OBJ = "/JarvisSeat"
_IFACE = "org.kde.KWin.JarvisSeat"

# Negative probes are retried after this long. Positives stick for the engine's
# lifetime (the fork IS the session compositor — it doesn't go away mid-session).
_PROBE_TTL = 30.0

_available = False
_next_probe = 0.0
# Engine tool handlers run on real threads (asyncio.to_thread); single-flight
# the probe so concurrent input ops don't spawn duplicate qdbus subprocesses.
_probe_lock = threading.Lock()


_qdbus_bin_found: str | None = None


def _qdbus_bin() -> str | None:
    # Cache only a FOUND binary (PATH lookups are cheap; caching a miss would
    # poison every future probe if qdbus gets installed later).
    global _qdbus_bin_found
    if _qdbus_bin_found is None:
        for b in ("qdbus6", "qdbus-qt6", "qdbus"):
            if shutil.which(b):
                _qdbus_bin_found = b
                break
    return _qdbus_bin_found


def _probe() -> bool:
    qb = _qdbus_bin()
    try:
        if qb:
            r = subprocess.run([qb, _SVC, _OBJ], capture_output=True, timeout=3)
            return r.returncode == 0 and b"movePointer" in r.stdout
        if shutil.which("gdbus"):
            r = subprocess.run(["gdbus", "introspect", "--session", "-d", _SVC,
                                "-o", _OBJ], capture_output=True, timeout=3)
            return r.returncode == 0 and b"JarvisSeat" in r.stdout
    except Exception:  # noqa: BLE001
        return False
    return False


def available() -> bool:
    """True iff the forked KWin is running and exposes the JarvisSeat iface.

    A negative result is re-probed after _PROBE_TTL rather than cached forever:
    the engine can start before the forked KWin registers the iface (cold boot,
    relogin), and permanently caching that one failed probe would silently exile
    all real-screen input to the shared-seat uinput/ydotool path — exactly the
    user/agent input mixing the jarvis seat exists to prevent.
    """
    global _available, _next_probe
    if _available:
        return True
    # Single-flight without queueing: if another thread is already probing,
    # answer from the cache immediately (input falls through to the shared-seat
    # path for that one op) rather than stalling behind a up-to-3s subprocess.
    if not _probe_lock.acquire(blocking=False):
        return _available
    try:
        if _available:
            return True
        now = time.monotonic()
        if now < _next_probe:
            return False
        _available = _probe()
        if not _available:
            _next_probe = now + _PROBE_TTL
        return _available
    finally:
        _probe_lock.release()


def _call(method: str, *args) -> None:
    qb = _qdbus_bin()
    try:
        if qb:
            subprocess.run([qb, _SVC, _OBJ, f"{_IFACE}.{method}",
                            *[str(a) for a in args]],
                           capture_output=True, timeout=4)
        elif shutil.which("gdbus"):
            subprocess.run(["gdbus", "call", "--session", "-d", _SVC, "-o", _OBJ,
                            "-m", f"{_IFACE}.{method}", *[str(a) for a in args]],
                           capture_output=True, timeout=4)
    except Exception:  # noqa: BLE001 — never break the input path
        pass


# Qt::MouseButton values
_QT_BUTTON = {"left": 1, "right": 2, "middle": 4}


def move(gx: float, gy: float) -> None:
    _call("movePointer", float(gx), float(gy))


def button(name: str, pressed: bool) -> None:
    _call("pointerButton", _QT_BUTTON.get(name, 1), "true" if pressed else "false")


def click(name: str, gx: float, gy: float) -> None:
    """ATOMIC click at global (gx,gy): one DBus call re-focuses the surface there
    and does motion+press+release together. Reliable where separate move+press+
    release raced and dropped the click (the ~95%-fail desktop bug)."""
    _call("pointerClick", float(gx), float(gy), _QT_BUTTON.get(name, 1))


def key(evdev_code: int, pressed: bool) -> None:
    """evdev_code = Linux keycode (e.g. KEY_A = 30)."""
    _call("key", int(evdev_code), "true" if pressed else "false")


def axis(orientation: int, delta: float, v120: int) -> None:
    """Scroll on the jarvis seat. orientation: 0=vertical, 1=horizontal.
    delta = logical px (+ve down/right); v120 = discrete wheel steps * 120."""
    _call("pointerAxis", int(orientation), float(delta), int(v120))


def combo(resolved: list[str]) -> None:
    """Send a resolved combo like ['29:1','20:1','20:0','29:0'] (CODE:STATE) to the
    jarvis seat — each is an evdev keycode + press(1)/release(0)."""
    for item in resolved:
        code, _, state = item.partition(":")
        key(int(code), state == "1")


# US-layout ASCII -> (evdev keycode, needs_shift). Linux input-event-codes.
_LSHIFT = 42
_BASE = {
    "a": 30, "b": 48, "c": 46, "d": 32, "e": 18, "f": 33, "g": 34, "h": 35,
    "i": 23, "j": 36, "k": 37, "l": 38, "m": 50, "n": 49, "o": 24, "p": 25,
    "q": 16, "r": 19, "s": 31, "t": 20, "u": 22, "v": 47, "w": 17, "x": 45,
    "y": 21, "z": 44,
    "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10,
    "0": 11, "-": 12, "=": 13, "[": 26, "]": 27, "\\": 43, ";": 39, "'": 40,
    "`": 41, ",": 51, ".": 52, "/": 53, " ": 57, "\t": 15, "\n": 28,
}
_SHIFTED = {
    "A": 30, "B": 48, "C": 46, "D": 32, "E": 18, "F": 33, "G": 34, "H": 35,
    "I": 23, "J": 36, "K": 37, "L": 38, "M": 50, "N": 49, "O": 24, "P": 25,
    "Q": 16, "R": 19, "S": 31, "T": 20, "U": 22, "V": 47, "W": 17, "X": 45,
    "Y": 21, "Z": 44,
    "!": 2, "@": 3, "#": 4, "$": 5, "%": 6, "^": 7, "&": 8, "*": 9, "(": 10,
    ")": 11, "_": 12, "+": 13, "{": 26, "}": 27, "|": 43, ":": 39, '"': 40,
    "~": 41, "<": 51, ">": 52, "?": 53,
}


def type_text(text: str) -> int:
    """Type `text` into the jarvis-seat-focused window, char by char (US layout),
    holding Shift for uppercase/symbols. Returns chars handled."""
    n = 0
    for ch in text:
        if ch in _BASE:
            key(_BASE[ch], True)
            key(_BASE[ch], False)
            n += 1
        elif ch in _SHIFTED:
            key(_LSHIFT, True)
            key(_SHIFTED[ch], True)
            key(_SHIFTED[ch], False)
            key(_LSHIFT, False)
            n += 1
        # else: unsupported char (non-US) — skip (caller can clipboard-paste).
    return n
