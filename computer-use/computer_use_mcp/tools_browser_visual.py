"""Graphical browser tools: see and drive VM consoles, remote desktops and
canvas apps inside a Chrome tab with real (CDP) mouse and keyboard input.

The loop the model runs: browser_visual_inspect (look) -> browser_click_xy /
browser_type_trusted / browser_key_press (act, verify=True returns a fresh
image) -> check -> retry or replan. Coordinates are measured on the latest
inspect image; the math lives in browser_visual.py.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP, Image

from computer_use_mcp import browser_visual as bv
from computer_use_mcp.browser_bridge import bridge

UPGRADE_HINT = (
    "The connected Chrome extension predates graphical (VM) control. Reload it at "
    "chrome://extensions (needs Cindro extension >= 0.6.0 or the computer-use bridge "
    ">= 0.3.0; packaging/install.sh re-stages it)."
)
MAX_TYPE_CHARS = 20000


def _err(exc: Exception) -> list:
    return [json.dumps({"error": str(exc)})]


async def _send(method: str, params: dict, timeout: Optional[float] = None) -> Any:
    try:
        return await bridge.send_command(method, params, timeout=timeout)
    except RuntimeError as exc:
        if f"unknown method {method}" in str(exc):
            raise RuntimeError(UPGRADE_HINT) from exc
        raise


def _image(data_url: str) -> Image:
    if "," not in (data_url or ""):
        raise RuntimeError("extension returned no image")
    head, b64 = data_url.split(",", 1)
    return Image(data=base64.b64decode(b64), format="jpeg" if "jpeg" in head else "png")


def _main_frame(frames: list[dict]) -> dict:
    for f in frames or []:
        if f.get("frameId") == 0:
            return f
    return (frames or [{}])[0]


def _inspect_meta(insp: bv.Inspection, res: dict) -> dict:
    meta = insp.public()
    main = _main_frame(res.get("frames") or [])
    meta.update({
        "title": res.get("title"),
        "url": res.get("url"),
        "device_pixel_ratio": res.get("devicePixelRatio"),
        "browser_zoom": res.get("zoom"),
        "fullscreen": res.get("fullscreen"),
        "page_has_focus": main.get("hasFocus"),
        "focused_element": main.get("active"),
        "surfaces": bv.describe_surfaces(insp),
    })
    meta.update(bv.assess_graphical(insp.surfaces, insp.viewport_w, insp.viewport_h))
    if insp.origin_x or insp.origin_y or insp.image_w < round(insp.viewport_w * insp.scale_x) - 1:
        meta["zoomed_region"] = True
        meta["note"] = ("This image shows only part of the tab. Coordinates on it are valid; "
                        "inspect again without region/surface to act elsewhere.")
    return meta


def _capture_params(max_width: int, max_height: int, grid: bool, fmt: str,
                    clip: Optional[dict] = None) -> dict:
    fmt = (fmt or "png").lower()
    if fmt not in ("png", "jpeg"):
        raise ValueError("format must be png or jpeg")
    p = {"maxWidth": max(64, min(int(max_width), 4096)),
         "maxHeight": max(64, min(int(max_height), 4096)),
         "grid": bool(grid), "format": fmt}
    if clip:
        p["clip"] = clip
        p["upscale"] = True
    return p


async def inspect(tab_id: Optional[int] = None, *, max_width: int = 1280, max_height: int = 1280,
                  clip: Optional[dict] = None, grid: bool = False, fmt: str = "png") -> tuple[bv.Inspection, dict]:
    capture = _capture_params(max_width, max_height, grid, fmt, clip)
    res = await _send("page.inspect", dict(capture, tabId=tab_id), timeout=45)
    insp = bv.inspection_from_capture(res, tab_id if tab_id is not None else res.get("tabId"), capture)
    return insp, res


class _Ctx:
    """Resolved target of one action: tab, inspection (may be None), space."""

    def __init__(self, tab_id: Optional[int], inspect_id: Optional[str], coord_space: str):
        self.space = bv.normalize_space(coord_space)
        self.insp = bv.store.get(inspect_id, None if inspect_id else tab_id)
        if inspect_id:
            if tab_id is not None and self.insp.tab_id != tab_id:
                raise ValueError(f"inspect_id {inspect_id} belongs to tab {self.insp.tab_id}, "
                                 f"not tab {tab_id}")
            self.tab = self.insp.tab_id
        else:
            self.tab = bv.store.default_tab(tab_id)
        self.held = bv.store.held.get(self.tab, 0) if self.tab is not None else 0

    def point(self, x: float, y: float, surface: Optional[str] = None) -> tuple[float, float]:
        return bv.resolve_point(self.insp, x, y, self.space, surface)

    def expect_viewport(self) -> Optional[dict]:
        if self.insp is None or self.space == "viewport":
            return None
        exp = {"width": self.insp.viewport_w, "height": self.insp.viewport_h}
        if self.insp.scroll_x is not None:
            exp.update(scrollX=self.insp.scroll_x, scrollY=self.insp.scroll_y)
        return exp


async def _dispatch(ctx: _Ctx, events: list[dict], *, pointer: Optional[tuple[float, float]],
                    release: list[dict], verify: bool, settle_ms: int,
                    summary: dict) -> list:
    params: dict = {"tabId": ctx.tab, "events": events, "releaseOnError": release,
                    "expectViewport": ctx.expect_viewport()}
    if pointer:
        params["pointer"] = {"x": pointer[0], "y": pointer[1]}
    settle = max(0, min(int(settle_ms), 10000))
    if verify:
        cap = dict(ctx.insp.capture) if ctx.insp else _capture_params(1280, 1280, False, "png")
        params["verify"] = dict(cap, settleMs=settle)
    timeout = bv.sequence_timeout(events) + (settle / 1000.0 + 15 if verify else 0)
    res = await _send("input.sequence", params, timeout=timeout)
    tab = res.get("tabId", ctx.tab)
    out = {"ok": True, "tab_id": tab, "dispatched": res.get("dispatched")}
    out.update(summary)
    if pointer:
        bv.store.last_point[tab] = pointer
    if not verify or not res.get("verify"):
        return [json.dumps(out)]
    v = res["verify"]
    insp = bv.inspection_from_capture(v, tab, params["verify"])
    ratio = v.get("changeRatio")
    out["verify"] = {
        "screen_changed": bool(ratio is not None and ratio > 0.002),
        "change_ratio": round(ratio, 4) if ratio is not None else None,
        "settle_ms": settle,
        **_inspect_meta(insp, v),
        "next": "Coordinates now refer to THIS image. Confirm the intended change is "
                "visible; if not, re-target and retry.",
    }
    return [_image(v.get("dataUrl", "")), json.dumps(out)]


def _image_point(ctx: _Ctx, cx: float, cy: float) -> Optional[list]:
    if ctx.insp is None:
        return None
    ix, iy = ctx.insp.css_to_image(cx, cy)
    return [round(ix, 1), round(iy, 1)]


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    async def browser_visual_inspect(
        tab_id: Optional[int] = None,
        max_width: int = 1280,
        max_height: int = 1280,
        surface: Optional[str] = None,
        region_x: Optional[float] = None,
        region_y: Optional[float] = None,
        region_w: Optional[float] = None,
        region_h: Optional[float] = None,
        region_space: str = "image",
        grid: bool = False,
        format: str = "png",
    ) -> list:
        """LOOK at a tab as pixels — use for VMs/remote desktops in Chrome (noVNC,
        Proxmox/Guacamole/SPICE/VMware consoles), canvas apps, or anything
        browser_snapshot can't see into. Returns a screenshot plus metadata:
        inspect_id, the graphical surfaces found in every frame (kind e.g.
        novnc/guacamole/canvas, rect_image, guest framebuffer size, focus) and
        whether the page is 'graphical'. Measure x/y on THIS image and pass them
        to browser_click_xy / browser_drag_xy / browser_scroll_xy (coord_space=
        'image', the default). DPR, browser zoom, iframes and letterboxing are
        handled for you. To read small console text, zoom in: surface='s1' (a
        surface id from the metadata) or region_x/y/w/h (in coordinates of the
        previous image) returns a magnified crop — coordinates then refer to
        that crop. grid=True overlays a 100px labelled grid."""
        try:
            clip = None
            if surface or None not in (region_x, region_y, region_w, region_h):
                prev = bv.store.get(None, tab_id)
                if surface:
                    if prev is None:
                        raise ValueError("inspect the tab once before zooming into a surface")
                    s = prev.surface(surface)
                    vis = s.get("visible_css") or s.get("content_css")
                    if not vis:
                        raise ValueError(f"surface {surface} has no known on-screen rect")
                    clip = dict(vis)
                    tab_id = prev.tab_id
                else:
                    space = bv.normalize_space(region_space)
                    if space == "image":
                        if prev is None:
                            raise ValueError("region in image coordinates needs a previous "
                                             "inspection; or pass region_space='viewport'")
                        x0, y0 = prev.image_to_css(region_x, region_y)
                        x1, y1 = prev.image_to_css(region_x + region_w, region_y + region_h)
                        tab_id = prev.tab_id
                    elif space == "viewport":
                        x0, y0, x1, y1 = region_x, region_y, region_x + region_w, region_y + region_h
                    else:
                        raise ValueError("region_space must be image or viewport")
                    clip = {"x": min(x0, x1), "y": min(y0, y1),
                            "w": abs(x1 - x0), "h": abs(y1 - y0)}
            insp, res = await inspect(tab_id, max_width=max_width, max_height=max_height,
                                      clip=clip, grid=grid, fmt=format)
            return [_image(res.get("dataUrl", "")), json.dumps(_inspect_meta(insp, res))]
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_click_xy(
        x: float,
        y: float,
        button: str = "left",
        clicks: int = 1,
        modifiers: str = "",
        coord_space: str = "image",
        surface: Optional[str] = None,
        inspect_id: Optional[str] = None,
        tab_id: Optional[int] = None,
        verify: bool = False,
        settle_ms: int = 600,
    ) -> list:
        """Click at a POINT with real mouse input (CDP) — reaches into canvases,
        VM consoles and cross-origin iframes where DOM clicks can't. x/y are
        pixels on the latest browser_visual_inspect image (coord_space='image');
        'viewport' = page CSS px; 'surface' = guest framebuffer px of `surface`
        (e.g. the VM's own screen resolution). button: left/right/middle;
        clicks=2 double-clicks; modifiers e.g. 'shift' or 'ctrl+shift' are held
        as real keys (VMs see them). verify=True waits settle_ms and returns a
        new screenshot + whether the screen changed. Defaults to the most
        recently inspected tab."""
        try:
            ctx = _Ctx(tab_id, inspect_id, coord_space)
            cx, cy = ctx.point(x, y, surface)
            down, mask = bv.modifier_names_events(modifiers, True)
            up, _ = bv.modifier_names_events(modifiers, False, mask)
            b = bv.button_name(button)
            events = down + bv.click_events(cx, cy, b, clicks, mask, ctx.held) + up
            return await _dispatch(
                ctx, events, pointer=(cx, cy),
                release=bv.release_all_events(cx, cy, ctx.held | bv.BUTTONS[b]),
                verify=verify, settle_ms=settle_ms,
                summary={"clicked": {"button": b, "clicks": max(1, min(int(clicks), 3)),
                                     "point_css": [cx, cy], "point_image": _image_point(ctx, cx, cy)}})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_move_xy(
        x: float,
        y: float,
        steps: int = 8,
        coord_space: str = "image",
        surface: Optional[str] = None,
        inspect_id: Optional[str] = None,
        tab_id: Optional[int] = None,
        verify: bool = False,
        settle_ms: int = 600,
    ) -> list:
        """Move the mouse (hover) to a point with real input — opens hover menus
        and tooltips, moves the VM's pointer. Glides from the last position in
        `steps` moves; held buttons (browser_mouse_down) stay held."""
        try:
            ctx = _Ctx(tab_id, inspect_id, coord_space)
            cx, cy = ctx.point(x, y, surface)
            last = bv.store.last_point.get(ctx.tab)
            events = bv.move_events(cx, cy, ctx.held, from_xy=last, steps=max(1, min(int(steps), 100)))
            return await _dispatch(ctx, events, pointer=(cx, cy),
                                   release=bv.release_all_events(cx, cy, ctx.held),
                                   verify=verify, settle_ms=settle_ms,
                                   summary={"moved_to_css": [cx, cy],
                                            "buttons_held": ctx.held})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_drag_xy(
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        button: str = "left",
        steps: int = 12,
        hold_ms: int = 0,
        modifiers: str = "",
        coord_space: str = "image",
        surface: Optional[str] = None,
        inspect_id: Optional[str] = None,
        tab_id: Optional[int] = None,
        verify: bool = False,
        settle_ms: int = 600,
    ) -> list:
        """Real drag: press at (x1,y1), glide to (x2,y2) in `steps` moves with
        the button held, pause hold_ms, release. Works for window moves inside
        a VM, sliders, selections, file drags, canvas drawing."""
        try:
            ctx = _Ctx(tab_id, inspect_id, coord_space)
            ax, ay = ctx.point(x1, y1, surface)
            bx, by = ctx.point(x2, y2, surface)
            down, mask = bv.modifier_names_events(modifiers, True)
            up, _ = bv.modifier_names_events(modifiers, False, mask)
            b = bv.button_name(button)
            events = down + bv.drag_events(ax, ay, bx, by, b, steps, hold_ms, mask) + up
            return await _dispatch(ctx, events, pointer=(bx, by),
                                   release=bv.release_all_events(bx, by, bv.BUTTONS[b]),
                                   verify=verify, settle_ms=settle_ms,
                                   summary={"dragged_css": [[ax, ay], [bx, by]], "button": b})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_scroll_xy(
        x: float,
        y: float,
        direction: str = "down",
        amount: int = 3,
        modifiers: str = "",
        coord_space: str = "image",
        surface: Optional[str] = None,
        inspect_id: Optional[str] = None,
        tab_id: Optional[int] = None,
        verify: bool = False,
        settle_ms: int = 600,
    ) -> list:
        """Scroll the wheel at a point (amount = notches; up/down/left/right) —
        scrolls whatever is under that point, e.g. a window inside the VM or a
        canvas map. One wheel event per notch so VNC/RDP clients see each."""
        try:
            ctx = _Ctx(tab_id, inspect_id, coord_space)
            cx, cy = ctx.point(x, y, surface)
            down, mask = bv.modifier_names_events(modifiers, True)
            up, _ = bv.modifier_names_events(modifiers, False, mask)
            events = down + bv.wheel_events(cx, cy, direction, amount, mask, ctx.held) + up
            return await _dispatch(ctx, events, pointer=(cx, cy),
                                   release=bv.release_all_events(cx, cy, ctx.held),
                                   verify=verify, settle_ms=settle_ms,
                                   summary={"scrolled": {"direction": direction, "notches": amount,
                                                         "point_css": [cx, cy]}})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_mouse_down(
        x: float,
        y: float,
        button: str = "left",
        coord_space: str = "image",
        surface: Optional[str] = None,
        inspect_id: Optional[str] = None,
        tab_id: Optional[int] = None,
    ) -> list:
        """Press and HOLD a mouse button at a point (for custom drags / long
        presses: then browser_move_xy, then browser_mouse_up). Always release;
        browser_input_release frees anything stuck."""
        try:
            ctx = _Ctx(tab_id, inspect_id, coord_space)
            cx, cy = ctx.point(x, y, surface)
            events, now = bv.press_events(cx, cy, button, ctx.held)
            out = await _dispatch(ctx, events, pointer=(cx, cy),
                                  release=bv.release_all_events(cx, cy, now),
                                  verify=False, settle_ms=0,
                                  summary={"pressed": bv.button_name(button), "point_css": [cx, cy]})
            tab = json.loads(out[-1]).get("tab_id", ctx.tab)
            bv.store.held[tab] = now
            return out
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_mouse_up(
        x: Optional[float] = None,
        y: Optional[float] = None,
        button: str = "left",
        coord_space: str = "image",
        surface: Optional[str] = None,
        inspect_id: Optional[str] = None,
        tab_id: Optional[int] = None,
        verify: bool = False,
        settle_ms: int = 600,
    ) -> list:
        """Release a held mouse button (at x/y, or where the pointer last was)."""
        try:
            ctx = _Ctx(tab_id, inspect_id, coord_space)
            if x is not None and y is not None:
                cx, cy = ctx.point(x, y, surface)
            else:
                last = bv.store.last_point.get(ctx.tab)
                if last is None:
                    raise ValueError("no known pointer position — pass x and y")
                cx, cy = last
            events, now = bv.release_events(cx, cy, button, ctx.held)
            out = await _dispatch(ctx, events, pointer=(cx, cy), release=[],
                                  verify=verify, settle_ms=settle_ms,
                                  summary={"released": bv.button_name(button), "point_css": [cx, cy]})
            tab = json.loads(out[-1]).get("tab_id", ctx.tab)
            bv.store.held[tab] = now
            return out
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_key_press(
        keys: str,
        repeat: int = 1,
        hold_ms: int = 0,
        tab_id: Optional[int] = None,
        verify: bool = False,
        settle_ms: int = 600,
    ) -> list:
        """Press real keys/shortcuts in the tab (key-down/key-up with correct
        key, code and modifiers) — reaches VM consoles and canvas apps, which
        receive them as the guest's own keyboard: 'enter', 'ctrl+alt+delete',
        'win+r', 'alt+tab', 'ctrl+shift+esc', 'alt+f4', 'f2'. Separate several
        presses with spaces: 'ctrl+a ctrl+c'. repeat presses the whole sequence
        again; hold_ms keeps the last key down. Goes to the element focused in
        the page — click the console first if needed."""
        try:
            ctx = _Ctx(tab_id, None, "viewport")
            seq = bv.parse_key_sequence(keys)
            repeat = max(1, min(int(repeat), 100))
            events: list[dict] = []
            for _ in range(repeat):
                for combo in seq:
                    evs = bv.combo_events(combo, hold_ms=hold_ms)
                    if events:
                        evs[0]["delayMs"] = 30
                    events.extend(evs)
            return await _dispatch(ctx, events, pointer=None,
                                   release=bv.release_modifier_events(),
                                   verify=verify, settle_ms=settle_ms,
                                   summary={"pressed": seq, "repeat": repeat})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_type_trusted(
        text: str,
        mode: str = "auto",
        delay_ms: int = 12,
        submit: bool = False,
        x: Optional[float] = None,
        y: Optional[float] = None,
        coord_space: str = "image",
        tab_id: Optional[int] = None,
        verify: bool = False,
        settle_ms: int = 600,
    ) -> list:
        """Type text with REAL keyboard input into whatever is focused — a VM
        console (noVNC/Guacamole/SPICE), a terminal, a canvas editor, or a
        normal field. mode 'keys' sends a key-down/up per character (what
        remote consoles need); 'insert' commits text in one go (fast, for
        normal text fields/editors); 'auto' picks insert only for a plain
        focused text field. Pass x/y to click there first to focus. '\\n'
        presses Enter; submit=True presses Enter at the end. Raise delay_ms if
        a slow VM drops characters."""
        try:
            if text is None or len(text) > MAX_TYPE_CHARS:
                raise ValueError(f"text must be 1..{MAX_TYPE_CHARS} characters")
            ctx = _Ctx(tab_id, None, coord_space)
            events: list[dict] = []
            pointer = None
            if x is not None and y is not None:
                pointer = ctx.point(x, y)
                events += bv.click_events(pointer[0], pointer[1], "left", 1, 0, ctx.held)
            chosen = (mode or "auto").strip().lower()
            if chosen == "auto" and not events:
                try:
                    info = await _send("page.focus", {"tabId": ctx.tab}, timeout=10)
                    chosen = bv.pick_type_mode("auto", info.get("frames") or [])
                except Exception:
                    chosen = "keys"
            elif chosen == "auto":
                chosen = "keys"   # focus is about to move with the click; keys always land
            else:
                chosen = bv.pick_type_mode(chosen, [])
            delay = max(0, min(int(delay_ms), 1000))
            typed = bv.text_events(text, delay) if chosen == "keys" else bv.insert_text_events(text)
            if events and typed:
                typed[0]["delayMs"] = max(int(typed[0].get("delayMs") or 0), 120)
            events += typed
            if submit:
                sub = bv.combo_events("enter")
                sub[0]["delayMs"] = 40
                events += sub
            return await _dispatch(ctx, events, pointer=pointer,
                                   release=bv.release_modifier_events(),
                                   verify=verify, settle_ms=settle_ms,
                                   summary={"typed_chars": len(text), "mode": chosen,
                                            "submitted": bool(submit)})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_input_release(tab_id: Optional[int] = None) -> list:
        """Recovery: release every held mouse button and modifier key in the tab
        (use if a drag or shortcut was interrupted and the VM acts as if
        shift/ctrl or the mouse is stuck down)."""
        try:
            ctx = _Ctx(tab_id, None, "viewport")
            x, y = bv.store.last_point.get(ctx.tab, (0, 0))
            held = ctx.held or sum(bv.BUTTONS.values())
            out = await _dispatch(ctx, bv.release_all_events(x, y, held), pointer=None,
                                  release=[], verify=False, settle_ms=0,
                                  summary={"released": "all"})
            tab = json.loads(out[-1]).get("tab_id", ctx.tab)
            bv.store.held.pop(tab, None)
            return out
        except Exception as exc:
            return _err(exc)


async def graphical_hint(tab_id: Optional[int]) -> Optional[dict]:
    """Cheap (no screenshot) check used by browser_snapshot: does this tab show
    a VM console/canvas the DOM refs can't reach? None if unknown."""
    try:
        res = await bridge.send_command("page.surfaces", {"tabId": tab_id}, timeout=4)
    except Exception:
        return None
    vp = res.get("viewport") or {}
    vw, vh = float(vp.get("width") or 0), float(vp.get("height") or 0)
    if not vw or not vh:
        return None
    surfaces = bv.compose_surfaces(res.get("frames") or [], vw, vh)
    verdict = bv.assess_graphical(surfaces, vw, vh)
    if not verdict.get("graphical"):
        return None
    verdict["surfaces"] = [
        {"id": s["id"], "kind": s["kind"],
         "rect_css": {k: round(v) for k, v in (s.get("visible_css") or {}).items()}}
        for s in surfaces[:6]]
    return verdict
