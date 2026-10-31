"""Graphical (pixel-level) control of a Chrome tab: VM consoles, remote desktops,
canvas apps — anything without normal HTML elements to click.

The DOM tools (browser_snapshot/browser_click/browser_type) can't reach inside a
noVNC/Guacamole/SPICE/VMware console: the guest desktop is pixels on a <canvas>
(or a <video> for WebRTC desktops), often inside nested, cross-origin iframes.
This module is the pure half of the fix:

  * Inspection — what a `browser_visual_inspect` image maps to. The extension
    captures the viewport (Page.captureScreenshot, device pixels), optionally
    crops + downscales it, and reports the CSS viewport size. An Inspection
    stores the affine map image px -> main-frame CSS px, which is exactly the
    coordinate space CDP's Input.dispatchMouseEvent takes. Device pixel ratio,
    browser zoom, the debugger infobar and crop/downscale all fold into that one
    measured scale, so nothing has to be guessed.
  * Surfaces — the graphical elements found in every frame (canvas/video/...),
    composed into main-frame CSS coordinates through the iframe chain (offsets
    AND css-transform scale), with object-fit letterboxing resolved so a guest
    framebuffer pixel maps to the right on-screen pixel.
  * Input — the exact CDP Input.* event sequences for clicks, drags, wheel,
    key combos and typed text (US layout key/code/keyCode triples, which is what
    noVNC/Guacamole translate into keysyms/scancodes). Real browser input, not
    synthetic JS events, so it is trusted and hit-tests into iframes.

The extension side (extension/visual.js) only captures, measures, and
dispatches the event lists built here; all the logic that matters lives in
Python so it is unit-tested.
"""

from __future__ import annotations

import math
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urldefrag

# --------------------------------------------------------------------------- mapping

COORD_SPACES = ("image", "viewport", "surface")
_COORD_ALIASES = {
    "image": "image", "screenshot": "image", "img": "image",
    "viewport": "viewport", "css": "viewport", "page": "viewport",
    "surface": "surface", "guest": "surface", "framebuffer": "surface",
}

# Kinds that are, for practical purposes, a remote machine's screen.
VM_KINDS = frozenset({
    "novnc", "guacamole", "spice", "vmware", "kasm", "remote-video", "rdp", "vnc",
})


@dataclass
class Inspection:
    """One browser_visual_inspect image and how its pixels map to the page."""
    inspect_id: str
    tab_id: int
    image_w: int
    image_h: int
    origin_x: float          # main-frame CSS px shown at image (0,0)
    origin_y: float
    scale_x: float           # image px per CSS px
    scale_y: float
    viewport_w: float        # main-frame CSS viewport (innerWidth/innerHeight)
    viewport_h: float
    surfaces: list[dict] = field(default_factory=list)
    scroll_x: Optional[float] = None   # main-frame scroll at capture (None: unknown)
    scroll_y: Optional[float] = None
    capture: dict = field(default_factory=dict)   # params to re-capture the same view
    created: float = field(default_factory=time.time)

    def image_to_css(self, x: float, y: float) -> tuple[float, float]:
        _finite(x, y)
        tol = 1.0
        if not (-tol <= x <= self.image_w + tol and -tol <= y <= self.image_h + tol):
            raise ValueError(
                f"({x:g},{y:g}) is outside the inspected image "
                f"({self.image_w}x{self.image_h}) — measure on the latest "
                "browser_visual_inspect image")
        x = min(max(x, 0.0), self.image_w - 0.5)
        y = min(max(y, 0.0), self.image_h - 0.5)
        return self.origin_x + x / self.scale_x, self.origin_y + y / self.scale_y

    def css_to_image(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.origin_x) * self.scale_x, (y - self.origin_y) * self.scale_y

    def css_rect_to_image(self, r: dict) -> dict:
        x0, y0 = self.css_to_image(r["x"], r["y"])
        x1, y1 = self.css_to_image(r["x"] + r["w"], r["y"] + r["h"])
        return {"x": round(x0), "y": round(y0), "w": round(x1 - x0), "h": round(y1 - y0)}

    def surface(self, sid: Optional[str]) -> dict:
        if not self.surfaces:
            raise ValueError("no graphical surface was found in the last inspection")
        if not sid:
            return self.surfaces[0]
        for s in self.surfaces:
            if s["id"] == sid:
                return s
        raise ValueError(f"unknown surface {sid!r} (have: "
                         f"{', '.join(s['id'] for s in self.surfaces)})")

    def public(self) -> dict:
        return {
            "inspect_id": self.inspect_id,
            "tab_id": self.tab_id,
            "image": {"width": self.image_w, "height": self.image_h},
            "viewport_css": {"width": self.viewport_w, "height": self.viewport_h},
            "image_origin_css": {"x": round(self.origin_x, 2), "y": round(self.origin_y, 2)},
            "image_px_per_css_px": round(self.scale_x, 4),
        }


def _finite(*vals: float) -> None:
    for v in vals:
        if v is None or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError(f"coordinate {v!r} is not a finite number")


def _round_half_up(v: float) -> int:
    return math.floor(v + 0.5)  # not round(): banker's rounding sends 40.5 to 40


