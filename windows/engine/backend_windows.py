"""Windows (Win32) backend for the Jarvis computer-use engine.

SECOND-PRIORITY, FULLY ISOLATED. Nothing under ``computer-use/`` is edited:
``windows/engine/server_windows.py`` monkeypatches the functions in this module
onto the engine's ``input`` / ``screen`` / ``session`` modules at startup, so the
unchanged engine routes every primitive here when run on Windows.

Mechanism per primitive:
  * mouse  -> Win32 ``SendInput`` (ctypes) with absolute coordinates normalised
    0..65535 over the VIRTUAL screen; wheel via ``MOUSEEVENTF_WHEEL`` (delta 120).
  * keyboard -> ``SendInput`` with a VK-code table (Windows analogue of
    ``input._KEY_CODES``) for combos, and ``KEYEVENTF_UNICODE`` for text (full
    Unicode, no clipboard dependency).
  * screen -> ``mss`` + Pillow, reusing the engine's downscale/crop contract and
    setting ``screen.LAST_SHOT`` so the UNCHANGED ``screen.map_to_desktop`` keeps
    working.
  * session -> a single ``SessionInfo(kind="windows")`` whose monitors come from
    ``mss`` (EnumDisplayMonitors under the hood).

ctypes / pywin32 / mss are imported LAZILY inside functions and guarded by
``sys.platform == 'win32'`` so ``import backend_windows`` succeeds on Linux (for
the test-suite) with no Win32 present. The engine dataclasses
(``SessionInfo`` / ``Output``) and the OS-agnostic ``screen.map_to_desktop`` /
``screen.Rect`` / ``screen.LAST_SHOT`` are imported from the engine and reused
verbatim -- imported, never modified.

Windows v2 -- the isolated "beside-you" agent desktop (see windows/isolation/):
  * ``which='agent'`` is the agent's OWN isolated Windows desktop (a Windows
    Sandbox / RDP child session / Hyper-V guest), NOT the user's real screen.
    The engine runs INSIDE that isolated desktop, so its ``SendInput`` injection
    and ``mss`` capture are scoped to it by the OS boundary -- the Windows
    realization of Linux's nested-Sway seat. The engine signals "I am the
    in-sandbox instance" via the env flag ``JARVIS_AGENT_INSANDBOX=1`` (set by
    ``bootstrap.ps1`` inside the box). With it set, ``get_session('agent')``
    returns THIS desktop (``detect()['active']``-equivalent); without it the
    'agent' session raises (v1 = host drives the real screen via take-over).
  * KWin multi-seat (the agent's own cursor/keyboard seat) stays Linux-only --
    on Windows the seat isolation comes from the Sandbox/session/VM boundary.
"""

from __future__ import annotations

import io
import os
import sys
import time

# Engine modules: imported (never modified). map_to_desktop / Rect / LAST_SHOT /
# the _LOCK and the SessionInfo/Output dataclasses are all OS-agnostic and reused.
# agent_bus is the pointer-event bus (~/.local/share/jarvis/agent_pointer.jsonl)
# the desktop sidebar tails to auto-arm the "Jarvis is using your computer"
# banner + glowing cursor overlay -- pure stdlib, safe to reuse verbatim here.
from computer_use_mcp import agent_bus as _agent_bus
from computer_use_mcp import screen as _screen
from computer_use_mcp import session as _session
from computer_use_mcp.config import load_config

SessionInfo = _session.SessionInfo
Output = _session.Output

ABS_MAX = 65535
WHEEL_DELTA = 120

_BUTTONS = ("left", "right", "middle")


