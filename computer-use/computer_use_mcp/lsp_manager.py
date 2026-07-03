"""Language-Server-Protocol client for real-time diagnostics on demand.

The co-work brain edits source files through its OWN CLI tools; the engine has no
file-write hook. So diagnostics are an EXPLICIT tool the model calls right after
editing (``lsp_diagnostics``): it spins up — or REUSES — one language server per
language, opens the file, collects diagnostics, and hands back a small structured
list of errors/warnings/info/hints. No new pip deps: this speaks raw JSON-RPC over
the server's stdio with ``Content-Length`` framing.

Design notes:

* **One process per language, kept alive across calls** (module-level ``_clients``
  dict). A lazy idle-reaper terminates a server that hasn't been used in
  ``_IDLE_TIMEOUT`` seconds on the next call — simpler than a pid-file supervisor,
  which is fine because every diagnostics call comes from the single engine
  process. If the same language is asked for with a *different* workspace root the
  old server is replaced, so there is still exactly one process per language.
* **Both diagnostic transports.** After ``didOpen`` we try LSP 3.17 PULL
  diagnostics (``textDocument/diagnostic``, which rust-analyzer supports); if the
  server lacks that capability — or returns nothing — we wait briefly for PUSH
  ``textDocument/publishDiagnostics`` notifications (pylsp etc.).
* **Graceful degradation.** A missing server binary, an unsupported extension, a
  missing file, or a protocol timeout all return ``{"diagnostics": [], "error":
  ...}``. This module NEVER raises out to the tool layer.

Lines and columns in the returned diagnostics are **1-based** (LSP is 0-based) for
human readability.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

# ---------------------------------------------------------------------------
# Language / server maps
# ---------------------------------------------------------------------------

# file extension -> language KEY (the per-language server-process identity).
_EXT_LANG = {
    ".py": "python",
    ".rs": "rust",
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "typescript", ".jsx": "typescript",
    ".c": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
    ".h": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".go": "go",
    ".qml": "qml",
}

# file extension -> LSP ``languageId`` sent in didOpen (more specific than the
# server key: e.g. .tsx is "typescriptreact", .c is "c").
_EXT_LANG_ID = {
    ".py": "python",
    ".rs": "rust",
    ".ts": "typescript", ".tsx": "typescriptreact",
    ".js": "javascript", ".jsx": "javascriptreact",
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
    ".h": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".go": "go",
    ".qml": "qml",
}

# language KEY -> spawn command (first element is the binary looked up on PATH).
_LANG_CMD = {
    "python": ["pylsp"],
    "rust": ["rust-analyzer"],
    "typescript": ["typescript-language-server", "--stdio"],
    "cpp": ["clangd"],
    "go": ["gopls"],
    "qml": ["qmlls"],
}

# Walk up from the edited file looking for one of these to anchor the workspace.
_ROOT_MARKERS = (
    "Cargo.toml", "pyproject.toml", "setup.py", "package.json",
    "CMakeLists.txt", "compile_commands.json", "go.mod", ".git",
)

# LSP DiagnosticSeverity (1-4) -> our string.
_SEVERITY = {1: "error", 2: "warning", 3: "info", 4: "hint"}
_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2, "hint": 3}

_IDLE_TIMEOUT = 120.0          # seconds a server may sit unused before reaping
_INIT_TIMEOUT = 20.0           # seconds to wait for the initialize handshake
_DEFAULT_DIAG_TIMEOUT = 5.0    # seconds to wait for diagnostics to arrive


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested directly)
# ---------------------------------------------------------------------------

def _detect_language(path: str) -> str:
    """Return the language KEY for a file path, or "" if unsupported."""
    return _EXT_LANG.get(Path(path).suffix.lower(), "")


def _language_id(path: str) -> str:
    """Return the LSP ``languageId`` for the file's extension."""
    ext = Path(path).suffix.lower()
    return _EXT_LANG_ID.get(ext) or _detect_language(path) or "plaintext"


def _lsp_command(language: str):
    """Resolve the spawn command for a language, or None if the binary is absent.

    Only the executable (element 0) is resolved via ``shutil.which``; the rest of
    the argv (e.g. ``--stdio``) is preserved verbatim.
    """
    spec = _LANG_CMD.get(language)
    if not spec:
        return None
    binary = shutil.which(spec[0])
    if not binary:
        return None
    return [binary] + list(spec[1:])