def normalize_space(space: Optional[str]) -> str:
    key = (space or "image").strip().lower()
    if key not in _COORD_ALIASES:
        raise ValueError(f"coord_space must be one of {', '.join(COORD_SPACES)} (got {space!r})")
    return _COORD_ALIASES[key]


def surface_to_css(surface: dict, gx: float, gy: float) -> tuple[float, float]:
    """Guest framebuffer pixel -> main-frame CSS px through the surface's drawn
    content rect (already letterbox-corrected)."""
    _finite(gx, gy)
    fb = surface.get("framebuffer") or {}
    fw, fh = fb.get("w") or 0, fb.get("h") or 0
    if not fw or not fh:
        raise ValueError(f"surface {surface.get('id')} has no known framebuffer size; "
                         "use coord_space='image'")
    if not (-1 <= gx <= fw + 1 and -1 <= gy <= fh + 1):
        raise ValueError(f"({gx:g},{gy:g}) is outside surface {surface.get('id')}'s "
                         f"{fw}x{fh} framebuffer")
    r = surface["content_css"]
    if not r:
        raise ValueError(f"surface {surface.get('id')} isn't located on screen; "
                         "use coord_space='image'")

    def axis(g: float, n: int, start: float, size: float) -> float:
        # Aim at the CENTER of guest pixel g (consoles truncate client->guest),
        # then keep the integer CSS point inside the drawn rect: Chrome
        # hit-tests the right/bottom edge as outside the canvas.
        g = min(max(g, 0.0), n - 1.0)
        v = _round_half_up(start + (g + 0.5) * size / n)
        return float(min(max(v, math.ceil(start)), math.ceil(start + size) - 1))

    return axis(gx, fw, r["x"], r["w"]), axis(gy, fh, r["y"], r["h"])


def resolve_point(insp: Optional[Inspection], x: float, y: float, coord_space: str,
                  surface: Optional[str] = None,
                  viewport: Optional[tuple[float, float]] = None) -> tuple[float, float]:
    """Any supported coordinate space -> main-frame CSS px (CDP Input space)."""
    space = normalize_space(coord_space)
    if space == "viewport":
        _finite(x, y)
        cx, cy = float(x), float(y)
    elif insp is None:
        raise ValueError(
            "no browser_visual_inspect image for this tab yet — call "
            "browser_visual_inspect first (or pass coord_space='viewport')")
    elif space == "image":
        cx, cy = insp.image_to_css(x, y)
    else:
        cx, cy = surface_to_css(insp.surface(surface), x, y)
    vw, vh = viewport or ((insp.viewport_w, insp.viewport_h) if insp else (None, None))
    if vw and vh and not (0 <= cx < vw + 0.5 and 0 <= cy < vh + 0.5):
        raise ValueError(
            f"point maps to CSS ({cx:.1f},{cy:.1f}), outside the visible viewport "
            f"({vw:g}x{vh:g}) — scroll it into view or re-inspect")
    # Integer CSS px: Chrome hands pages integer clientX/Y anyway, so rounding to
    # nearest (not the implicit floor) keeps the guest within half a pixel.
    return float(_round_half_up(cx)), float(_round_half_up(cy))


# ----------------------------------------------------------------- object-fit / frames

def _pct(v: Any, default: float = 0.5) -> float:
    try:
        s = str(v).strip()
        if s.endswith("%"):
            return float(s[:-1]) / 100.0
        return {"left": 0.0, "top": 0.0, "center": 0.5, "right": 1.0, "bottom": 1.0}.get(s, default)
    except Exception:
        return default


def object_fit_rect(box: dict, iw: float, ih: float, fit: str = "fill",
                    position: str = "50% 50%") -> dict:
    """Where a replaced element (canvas/video/img) actually draws its intrinsic
    iw x ih picture inside its content box — the letterbox math."""
    bw, bh = float(box["w"]), float(box["h"])
    if not iw or not ih or not bw or not bh:
        return dict(box)
    fit = (fit or "fill").lower()
    if fit == "fill":
        return {"x": box["x"], "y": box["y"], "w": bw, "h": bh}
    if fit == "none":
        w, h = iw, ih
    else:
        s_contain = min(bw / iw, bh / ih)
        s_cover = max(bw / iw, bh / ih)
        s = {"contain": s_contain, "cover": s_cover,
             "scale-down": min(1.0, s_contain)}.get(fit, s_contain)
        w, h = iw * s, ih * s
    parts = (position or "50% 50%").split()
    px = _pct(parts[0]) if parts else 0.5
    py = _pct(parts[1]) if len(parts) > 1 else 0.5
    return {"x": box["x"] + (bw - w) * px, "y": box["y"] + (bh - h) * py, "w": w, "h": h}


def _norm_url(u: str) -> str:
    try:
        return urldefrag(u or "")[0].rstrip("/")
    except Exception:
        return u or ""