# ---------------------------------------------------------------------------
# Virtual-key table  (Windows analogue of computer_use_mcp.input._KEY_CODES)
#
# Pure data -- importable on Linux. Must cover EVERY key name that
# input._resolve_combo accepts (asserted by the test-suite).
# ---------------------------------------------------------------------------
_VK_CODES: dict[str, int] = {
    # modifiers
    "ctrl": 0x11, "control": 0x11, "rightctrl": 0xA3,
    "shift": 0x10, "rightshift": 0xA1,
    "alt": 0x12, "rightalt": 0xA5, "altgr": 0xA5,
    "meta": 0x5B, "super": 0x5B, "win": 0x5B, "cmd": 0x5B, "rightmeta": 0x5C,
    # editing / navigation
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "backspace": 0x08,
    "escape": 0x1B, "esc": 0x1B, "space": 0x20, "capslock": 0x14,
    "delete": 0x2E, "del": 0x2E, "insert": 0x2D, "ins": 0x2D,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pgup": 0x21, "pagedown": 0x22, "pgdn": 0x22,
    # OEM punctuation (US layout)
    "minus": 0xBD, "equal": 0xBB, "leftbrace": 0xDB, "rightbrace": 0xDD,
    "semicolon": 0xBA, "apostrophe": 0xDE, "grave": 0xC0, "backslash": 0xDC,
    "comma": 0xBC, "dot": 0xBE, "period": 0xBE, "slash": 0xBF,
    "printscreen": 0x2C, "sysrq": 0x2C, "scrolllock": 0x91, "pause": 0x13,
    "menu": 0x5D,
    # keypad
    "kp0": 0x60, "kp1": 0x61, "kp2": 0x62, "kp3": 0x63, "kp4": 0x64,
    "kp5": 0x65, "kp6": 0x66, "kp7": 0x67, "kp8": 0x68, "kp9": 0x69,
    "kpenter": 0x0D, "kpplus": 0x6B, "kpminus": 0x6D, "kpasterisk": 0x6A,
    "kpslash": 0x6F, "kpdot": 0x6E,
}
# letters a-z -> VK 0x41..0x5A
_VK_CODES.update({ch: 0x41 + i for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz")})
# digits 0-9 -> VK 0x30..0x39
_VK_CODES.update({ch: 0x30 + int(ch) for ch in "0123456789"})
# function keys f1..f24 -> VK 0x70..0x87
_VK_CODES.update({f"f{i}": 0x70 + (i - 1) for i in range(1, 25)})

# Keys that must carry KEYEVENTF_EXTENDEDKEY for correct behaviour.
_EXTENDED_VKS: frozenset[int] = frozenset({
    0xA3,  # right ctrl
    0xA5,  # right alt / altgr
    0x5B, 0x5C, 0x5D,  # lwin / rwin / apps(menu)
    0x2E, 0x2D,  # delete / insert
    0x26, 0x28, 0x25, 0x27,  # arrows
    0x24, 0x23,  # home / end
    0x21, 0x22,  # pageup / pagedown
    0x2C,  # printscreen
    0x90, 0x91,  # numlock / scrolllock
    0x6F,  # numpad divide
    # NB: numpad-enter shares VK_RETURN; the extended flag distinguishes it, but
    # we keep plain Return non-extended (the common case).
})


# ---------------------------------------------------------------------------
# Lazy Win32 layer (ctypes). Only touched on Windows.
# ---------------------------------------------------------------------------
_WIN = None


def _winapi():
    """Build & cache the ctypes SendInput layer. Raises on non-Windows."""
    global _WIN
    if _WIN is not None:
        return _WIN
    if sys.platform != "win32":
        raise RuntimeError(
            "The Windows input backend requires Windows (sys.platform=='win32')."
        )
    import ctypes
    from ctypes import wintypes
    from types import SimpleNamespace

    ULONG_PTR = ctypes.POINTER(ctypes.c_ulong)

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", ctypes.c_long),
            ("dy", ctypes.c_long),
            ("mouseData", ctypes.c_ulong),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", ctypes.c_ushort),
            ("wScan", ctypes.c_ushort),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", ctypes.c_ulong),
            ("wParamL", ctypes.c_short),
            ("wParamH", ctypes.c_ushort),
        ]

    class _INPUTunion(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", ctypes.c_ulong), ("u", _INPUTunion)]

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
    user32.SendInput.restype = wintypes.UINT
    user32.GetSystemMetrics.argtypes = (ctypes.c_int,)
    user32.GetSystemMetrics.restype = ctypes.c_int
    user32.GetCursorPos.argtypes = (ctypes.POINTER(POINT),)
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.SetCursorPos.argtypes = (ctypes.c_int, ctypes.c_int)
    user32.SetCursorPos.restype = wintypes.BOOL

    _WIN = SimpleNamespace(
        ctypes=ctypes, user32=user32,
        MOUSEINPUT=MOUSEINPUT, KEYBDINPUT=KEYBDINPUT, INPUT=INPUT, POINT=POINT,
        # constants
        INPUT_MOUSE=0, INPUT_KEYBOARD=1,
        MOUSEEVENTF_MOVE=0x0001,
        MOUSEEVENTF_LEFTDOWN=0x0002, MOUSEEVENTF_LEFTUP=0x0004,
        MOUSEEVENTF_RIGHTDOWN=0x0008, MOUSEEVENTF_RIGHTUP=0x0010,
        MOUSEEVENTF_MIDDLEDOWN=0x0020, MOUSEEVENTF_MIDDLEUP=0x0040,
        MOUSEEVENTF_WHEEL=0x0800, MOUSEEVENTF_HWHEEL=0x1000,
        MOUSEEVENTF_ABSOLUTE=0x8000, MOUSEEVENTF_VIRTUALDESK=0x4000,
        KEYEVENTF_EXTENDEDKEY=0x0001, KEYEVENTF_KEYUP=0x0002,
        KEYEVENTF_UNICODE=0x0004, KEYEVENTF_SCANCODE=0x0008,
        SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77,
        SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79,
    )
    return _WIN


_BUTTON_FLAGS = {
    "left": ("MOUSEEVENTF_LEFTDOWN", "MOUSEEVENTF_LEFTUP"),
    "right": ("MOUSEEVENTF_RIGHTDOWN", "MOUSEEVENTF_RIGHTUP"),
    "middle": ("MOUSEEVENTF_MIDDLEDOWN", "MOUSEEVENTF_MIDDLEUP"),
}


def _pointer_session(which: str) -> str:
    """Windows analogue of computer_use_mcp.input._is_agent: tag bus events
    'agent' only for the isolated in-sandbox desktop (v2), 'real' for every
    ordinary v1 call -- which drives the user's actual screen -- so the
    take-over banner/glow auto-arms exactly like the Linux real-screen path."""
    return "agent" if which == "agent" else "real"


def _virtual_screen() -> tuple[int, int, int, int]:
    """(x, y, w, h) of the bounding VIRTUAL screen, via GetSystemMetrics."""
    w = _winapi()
    gsm = w.user32.GetSystemMetrics
    return (
        gsm(w.SM_XVIRTUALSCREEN), gsm(w.SM_YVIRTUALSCREEN),
        gsm(w.SM_CXVIRTUALSCREEN), gsm(w.SM_CYVIRTUALSCREEN),
    )


def _normalize_abs(gx: float, gy: float,
                   virt: tuple[int, int, int, int] | None = None) -> tuple[int, int]:
    """Desktop pixel -> absolute 0..65535 over the virtual screen.

    Pure math (the virtual rect can be passed in for testing without Win32).
    Maps the virtual-screen origin to 0 and its last pixel to ABS_MAX.
    """
    if virt is None:
        virt = _virtual_screen()
    vx, vy, vw, vh = virt
    nx = round((float(gx) - vx) * ABS_MAX / max(1, vw - 1))
    ny = round((float(gy) - vy) * ABS_MAX / max(1, vh - 1))
    return max(0, min(ABS_MAX, nx)), max(0, min(ABS_MAX, ny))


# ---------------------------------------------------------------------------
# SendInput builders / emit
# ---------------------------------------------------------------------------
def _mouse_input(dx: int, dy: int, data: int, flags: int):
    w = _winapi()
    mi = w.MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, None)
    inp = w.INPUT()
    inp.type = w.INPUT_MOUSE
    inp.u.mi = mi
    return inp


def _key_input(vk: int, *, up: bool = False, extended: bool = False,
               scan: int = 0, unicode: bool = False):
    w = _winapi()
    flags = 0
    if unicode:
        flags |= w.KEYEVENTF_UNICODE
        wvk = 0
        wscan = scan
    else:
        wvk = vk
        wscan = 0
        if extended:
            flags |= w.KEYEVENTF_EXTENDEDKEY
    if up:
        flags |= w.KEYEVENTF_KEYUP
    ki = w.KEYBDINPUT(wvk, wscan, flags, 0, None)
    inp = w.INPUT()
    inp.type = w.INPUT_KEYBOARD
    inp.u.ki = ki
    return inp


def _send(*inputs) -> None:
    w = _winapi()
    n = len(inputs)
    if n == 0:
        return
    arr = (w.INPUT * n)(*inputs)
    sent = w.user32.SendInput(n, arr, w.ctypes.sizeof(w.INPUT))
    if sent != n:
        err = w.ctypes.get_last_error()
        raise RuntimeError(f"SendInput injected {sent}/{n} events (GetLastError={err})")


def _cursor_pos() -> tuple[int, int] | None:
    """Read back the real OS cursor position (GetCursorPos), or None if the
    call fails (e.g. off-Windows / no desktop)."""
    w = _winapi()
    pt = w.POINT()
    if not w.user32.GetCursorPos(w.ctypes.byref(pt)):
        return None
    return int(pt.x), int(pt.y)


def _mouse_move_abs(gx: int, gy: int) -> None:
    w = _winapi()
    nx, ny = _normalize_abs(gx, gy)
    flags = w.MOUSEEVENTF_MOVE | w.MOUSEEVENTF_ABSOLUTE | w.MOUSEEVENTF_VIRTUALDESK
    _send(_mouse_input(nx, ny, 0, flags))
    # SendInput can report success (all events injected, GetLastError=0) while
    # the cursor never actually moves -- observed live on a field machine, root
    # cause unconfirmed (input-filter driver / UIPI edge case / similar). A
    # swallowed move is dangerous here specifically because click()/drag() fire
    # their button-down/up as a SEPARATE, zero-relative SendInput call that
    # lands wherever the cursor CURRENTLY is -- so a silently-missed move makes
    # the click land at the last real position instead of the intended one
    # (exactly the "clicks land somewhere else" failure mode). Verify against
    # GetCursorPos and fall back to SetCursorPos, a different kernel path, so a
    # miss here doesn't propagate into a wrong-target click.
    pos = _cursor_pos()
    if pos is not None and (abs(pos[0] - gx) > 2 or abs(pos[1] - gy) > 2):
        w.user32.SetCursorPos(int(gx), int(gy))


# ---------------------------------------------------------------------------
# Mouse  (public signatures mirror computer_use_mcp.input)
# ---------------------------------------------------------------------------
def move(x: float, y: float, coord_space: str = "image",
         which: str = "active") -> tuple[int, int]:
    gx, gy = _screen.map_to_desktop(x, y, coord_space, which)
    _mouse_move_abs(gx, gy)
    # Publish the GLOBAL desktop position so the desktop sidebar's distinct-
    # cursor overlay (WindowController.showOverlay) auto-arms and tracks it --
    # the Windows analogue of computer_use_mcp.input.move's agent_bus.publish.
    _agent_bus.publish(gx, gy, kind="move", session=_pointer_session(which))
    return gx, gy


def click(x: float | None = None, y: float | None = None, button: str = "left",
          double: bool = False, coord_space: str = "image",
          which: str = "active") -> dict:
    if button not in _BUTTON_FLAGS:
        raise ValueError(f"button must be one of {list(_BUTTONS)}")
    pos = None
    if x is not None and y is not None:
        pos = move(x, y, coord_space, which)
        time.sleep(0.06)
    w = _winapi()
    down, up = (getattr(w, n) for n in _BUTTON_FLAGS[button])
    for i in range(2 if double else 1):
        _send(_mouse_input(0, 0, 0, down))
        time.sleep(0.04)
        _send(_mouse_input(0, 0, 0, up))
        if double and i == 0:
            time.sleep(0.12)
    if pos is not None:
        _agent_bus.publish(pos[0], pos[1], button=button, kind="click",
                           session=_pointer_session(which))
    return {"clicked": button, "double": double, "desktop_pos": pos}


def drag(x1: float, y1: float, x2: float, y2: float, button: str = "left",
         coord_space: str = "image", steps: int = 14,
         which: str = "active") -> dict:
    if button not in _BUTTON_FLAGS:
        raise ValueError(f"button must be one of {list(_BUTTONS)}")
    g1 = _screen.map_to_desktop(x1, y1, coord_space, which)
    g2 = _screen.map_to_desktop(x2, y2, coord_space, which)
    w = _winapi()
    down, up = (getattr(w, n) for n in _BUTTON_FLAGS[button])
    session_tag = _pointer_session(which)
    _mouse_move_abs(*g1)
    _agent_bus.publish(g1[0], g1[1], button=button, kind="down", session=session_tag)
    time.sleep(0.1)
    _send(_mouse_input(0, 0, 0, down))
    try:
        for i in range(1, max(2, steps) + 1):
            t = i / steps
            px = round(g1[0] + (g2[0] - g1[0]) * t)
            py = round(g1[1] + (g2[1] - g1[1]) * t)
            _mouse_move_abs(px, py)
            _agent_bus.publish(px, py, button=button, kind="drag", session=session_tag)
            time.sleep(0.02)
    finally:
        time.sleep(0.1)
        _send(_mouse_input(0, 0, 0, up))
        _agent_bus.publish(g2[0], g2[1], button=button, kind="up", session=session_tag)
    return {"from": g1, "to": g2, "button": button}


def scroll(amount: int = 3, direction: str = "down",
           x: float | None = None, y: float | None = None,
           coord_space: str = "image", which: str = "active") -> dict:
    if direction not in ("up", "down", "left", "right"):
        raise ValueError("direction must be up/down/left/right")
    pos = None
    if x is not None and y is not None:
        pos = move(x, y, coord_space, which)
        time.sleep(0.06)
    amount = max(1, int(amount))
    invert = -1 if load_config()["scroll_invert"] else 1
    w = _winapi()
    horiz = direction in ("left", "right")
    if horiz:
        # MOUSEEVENTF_HWHEEL: +ve = right.
        sign = 1 if direction == "right" else -1
        flag = w.MOUSEEVENTF_HWHEEL
    else:
        # MOUSEEVENTF_WHEEL: +ve = forward/up.
        sign = 1 if direction == "up" else -1
        sign *= invert
        flag = w.MOUSEEVENTF_WHEEL
    for _ in range(amount):
        _send(_mouse_input(0, 0, sign * WHEEL_DELTA, flag))
        time.sleep(0.02)
    if pos is not None:
        _agent_bus.publish(pos[0], pos[1], button=direction, kind="scroll",
                           session=_pointer_session(which))
    return {"scrolled": direction, "notches": amount, "desktop_pos": pos}


# ---------------------------------------------------------------------------
# Keyboard  (public signatures mirror computer_use_mcp.input)
# ---------------------------------------------------------------------------
def _resolve_vk(keys: str) -> list[tuple[int, bool]]:
    """'ctrl+shift+t' -> [(0x11, ext), (0x10, ext), (0x54, ext), ...]."""
    parts = [k.strip().lower() for k in keys.split("+") if k.strip()]
    if not parts:
        raise ValueError("Empty key combo")
    out: list[tuple[int, bool]] = []
    for p in parts:
        vk = _VK_CODES.get(p)
        if vk is None:
            raise ValueError(
                f"Unknown key name {p!r}. Known: {', '.join(sorted(_VK_CODES))}"
            )
        out.append((vk, vk in _EXTENDED_VKS))
    return out


def key_press(combo: str, repeat: int = 1) -> dict:
    vks = _resolve_vk(combo)
    repeat = max(1, int(repeat))
    for r in range(repeat):
        events = [_key_input(vk, extended=ext) for vk, ext in vks]
        events += [_key_input(vk, up=True, extended=ext) for vk, ext in reversed(vks)]
        _send(*events)
        if r + 1 < repeat:
            time.sleep(0.03)
    return {"pressed": combo, "repeat": repeat}


def _utf16_units(ch: str) -> list[int]:
    b = ch.encode("utf-16-le")
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]