def _find_root(path: str, root_dir: str = "") -> str:
    """Workspace root: explicit ``root_dir`` if given, else the nearest ancestor
    holding a project marker, else the file's own directory."""
    if root_dir:
        return str(Path(root_dir).expanduser().resolve())
    p = Path(path).expanduser().resolve()
    start = p if p.is_dir() else p.parent
    for d in [start, *start.parents]:
        for marker in _ROOT_MARKERS:
            if (d / marker).exists():
                return str(d)
    return str(start)


def _path_to_uri(path: str) -> str:
    return Path(path).expanduser().resolve().as_uri()


def _uri_to_path(uri: str) -> str:
    if uri and uri.startswith("file://"):
        return unquote(urlparse(uri).path)
    return uri or ""


def _state_dir() -> Path:
    """State directory, honoring ``$JARVIS_LSP_DIR``.

    This module keeps all live state in-memory (the ``_clients`` dict), so nothing
    is written here — but the override is accepted (and reported by
    ``server_status``) so ops/tests can point it somewhere hermetic.
    """
    override = os.environ.get("JARVIS_LSP_DIR")
    return Path(override) if override else Path(
        os.path.expanduser("~/.local/share/jarvis/lsp"))


def _normalize(diag: dict) -> dict:
    """LSP Diagnostic -> our compact structured record (1-based line/col)."""
    start = (diag.get("range") or {}).get("start") or {}
    code = diag.get("code")
    return {
        "severity": _SEVERITY.get(diag.get("severity", 1), "error"),
        "line": int(start.get("line", 0)) + 1,
        "col": int(start.get("character", 0)) + 1,
        "message": diag.get("message", ""),
        "source": diag.get("source", "") or "",
        "code": "" if code is None else code,
    }


# ---------------------------------------------------------------------------
# JSON-RPC / stdio client
# ---------------------------------------------------------------------------