def compose_frames(frames: list[dict]) -> dict[Any, dict]:
    """Place every frame in main-frame CSS coordinates.

    `frames` are per-frame reports from the extension (one per frame the
    content script reached, including cross-origin OOPIFs): {frameId, href,
    innerW, innerH, iframes: [{src, x, y, w, h, sx, sy}]} where each iframe
    entry is that <iframe>'s CONTENT box in its parent's viewport (x/y/sx/sy
    include css transforms; w/h are untransformed layout px == the child's
    innerWidth/innerHeight). Chrome doesn't tell a content script which
    <iframe> hosts it, so children are matched to iframe slots by URL + size
    (then size alone), breadth-first from the main frame (frameId 0).

    Returns {frameId: {"x","y","sx","sy","confidence"}}; frames that can't be
    placed get confidence "none" and no offset.
    """
    by_id = {f.get("frameId"): f for f in frames}
    main = by_id.get(0) or (frames[0] if frames else None)
    if main is None:
        return {}
    placed: dict[Any, dict] = {main.get("frameId", 0): {
        "x": 0.0, "y": 0.0, "sx": 1.0, "sy": 1.0, "confidence": "exact"}}
    queue = [main]
    while queue:
        parent = queue.pop(0)
        pa = placed[parent.get("frameId", 0)]
        for slot in parent.get("iframes") or []:
            cands = [f for fid, f in by_id.items() if fid not in placed]
            if not cands:
                break
            best, best_score = None, 0
            for f in cands:
                size_ok = (abs((f.get("innerW") or 0) - (slot.get("w") or 0)) <= 2 and
                           abs((f.get("innerH") or 0) - (slot.get("h") or 0)) <= 2)
                src = _norm_url(slot.get("src", ""))
                url_ok = bool(src) and src == _norm_url(f.get("href", ""))
                score = (2 if url_ok else 0) + (1 if size_ok else 0)
                if url_ok and not size_ok and slot.get("w") and f.get("innerW"):
                    score = 1  # same URL but a different size: weak (e.g. two tiles)
                if score > best_score:
                    best, best_score = f, score
            if best is None:
                continue
            sx = float(slot.get("sx") or 1.0)
            sy = float(slot.get("sy") or 1.0)
            placed[best.get("frameId")] = {
                "x": pa["x"] + float(slot["x"]) * pa["sx"],
                "y": pa["y"] + float(slot["y"]) * pa["sy"],
                "sx": pa["sx"] * sx,
                "sy": pa["sy"] * sy,
                "confidence": "exact" if best_score >= 3 else ("url" if best_score == 2 else "size"),
            }
            queue.append(best)
    for fid in by_id:
        placed.setdefault(fid, {"confidence": "none"})
    return placed


def _clip(r: dict, vw: float, vh: float) -> Optional[dict]:
    x0, y0 = max(r["x"], 0.0), max(r["y"], 0.0)
    x1, y1 = min(r["x"] + r["w"], vw), min(r["y"] + r["h"], vh)
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def compose_surfaces(frames: list[dict], viewport_w: float, viewport_h: float) -> list[dict]:
    """Every graphical surface in main-frame CSS coords, biggest first, ids s1.."""
    offsets = compose_frames(frames)
    out: list[dict] = []
    for f in frames:
        off = offsets.get(f.get("frameId"), {"confidence": "none"})
        for s in f.get("surfaces") or []:
            box = s.get("box")
            if not box:
                continue
            fb = s.get("intrinsic") or {}
            drawn = object_fit_rect(box, fb.get("w") or 0, fb.get("h") or 0,
                                    s.get("fit", "fill"), s.get("position", "50% 50%"))
            item = {
                "kind": s.get("kind", "canvas"),
                "tag": s.get("tag"),
                "label": s.get("label") or "",
                "frame_url": f.get("href", ""),
                "frame_placement": off.get("confidence", "none"),
                "focused": bool(s.get("focused")),
                "framebuffer": {"w": fb.get("w"), "h": fb.get("h")} if fb.get("w") else None,
            }
            if off.get("confidence") == "none":
                item["content_css"] = None
                item["note"] = "inside a frame that couldn't be located; use image coordinates"
            else:
                def place(r: dict) -> dict:
                    return {"x": off["x"] + r["x"] * off["sx"], "y": off["y"] + r["y"] * off["sy"],
                            "w": r["w"] * off["sx"], "h": r["h"] * off["sy"]}
                item["content_css"] = place(drawn)
                item["box_css"] = place(box)
                vis = _clip(item["content_css"], viewport_w, viewport_h)
                if vis is None:
                    continue  # scrolled out of view / zero-size
                item["visible_css"] = vis
            out.append(item)
    out.sort(key=lambda s: -((s.get("visible_css") or {}).get("w", 0) *
                             (s.get("visible_css") or {}).get("h", 0)))
    for i, s in enumerate(out, 1):
        s["id"] = f"s{i}"
    return out


def assess_graphical(surfaces: list[dict], viewport_w: float, viewport_h: float) -> dict:
    """Should the agent switch from DOM tools to pixel tools on this page?"""
    area = max(viewport_w * viewport_h, 1.0)
    big = [s for s in surfaces
           if (s.get("visible_css") and
               s["visible_css"]["w"] * s["visible_css"]["h"] >= 0.2 * area)]
    vm = [s for s in surfaces if s.get("kind") in VM_KINDS]
    graphical = bool(big or vm)
    res: dict = {"graphical": graphical}
    if graphical:
        main = (vm or big)[0]
        res["primary_surface"] = main["id"]
        res["primary_kind"] = main["kind"]
        res["hint"] = (
            f"This tab shows a graphical surface ({main['kind']}) that DOM refs can't reach "
            "into. Use browser_visual_inspect to look, then browser_click_xy / "
            "browser_type_trusted / browser_key_press with coordinates measured on that "
            "image; verify=True returns a fresh screenshot after each action.")
    return res


