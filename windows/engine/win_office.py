"""Desktop Microsoft Office (Excel / Word / PowerPoint) via COM automation.

When the desktop Office apps are installed, driving them through their object
model is exact and fast: read/write a whole range in one call, find/replace in a
document, add a slide -- no pixel hunting. (Excel for the WEB in a browser is
NOT reachable this way; use the sheet_* / mouse / keyboard tools for that.)

pywin32 late binding (``win32com.client.Dispatch`` / ``GetActiveObject``) --
no makepy/gencache, which is fragile in a frozen PyInstaller build. Imported
LAZILY so the module imports on Linux for the test-suite.
"""

from __future__ import annotations

import datetime as _dt
import importlib
import os
import sys

import backend_windows as _bw

PROGIDS = {"excel": "Excel.Application", "word": "Word.Application",
           "powerpoint": "PowerPoint.Application"}
_EXT_APP = {".xlsx": "excel", ".xlsm": "excel", ".xls": "excel", ".csv": "excel",
            ".docx": "word", ".doc": "word", ".rtf": "word", ".txt": "word",
            ".pptx": "powerpoint", ".ppt": "powerpoint"}
_MAX_CELLS = 20_000


def _com():
    if sys.platform != "win32":
        raise RuntimeError("Office COM automation requires Windows (sys.platform=='win32').")
    if _bw.in_sandbox():
        raise RuntimeError("Office isn't available inside the isolated agent box; "
                           "Office tools only drive the host's desktop apps.")
    pythoncom = importlib.import_module("pythoncom")
    pythoncom.CoInitialize()
    return importlib.import_module("win32com.client")


def installed(app: str) -> bool:
    if sys.platform != "win32":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, PROGIDS[app] + r"\CLSID"):
            return True
    except OSError:
        return False


def _running(app: str):
    client = _com()
    try:
        return client.GetActiveObject(PROGIDS[app])
    except Exception:
        return None


def _app(app: str, create: bool = True):
    obj = _running(app)
    if obj is not None:
        return obj
    if not create:
        raise RuntimeError(f"{app} isn't running -- open a file first (office_open) "
                           "or pass create=True")
    if not installed(app):
        raise RuntimeError(f"Microsoft {app.title()} (desktop) isn't installed here. "
                           "For Excel/Word/PowerPoint on the web, use the browser + "
                           "sheet_*/mouse/keyboard tools instead.")
    obj = _com().Dispatch(PROGIDS[app])
    obj.Visible = True
    return obj


def plain(v):
    """COM values -> JSON-safe (pywintypes datetimes, tuples-of-tuples, ...)."""
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    if isinstance(v, (_dt.datetime, _dt.date)):
        return v.isoformat()
    if hasattr(v, "isoformat"):                 # pywintypes.datetime
        try:
            return v.isoformat()
        except Exception:
            return str(v)
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def as_2d(v) -> list[list]:
    """Range.Value is a scalar for one cell, else a tuple of row tuples."""
    if isinstance(v, (list, tuple)):
        return [list(r) if isinstance(r, (list, tuple)) else [r] for r in plain(v)]
    return [[plain(v)]]


def pad_rows(rows: list[list]) -> list[list]:
    width = max((len(r) for r in rows), default=0)
    return [["" if c is None else c for c in r] + [""] * (width - len(r)) for r in rows]


def status() -> dict:
    out = {}
    for app in PROGIDS:
        entry = {"installed": installed(app), "running": False, "documents": []}
        try:
            obj = _running(app)
        except Exception:
            obj = None
        if obj is not None:
            entry["running"] = True
            coll = {"excel": "Workbooks", "word": "Documents",
                    "powerpoint": "Presentations"}[app]
            try:
                docs = getattr(obj, coll)
                entry["documents"] = [docs.Item(i).FullName for i in range(1, docs.Count + 1)]
            except Exception:
                pass
        out[app] = entry
    return out


def open_file(path: str) -> dict:
    path = os.path.abspath(os.path.expandvars(os.path.expanduser(path)))
    app = _EXT_APP.get(os.path.splitext(path)[1].lower())
    if app is None:
        raise ValueError(f"don't know which Office app opens {path!r}")
    obj = _app(app)
    if app == "excel":
        obj.Workbooks.Open(path)
    elif app == "word":
        obj.Documents.Open(path)
    else:
        obj.Presentations.Open(path)
    return {"opened": path, "app": app}


