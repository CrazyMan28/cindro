"""On-screen text reading via the built-in Windows OCR engine (Windows.Media.Ocr).

Web apps like Excel for the web draw their grid in the browser: there is no COM
object model, and the accessibility tree rarely exposes individual cells. OCR
gives the model the actual text on screen WITH desktop-pixel boxes, so it can
read values and click "the cell that says Total" instead of estimating pixels.

Offline, no model download -- Windows 10/11 ship the engine (it uses the user's
installed language packs). Reached through Windows PowerShell 5.1's built-in
WinRT projection, in a child process, NOT through the pywinrt wheels: those
bundle their own msvcp140.dll, and loading it before onnxruntime (faster-whisper)
crashes the process (0xC0000005 -- the MSVC std::mutex ABI break). A separate
process also keeps WinRT's apartment away from the UIA/COM STA on the tool
thread. The pure helpers (phrase matching, box mapping) are tested on Linux.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile

import backend_windows as _bw

_MAX_DIM = 4096          # stay well under OcrEngine.MaxImageDimension after upscaling
_CREATE_NO_WINDOW = 0x08000000

# Windows PowerShell 5.1 (powershell.exe -- NOT pwsh 7, which has no WinRT
# projection). Writes [{t: line, w: [{t,x,y,w,h}, ...]}, ...] as UTF-8 JSON to
# -Out (a file, so non-ASCII text survives the console code page).
_PS_SCRIPT = r"""
param([string]$Path, [string]$Out, [string]$Lang)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(-1)
    $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    if ($Lang) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
    } else {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) { throw "NO_OCR_LANGUAGE" }
    $result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
        $words = @()
        foreach ($w in $line.Words) {
            $r = $w.BoundingRect
            $words += [pscustomobject]@{ t = $w.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
        }
        $lines += [pscustomobject]@{ t = $line.Text; w = $words }
    }
    $json = ConvertTo-Json -InputObject @($lines) -Depth 6 -Compress
    [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
} finally {
    $stream.Dispose()
}
"""
_SCRIPT_PATH: str | None = None


def _require_windows() -> None:
    if sys.platform != "win32":
        raise RuntimeError("Windows OCR requires Windows (sys.platform=='win32').")


def _script() -> str:
    global _SCRIPT_PATH
    if _SCRIPT_PATH is None or not os.path.exists(_SCRIPT_PATH):
        fd, path = tempfile.mkstemp(prefix="cindro-ocr-", suffix=".ps1")
        with os.fdopen(fd, "w", encoding="utf-8-sig") as f:
            f.write(_PS_SCRIPT)
        _SCRIPT_PATH = path
    return _SCRIPT_PATH


def parse_ps_output(text: str) -> list:
    """The script's JSON -> [(line_text, [(word, x, y, w, h), ...]), ...].
    Tolerates PowerShell 5.1 collapsing a one-element array to an object."""
    data = json.loads(text) if text.strip() else []
    if isinstance(data, dict):
        data = [data]
    out = []
    for line in data or []:
        words = line.get("w") or []
        if isinstance(words, dict):
            words = [words]
        out.append((str(line.get("t", "")),
                    [(str(w.get("t", "")), float(w["x"]), float(w["y"]),
                      float(w["w"]), float(w["h"])) for w in words]))
    return out


def _recognize(png_path: str, lang: str | None):
    _require_windows()
    out = png_path + ".json"
    args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", _script(), "-Path", png_path, "-Out", out]
    if lang:
        args += ["-Lang", lang]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=60,
                              creationflags=_CREATE_NO_WINDOW)
        if proc.returncode != 0 or not os.path.exists(out):
            err = (proc.stderr or proc.stdout or "").strip()
            if "NO_OCR_LANGUAGE" in err:
                raise RuntimeError(
                    (f"OCR language {lang!r} isn't installed. Install it with (admin PowerShell): "
                     f'Add-WindowsCapability -Online -Name "Language.OCR~~~{lang}~0.0.1.0"')
                    if lang else
                    "No Windows OCR language is installed for this user "
                    "(Settings > Time & language > Language > add English).")
            raise RuntimeError(f"Windows OCR failed: {err[-600:] or f'rc={proc.returncode}'}")
        with open(out, encoding="utf-8-sig") as f:
            return parse_ps_output(f.read())
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


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

    _require_windows()
    rect = _capture_rect(region, window)
    img = _bw._grab_region(rect)
    scale = max(1.0, min(4.0, float(scale)))
    if max(img.width, img.height) * scale > _MAX_DIM:
        scale = max(1.0, _MAX_DIM / max(img.width, img.height))
    if scale != 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)), PILImage.LANCZOS)
    fd, png = tempfile.mkstemp(prefix="cindro-ocr-", suffix=".png")
    os.close(fd)
    try:
        img.convert("RGB").save(png, format="PNG")
        raw = _recognize(png, lang)
    finally:
        try:
            os.remove(png)
        except OSError:
            pass
    lines = build_lines(raw, (rect.x, rect.y), scale)
    return {"captured_rect": rect.as_dict(), "scale": round(scale, 3),
            "text": "\n".join(l["text"] for l in lines), "lines": lines}