# ----------------------------------------------------------------------- keyboard

MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT = 1, 2, 4, 8

# name -> (key, code, keyCode, text, location)
_K: dict[str, tuple[str, str, int, Optional[str], int]] = {
    "shift": ("Shift", "ShiftLeft", 16, None, 1),
    "ctrl": ("Control", "ControlLeft", 17, None, 1),
    "alt": ("Alt", "AltLeft", 18, None, 1),
    "meta": ("Meta", "MetaLeft", 91, None, 1),
    "rightshift": ("Shift", "ShiftRight", 16, None, 2),
    "rightctrl": ("Control", "ControlRight", 17, None, 2),
    "rightalt": ("Alt", "AltRight", 18, None, 2),
    "altgr": ("AltGraph", "AltRight", 225, None, 2),
    "rightmeta": ("Meta", "MetaRight", 92, None, 2),
    "enter": ("Enter", "Enter", 13, "\r", 0),
    "tab": ("Tab", "Tab", 9, None, 0),
    "backspace": ("Backspace", "Backspace", 8, None, 0),
    "escape": ("Escape", "Escape", 27, None, 0),
    "space": (" ", "Space", 32, " ", 0),
    "delete": ("Delete", "Delete", 46, None, 0),
    "insert": ("Insert", "Insert", 45, None, 0),
    "home": ("Home", "Home", 36, None, 0),
    "end": ("End", "End", 35, None, 0),
    "pageup": ("PageUp", "PageUp", 33, None, 0),
    "pagedown": ("PageDown", "PageDown", 34, None, 0),
    "left": ("ArrowLeft", "ArrowLeft", 37, None, 0),
    "up": ("ArrowUp", "ArrowUp", 38, None, 0),
    "right": ("ArrowRight", "ArrowRight", 39, None, 0),
    "down": ("ArrowDown", "ArrowDown", 40, None, 0),
    "capslock": ("CapsLock", "CapsLock", 20, None, 0),
    "numlock": ("NumLock", "NumLock", 144, None, 0),
    "scrolllock": ("ScrollLock", "ScrollLock", 145, None, 0),
    "pause": ("Pause", "Pause", 19, None, 0),
    "printscreen": ("PrintScreen", "PrintScreen", 44, None, 0),
    "contextmenu": ("ContextMenu", "ContextMenu", 93, None, 0),
    "kpenter": ("Enter", "NumpadEnter", 13, "\r", 3),
    "kpplus": ("+", "NumpadAdd", 107, "+", 3),
    "kpminus": ("-", "NumpadSubtract", 109, "-", 3),
    "kpmultiply": ("*", "NumpadMultiply", 106, "*", 3),
    "kpdivide": ("/", "NumpadDivide", 111, "/", 3),
    "kpdecimal": (".", "NumpadDecimal", 110, ".", 3),
}
for _i in range(1, 25):
    _K[f"f{_i}"] = (f"F{_i}", f"F{_i}", 111 + _i, None, 0)
for _i in range(10):
    _K[f"kp{_i}"] = (str(_i), f"Numpad{_i}", 96 + _i, str(_i), 3)

_ALIASES = {
    "control": "ctrl", "ctl": "ctrl", "lctrl": "ctrl", "rctrl": "rightctrl",
    "option": "alt", "opt": "alt", "lalt": "alt", "ralt": "rightalt",
    "win": "meta", "windows": "meta", "super": "meta", "cmd": "meta", "command": "meta",
    "os": "meta", "lwin": "meta", "rwin": "rightmeta",
    "lshift": "shift", "rshift": "rightshift",
    "return": "enter", "esc": "escape", "del": "delete", "ins": "insert",
    "pgup": "pageup", "pgdn": "pagedown", "page_up": "pageup", "page_down": "pagedown",
    "arrowleft": "left", "arrowup": "up", "arrowright": "right", "arrowdown": "down",
    "bksp": "backspace", "bs": "backspace", "spacebar": "space",
    "prtsc": "printscreen", "prtscn": "printscreen", "print": "printscreen", "sysrq": "printscreen",
    "menu": "contextmenu", "apps": "contextmenu", "break": "pause",
    "plus": "+", "minus": "-", "equal": "=", "equals": "=", "comma": ",", "period": ".",
    "dot": ".", "slash": "/", "backslash": "\\", "semicolon": ";", "apostrophe": "'",
    "quote": "'", "grave": "`", "backtick": "`", "tilde": "~", "leftbracket": "[",
    "rightbracket": "]", "leftbrace": "[", "rightbrace": "]",
    "numpadenter": "kpenter", "kpadd": "kpplus", "kpsubtract": "kpminus",
    "kpasterisk": "kpmultiply", "kpslash": "kpdivide", "kpdot": "kpdecimal",
}

_MOD_BITS = {"Shift": MOD_SHIFT, "Control": MOD_CTRL, "Alt": MOD_ALT, "Meta": MOD_META,
             "AltGraph": 0}