# ---------------------------------------------------------------------------
# Excel (desktop)
# ---------------------------------------------------------------------------
def _sheet(sheet: str | None, book: str | None, create: bool = False):
    xl = _app("excel", create=create)
    wb = xl.Workbooks.Item(book) if book else xl.ActiveWorkbook
    if wb is None:
        if not create:
            raise RuntimeError("Excel has no open workbook")
        wb = xl.Workbooks.Add()
    ws = wb.Worksheets.Item(sheet) if sheet else wb.ActiveSheet
    return xl, wb, ws


def excel_read(range_: str | None = None, sheet: str | None = None,
               book: str | None = None, formulas: bool = False) -> dict:
    _xl, wb, ws = _sheet(sheet, book)
    rng = ws.Range(range_) if range_ else ws.UsedRange
    cells = int(rng.Count)
    if cells > _MAX_CELLS:
        raise RuntimeError(f"{rng.Address} has {cells} cells (> {_MAX_CELLS}); read a smaller range")
    out = {"book": wb.Name, "sheet": ws.Name, "address": rng.Address.replace("$", ""),
           "values": as_2d(rng.Value)}
    if formulas:
        out["formulas"] = as_2d(rng.Formula)
    return out


def excel_write(start: str, rows: list[list], sheet: str | None = None,
                book: str | None = None) -> dict:
    """Write rows starting at `start` (e.g. 'B2'). Strings starting with '='
    become formulas (Range.Formula takes both values and formulas)."""
    if not rows:
        raise ValueError("rows is empty")
    _xl, wb, ws = _sheet(sheet, book, create=True)
    data = pad_rows(rows)
    rng = ws.Range(start).Resize(len(data), len(data[0]))
    rng.Formula = tuple(tuple(r) for r in data)
    return {"book": wb.Name, "sheet": ws.Name, "address": rng.Address.replace("$", ""),
            "rows": len(data), "cols": len(data[0])}


def excel_run(action: str, arg: str | None = None, sheet: str | None = None,
              book: str | None = None) -> dict:
    """save | save_as(arg=path) | recalc | autofit | add_sheet(arg=name) |
    activate_sheet(arg=name) | list_sheets | select(arg=range) | new_workbook."""
    if action == "new_workbook":
        xl = _app("excel")
        wb = xl.Workbooks.Add()
        return {"action": action, "book": wb.Name}
    xl, wb, ws = _sheet(sheet, book)
    if action == "save":
        wb.Save()
    elif action == "save_as":
        if not arg:
            raise ValueError("save_as needs arg=<path>")
        wb.SaveAs(os.path.abspath(os.path.expanduser(arg)))
    elif action == "recalc":
        xl.Calculate()
    elif action == "autofit":
        ws.UsedRange.Columns.AutoFit()
    elif action == "add_sheet":
        new = wb.Worksheets.Add()
        if arg:
            new.Name = arg
        return {"action": action, "sheet": new.Name}
    elif action == "activate_sheet":
        wb.Worksheets.Item(arg).Activate()
    elif action == "list_sheets":
        return {"action": action, "book": wb.Name,
                "sheets": [wb.Worksheets.Item(i).Name for i in range(1, wb.Worksheets.Count + 1)]}
    elif action == "select":
        ws.Activate()
        ws.Range(arg).Select()
    else:
        raise ValueError(f"unknown excel action {action!r}")
    return {"action": action, "book": wb.Name, "sheet": ws.Name}


# ---------------------------------------------------------------------------
# Word
# ---------------------------------------------------------------------------
def _doc(doc: str | None, create: bool = False):
    wd = _app("word", create=create)
    if doc:
        return wd, wd.Documents.Item(doc)
    if wd.Documents.Count == 0:
        if not create:
            raise RuntimeError("Word has no open document")
        return wd, wd.Documents.Add()
    return wd, wd.ActiveDocument


def word_read(doc: str | None = None, max_chars: int = 20_000) -> dict:
    _wd, d = _doc(doc)
    text = d.Content.Text.replace("\r", "\n")
    return {"document": d.Name, "chars": len(text), "text": text[:max(0, int(max_chars))],
            "truncated": len(text) > max_chars}