def type_text(text: str, method: str = "auto") -> dict:
    if method not in ("auto", "type", "paste"):
        raise ValueError("method must be auto/type/paste")
    w = _winapi()
    events = []
    for ch in text:
        if ch == "\r":
            continue  # \r\n -> single Return (handled by the \n below)
        if ch == "\n":
            events.append(_key_input(0x0D))
            events.append(_key_input(0x0D, up=True))
            continue
        if ch == "\t":
            events.append(_key_input(0x09))
            events.append(_key_input(0x09, up=True))
            continue
        for unit in _utf16_units(ch):
            events.append(_key_input(0, scan=unit, unicode=True))
            events.append(_key_input(0, scan=unit, up=True, unicode=True))
    if events:
        # One SendInput call keeps the keystrokes atomic / in order.
        _send(*events)
    # method is accepted for API parity; Windows always uses Unicode injection
    # (no clipboard-paste fallback is needed -- KEYEVENTF_UNICODE is full Unicode).
    return {"typed_chars": len(text), "method": "unicode"}


# ---------------------------------------------------------------------------
# Screen  (public signatures mirror computer_use_mcp.screen)
# ---------------------------------------------------------------------------
def _grab_region(rect):
    """Capture a virtual-desktop rect with mss -> PIL RGB Image."""
    from PIL import Image as PILImage
    import mss

    with mss.mss() as sct:
        raw = sct.grab({"left": rect.x, "top": rect.y,
                        "width": rect.w, "height": rect.h})
    return PILImage.frombytes("RGB", raw.size, raw.rgb)