# Printable US-layout characters: char -> (code, keyCode, needs_shift)
_US: dict[str, tuple[str, int, bool]] = {" ": ("Space", 32, False)}
for _c in "abcdefghijklmnopqrstuvwxyz":
    _US[_c] = (f"Key{_c.upper()}", ord(_c.upper()), False)
    _US[_c.upper()] = (f"Key{_c.upper()}", ord(_c.upper()), True)
for _d, _s in zip("1234567890", "!@#$%^&*()"):
    _US[_d] = (f"Digit{_d}", ord(_d), False)
    _US[_s] = (f"Digit{_d}", ord(_d), True)
for _plain, _shifted, _code, _kc in (
        ("-", "_", "Minus", 189), ("=", "+", "Equal", 187),
        ("[", "{", "BracketLeft", 219), ("]", "}", "BracketRight", 221),
        ("\\", "|", "Backslash", 220), (";", ":", "Semicolon", 186),
        ("'", '"', "Quote", 222), (",", "<", "Comma", 188), (".", ">", "Period", 190),
        ("/", "?", "Slash", 191), ("`", "~", "Backquote", 192)):
    _US[_plain] = (_code, _kc, False)
    _US[_shifted] = (_code, _kc, True)
# key code -> the char that key types without / with Shift (US layout)
_UNSHIFT: dict[str, str] = {}
_SHIFTED: dict[str, str] = {}
for _ch, (_code, _kc, _sh) in _US.items():
    (_SHIFTED if _sh else _UNSHIFT)[_code] = _ch


@dataclass(frozen=True)
class KeyDef:
    key: str
    code: str
    key_code: int
    text: Optional[str]
    location: int = 0
    shift: bool = False      # printable char that needs Shift on a US layout

    @property
    def modifier_bit(self) -> int:
        return _MOD_BITS.get(self.key, 0) if self.text is None else 0

    @property
    def is_modifier(self) -> bool:
        return self.key in _MOD_BITS and self.text is None


def key_def(name: str) -> KeyDef:
    """Resolve a key name ('ctrl', 'F5', 'enter', 'a', 'A', '?', 'win') to a KeyDef."""
    if name is None or name == "":
        raise ValueError("empty key name")
    if len(name) == 1:
        if name in _US:
            code, kc, sh = _US[name]
            return KeyDef(name, code, kc, name, 0, sh)
        if name.isprintable():
            return KeyDef(name, "", 0, name, 0, False)  # non-US char: key+text only
    low = name.strip().lower().replace(" ", "")
    low = _ALIASES.get(low, low)
    if len(low) == 1:
        return key_def(low)
    if low in _K:
        k, code, kc, text, loc = _K[low]
        return KeyDef(k, code, kc, text, loc)
    known = sorted(set(_K) | set(_ALIASES))
    raise ValueError(f"unknown key {name!r}. Known names: {', '.join(known)} "
                     "(or any single character)")


def parse_combo(combo: str) -> list[KeyDef]:
    """'ctrl+alt+delete' -> [ctrl, alt, delete]. '+' itself: 'ctrl+plus' or 'ctrl++'."""
    s = (combo or "").strip()
    if not s:
        raise ValueError("empty key combo")
    parts: list[str] = []
    buf = ""
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "+" and buf:
            parts.append(buf)
            buf = ""
        elif ch == "+" and not buf:
            parts.append("+")      # a literal plus (leading or 'ctrl++')
            if i + 1 < len(s) and s[i + 1] == "+":
                i += 1
        else:
            buf += ch
        i += 1
    if buf:
        parts.append(buf)
    if len(parts) > 1 and len(parts[-1]) == 1 and parts[-1].isalpha():
        parts[-1] = parts[-1].lower()  # 'ctrl+C' means ctrl+c, not ctrl+shift+c
    keys = [key_def(p) for p in parts]
    mods = keys[:-1]
    for m in mods:
        if not m.is_modifier:
            raise ValueError(f"in {combo!r}, only the LAST key may be a non-modifier "
                             f"({m.key!r} isn't a modifier); use a space to press keys in sequence")
    return keys


def _key_event(kind: str, k: KeyDef, modifiers: int, text: Optional[str] = None,
               delay_ms: int = 0) -> dict:
    params: dict[str, Any] = {
        "type": kind, "modifiers": modifiers, "key": k.key, "code": k.code,
        "windowsVirtualKeyCode": k.key_code, "nativeVirtualKeyCode": k.key_code,
    }
    if k.location:
        params["location"] = k.location
    if text:
        params["text"] = text
        params["unmodifiedText"] = _UNSHIFT.get(k.code, text) if k.shift else text
    ev = {"method": "Input.dispatchKeyEvent", "params": params}
    if delay_ms:
        ev["delayMs"] = int(delay_ms)
    return ev


def combo_events(combo: str, hold_ms: int = 0, base_modifiers: int = 0) -> list[dict]:
    """CDP events for pressing and releasing a chord, modifiers first and last."""
    keys = parse_combo(combo)
    return keys_events(keys, hold_ms=hold_ms, base_modifiers=base_modifiers)