def word_insert(text: str, where: str = "end", doc: str | None = None) -> dict:
    wd, d = _doc(doc, create=True)
    if where == "end":
        d.Content.InsertAfter(text)
    elif where == "start":
        d.Content.InsertBefore(text)
    elif where == "cursor":
        wd.Selection.TypeText(text)
    else:
        raise ValueError("where must be end/start/cursor")
    return {"document": d.Name, "inserted_chars": len(text), "where": where}


def word_find_replace(find: str, replace: str, doc: str | None = None,
                      match_case: bool = False, whole_word: bool = False) -> dict:
    _wd, d = _doc(doc)
    before = d.Content.Text
    count = (before.count(find) if match_case else before.lower().count(find.lower()))
    rng = d.Content
    # Find.Execute(FindText, MatchCase, MatchWholeWord, MatchWildcards,
    #   MatchSoundsLike, MatchAllWordForms, Forward, Wrap=wdFindContinue(1),
    #   Format, ReplaceWith, Replace=wdReplaceAll(2))
    rng.Find.Execute(find, match_case, whole_word, False, False, False, True, 1,
                     False, replace, 2)
    return {"document": d.Name, "replaced_approx": count}


def word_save_as(path: str, fmt: str = "docx", doc: str | None = None) -> dict:
    _wd, d = _doc(doc)
    codes = {"docx": 16, "pdf": 17, "txt": 2, "rtf": 6}
    if fmt not in codes:
        raise ValueError(f"format must be one of {sorted(codes)}")
    path = os.path.abspath(os.path.expanduser(path))
    d.SaveAs2(path, codes[fmt])
    return {"saved": path, "format": fmt}


# ---------------------------------------------------------------------------
# PowerPoint
# ---------------------------------------------------------------------------
def _pres(pres: str | None, create: bool = False):
    pp = _app("powerpoint", create=create)
    if pres:
        return pp, pp.Presentations.Item(pres)
    if pp.Presentations.Count == 0:
        if not create:
            raise RuntimeError("PowerPoint has no open presentation")
        return pp, pp.Presentations.Add()
    return pp, pp.ActivePresentation


def _shape_text(shape) -> str | None:
    try:
        if shape.HasTextFrame and shape.TextFrame.HasText:
            return shape.TextFrame.TextRange.Text.replace("\r", "\n")
    except Exception:
        pass
    return None


def ppt_list(pres: str | None = None) -> dict:
    _pp, p = _pres(pres)
    slides = []
    for i in range(1, p.Slides.Count + 1):
        s = p.Slides.Item(i)
        shapes = []
        for j in range(1, s.Shapes.Count + 1):
            sh = s.Shapes.Item(j)
            shapes.append({"index": j, "name": sh.Name, "text": _shape_text(sh)})
        slides.append({"slide": i, "layout": int(s.Layout), "shapes": shapes})
    return {"presentation": p.Name, "slides": slides}


def ppt_add_slide(title: str = "", body: str = "", layout: int = 2,
                  index: int | None = None, pres: str | None = None) -> dict:
    """layout: 1 title, 2 title+content (default), 11 title only, 12 blank."""
    _pp, p = _pres(pres, create=True)
    idx = int(index) if index else p.Slides.Count + 1
    s = p.Slides.Add(idx, int(layout))
    if title and s.Shapes.Count >= 1:
        s.Shapes.Item(1).TextFrame.TextRange.Text = title
    if body and s.Shapes.Count >= 2:
        s.Shapes.Item(2).TextFrame.TextRange.Text = body
    return {"presentation": p.Name, "slide": idx}


def ppt_set_text(slide: int, shape: str, text: str, pres: str | None = None) -> dict:
    _pp, p = _pres(pres)
    s = p.Slides.Item(int(slide))
    key = int(shape) if str(shape).isdigit() else shape
    sh = s.Shapes.Item(key)
    sh.TextFrame.TextRange.Text = text
    return {"presentation": p.Name, "slide": int(slide), "shape": sh.Name}


def ppt_export(path: str, fmt: str = "pptx", pres: str | None = None) -> dict:
    _pp, p = _pres(pres)
    codes = {"pptx": 24, "pdf": 32}
    if fmt not in codes:
        raise ValueError(f"format must be one of {sorted(codes)}")
    path = os.path.abspath(os.path.expanduser(path))
    p.SaveAs(path, codes[fmt])
    return {"saved": path, "format": fmt}