def take_screenshot(output: str | None = None, region: dict | None = None,
                    max_width: int | None = None, include_cursor: bool = False,
                    which: str = "active") -> tuple[bytes, dict]:
    """Capture + downscale; returns (png_bytes, metadata). Mirrors the engine's
    contract and sets screen.LAST_SHOT so map_to_desktop keeps working."""
    from PIL import Image as PILImage

    info = get_session(which)
    if not info.outputs:
        raise RuntimeError(
            info.outputs_unavailable_reason
            or f"Session {info.kind} reports no outputs — cannot capture."
        )
    if max_width is None:
        max_width = int(load_config()["max_image_width"])

    bbox = info.bbox
    if output:
        out = next((o for o in info.outputs if o.name.lower() == output.lower()), None)
        if out is None:
            raise RuntimeError(
                f"Unknown output {output!r}. Available: {[o.name for o in info.outputs]}"
            )
        rect = _screen.Rect(out.x, out.y, out.w, out.h)
    elif region:
        rect = _screen.Rect(region["x"], region["y"], region["w"], region["h"])
    else:
        rect = _screen.Rect(bbox["x"], bbox["y"], bbox["w"], bbox["h"])

    img = _grab_region(rect)  # mss already returns exactly the requested rect

    native_w, native_h = img.size
    if max_width and native_w > max_width:
        img.thumbnail((max_width, 10_000_000), PILImage.LANCZOS)
    scaled_w, scaled_h = img.size

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png = buf.getvalue()

    scale = scaled_w / rect.w if rect.w else 1.0
    shot = {
        "origin": (rect.x, rect.y),
        "scale": scale,
        "session_kind": info.kind,
        "output": output,
        "image_w": scaled_w,
        "image_h": scaled_h,
        "taken_at": time.time(),
    }
    with _screen._LOCK:
        _screen.LAST_SHOT = shot

    meta = {
        "coord_space": "image",
        "note": "Coordinates measured on THIS image are accepted directly by "
                "mouse_move/mouse_click/mouse_drag/scroll (coord_space='image', the default).",
        "captured_rect": rect.as_dict(),
        "image_size": {"w": scaled_w, "h": scaled_h},
        "scale": round(scale, 5),
        "session": info.kind,
        "output": output,
        "include_cursor": include_cursor,  # mss has no cursor overlay; advisory only
        "outputs": [o.as_dict() for o in info.outputs],
    }
    return png, meta


