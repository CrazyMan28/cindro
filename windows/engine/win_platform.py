"""Windows implementations of the engine's clipboard / windows / apps / workspaces.

The engine's ``tools_desktop`` calls ``clipboard.copy/paste``,
``windows.list_windows/activate/close/set_state``, ``apps.list_apps/launch`` and
``workspaces.*`` BY MODULE ATTRIBUTE at call time -- but those modules are
Linux-only (wl-copy, KWin JS, swaymsg, .desktop files), so on Windows every one
of those tools failed. ``server_windows.apply_patches()`` rebinds the functions
below over them, exactly like it already does for input/screen/session. Nothing
under ``computer-use/`` is edited.

pywin32 / winreg / ctypes are imported LAZILY so this module imports on Linux
(the test-suite exercises the pure helpers: TSV / CF_HTML codecs, id parsing,
app matching, the desktop_reset safety rule).
"""

from __future__ import annotations

import csv
import difflib
import html
import importlib
import io
import json
import os
import subprocess
import sys
import time

import backend_windows as _bw

_CREATE_NO_WINDOW = 0x08000000


def _mod(name: str):
    """Import a pywin32 / Windows-only module, with a clear error off-Windows."""
    if sys.platform != "win32":
        raise RuntimeError(f"{name} requires Windows (sys.platform=='win32').")
    return importlib.import_module(name)


# ===========================================================================
# Clipboard
# ===========================================================================
_CF_UNICODETEXT = 13


def rows_to_tsv(rows: list[list]) -> str:
    """Rows -> the TSV Excel/Sheets put on (and accept from) the clipboard.
    Cells holding tabs/newlines/quotes are quoted Excel-style."""
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    for r in rows:
        w.writerow(["" if c is None else c for c in r])
    return buf.getvalue()


def tsv_to_rows(text: str) -> list[list[str]]:
    """Clipboard TSV (as Excel/Sheets copy a range) -> rows of strings."""
    if not text:
        return []
    text = text.replace("\r\n", "\n")
    if text.endswith("\n"):
        text = text[:-1]
    return [list(r) for r in csv.reader(io.StringIO(text), delimiter="\t")]


def rows_to_html(rows: list[list]) -> str:
    body = "".join(
        "<tr>" + "".join(f"<td>{html.escape('' if c is None else str(c))}</td>" for c in r) + "</tr>"
        for r in rows
    )
    return f"<table>{body}</table>"


def build_cf_html(fragment: str) -> bytes:
    """Wrap an HTML fragment in the Windows "HTML Format" clipboard envelope
    (byte offsets into the UTF-8 payload, zero-padded so the header length is
    fixed)."""
    header = ("Version:0.9\r\nStartHTML:{:010d}\r\nEndHTML:{:010d}\r\n"
              "StartFragment:{:010d}\r\nEndFragment:{:010d}\r\n")
    prefix = "<html><body>\r\n<!--StartFragment-->"
    suffix = "<!--EndFragment-->\r\n</body></html>"
    start_html = len(header.format(0, 0, 0, 0).encode("utf-8"))
    start_frag = start_html + len(prefix.encode("utf-8"))
    end_frag = start_frag + len(fragment.encode("utf-8"))
    end_html = end_frag + len(suffix.encode("utf-8"))
    return (header.format(start_html, end_html, start_frag, end_frag)
            + prefix + fragment + suffix).encode("utf-8")


class _Clipboard:
    """OpenClipboard with retries (another app may hold it for a few ms)."""

    def __enter__(self):
        self.cb = _mod("win32clipboard")
        last = None
        for _ in range(20):
            try:
                self.cb.OpenClipboard()
                return self.cb
            except Exception as exc:  # pywintypes.error: access denied (busy)
                last = exc
                time.sleep(0.03)
        raise RuntimeError(f"clipboard busy (OpenClipboard failed): {last}")

    def __exit__(self, *exc):
        try:
            self.cb.CloseClipboard()
        except Exception:
            pass
        return False


def clipboard_copy(text: str, which: str = "active") -> None:
    with _Clipboard() as cb:
        cb.EmptyClipboard()
        cb.SetClipboardData(_CF_UNICODETEXT, text)


def clipboard_paste(which: str = "active") -> str:
    with _Clipboard() as cb:
        if not cb.IsClipboardFormatAvailable(_CF_UNICODETEXT):
            return ""
        data = cb.GetClipboardData(_CF_UNICODETEXT)
    return data if isinstance(data, str) else data.decode("utf-16-le", "replace")


