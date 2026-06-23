"""Screenshots and the image -> desktop coordinate transform.

Capture backends (probed once per session kind, overridable via config):
  - sway: grim (wlr screencopy; supports -g region and -c cursor natively)
  - KDE:  spectacle -b -n (this KWin lacks the screencopy protocols grim
    speaks — verified), which captures the full virtual desktop only, so
    output/region shots are PIL-cropped from the full image.

Every screenshot records LAST_SHOT = {origin, scale, ...} so mouse tools can
accept coordinates measured on the (possibly downscaled) image and map them
back to desktop pixels: desktop = origin + image_xy / scale.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import threading
import time

from computer_use_mcp import session
from computer_use_mcp.config import load_config

_LOCK = threading.Lock()
LAST_SHOT: dict | None = None

_GRIM_WORKS: dict[str, bool] = {}  # session kind -> probe result
IMAGE_COORD_MAX_AGE = 120  # seconds before image-space clicks demand a re-shot


class Rect:
    def __init__(self, x: int, y: int, w: int, h: int):
        self.x, self.y, self.w, self.h = int(x), int(y), int(w), int(h)

    def as_dict(self) -> dict:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


def _grim_capture(info: session.SessionInfo, rect: Rect | None, cursor: bool) -> bytes:
    cmd = ["grim", "-t", "png"]
    if cursor:
        cmd.append("-c")
    if rect is not None:
        cmd += ["-g", f"{rect.x},{rect.y} {rect.w}x{rect.h}"]
    cmd.append("-")
    proc = subprocess.run(cmd, capture_output=True, timeout=20, env=info.env())
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"grim failed: {proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout


def _spectacle_capture(info: session.SessionInfo, cursor: bool) -> bytes:
    fd, fname = tempfile.mkstemp(suffix=".png", prefix="computer-use-")
    os.close(fd)
    try:
        cmd = ["spectacle", "-b", "-n", "-o", fname]
        if cursor:
            cmd.append("-p")
        proc = subprocess.run(cmd, capture_output=True, timeout=30, env=info.env())
        try:
            with open(fname, "rb") as f:
                data = f.read()
        except OSError:
            data = b""
        if not data:
            raise RuntimeError(
                f"spectacle produced no image: {proc.stderr.decode(errors='replace').strip()}"
            )
        return data
    finally:
        if os.path.exists(fname):
            os.unlink(fname)


def _grim_available(info: session.SessionInfo) -> bool:
    pref = load_config()["screenshot_tool"]
    if pref == "grim":
        return True
    if pref == "spectacle":
        return False
    if info.kind not in _GRIM_WORKS:
        try:
            probe = info.outputs[0] if info.outputs else None
            rect = Rect(probe.x, probe.y, 16, 16) if probe else None
            _grim_capture(info, rect, cursor=False)
            _GRIM_WORKS[info.kind] = True
        except Exception:
            _GRIM_WORKS[info.kind] = False
    return _GRIM_WORKS[info.kind]


def take_screenshot(
    output: str | None = None,
    region: dict | None = None,
    max_width: int | None = None,
    include_cursor: bool = False,
    which: str = "active",
) -> tuple[bytes, dict]:
    """Capture and downscale; returns (png_bytes, metadata dict)."""
    from PIL import Image as PILImage

    info = session.get_session(which)
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
        rect = Rect(out.x, out.y, out.w, out.h)
    elif region:
        rect = Rect(region["x"], region["y"], region["w"], region["h"])
    else:
        rect = Rect(bbox["x"], bbox["y"], bbox["w"], bbox["h"])

    if _grim_available(info):
        png = _grim_capture(info, rect, include_cursor)
        img = PILImage.open(io.BytesIO(png))
    else:
        png = _spectacle_capture(info, include_cursor)
        img = PILImage.open(io.BytesIO(png))
        # spectacle covers the full desktop; crop unless the full bbox was asked
        if (rect.x, rect.y, rect.w, rect.h) != (bbox["x"], bbox["y"], bbox["w"], bbox["h"]):
            img = img.crop((
                rect.x - bbox["x"], rect.y - bbox["y"],
                rect.x - bbox["x"] + rect.w, rect.y - bbox["y"] + rect.h,
            ))

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
    global LAST_SHOT
    with _LOCK:
        LAST_SHOT = shot

    meta = {
        "coord_space": "image",
        "note": "Coordinates measured on THIS image are accepted directly by "
                "mouse_move/mouse_click/mouse_drag/scroll (coord_space='image', the default).",
        "captured_rect": rect.as_dict(),
        "image_size": {"w": scaled_w, "h": scaled_h},
        "scale": round(scale, 5),
        "session": info.kind,
        "output": output,
        "include_cursor": include_cursor,
        "outputs": [o.as_dict() for o in info.outputs],
    }
    return png, meta


def _capture_png(info: session.SessionInfo, rect: Rect | None,
                 cursor: bool) -> bytes:
    """One raw PNG capture for the given session, choosing grim vs spectacle.
    Shared by take_screenshot() and the video source."""
    if _grim_available(info):
        return _grim_capture(info, rect, cursor)
    return _spectacle_capture(info, cursor)


def grab_jpeg_frame(which: str = "agent", *, width: int | None = None,
                    quality: int = 70, include_cursor: bool = False) -> bytes:
    """Capture a single frame of the session and JPEG-encode it (Pillow).

    Used by GET /video/frame and as the per-frame engine of video_source().
    For which in ('sway','agent') this grabs the wlroots output via grim over the
    session's own WAYLAND_DISPLAY; for 'kde' it falls back to spectacle (NOTE:
    spectacle cannot see layer-shell overlays — the daemon should stream the
    nested 'agent' desktop, per spikes/RESULTS.md)."""
    from PIL import Image as PILImage

    info = session.get_session(which)
    if not info.outputs:
        raise RuntimeError(
            info.outputs_unavailable_reason
            or f"Session {info.kind} reports no outputs — cannot capture video."
        )
    bbox = info.bbox
    rect = Rect(bbox["x"], bbox["y"], bbox["w"], bbox["h"])
    png = _capture_png(info, rect, include_cursor)
    img = PILImage.open(io.BytesIO(png)).convert("RGB")
    if width and img.width > width:
        img.thumbnail((width, 10_000_000), PILImage.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(quality))
    return buf.getvalue()


def video_source(which: str = "agent", *, fps: float = 6.0,
                 width: int | None = None, quality: int = 70,
                 include_cursor: bool = False, max_frames: int | None = None):
    """Generator yielding JPEG-encoded frames of the (agent or active) output.

    Drives grab_jpeg_frame() on a fixed cadence (configurable fps/width/quality).
    The default which='agent' streams the nested headless-Sway desktop via grim
    (the live-video source the daemon re-publishes over the device channel). On a
    transient capture error the frame is skipped (the desktop may be briefly
    unavailable) rather than killing the stream. Stops after max_frames if set."""
    period = 1.0 / max(0.5, float(fps))
    if width is None:
        width = int(load_config().get("video_width", 1280))
    count = 0
    while True:
        start = time.monotonic()
        try:
            yield grab_jpeg_frame(which, width=width, quality=quality,
                                  include_cursor=include_cursor)
        except Exception:
            # Skip a bad frame (compositor not ready / transient grim error).
            pass
        count += 1
        if max_frames is not None and count >= max_frames:
            return
        elapsed = time.monotonic() - start
        if elapsed < period:
            time.sleep(period - elapsed)


def map_to_desktop(x: float, y: float, coord_space: str = "image",
                   which: str = "active") -> tuple[int, int]:
    """Map a tool-supplied coordinate to global desktop pixels and validate it
    against the TARGET session's monitors. For the default real path that target
    is the ACTIVE session (uinput input lands there); for which='agent' it is the
    nested headless-Sway desktop the co-worker brain drives."""
    target = session.get_session(which)

    if coord_space == "desktop":
        gx, gy = float(x), float(y)
    elif coord_space.startswith("output:"):
        name = coord_space.split(":", 1)[1]
        out = next((o for o in target.outputs if o.name.lower() == name.lower()), None)
        if out is None:
            raise RuntimeError(
                f"Unknown output {name!r}. Available: {[o.name for o in target.outputs]}"
            )
        gx, gy = out.x + float(x), out.y + float(y)
    elif coord_space == "image":
        with _LOCK:
            shot = LAST_SHOT
        if shot is None:
            raise RuntimeError(
                "No screenshot taken yet. Call desktop_screenshot first and use "
                "its image coordinates, or pass coord_space='desktop'."
            )
        if time.time() - shot["taken_at"] > IMAGE_COORD_MAX_AGE:
            raise RuntimeError(
                f"Last screenshot is older than {IMAGE_COORD_MAX_AGE}s — take a fresh "
                "desktop_screenshot before clicking by image coordinates."
            )
        if shot["session_kind"] != target.kind:
            raise RuntimeError(
                f"Last screenshot captured the {shot['session_kind']} session, but this "
                f"input targets the {target.kind} session. Screenshot the {target.kind} "
                "session (the same 'which') and use coordinates from that image."
            )
        gx = shot["origin"][0] + float(x) / shot["scale"]
        gy = shot["origin"][1] + float(y) / shot["scale"]
    else:
        raise RuntimeError(
            f"Unknown coord_space {coord_space!r}: use 'image', 'desktop', or 'output:NAME'."
        )

    if target.outputs and not any(o.contains(gx, gy) for o in target.outputs):
        rects = "; ".join(f"{o.name}: {o.x},{o.y} {o.w}x{o.h}" for o in target.outputs)
        raise RuntimeError(
            f"Point ({gx:.0f},{gy:.0f}) lands outside every monitor (dead zone in the "
            f"layout). Monitors: {rects}"
        )
    return round(gx), round(gy)