def keys_events(keys: list[KeyDef], hold_ms: int = 0, base_modifiers: int = 0) -> list[dict]:
    evs: list[dict] = []
    mods = base_modifiers
    *held, main = keys
    for m in held:
        mods |= m.modifier_bit
        evs.append(_key_event("rawKeyDown", m, mods))
    auto_shift = main.shift and not (mods & MOD_SHIFT)
    shift_def = key_def("shift")
    if auto_shift:
        mods |= MOD_SHIFT
        evs.append(_key_event("rawKeyDown", shift_def, mods))
    if main.is_modifier:
        mods |= main.modifier_bit
    if mods & MOD_SHIFT and not main.shift and main.code in _SHIFTED:
        sch = _SHIFTED[main.code]  # shift+a -> key 'A' (what a real keyboard reports)
        main = KeyDef(sch, main.code, main.key_code, sch, main.location, True)
    # Text only when no command modifier is held (ctrl+c must not type a 'c').
    text = main.text if main.text and not (mods & (MOD_CTRL | MOD_ALT | MOD_META)) else None
    evs.append(_key_event("keyDown" if text else "rawKeyDown", main, mods, text))
    if main.is_modifier:
        mods &= ~main.modifier_bit
    evs.append(_key_event("keyUp", main, mods, delay_ms=hold_ms))
    if auto_shift:
        mods &= ~MOD_SHIFT
        evs.append(_key_event("keyUp", shift_def, mods))
    for m in reversed(held):
        mods &= ~m.modifier_bit
        evs.append(_key_event("keyUp", m, mods))
    return evs


def parse_key_sequence(keys: str) -> list[str]:
    """'ctrl+a ctrl+c' -> ['ctrl+a', 'ctrl+c']; whitespace separates presses."""
    seq = [p for p in (keys or "").split() if p]
    if not seq:
        raise ValueError("no keys given")
    return seq


def text_events(text: str, delay_ms: int = 10) -> list[dict]:
    """Type text as real key presses (what VNC/RDP consoles need: they turn key
    events into keysyms/scancodes and ignore DOM value changes and insertText).
    '\\n' presses Enter, '\\t' Tab; characters outside the US layout are sent
    as key+text events (noVNC maps those to unicode keysyms)."""
    evs: list[dict] = []
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    first = True
    for ch in text:
        if ch == "\n":
            k = key_def("enter")
        elif ch == "\t":
            k = key_def("tab")
        else:
            k = key_def(ch)
        seq = keys_events([k])
        if not first and delay_ms:
            seq[0]["delayMs"] = int(delay_ms)
        first = False
        evs.extend(seq)
    return evs


def insert_text_events(text: str) -> list[dict]:
    return [{"method": "Input.insertText", "params": {"text": text}}]


def modifier_names_events(modifiers: str, down: bool, base: int = 0) -> tuple[list[dict], int]:
    """Press (or release) named modifiers like 'shift' or 'ctrl+shift' around a
    mouse action. Returns (events, resulting modifier mask)."""
    evs: list[dict] = []
    mask = base
    names = [m for m in (modifiers or "").replace(",", "+").split("+") if m.strip()]
    defs = [key_def(n) for n in names]
    for d in defs:
        if not d.is_modifier:
            raise ValueError(f"{d.key!r} is not a modifier (use shift/ctrl/alt/meta)")
    for d in (defs if down else list(reversed(defs))):
        if down:
            mask |= d.modifier_bit
            evs.append(_key_event("rawKeyDown", d, mask))
        else:
            mask &= ~d.modifier_bit
            evs.append(_key_event("keyUp", d, mask))
    return evs, mask


def modifier_mask(modifiers: str) -> int:
    return modifier_names_events(modifiers, True)[1]


# ------------------------------------------------------------------------- mouse

BUTTONS = {"left": 1, "right": 2, "middle": 4, "back": 8, "forward": 16}
_BUTTON_ALIASES = {"primary": "left", "secondary": "right", "wheel": "middle", "auxiliary": "middle"}


def button_name(button: str) -> str:
    b = (button or "left").strip().lower()
    b = _BUTTON_ALIASES.get(b, b)
    if b not in BUTTONS:
        raise ValueError(f"button must be one of {', '.join(BUTTONS)} (got {button!r})")
    return b


def _mouse(kind: str, x: float, y: float, *, button: str = "none", buttons: int = 0,
           click_count: int = 0, modifiers: int = 0, delay_ms: int = 0, **extra) -> dict:
    params: dict[str, Any] = {"type": kind, "x": x, "y": y, "modifiers": modifiers,
                              "button": button, "buttons": buttons}
    if click_count:
        params["clickCount"] = click_count
    params.update(extra)
    ev = {"method": "Input.dispatchMouseEvent", "params": params}
    if delay_ms:
        ev["delayMs"] = int(delay_ms)
    return ev


def move_events(x: float, y: float, held: int = 0, modifiers: int = 0,
                from_xy: Optional[tuple[float, float]] = None, steps: int = 1) -> list[dict]:
    """Pointer motion; with from_xy, interpolated so hover/drag thresholds fire."""
    if not from_xy or steps <= 1:
        return [_mouse("mouseMoved", x, y, buttons=held, modifiers=modifiers,
                       button=_held_button(held))]
    evs = []
    fx, fy = from_xy
    for i in range(1, steps + 1):
        t = i / steps
        evs.append(_mouse("mouseMoved", round(fx + (x - fx) * t, 2), round(fy + (y - fy) * t, 2),
                          buttons=held, modifiers=modifiers, button=_held_button(held),
                          delay_ms=16))
    return evs