def grab_jpeg_frame(which: str = "agent", *, width: int | None = None,
                    quality: int = 70, include_cursor: bool = False) -> bytes:
    """Single JPEG frame of the session (mss + Pillow).

    The default which='agent' resolves through ``get_session('agent')``: INSIDE
    the isolated agent desktop (``JARVIS_AGENT_INSANDBOX=1``) that is THIS
    desktop, so the daemon's /video/mjpeg pump (which defaults to which='agent')
    streams the agent box. OUTSIDE a sandbox 'agent' raises (Linux-only nested
    desktop); pass which='active' for the host's real screen."""
    from PIL import Image as PILImage

    info = get_session(which)
    if not info.outputs:
        raise RuntimeError(
            info.outputs_unavailable_reason
            or f"Session {info.kind} reports no outputs — cannot capture video."
        )
    bbox = info.bbox
    rect = _screen.Rect(bbox["x"], bbox["y"], bbox["w"], bbox["h"])
    img = _grab_region(rect)  # already RGB
    if width and img.width > width:
        img.thumbnail((width, 10_000_000), PILImage.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(quality))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Session  (public signatures mirror computer_use_mcp.session)
# ---------------------------------------------------------------------------
_SESSION_CACHE: tuple[float, dict] | None = None
_SESSION_TTL = 2.0


