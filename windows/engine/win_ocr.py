"""On-screen text reading via the built-in Windows OCR engine (Windows.Media.Ocr).

Web apps like Excel for the web draw their grid in the browser: there is no COM
object model, and the accessibility tree rarely exposes individual cells. OCR
gives the model the actual text on screen WITH desktop-pixel boxes, so it can
read values and click "the cell that says Total" instead of estimating pixels.

Offline, no model download -- Windows 10/11 ship the engine (it uses the user's
installed language packs). Accessed through the pywinrt projection
(``winrt-Windows.Media.Ocr`` & friends).

WinRT wants its own (MTA) apartment, while UI Automation / Office COM put the
tool thread in an STA. So every recognition runs on ONE dedicated worker thread
that owns the WinRT apartment and its own asyncio loop. All imports are lazy:
the pure helpers (phrase matching, box mapping) are tested on Linux.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import re
import sys

import backend_windows as _bw

_POOL: concurrent.futures.ThreadPoolExecutor | None = None
_MAX_DIM = 4096          # stay well under OcrEngine.max_image_dimension after upscaling


def _pool() -> concurrent.futures.ThreadPoolExecutor:
    global _POOL
    if _POOL is None:
        _POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="winocr")
    return _POOL


def _winrt():
    if sys.platform != "win32":
        raise RuntimeError("Windows OCR requires Windows (sys.platform=='win32').")
    try:
        ocr = importlib.import_module("winrt.windows.media.ocr")
        imaging = importlib.import_module("winrt.windows.graphics.imaging")
        streams = importlib.import_module("winrt.windows.storage.streams")
        glob = importlib.import_module("winrt.windows.globalization")
        importlib.import_module("winrt.windows.foundation.collections")
    except ImportError as exc:
        raise RuntimeError(
            "Windows OCR support (pywinrt winrt-Windows.Media.Ocr) is missing from this "
            f"engine build ({exc}).") from exc
    return ocr, imaging, streams, glob


async def _recognize(rgba: bytes, w: int, h: int, lang: str | None):
    ocr, imaging, streams, glob = _winrt()
    if lang:
        language = glob.Language(lang)
        if not ocr.OcrEngine.is_language_supported(language):
            raise RuntimeError(
                f"OCR language {lang!r} isn't installed. Install it with (admin PowerShell): "
                f'Add-WindowsCapability -Online -Name "Language.OCR~~~{lang}~0.0.1.0"')
        engine = ocr.OcrEngine.try_create_from_language(language)
    else:
        engine = ocr.OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("No Windows OCR language is installed for this user "
                           "(Settings > Time & language > Language > add English).")
    writer = streams.DataWriter()
    writer.write_bytes(rgba)
    bmp = imaging.SoftwareBitmap.create_copy_from_buffer(
        writer.detach_buffer(), imaging.BitmapPixelFormat.RGBA8, w, h)
    result = await engine.recognize_async(bmp)
    lines = []
    for line in result.lines:
        words = []
        for word in line.words:
            r = word.bounding_rect
            words.append((word.text, float(r.x), float(r.y), float(r.width), float(r.height)))
        lines.append((line.text, words))
    return lines


def _recognize_sync(rgba: bytes, w: int, h: int, lang: str | None):
    return asyncio.run(_recognize(rgba, w, h, lang))


def map_box(x: float, y: float, w: float, h: float, origin: tuple[int, int],
            scale: float) -> list[int]:
    """OCR box on the (upscaled) capture -> desktop pixels [x, y, w, h]."""
    return [round(origin[0] + x / scale), round(origin[1] + y / scale),
            max(1, round(w / scale)), max(1, round(h / scale))]


def union(boxes: list[list[int]]) -> list[int]:
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return [x0, y0, x1 - x0, y1 - y0]


def build_lines(raw, origin: tuple[int, int], scale: float) -> list[dict]:
    """[(line_text, [(word, x, y, w, h), ...]), ...] -> desktop-space dicts."""
    out = []
    for text, words in raw:
        wl = [{"text": t, "rect": map_box(x, y, w, h, origin, scale)} for t, x, y, w, h in words]
        if not wl:
            continue
        out.append({"text": text, "rect": union([w["rect"] for w in wl]), "words": wl})
    return out


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def find_phrase(lines: list[dict], text: str, exact: bool = False) -> list[dict]:
    """Every occurrence of `text` (one or more words, case/space-insensitive)
    inside an OCR line: the minimal run of words containing it (exact=True: the
    run must equal it), with the run's union box and centre."""
    target = _norm(text)
    if not target:
        raise ValueError("text is empty")
    span = len(target.split(" ")) + 2      # OCR may split/merge a word or two
    hits = []
    for li, line in enumerate(lines):
        words = line["words"]
        joined = lambda i, j: _norm(" ".join(w["text"] for w in words[i:j]))  # noqa: E731
        for i in range(len(words)):
            for j in range(i + 1, min(len(words), i + span) + 1):
                cand = joined(i, j)
                if exact:
                    ok = cand == target
                else:
                    # minimal: contains it, and dropping the first word loses it
                    ok = target in cand and not (j - i > 1 and target in joined(i + 1, j))
                if ok:
                    box = union([w["rect"] for w in words[i:j]])
                    hits.append({"text": " ".join(w["text"] for w in words[i:j]),
                                 "line": li, "rect": box,
                                 "center": [box[0] + box[2] // 2, box[1] + box[3] // 2]})
                    break
                if not exact and target in cand:
                    break      # not minimal from this start; a later start owns it
    return hits


def window_rect(window: str) -> dict:
    """Desktop rect of a window given by id ('win:123') or title substring."""
    import win_platform as _wp
    g = _wp._mod("win32gui")
    hwnd = _wp._resolve_hwnd(window)
    left, top, right, bottom = g.GetWindowRect(hwnd)
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}


def _capture_rect(region: dict | None, window: str | None) -> "_bw._screen.Rect":
    if window:
        r = window_rect(window)
    elif region:
        r = region
    else:
        info = _bw.get_session("active")
        r = info.bbox
    rect = _bw._screen.Rect(int(r["x"]), int(r["y"]), int(r["w"]), int(r["h"]))
    # Clip to the virtual desktop (maximized windows overhang by a few px).
    info = _bw.get_session("active")
    b = info.bbox
    x0, y0 = max(rect.x, b["x"]), max(rect.y, b["y"])
    x1 = min(rect.x + rect.w, b["x"] + b["w"])
    y1 = min(rect.y + rect.h, b["y"] + b["h"])
    if x1 <= x0 or y1 <= y0:
        raise RuntimeError("the requested area is off-screen")
    return _bw._screen.Rect(x0, y0, x1 - x0, y1 - y0)


def read(region: dict | None = None, window: str | None = None, scale: float = 2.0,
         lang: str | None = None) -> dict:
    """OCR an area (default: the whole desktop). Returns lines with desktop
    boxes. scale>1 upscales first -- small UI text (spreadsheet cells) reads far
    better at 2x."""
    from PIL import Image as PILImage

    rect = _capture_rect(region, window)
    img = _bw._grab_region(rect)
    scale = max(1.0, min(4.0, float(scale)))
    if max(img.width, img.height) * scale > _MAX_DIM:
        scale = max(1.0, _MAX_DIM / max(img.width, img.height))
    if scale != 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)), PILImage.LANCZOS)
    rgba = img.convert("RGBA")
    _winrt()   # fail fast with a clear message before hopping threads
    raw = _pool().submit(_recognize_sync, rgba.tobytes(), rgba.width, rgba.height,
                         lang).result(timeout=60)
    lines = build_lines(raw, (rect.x, rect.y), scale)
    return {"captured_rect": rect.as_dict(), "scale": round(scale, 3),
            "text": "\n".join(l["text"] for l in lines), "lines": lines}
