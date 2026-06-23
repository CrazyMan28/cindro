"""Agent-desktop keyboard injection via zwp_virtual_keyboard_v1.

The host keyboard path (ydotool -> /dev/uinput) only ever lands on the host
seat. The nested headless Sway that the co-worker drives runs with
WLR_LIBINPUT_NO_DEVICES=1, so it ignores host input devices entirely — ydotool
keystrokes never reach it. Instead we bind a Wayland *virtual keyboard*
(zwp_virtual_keyboard_v1) to the nested compositor's WAYLAND_DISPLAY and inject
key events directly into its seat — isolated from the user's real screen, the
keyboard analogue of the swaymsg `seat - cursor` mouse path in input.py.

A short-lived client is created per type/key_press call (connect, upload an xkb
keymap, emit key down/up events, disconnect). This keeps no global Wayland
connection in the engine and tolerates the nested compositor restarting.
"""

from __future__ import annotations

import importlib
import os
import threading
import time
from pathlib import Path

from computer_use_mcp.session import SessionInfo

_XML = str(Path(__file__).with_name("virtual-keyboard-unstable-v1.xml"))
_GEN_LOCK = threading.Lock()
_MgrClass = None  # cached generated ZwpVirtualKeyboardManagerV1

# A standard US xkb keymap; `key` codes below are raw Linux evdev keycodes,
# which this keymap maps 1:1 (evdev keycodes). sway compiles the includes from
# its installed xkb data.
_XKB_KEYMAP = (
    'xkb_keymap {\n'
    '  xkb_keycodes { include "evdev+aliases(qwerty)" };\n'
    '  xkb_types    { include "complete" };\n'
    '  xkb_compat   { include "complete" };\n'
    '  xkb_symbols  { include "pc+us+inet(evdev)" };\n'
    '};\n'
)