class _Client:
    """One language-server subprocess spoken to over Content-Length-framed
    JSON-RPC. A daemon reader thread demultiplexes responses, server->client
    requests, and publishDiagnostics notifications."""

    def __init__(self, language: str, command: list, root_uri: str):
        self.language = language
        self.command = command
        self.root_uri = root_uri
        self.last_used = time.time()
        self.opened: set = set()

        self._id = 0
        self._lock = threading.Lock()          # guards id/response tables
        self._write_lock = threading.Lock()    # serializes stdin writes
        self._responses: dict = {}
        self._resp_events: dict = {}
        self._server_caps: dict = {}
        self._alive = True

        self._diag_lock = threading.Lock()
        self._diagnostics: dict = {}            # uri -> list[raw diagnostic]
        self._diag_versions: dict = {}          # uri -> int (bumped per publish)

        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # -- low level I/O ------------------------------------------------------

    def _read_loop(self) -> None:
        stream = self.proc.stdout
        try:
            while True:
                headers = {}
                while True:
                    line = stream.readline()
                    if not line:
                        return                      # EOF
                    line = line.strip()
                    if line == b"":
                        break                       # end of headers
                    if b":" in line:
                        k, _, v = line.partition(b":")
                        headers[k.strip().lower()] = v.strip()
                try:
                    length = int(headers.get(b"content-length", b"0"))
                except ValueError:
                    length = 0
                if length <= 0:
                    continue
                body = self._read_exact(stream, length)
                if body is None:
                    return
                try:
                    msg = json.loads(body.decode("utf-8", errors="replace"))
                except Exception:
                    continue
                self._dispatch(msg)
        except Exception:
            pass
        finally:
            self._alive = False

    @staticmethod
    def _read_exact(stream, n: int):
        buf = bytearray()
        while len(buf) < n:
            chunk = stream.read(n - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        return bytes(buf)

    def _send(self, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(data)}\r\n\r\n".encode("ascii")
        with self._write_lock:
            if self.proc.stdin is None:
                raise RuntimeError("server stdin is closed")
            self.proc.stdin.write(header + data)
            self.proc.stdin.flush()

    def _dispatch(self, msg: dict) -> None:
        if "id" in msg and ("result" in msg or "error" in msg):
            rid = msg["id"]
            with self._lock:
                self._responses[rid] = msg
                ev = self._resp_events.get(rid)
            if ev is not None:
                ev.set()
        elif msg.get("method") == "textDocument/publishDiagnostics":
            params = msg.get("params") or {}
            uri = params.get("uri")
            if uri:
                with self._diag_lock:
                    self._diagnostics[uri] = params.get("diagnostics", []) or []
                    self._diag_versions[uri] = self._diag_versions.get(uri, 0) + 1
        elif "id" in msg and "method" in msg:
            # server -> client request; must answer or some servers block.
            self._reply_to_server_request(msg)
        # else: a notification we don't care about (logMessage, $/progress, ...).

    def _reply_to_server_request(self, msg: dict) -> None:
        method = msg.get("method")
        if method == "workspace/configuration":
            items = (msg.get("params") or {}).get("items") or []
            result = [None] * len(items)
        else:
            # registerCapability / workDoneProgress/create / anything else.
            result = None
        try:
            self._send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        except Exception:
            pass

    # -- request / notify ---------------------------------------------------

    def _request(self, method: str, params, timeout: float):
        with self._lock:
            self._id += 1
            rid = self._id
            ev = threading.Event()
            self._resp_events[rid] = ev
        self._send({"jsonrpc": "2.0", "id": rid, "method": method,
                    "params": params})
        if not ev.wait(timeout):
            with self._lock:
                self._resp_events.pop(rid, None)
                self._responses.pop(rid, None)
            raise TimeoutError(f"LSP request {method!r} timed out after {timeout}s")
        with self._lock:
            resp = self._responses.pop(rid, None)
            self._resp_events.pop(rid, None)
        if resp is None:
            raise RuntimeError(f"LSP request {method!r} produced no response")
        if "error" in resp:
            raise RuntimeError(f"LSP error for {method!r}: {resp['error']}")
        return resp.get("result")

    def _notify(self, method: str, params) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    # -- lifecycle ----------------------------------------------------------

    def initialize(self, root_uri: str, timeout: float = _INIT_TIMEOUT) -> dict:
        root_path = _uri_to_path(root_uri)
        params = {
            "processId": os.getpid(),
            "clientInfo": {"name": "jarvis-lsp", "version": "1"},
            "rootUri": root_uri,
            "rootPath": root_path,
            "capabilities": {
                "textDocument": {
                    "publishDiagnostics": {"relatedInformation": True},
                    "diagnostic": {"dynamicRegistration": True,
                                   "relatedDocumentSupport": False},
                    "synchronization": {"didSave": True},
                },
                "workspace": {"configuration": True, "workspaceFolders": True},
            },
            "workspaceFolders": [{"uri": root_uri,
                                  "name": Path(root_path).name or "root"}],
        }
        result = self._request("initialize", params, timeout) or {}
        self._server_caps = result.get("capabilities", {}) or {}
        self._notify("initialized", {})
        return self._server_caps

    def supports_pull(self) -> bool:
        return bool(self._server_caps.get("diagnosticProvider"))

    def sync_document(self, uri: str, language_id: str, text: str) -> None:
        """Force the server onto the CURRENT file contents. We didClose (if it
        was open) then didOpen, and clear any stale published diagnostics, so a
        re-run after an edit reflects the new text."""
        if uri in self.opened:
            self._notify("textDocument/didClose", {"textDocument": {"uri": uri}})
            self.opened.discard(uri)
        with self._diag_lock:
            self._diagnostics.pop(uri, None)
            self._diag_versions.pop(uri, None)
        self._notify("textDocument/didOpen", {
            "textDocument": {"uri": uri, "languageId": language_id,
                             "version": 1, "text": text},
        })
        self.opened.add(uri)

    def pull_diagnostics(self, uri: str, timeout: float) -> list:
        result = self._request("textDocument/diagnostic",
                               {"textDocument": {"uri": uri}}, timeout) or {}
        if result.get("kind") == "unchanged":
            return []
        return result.get("items", []) or []

    def collect_push(self, uri: str, timeout: float, settle: float = 0.5) -> list:
        """Wait up to ``timeout`` for publishDiagnostics for ``uri``. Returns as
        soon as a NON-empty result has been stable for ``settle`` seconds;
        otherwise waits the full window (a clean file legitimately stays empty)."""
        deadline = time.time() + timeout
        last_ver = 0
        stable_at = None
        while time.time() < deadline:
            with self._diag_lock:
                ver = self._diag_versions.get(uri, 0)
                snap = list(self._diagnostics.get(uri, []))
            if ver != last_ver:
                last_ver = ver
                stable_at = time.time()
            if snap and stable_at and (time.time() - stable_at) >= settle:
                return snap
            time.sleep(0.05)
        with self._diag_lock:
            return list(self._diagnostics.get(uri, []))

    def alive(self) -> bool:
        return self._alive and self.proc.poll() is None

    def pid(self) -> int:
        return self.proc.pid

    def shutdown(self, timeout: float = 3.0) -> None:
        self._alive = False
        try:
            try:
                self._request("shutdown", None, timeout=1.5)
            except Exception:
                pass
            try:
                self._notify("exit", None)
            except Exception:
                pass
        finally:
            try:
                self.proc.terminate()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=timeout)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# Module-level registry of live clients