def _enumerate_monitors() -> list[Output]:
    """Monitors via mss (EnumDisplayMonitors under the hood)."""
    import mss

    outs: list[Output] = []
    with mss.mss() as sct:
        # monitors[0] is the bounding virtual screen; [1:] are the real displays.
        for i, m in enumerate(sct.monitors[1:], start=1):
            outs.append(Output(
                name=f"DISPLAY{i}",
                x=int(m["left"]), y=int(m["top"]),
                w=int(m["width"]), h=int(m["height"]),
                scale=1.0,
            ))
    return outs


def _build_windows_session() -> SessionInfo:
    info = SessionInfo(kind="windows", session_id="windows", active=True)
    try:
        info.outputs = _enumerate_monitors()
        if not info.outputs:
            info.outputs_unavailable_reason = "mss reported no displays."
    except Exception as exc:  # mss missing / display query failed
        info.outputs_unavailable_reason = f"monitor enumeration failed: {exc}"
    return info


def detect(refresh: bool = False) -> dict:
    """Return {"active": SessionInfo, "sessions": [SessionInfo]} (single session)."""
    global _SESSION_CACHE
    now = time.monotonic()
    if not refresh and _SESSION_CACHE and now - _SESSION_CACHE[0] < _SESSION_TTL:
        return _SESSION_CACHE[1]
    info = _build_windows_session()
    result = {"active": info, "sessions": [info]}
    _SESSION_CACHE = (now, result)
    return result