# Linux evdev key codes for keyboard keys (mirrors input.py _KEY_CODES so
# key_press combos resolve identically on the agent seat).
KEY_CODES: dict[str, int] = {
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
KEY_CODES.update({ch: code for ch, code in zip(
    "abcdefghijklmnopqrstuvwxyz",
    [30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38,
     50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44],
)})
KEY_CODES.update({ch: code for ch, code in zip("1234567890", range(2, 12))})
KEY_CODES.update({f"f{i}": code for i, code in zip(range(1, 13),
    [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88])})
KEY_CODES.update({f"f{i}": code for i, code in zip(range(13, 25), range(183, 195))})

# Printable char -> (evdev keycode, needs_shift). Unshifted keys first.
_CHAR_KEYS: dict[str, tuple[int, bool]] = {}
for _ch in "abcdefghijklmnopqrstuvwxyz":
    _CHAR_KEYS[_ch] = (KEY_CODES[_ch], False)
    _CHAR_KEYS[_ch.upper()] = (KEY_CODES[_ch], True)
for _ch in "1234567890":
    _CHAR_KEYS[_ch] = (KEY_CODES[_ch], False)
# Shifted top-row symbols (US layout).
for _sym, _digit in zip(")!@#$%^&*(", "0123456789"):
    _CHAR_KEYS[_sym] = (KEY_CODES[_digit], True)
_CHAR_KEYS.update({
    " ": (57, False), "\n": (28, False), "\t": (15, False),
    "-": (12, False), "_": (12, True),
    "=": (13, False), "+": (13, True),
    "[": (26, False), "{": (26, True),
    "]": (27, False), "}": (27, True),
    ";": (39, False), ":": (39, True),
    "'": (40, False), '"': (40, True),
    "`": (41, False), "~": (41, True),
    "\\": (43, False), "|": (43, True),
    ",": (51, False), "<": (51, True),
    ".": (52, False), ">": (52, True),
    "/": (53, False), "?": (53, True),
})

_MOD_SHIFT = 1  # xkb mods_depressed bit for Shift


def _manager_class():
    """Generate (once) the zwp_virtual_keyboard bindings from the bundled XML
    into pywayland's protocol package, so its `from ..wayland import WlSeat`
    relative imports resolve."""
    global _MgrClass
    with _GEN_LOCK:
        if _MgrClass is not None:
            return _MgrClass
        from pywayland.scanner import Protocol
        import pywayland.protocol as _pp

        proto = Protocol.parse_file(_XML)
        gendir = os.path.dirname(_pp.__file__)
        pkg = proto.name  # virtual_keyboard_unstable_v1
        mod_path = os.path.join(gendir, pkg, "zwp_virtual_keyboard_manager_v1.py")
        if not os.path.exists(mod_path):
            imports = {"wl_seat": "wayland", "wl_registry": "wayland"}
            for iface in proto.interface:
                imports[iface.name] = pkg
            proto.output(gendir, imports)
            importlib.invalidate_caches()
        mgr_mod = importlib.import_module(
            f"pywayland.protocol.{pkg}.zwp_virtual_keyboard_manager_v1")
        _MgrClass = mgr_mod.ZwpVirtualKeyboardManagerV1
        return _MgrClass


class _Keyboard:
    """A connected virtual keyboard on the nested compositor. Use as a context
    manager so the Wayland connection is always torn down."""

    def __init__(self, info: SessionInfo):
        self.info = info
        self._d = None
        self._vk = None

    def __enter__(self):
        from pywayland.client import Display
        from pywayland.protocol.wayland import WlSeat
        from pywayland.utils import AnonymousFile

        MgrClass = _manager_class()
        env = self.info.env()
        # Point libwayland at the nested compositor's socket.
        os.environ_backup = {k: os.environ.get(k) for k in
                             ("WAYLAND_DISPLAY", "XDG_RUNTIME_DIR")}
        if env.get("XDG_RUNTIME_DIR"):
            os.environ["XDG_RUNTIME_DIR"] = env["XDG_RUNTIME_DIR"]
        if env.get("WAYLAND_DISPLAY"):
            os.environ["WAYLAND_DISPLAY"] = env["WAYLAND_DISPLAY"]

        d = Display()
        d.connect()
        self._d = d
        reg = d.get_registry()
        found: dict[str, int] = {}

        def on_global(registry, name, iface, version):
            if iface == "zwp_virtual_keyboard_manager_v1":
                found["mgr"] = name
                found["mgr_ver"] = version
            elif iface == "wl_seat":
                found["seat"] = name
                found["seat_ver"] = version

        reg.dispatcher["global"] = on_global
        d.roundtrip()
        if "mgr" not in found or "seat" not in found:
            raise RuntimeError(
                "nested compositor exposes no virtual_keyboard_manager/wl_seat "
                "(cannot inject agent keyboard input)")
        mgr = reg.bind(found["mgr"], MgrClass, found["mgr_ver"])
        seat = reg.bind(found["seat"], WlSeat, min(found["seat_ver"], 7))
        d.roundtrip()
        vk = mgr.create_virtual_keyboard(seat)
        km = _XKB_KEYMAP.encode()
        with AnonymousFile(len(km)) as fd:
            os.write(fd, km)
            os.lseek(fd, 0, os.SEEK_SET)
            vk.keymap(1, fd, len(km))  # format 1 = xkb v1
        d.roundtrip()
        time.sleep(0.05)
        self._vk = vk
        return self

    def __exit__(self, *exc):
        try:
            if self._d is not None:
                self._d.roundtrip()
                self._d.disconnect()
        finally:
            for k, v in getattr(os, "environ_backup", {}).items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def _key(self, code: int, state: int) -> None:
        t = int(time.time() * 1000) & 0xFFFFFFFF
        self._vk.key(t, code, state)
        self._d.flush()
        time.sleep(0.008)

    def _set_shift(self, on: bool) -> None:
        self._vk.modifiers(_MOD_SHIFT if on else 0, 0, 0, 0)
        self._d.flush()

    def tap(self, code: int, shift: bool = False) -> None:
        if shift:
            self._set_shift(True)
        self._key(code, 1)
        self._key(code, 0)
        if shift:
            self._set_shift(False)

    def type_text(self, text: str) -> int:
        typed = 0
        for ch in text:
            spec = _CHAR_KEYS.get(ch)
            if spec is None:
                continue
            self.tap(spec[0], spec[1])
            typed += 1
        return typed

    def combo(self, codes: list[int]) -> None:
        """Press codes in order, release in reverse (modifier chord)."""
        for c in codes:
            self._key(c, 1)
        for c in reversed(codes):
            self._key(c, 0)


def type_text(info: SessionInfo, text: str) -> int:
    """Type `text` into the focused window of the nested agent compositor."""
    with _Keyboard(info) as kb:
        return kb.type_text(text)


def key_press(info: SessionInfo, combo: str, repeat: int = 1) -> None:
    """Press a key/chord (e.g. 'Return', 'ctrl+c') on the nested agent seat."""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        raise ValueError("Empty key combo")
    codes = []
    for p in parts:
        code = KEY_CODES.get(p)
        if code is None:
            raise ValueError(f"Unknown key name {p!r}")
        codes.append(code)
    repeat = max(1, int(repeat))
    with _Keyboard(info) as kb:
        for i in range(repeat):
            kb.combo(codes)
            if i + 1 < repeat:
                time.sleep(0.03)