def clipboard_set_table(rows: list[list], include_html: bool = False) -> dict:
    tsv = rows_to_tsv(rows)
    with _Clipboard() as cb:
        cb.EmptyClipboard()
        cb.SetClipboardData(_CF_UNICODETEXT, tsv)
        if include_html:
            fmt = cb.RegisterClipboardFormat("HTML Format")
            cb.SetClipboardData(fmt, build_cf_html(rows_to_html(rows)))
    return {"rows": len(rows), "cols": max((len(r) for r in rows), default=0),
            "html": include_html}


def clipboard_get_table() -> list[list[str]]:
    return tsv_to_rows(clipboard_paste())


def clipboard_formats() -> list[str]:
    names = {1: "CF_TEXT", 2: "CF_BITMAP", 8: "CF_DIB", 13: "CF_UNICODETEXT",
             15: "CF_HDROP", 17: "CF_DIBV5"}
    out = []
    with _Clipboard() as cb:
        fmt = cb.EnumClipboardFormats(0)
        while fmt:
            try:
                out.append(names.get(fmt) or cb.GetClipboardFormatName(fmt))
            except Exception:
                out.append(str(fmt))
            fmt = cb.EnumClipboardFormats(fmt)
    return out


# ===========================================================================
# Windows (top-level application windows)
# ===========================================================================
_GWL_EXSTYLE = -20
_WS_EX_TOOLWINDOW = 0x00000080
_WS_EX_APPWINDOW = 0x00040000
_GW_OWNER = 4
_WM_CLOSE = 0x0010
_SW_MINIMIZE, _SW_MAXIMIZE, _SW_RESTORE = 6, 3, 9


def parse_window_id(window_id) -> int | None:
    """'win:1234' / '1234' / 1234 -> hwnd; anything else -> None (title match)."""
    if isinstance(window_id, int):
        return window_id
    s = str(window_id).strip()
    if s.lower().startswith("win:"):
        s = s[4:]
    try:
        return int(s, 0)
    except ValueError:
        return None


def _exe_name(pid: int) -> str:
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, int(pid))  # QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(len(buf))
            if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return os.path.basename(buf.value)
        finally:
            k32.CloseHandle(h)
    except Exception:
        pass
    return ""


def _is_cloaked(hwnd: int) -> bool:
    """UWP/suspended and other-virtual-desktop windows are 'visible' but cloaked."""
    try:
        import ctypes
        val = ctypes.c_int(0)
        ctypes.windll.dwmapi.DwmGetWindowAttribute(
            ctypes.c_void_p(hwnd), 14, ctypes.byref(val), ctypes.sizeof(val))  # DWMWA_CLOAKED
        return bool(val.value)
    except Exception:
        return False


def _host_windows() -> list[dict]:
    g = _mod("win32gui")
    wp = _mod("win32process")
    fg = g.GetForegroundWindow()
    out: list[dict] = []

    def cb(hwnd, _):
        try:
            if not g.IsWindowVisible(hwnd):
                return True
            title = g.GetWindowText(hwnd)
            if not title:
                return True
            ex = g.GetWindowLong(hwnd, _GWL_EXSTYLE)
            if ex & _WS_EX_TOOLWINDOW:
                return True
            if g.GetWindow(hwnd, _GW_OWNER) and not ex & _WS_EX_APPWINDOW:
                return True
            if _is_cloaked(hwnd):
                return True
            left, top, right, bottom = g.GetWindowRect(hwnd)
            _tid, pid = wp.GetWindowThreadProcessId(hwnd)
            out.append({
                "id": f"win:{hwnd}", "title": title, "app": _exe_name(pid),
                "pid": pid,
                "rect": {"x": left, "y": top, "w": right - left, "h": bottom - top},
                "active": hwnd == fg, "minimized": bool(g.IsIconic(hwnd)),
                "maximized": bool(_is_zoomed(hwnd)),
                "output": None, "session": "windows",
            })
        except Exception:
            pass
        return True

    g.EnumWindows(cb, None)
    return out


def _is_zoomed(hwnd: int) -> bool:
    try:
        import ctypes
        return bool(ctypes.windll.user32.IsZoomed(hwnd))
    except Exception:
        return False