def _held_button(held: int) -> str:
    for name, bit in BUTTONS.items():
        if held & bit:
            return name
    return "none"


def click_events(x: float, y: float, button: str = "left", clicks: int = 1,
                 modifiers: int = 0, held: int = 0) -> list[dict]:
    """mouseMoved first (VNC/RDP clients only learn the pointer position from
    motion), then press/release pairs with an incrementing clickCount so
    dblclick fires; small gaps so remote framebuffer protocols see each edge."""
    b = button_name(button)
    bit = BUTTONS[b]
    clicks = max(1, min(int(clicks), 3))
    evs = move_events(x, y, held, modifiers)
    for n in range(1, clicks + 1):
        evs.append(_mouse("mousePressed", x, y, button=b, buttons=held | bit, click_count=n,
                          modifiers=modifiers, delay_ms=30 if n == 1 else 70))
        evs.append(_mouse("mouseReleased", x, y, button=b, buttons=held, click_count=n,
                          modifiers=modifiers, delay_ms=40))
    return evs


def press_events(x: float, y: float, button: str, held: int, modifiers: int = 0) -> tuple[list[dict], int]:
    b = button_name(button)
    now = held | BUTTONS[b]
    return (move_events(x, y, held, modifiers) +
            [_mouse("mousePressed", x, y, button=b, buttons=now, click_count=1,
                    modifiers=modifiers, delay_ms=20)], now)


def release_events(x: float, y: float, button: str, held: int, modifiers: int = 0) -> tuple[list[dict], int]:
    b = button_name(button)
    now = held & ~BUTTONS[b]
    return ([_mouse("mouseReleased", x, y, button=b, buttons=now, click_count=1,
                    modifiers=modifiers)], now)


def drag_events(x1: float, y1: float, x2: float, y2: float, button: str = "left",
                steps: int = 12, hold_ms: int = 0, modifiers: int = 0) -> list[dict]:
    """Press, glide (buttons mask set on every move so the page sees a real
    drag), optionally pause, release. steps >= 2 so drag thresholds trip."""
    b = button_name(button)
    bit = BUTTONS[b]
    steps = max(2, min(int(steps), 200))
    evs = move_events(x1, y1, 0, modifiers)
    evs.append(_mouse("mousePressed", x1, y1, button=b, buttons=bit, click_count=1,
                      modifiers=modifiers, delay_ms=30))
    moves = move_events(x2, y2, bit, modifiers, from_xy=(x1, y1), steps=steps)
    moves[0]["delayMs"] = 60
    evs.extend(moves)
    evs.append(_mouse("mouseReleased", x2, y2, button=b, buttons=0, click_count=1,
                      modifiers=modifiers, delay_ms=max(40, int(hold_ms))))
    return evs


WHEEL_NOTCH_PX = 100


def wheel_events(x: float, y: float, direction: str = "down", amount: int = 3,
                 modifiers: int = 0, held: int = 0) -> list[dict]:
    """One mouseWheel per notch: noVNC/Guacamole turn each wheel event into at
    most one remote wheel click, so a single huge delta would scroll once."""
    d = (direction or "down").strip().lower()
    vec = {"down": (0, 1), "up": (0, -1), "right": (1, 0), "left": (-1, 0)}.get(d)
    if vec is None:
        raise ValueError("direction must be up/down/left/right")
    amount = max(1, min(int(amount), 50))
    evs = move_events(x, y, held, modifiers)
    for i in range(amount):
        evs.append(_mouse("mouseWheel", x, y, buttons=held, modifiers=modifiers,
                          deltaX=vec[0] * WHEEL_NOTCH_PX, deltaY=vec[1] * WHEEL_NOTCH_PX,
                          delay_ms=40 if i else 0))
    return evs


def release_modifier_events() -> list[dict]:
    return [_key_event("keyUp", key_def(n), 0) for n in ("shift", "ctrl", "alt", "meta")]


def release_all_events(x: float, y: float, held: int) -> list[dict]:
    """Recovery: release every held mouse button and every modifier key."""
    evs = []
    for name, bit in BUTTONS.items():
        if held & bit:
            held &= ~bit
            evs.append(_mouse("mouseReleased", x, y, button=name, buttons=held, click_count=1))
    return evs + release_modifier_events()


def sequence_timeout(events: list[dict], base: float = 30.0) -> float:
    """Bridge timeout for an event batch: its own delays plus headroom."""
    total_ms = sum(int(e.get("delayMs") or 0) for e in events)
    return base + total_ms / 1000.0 + 0.01 * len(events)


# ------------------------------------------------------------------------- state

