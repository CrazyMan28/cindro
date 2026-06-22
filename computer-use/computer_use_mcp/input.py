"""Mouse via a virtual ABSOLUTE pointer device (uinput/evdev); keyboard via ydotool.

Why not ydotool for the mouse: its device is relative-only, so `mousemove
--absolute` is emulated (giant relative pin + relative move). On this KDE that
breaks twice — libinput acceleration scales the deltas (~2x) and Plasma's
screen-edge barriers eat single-event motion at monitor boundaries, pinning
the cursor at output corners. A uinput device with ABS_X/ABS_Y (what VM mice
use) is mapped by both KWin and sway onto the whole desktop with no
acceleration and no barriers — verified pixel-exact on all 3 monitors.

Keyboard stays on ydotool (`type` has a built-in ASCII keymap, `key` takes
raw input-event codes); key events have none of the pointer pathologies.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time

from computer_use_mcp import clipboard, screen, session
from computer_use_mcp.config import load_config

ABS_MAX = 65535

# Linux input-event key codes (extends the table from the older adapter).
_KEY_CODES: dict[str, int] = {
    "ctrl": 29, "control": 29, "rightctrl": 97,
    "shift": 42, "rightshift": 54,
    "alt": 56, "rightalt": 100, "altgr": 100,
    "meta": 125, "super": 125, "win": 125, "cmd": 125, "rightmeta": 126,
    "enter": 28, "return": 28, "tab": 15, "backspace": 14,
    "escape": 1, "esc": 1, "space": 57, "capslock": 58,
    "delete": 111, "del": 111, "insert": 110, "ins": 110,
    "up": 103, "down": 108, "left": 105, "right": 106,
    "home": 102, "end": 107,
    "pageup": 104, "pgup": 104, "pagedown": 109, "pgdn": 109,
    "minus": 12, "equal": 13, "leftbrace": 26, "rightbrace": 27,
    "semicolon": 39, "apostrophe": 40, "grave": 41, "backslash": 43,
    "comma": 51, "dot": 52, "period": 52, "slash": 53,
    "printscreen": 99, "sysrq": 99, "scrolllock": 70, "pause": 119, "menu": 127,
    "kp0": 82, "kp1": 79, "kp2": 80, "kp3": 81, "kp4": 75, "kp5": 76,
    "kp6": 77, "kp7": 71, "kp8": 72, "kp9": 73, "kpenter": 96,
    "kpplus": 78, "kpminus": 74, "kpasterisk": 55, "kpslash": 98, "kpdot": 83,
}
_KEY_CODES.update({ch: code for ch, code in zip(
    "abcdefghijklmnopqrstuvwxyz",
    [30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38,
     50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44],
)})
_KEY_CODES.update({ch: code for ch, code in zip("1234567890", range(2, 12))})
_KEY_CODES.update({f"f{i}": code for i, code in zip(range(1, 13),
    [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88])})
_KEY_CODES.update({f"f{i}": code for i, code in zip(range(13, 25), range(183, 195))})


# -- virtual pointer -----------------------------------------------------------

_POINTER = None
_POINTER_LOCK = threading.Lock()
_BUTTONS = {"left": "BTN_LEFT", "right": "BTN_RIGHT", "middle": "BTN_MIDDLE"}


def _pointer():
    """Lazily create the virtual absolute pointer (kept open for the server's
    lifetime so compositors don't re-enumerate it on every call)."""
    global _POINTER
    with _POINTER_LOCK:
        if _POINTER is None:
            try:
                from evdev import AbsInfo, UInput, ecodes as e
            except ImportError as exc:
                raise RuntimeError(f"python-evdev missing: {exc}") from exc
            try:
                _POINTER = UInput(
                    {
                        e.EV_ABS: [
                            (e.ABS_X, AbsInfo(0, 0, ABS_MAX, 0, 0, 0)),
                            (e.ABS_Y, AbsInfo(0, 0, ABS_MAX, 0, 0, 0)),
                        ],
                        e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE],
                        e.EV_REL: [e.REL_WHEEL, e.REL_HWHEEL],
                    },
                    name="computer-use-pointer",
                    vendor=0x1234, product=0x5678,
                )
            except PermissionError as exc:
                raise RuntimeError(
                    f"/dev/uinput not writable ({exc}) — the install step grants an "
                    "ACL: sudo setfacl -m u:$USER:rw /dev/uinput"
                ) from exc
            time.sleep(0.6)  # let libinput/the compositor enumerate the device
        return _POINTER


def _emit_abs(gx: int, gy: int) -> None:
    from evdev import ecodes as e
    active = session.get_session("active")
    bbox = active.bbox
    if bbox is None:
        raise RuntimeError("Active session reports no outputs — cannot position mouse.")
    ax = round((gx - bbox["x"]) / max(1, bbox["w"] - 1) * ABS_MAX)
    ay = round((gy - bbox["y"]) / max(1, bbox["h"] - 1) * ABS_MAX)
    ui = _pointer()
    ui.write(e.EV_ABS, e.ABS_X, max(0, min(ABS_MAX, ax)))
    ui.write(e.EV_ABS, e.ABS_Y, max(0, min(ABS_MAX, ay)))
    ui.syn()