# ---------------------------------------------------------------------------

_clients: dict = {}                 # language -> _Client
_clients_lock = threading.Lock()


def _reap_idle_locked(now: float) -> None:
    for lang in list(_clients.keys()):
        c = _clients[lang]
        if (now - c.last_used) > _IDLE_TIMEOUT or not c.alive():
            try:
                c.shutdown()
            except Exception:
                pass
            _clients.pop(lang, None)


def _get_client(language: str, command: list, root_uri: str) -> _Client:
    now = time.time()
    with _clients_lock:
        _reap_idle_locked(now)
        c = _clients.get(language)
        if c is not None and (not c.alive() or c.root_uri != root_uri):
            try:
                c.shutdown()
            except Exception:
                pass
            _clients.pop(language, None)
            c = None
        if c is None:
            c = _Client(language, command, root_uri)
            try:
                c.initialize(root_uri, timeout=_INIT_TIMEOUT)
            except Exception:
                c.shutdown()
                raise
            _clients[language] = c
        c.last_used = now
        return c


# ---------------------------------------------------------------------------
# Public API (called by tools_lsp)
# ---------------------------------------------------------------------------

def diagnose(path: str, language: str = "auto", root_dir: str = "",
             timeout: float = None) -> dict:
    """Open ``path`` in the appropriate language server and return its diagnostics.

    Never raises: any failure is reported as ``{"diagnostics": [], "error": ...}``.
    Diagnostic line/col are 1-based.
    """
    try:
        p = Path(path).expanduser()
        lang = _detect_language(str(p)) if language in ("", "auto", None) else language
        if not lang:
            return {"diagnostics": [],
                    "error": f"unsupported file type: {p.suffix or '(none)'}"}
        if lang not in _LANG_CMD:
            return {"diagnostics": [], "error": f"unknown language: {lang}"}
        command = _lsp_command(lang)
        if command is None:
            binary = _LANG_CMD[lang][0]
            return {"diagnostics": [],
                    "error": f"language server '{binary}' not installed"}
        if not p.exists():
            return {"diagnostics": [], "error": f"file not found: {p}"}

        text = p.read_text(encoding="utf-8", errors="replace")
        uri = _path_to_uri(str(p))
        language_id = _language_id(str(p))
        root = _find_root(str(p), root_dir)
        root_uri = Path(root).as_uri()

        diag_timeout = float(timeout) if timeout else _DEFAULT_DIAG_TIMEOUT

        client = _get_client(lang, command, root_uri)
        client.sync_document(uri, language_id, text)

        raw = []
        if client.supports_pull():
            try:
                raw = client.pull_diagnostics(uri, timeout=max(diag_timeout, 8.0))
            except Exception:
                raw = []
            if not raw:
                # rust-analyzer flycheck & friends deliver via publish after a beat.
                pushed = client.collect_push(uri, timeout=diag_timeout)
                if pushed:
                    raw = pushed
        else:
            raw = client.collect_push(uri, timeout=diag_timeout)

        diagnostics = [_normalize(d) for d in raw]
        diagnostics.sort(key=lambda d: (_SEVERITY_ORDER.get(d["severity"], 4),
                                        d["line"], d["col"]))
        return {
            "diagnostics": diagnostics,
            "count": len(diagnostics),
            "language": lang,
            "server": command[0],
            "root": root,
            "transport": "pull" if client.supports_pull() else "push",
        }
    except Exception as exc:  # noqa: BLE001 — the tool must never see a raise
        return {"diagnostics": [], "error": f"{type(exc).__name__}: {exc}"}


def server_status() -> dict:
    """Report the live per-language servers and which server binaries are on PATH."""
    now = time.time()
    with _clients_lock:
        servers = [{
            "language": lang,
            "server": c.command[0],
            "pid": c.pid(),
            "alive": c.alive(),
            "root": _uri_to_path(c.root_uri),
            "idle_sec": round(now - c.last_used, 1),
            "transport": "pull" if c.supports_pull() else "push",
            "open_documents": len(c.opened),
        } for lang, c in _clients.items()]
    available = {lang: (_lsp_command(lang) is not None) for lang in _LANG_CMD}
    return {
        "servers": servers,
        "available": available,
        "idle_timeout_sec": _IDLE_TIMEOUT,
        "state_dir": str(_state_dir()),
    }


def shutdown_all() -> None:
    """Terminate every live server (used by tests and orderly shutdown)."""
    with _clients_lock:
        for c in list(_clients.values()):
            try:
                c.shutdown()
            except Exception:
                pass
        _clients.clear()