def list_windows(which: str = "all") -> list[dict]:
    """Top-level app windows. SAFETY: 'sway'/'agent' mean the isolated agent
    desktop -- on the HOST engine that does not exist, so they return [] (the
    engine's desktop_reset closes everything list_windows('sway') returns; it
    must never see the user's real windows)."""
    if which in ("sway", "agent") and not _bw.in_sandbox():
        return []
    return _host_windows()


def _resolve_hwnd(window_id) -> int:
    hwnd = parse_window_id(window_id)
    g = _mod("win32gui")
    if hwnd is not None:
        if not g.IsWindow(hwnd):
            raise RuntimeError(f"window {window_id!r} no longer exists (re-run window_list)")
        return hwnd
    # Not an id: treat it as a title / app substring (handy for the model).
    needle = str(window_id).lower()
    wins = _host_windows()
    for w in wins:
        if needle in w["title"].lower() or needle == w["app"].lower():
            return int(w["id"][4:])
    raise RuntimeError(f"no window matches {window_id!r} (use window_list for ids)")


def _force_foreground(hwnd: int) -> bool:
    """SetForegroundWindow with the usual foreground-lock workarounds: a
    background process may not steal focus unless it just received input, so
    tap Alt (counts as input) and attach to the foreground thread's input."""
    g = _mod("win32gui")
    import ctypes
    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32
    if g.IsIconic(hwnd):
        g.ShowWindow(hwnd, _SW_RESTORE)
    try:
        g.SetForegroundWindow(hwnd)
    except Exception:
        pass
    if g.GetForegroundWindow() == hwnd:
        return True
    try:
        _bw._send(_bw._key_input(0x12), _bw._key_input(0x12, up=True))  # Alt tap
    except Exception:
        pass
    fg = g.GetForegroundWindow()
    fg_tid = u32.GetWindowThreadProcessId(fg, None) if fg else 0
    me = k32.GetCurrentThreadId()
    attached = bool(fg_tid) and fg_tid != me and u32.AttachThreadInput(me, fg_tid, True)
    try:
        u32.BringWindowToTop(hwnd)
        try:
            g.SetForegroundWindow(hwnd)
        except Exception:
            pass
        u32.SetFocus(hwnd)
    finally:
        if attached:
            u32.AttachThreadInput(me, fg_tid, False)
    time.sleep(0.05)
    return g.GetForegroundWindow() == hwnd


def activate(window_id) -> dict:
    hwnd = _resolve_hwnd(window_id)
    ok = _force_foreground(hwnd)
    out = {"activated": f"win:{hwnd}", "foreground": ok}
    if not ok:
        out["hint"] = ("Windows refused to bring it to the front (foreground lock). "
                       "Click its taskbar button or title bar instead.")
    return out


def close(window_id) -> dict:
    hwnd = _resolve_hwnd(window_id)
    _mod("win32gui").PostMessage(hwnd, _WM_CLOSE, 0, 0)
    return {"closed": f"win:{hwnd}", "note": "apps with unsaved changes may show a confirm dialog"}


def set_state(window_id, action: str, x: int | None = None, y: int | None = None,
              w: int | None = None, h: int | None = None) -> dict:
    """minimize | unminimize | maximize | fullscreen | restore | move_resize."""
    if action not in ("minimize", "unminimize", "maximize", "fullscreen", "restore",
                      "move_resize"):
        raise ValueError(f"Unknown action {action!r}")
    g = _mod("win32gui")
    hwnd = _resolve_hwnd(window_id)
    out = {"window": f"win:{hwnd}", "action": action}
    if action == "minimize":
        g.ShowWindow(hwnd, _SW_MINIMIZE)
    elif action in ("unminimize", "restore"):
        g.ShowWindow(hwnd, _SW_RESTORE)
    elif action in ("maximize", "fullscreen"):
        g.ShowWindow(hwnd, _SW_MAXIMIZE)
        if action == "fullscreen":
            out["note"] = "maximized (true fullscreen is app-specific: try key_press F11)"
    else:
        if g.IsIconic(hwnd) or _is_zoomed(hwnd):
            g.ShowWindow(hwnd, _SW_RESTORE)
        left, top, right, bottom = g.GetWindowRect(hwnd)
        nx = left if x is None else int(x)
        ny = top if y is None else int(y)
        nw = (right - left) if w is None else int(w)
        nh = (bottom - top) if h is None else int(h)
        g.MoveWindow(hwnd, nx, ny, nw, nh, True)
        out["rect"] = {"x": nx, "y": ny, "w": nw, "h": nh}
    return out