def _emit_button(button: str, value: int) -> None:
    from evdev import ecodes as e
    ui = _pointer()
    ui.write(e.EV_KEY, getattr(e, _BUTTONS[button]), value)
    ui.syn()


def move(x: float, y: float, coord_space: str = "image") -> tuple[int, int]:
    gx, gy = screen.map_to_desktop(x, y, coord_space)
    _emit_abs(gx, gy)
    return gx, gy


def click(x: float | None = None, y: float | None = None, button: str = "left",
          double: bool = False, coord_space: str = "image") -> dict:
    if button not in _BUTTONS:
        raise ValueError(f"button must be one of {list(_BUTTONS)}")
    pos = None
    if x is not None and y is not None:
        pos = move(x, y, coord_space)
        time.sleep(0.06)
    for i in range(2 if double else 1):
        _emit_button(button, 1)
        time.sleep(0.04)
        _emit_button(button, 0)
        if double and i == 0:
            time.sleep(0.12)
    return {"clicked": button, "double": double, "desktop_pos": pos}


def drag(x1: float, y1: float, x2: float, y2: float, button: str = "left",
         coord_space: str = "image", steps: int = 14) -> dict:
    if button not in _BUTTONS:
        raise ValueError(f"button must be one of {list(_BUTTONS)}")
    g1 = screen.map_to_desktop(x1, y1, coord_space)
    g2 = screen.map_to_desktop(x2, y2, coord_space)
    _emit_abs(*g1)
    time.sleep(0.1)
    _emit_button(button, 1)
    try:
        # DnD grab thresholds need motion while the button is held.
        for i in range(1, max(2, steps) + 1):
            t = i / steps
            _emit_abs(round(g1[0] + (g2[0] - g1[0]) * t),
                      round(g1[1] + (g2[1] - g1[1]) * t))
            time.sleep(0.02)
    finally:
        time.sleep(0.1)
        _emit_button(button, 0)
    return {"from": g1, "to": g2, "button": button}


def scroll(amount: int = 3, direction: str = "down",
           x: float | None = None, y: float | None = None,
           coord_space: str = "image") -> dict:
    from evdev import ecodes as e
    if direction not in ("up", "down", "left", "right"):
        raise ValueError("direction must be up/down/left/right")
    pos = None
    if x is not None and y is not None:
        pos = move(x, y, coord_space)
        time.sleep(0.06)
    amount = max(1, int(amount))
    invert = -1 if load_config()["scroll_invert"] else 1
    # evdev semantics: REL_WHEEL +1 = up, REL_HWHEEL +1 = right.
    code = e.REL_WHEEL if direction in ("up", "down") else e.REL_HWHEEL
    step = invert * (1 if direction in ("up", "right") else -1)
    ui = _pointer()
    for _ in range(amount):
        ui.write(e.EV_REL, code, step)
        ui.syn()
        time.sleep(0.02)
    return {"scrolled": direction, "notches": amount, "desktop_pos": pos}


# -- keyboard (ydotool) --------------------------------------------------------

def _resolve_combo(keys: str) -> list[str]:
    """'ctrl+shift+t' -> ['29:1','42:1','20:1','20:0','42:0','29:0']."""
    parts = [k.strip().lower() for k in keys.split("+") if k.strip()]
    if not parts:
        raise ValueError("Empty key combo")
    codes = []
    for p in parts:
        code = _KEY_CODES.get(p)
        if code is None:
            raise ValueError(
                f"Unknown key name {p!r}. Known: {', '.join(sorted(_KEY_CODES))}"
            )
        codes.append(code)
    return [f"{c}:1" for c in codes] + [f"{c}:0" for c in reversed(codes)]


def _ydotool(args: list[str], input_bytes: bytes | None = None, timeout: float = 60) -> str:
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env["YDOTOOL_SOCKET"] = str(load_config()["ydotool_socket"])
    proc = subprocess.run(
        ["ydotool", *args], capture_output=True, timeout=timeout, env=env, input=input_bytes,
    )
    err = (proc.stderr or proc.stdout).decode(errors="replace").strip()
    if proc.returncode != 0:
        hint = ""
        if "connect" in err.lower() or "socket" in err.lower():
            hint = " — ydotoold not reachable: systemctl --user start ydotoold"
        raise RuntimeError(f"ydotool {args[0]} failed: {err}{hint}")
    return err


def key_press(combo: str, repeat: int = 1) -> dict:
    args = _resolve_combo(combo)
    repeat = max(1, int(repeat))
    for i in range(repeat):
        _ydotool(["key", "-d", "12", *args])
        if i + 1 < repeat:
            time.sleep(0.03)
    return {"pressed": combo, "repeat": repeat}


def type_text(text: str, method: str = "auto") -> dict:
    if method not in ("auto", "type", "paste"):
        raise ValueError("method must be auto/type/paste")
    if method == "auto":
        method = "type" if text.isascii() and len(text) <= 200 else "paste"
    if method == "type":
        _ydotool(["type", "-f", "-"], input_bytes=text.encode())
    else:
        # Unicode/long text: ydotool's keymap is ASCII-bound — paste instead.
        clipboard.copy(text, "active")
        time.sleep(0.12)
        key_press("ctrl+v")
    return {"typed_chars": len(text), "method": method}