def in_sandbox() -> bool:
    """True when this engine runs INSIDE the isolated agent desktop.

    Set by ``windows/isolation/sandbox/bootstrap.ps1`` (env
    ``JARVIS_AGENT_INSANDBOX=1``) when the engine is launched inside a Windows
    Sandbox / RDP child session / Hyper-V guest. When true, the 'agent' session
    IS this desktop (the engine's SendInput + mss are scoped to it by the OS
    boundary). Truthy values: anything other than unset / "" / "0" / "false".
    """
    val = os.environ.get("JARVIS_AGENT_INSANDBOX", "").strip().lower()
    return val not in ("", "0", "false", "no", "off")


def get_session(which: str = "active") -> SessionInfo:
    """Resolve a session.

    Windows exposes ONE OS desktop per process ('windows'/'active'). 'agent' is
    the isolated "beside-you" co-worker desktop:

      * INSIDE the isolated desktop (``JARVIS_AGENT_INSANDBOX=1``) the 'agent'
        session IS this desktop -- return ``detect()['active']``-equivalent. The
        engine's SendInput/mss hit only this box (Sandbox/session/VM boundary),
        so input isolation is a property of the OS, not a cursor trick. This is
        what the daemon's /video/mjpeg pump (default which='agent') and the
        which='agent' tools target.
      * OUTSIDE a sandbox (the host engine, v1) 'agent' raises -- the nested
        headless desktop is Linux-only; the host drives the real screen via the
        take-over path (which='active').
    """
    if which == "agent":
        if in_sandbox():
            return detect()["active"]
        raise RuntimeError(
            "The 'agent' desktop requires the isolated Windows agent box "
            "(JARVIS_AGENT_INSANDBOX): the engine must run INSIDE a Windows "
            "Sandbox / RDP child session / Hyper-V guest (see windows/isolation). "
            "On the host engine only the real-screen 'windows'/'active' session "
            "exists (v1 take-over)."
        )
    if which in ("active", "windows"):
        return detect()["active"]
    raise RuntimeError(
        f"Session {which!r} not available on Windows (only 'windows'/'active' exists)."
    )


def compositor_hint() -> str:
    """Cheap active-compositor hint (the Windows analogue of the engine's)."""
    return "windows"