# ===========================================================================
# Applications
# ===========================================================================
_APPS_CACHE: tuple[float, list[dict]] | None = None
_APPS_TTL = 120.0


def _powershell(script: str, timeout: float = 20.0) -> str:
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=timeout,
        creationflags=_CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"powershell rc={proc.returncode}")
    return proc.stdout


def _start_menu_lnks() -> list[dict]:
    roots = [os.path.join(os.environ.get(v, ""), r"Microsoft\Windows\Start Menu\Programs")
             for v in ("ProgramData", "APPDATA")]
    out = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f.lower().endswith((".lnk", ".url")):
                    out.append({"id": os.path.join(dirpath, f), "name": f.rsplit(".", 1)[0],
                                "comment": "start menu shortcut"})
    return out


def _all_apps() -> list[dict]:
    global _APPS_CACHE
    now = time.monotonic()
    if _APPS_CACHE and now - _APPS_CACHE[0] < _APPS_TTL:
        return _APPS_CACHE[1]
    apps: dict[str, dict] = {}
    try:
        raw = _powershell("Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress")
        data = json.loads(raw) if raw.strip() else []
        if isinstance(data, dict):
            data = [data]
        for d in data:
            if d.get("AppID") and d.get("Name"):
                apps[d["Name"].lower()] = {"id": d["AppID"], "name": d["Name"],
                                           "comment": "start menu app"}
    except Exception:
        pass
    for a in _start_menu_lnks():
        apps.setdefault(a["name"].lower(), a)
    out = sorted(apps.values(), key=lambda a: a["name"].lower())
    _APPS_CACHE = (now, out)
    return out


def list_apps(filter_text: str | None = None) -> list[dict]:
    out = _all_apps()
    if filter_text:
        ft = filter_text.lower()
        out = [a for a in out if ft in a["name"].lower() or ft in a["id"].lower()]
    return out


def match_app(app: str, apps: list[dict]) -> dict | None:
    """Exact name/id -> unique prefix -> unique substring -> close fuzzy match."""
    al = app.strip().lower()
    for a in apps:
        if a["name"].lower() == al or a["id"].lower() == al:
            return a
    for pool in ([a for a in apps if a["name"].lower().startswith(al)],
                 [a for a in apps if al in a["name"].lower()]):
        if len(pool) == 1:
            return pool[0]
        if pool:
            # Prefer the shortest name ("Excel" over "Excel Viewer Tools").
            return sorted(pool, key=lambda a: len(a["name"]))[0]
    names = {a["name"].lower(): a for a in apps}
    close_ = difflib.get_close_matches(al, list(names), n=1, cutoff=0.75)
    return names[close_[0]] if close_ else None


def launch(app: str, wait_for_window: bool = True, timeout: float = 10.0,
           which: str | None = None) -> dict:
    if which == "agent" and not _bw.in_sandbox():
        raise RuntimeError("which='agent' needs the isolated Windows agent box; "
                           "on the host only the real screen exists (which='active').")
    before = {w["id"] for w in _host_windows()} if wait_for_window else set()
    entry = match_app(app, _all_apps()) if not os.path.exists(app) else None
    if entry is not None:
        target = entry["id"]
        label = entry["name"]
        if os.path.exists(target):          # .lnk / .url / exe path
            os.startfile(target)            # type: ignore[attr-defined]
            via = "shortcut"
        else:                               # AUMID (Store / registered app)
            subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{target}"],
                             creationflags=_CREATE_NO_WINDOW)
            via = "aumid"
    else:
        # Raw command / path / URL. ShellExecute resolves "App Paths" names too
        # (excel, winword, chrome, msedge, notepad, calc, ...).
        label = app
        try:
            os.startfile(app)               # type: ignore[attr-defined]
            via = "shellexecute"
        except OSError as exc:
            raise RuntimeError(
                f"No installed app or command matches {app!r} ({exc}). "
                "Use app_list to see installed applications.") from exc
    result = {"launched": label, "via": via, "which": "active", "new_windows": []}
    if wait_for_window:
        deadline = time.monotonic() + max(1.0, float(timeout))
        while time.monotonic() < deadline:
            time.sleep(0.4)
            new = [w for w in _host_windows() if w["id"] not in before]
            if new:
                result["new_windows"] = new
                break
        if not result["new_windows"]:
            result["hint"] = ("no NEW window appeared (single-instance apps may reuse "
                              "an existing window) -- check window_list / screenshot")
    return result