class InspectionStore:
    """Inspections by id (LRU) plus the newest per tab.

    The shared engine serves several sessions, so tools accept an explicit
    inspect_id: an agent that passes the id it got back keeps using ITS image's
    mapping even if another agent inspected the same tab since. Without an id,
    the newest inspection of the tab (or of the most recently inspected tab
    when no tab is given) is used.
    """

    def __init__(self, cap: int = 48) -> None:
        self._by_id: "OrderedDict[str, Inspection]" = OrderedDict()
        self._latest_by_tab: dict[int, str] = {}
        self._latest_tab: Optional[int] = None
        self._cap = cap
        self.held: dict[int, int] = {}            # tab -> held mouse-button mask
        self.last_point: dict[int, tuple[float, float]] = {}  # tab -> last css point

    def new_id(self) -> str:
        return "v" + uuid.uuid4().hex[:10]

    def add(self, insp: Inspection) -> Inspection:
        self._by_id[insp.inspect_id] = insp
        self._by_id.move_to_end(insp.inspect_id)
        while len(self._by_id) > self._cap:
            old_id, old = self._by_id.popitem(last=False)
            if self._latest_by_tab.get(old.tab_id) == old_id:
                self._latest_by_tab.pop(old.tab_id, None)
        self._latest_by_tab[insp.tab_id] = insp.inspect_id
        self._latest_tab = insp.tab_id
        return insp

    def get(self, inspect_id: Optional[str] = None, tab_id: Optional[int] = None) -> Optional[Inspection]:
        if inspect_id:
            insp = self._by_id.get(inspect_id)
            if insp is None:
                raise ValueError(f"unknown or expired inspect_id {inspect_id!r} — "
                                 "call browser_visual_inspect again")
            if tab_id is not None and insp.tab_id != tab_id:
                raise ValueError(f"inspect_id {inspect_id} belongs to tab {insp.tab_id}, "
                                 f"not tab {tab_id}")
            return insp
        tid = tab_id if tab_id is not None else self._latest_tab
        if tid is None:
            return None
        iid = self._latest_by_tab.get(tid)
        return self._by_id.get(iid) if iid else None

    def default_tab(self, tab_id: Optional[int]) -> Optional[int]:
        return tab_id if tab_id is not None else self._latest_tab

    def forget_tab(self, tab_id: int) -> None:
        iid = self._latest_by_tab.pop(tab_id, None)
        if iid:
            self._by_id.pop(iid, None)
        self.held.pop(tab_id, None)
        self.last_point.pop(tab_id, None)
        if self._latest_tab == tab_id:
            self._latest_tab = None

    def clear(self) -> None:
        self.__init__(self._cap)


store = InspectionStore()


def inspection_from_capture(res: dict, tab_id: int, capture: dict,
                            store_: Optional[InspectionStore] = None) -> Inspection:
    """Build (and remember) an Inspection from the extension's page.inspect reply."""
    st = store_ or store
    m = res.get("mapping") or {}
    vp = res.get("viewport") or {}
    insp = Inspection(
        inspect_id=st.new_id(),
        tab_id=int(res.get("tabId", tab_id)),
        image_w=int(res["imageWidth"]),
        image_h=int(res["imageHeight"]),
        origin_x=float(m.get("originX", 0.0)),
        origin_y=float(m.get("originY", 0.0)),
        scale_x=float(m["scaleX"]),
        scale_y=float(m["scaleY"]),
        viewport_w=float(vp.get("width") or 0),
        viewport_h=float(vp.get("height") or 0),
        capture=dict(capture),
    )
    sc = res.get("scroll") or {}
    if sc.get("x") is not None and sc.get("y") is not None:
        insp.scroll_x, insp.scroll_y = float(sc["x"]), float(sc["y"])
    if insp.scale_x <= 0 or insp.scale_y <= 0:
        raise RuntimeError(f"extension reported a bad image scale: {m}")
    frames = res.get("frames") or []
    insp.surfaces = compose_surfaces(frames, insp.viewport_w, insp.viewport_h)
    return st.add(insp)


def describe_surfaces(insp: Inspection) -> list[dict]:
    """Surfaces as the model should see them: rects in IMAGE pixels."""
    out = []
    for s in insp.surfaces:
        d = {"id": s["id"], "kind": s["kind"], "focused": s["focused"]}
        if s.get("label"):
            d["label"] = s["label"][:80]
        if s.get("framebuffer"):
            d["framebuffer"] = s["framebuffer"]
        if s.get("content_css"):
            vis = s.get("visible_css") or s["content_css"]
            d["rect_image"] = insp.css_rect_to_image(vis)
        else:
            d["note"] = s.get("note", "")
        if s.get("frame_placement") not in ("exact", None):
            d["frame_placement"] = s["frame_placement"]
        if s.get("frame_url"):
            d["frame_url"] = s["frame_url"][:160]
        out.append(d)
    return out


def pick_type_mode(mode: str, focus_frames: list[dict]) -> str:
    """'auto' -> 'insert' only when a plain text field is focused; otherwise
    'keys' (canvas consoles, terminals, unknown/cross-origin focus)."""
    m = (mode or "auto").strip().lower()
    if m in ("keys", "key", "keystrokes"):
        return "keys"
    if m in ("insert", "inserttext", "paste"):
        return "insert"
    if m != "auto":
        raise ValueError("mode must be auto, keys or insert")
    focused = [f for f in focus_frames if f.get("hasFocus") and f.get("active")]
    # The deepest focused frame is the one whose active element isn't an iframe.
    leaf = [f for f in focused if (f["active"].get("tag") or "").upper() not in ("IFRAME", "FRAME")]
    if not leaf:
        return "keys"
    a = leaf[-1]["active"]
    return "insert" if a.get("plainText") else "keys"