# ===========================================================================
# Workspaces  (Windows virtual desktops)
# ===========================================================================
_VD_KEY = r"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops"


def _guids(blob: bytes | None) -> list[str]:
    import uuid
    if not blob:
        return []
    return [str(uuid.UUID(bytes_le=bytes(blob[i:i + 16])))
            for i in range(0, len(blob) - len(blob) % 16, 16)]


def _vd_state() -> tuple[list[dict], int]:
    winreg = _mod("winreg")
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _VD_KEY) as k:
        ids = _guids(winreg.QueryValueEx(k, "VirtualDesktopIDs")[0])
        try:
            cur = _guids(winreg.QueryValueEx(k, "CurrentVirtualDesktop")[0])
        except OSError:
            cur = []
    if not cur:  # Windows 10 keeps it per logon session
        try:
            import ctypes
            sid = ctypes.c_ulong()
            ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(sid))
            p = rf"Software\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo\{sid.value}\VirtualDesktops"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, p) as k:
                cur = _guids(winreg.QueryValueEx(k, "CurrentVirtualDesktop")[0])
        except OSError:
            cur = []
    rows = []
    for i, gid in enumerate(ids, start=1):
        name = f"Desktop {i}"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                rf"{_VD_KEY}\Desktops\{{{gid.upper()}}}") as dk:
                name = winreg.QueryValueEx(dk, "Name")[0] or name
        except OSError:
            pass
        rows.append({"num": i, "name": name, "id": gid,
                     "focused": bool(cur) and gid == cur[0],
                     "visible": bool(cur) and gid == cur[0], "output": None})
    focused = next((r["num"] for r in rows if r["focused"]), 1)
    return rows, focused


def list_workspaces(which: str = "active") -> dict:
    rows, _cur = _vd_state()
    return {"compositor": "windows", "which": which, "workspaces": rows}


def switch_workspace(name: str | None = None, num: int | None = None,
                     which: str = "active") -> dict:
    rows, cur = _vd_state()
    if num is None:
        if name is None:
            raise ValueError("workspace_switch needs name or num")
        hit = next((r for r in rows if r["name"].lower() == name.lower()), None)
        if hit is None:
            raise RuntimeError(f"virtual desktop {name!r} not found (use workspace_list)")
        num = hit["num"]
    num = int(num)
    if not 1 <= num <= len(rows):
        raise RuntimeError(f"virtual desktop {num} doesn't exist (have {len(rows)})")
    combo = "ctrl+win+right" if num > cur else "ctrl+win+left"
    for _ in range(abs(num - cur)):
        _bw.key_press(combo)
        time.sleep(0.25)
    return {"switched_to": rows[num - 1]["name"], "num_or_name": name or num,
            "compositor": "windows", "which": which}


def create_workspace(name: str, switch: bool = True, which: str = "active") -> dict:
    before, cur = _vd_state()
    _bw.key_press("ctrl+win+d")             # creates AND switches to it
    time.sleep(0.4)
    new_num = len(before) + 1
    if not switch:
        for _ in range(new_num - cur):
            _bw.key_press("ctrl+win+left")
            time.sleep(0.25)
    return {"created": name, "num": new_num, "switched": switch, "compositor": "windows",
            "which": which,
            "note": "Windows has no API to name it from here; it shows as "
                    f"'Desktop {new_num}' (rename via Task View if needed)."}


def rename_workspace(name: str, old: str | None = None, which: str = "active") -> dict:
    raise RuntimeError("Renaming Windows virtual desktops isn't supported by the engine "
                       "(no public API). Rename it via Task View (win+tab) -> right-click.")


# ===========================================================================
# Patch table (consumed by server_windows.apply_patches)
# ===========================================================================
PATCHES = {
    "clipboard": {"copy": clipboard_copy, "paste": clipboard_paste},
    "windows": {"list_windows": list_windows, "activate": activate, "close": close,
                "set_state": set_state},
    "apps": {"list_apps": list_apps, "launch": launch},
    "workspaces": {"list_workspaces": list_workspaces, "switch_workspace": switch_workspace,
                   "create_workspace": create_workspace, "rename_workspace": rename_workspace},
}
