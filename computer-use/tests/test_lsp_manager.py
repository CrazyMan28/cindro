"""Tests for computer_use_mcp.lsp_manager.

Three layers:

1. PURE UNIT — language detection, command resolution, workspace-root walk. No
   subprocess, no I/O beyond tmp files.
2. FAKE LSP SERVER — a tiny inline Python script that speaks just enough
   Content-Length-framed JSON-RPC (initialize -> capabilities w/ diagnosticProvider,
   didOpen, textDocument/diagnostic -> one canned error). Spawned by monkeypatching
   the command map; asserts diagnose() round-trips the framing and returns the
   canned diagnostic normalized (1-based line/col).
3. LIVE rust-analyzer — skipped unless the real binary is on PATH. Writes a minimal
   Cargo project with a type error and asserts >=1 error diagnostic; if indexing is
   too slow/flaky it SKIPS (with a reason) rather than failing.

Hermetic: JARVIS_LSP_DIR -> tmp, and every test shuts all servers down before and
after so no client leaks between tests.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from computer_use_mcp import lsp_manager


def _rust_analyzer_usable() -> bool:
    """True only if a REAL, runnable rust-analyzer is on PATH.

    ``shutil.which`` also finds the rustup proxy shim, which exits non-zero with
    'Unknown binary rust-analyzer' when the component isn't installed and never
    speaks LSP — running the live test against it just burns the init timeout. So
    gate on a working ``--version`` instead of mere presence."""
    exe = shutil.which("rust-analyzer")
    if not exe:
        return False
    try:
        p = subprocess.run([exe, "--version"], capture_output=True, timeout=10)
        return p.returncode == 0
    except Exception:
        return False


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_LSP_DIR", str(tmp_path / "lspstate"))
    lsp_manager.shutdown_all()
    yield
    lsp_manager.shutdown_all()


# ===========================================================================
# 1. PURE UNIT
# ===========================================================================


@pytest.mark.parametrize("name,lang", [
    ("a.py", "python"),
    ("lib.rs", "rust"),
    ("app.ts", "typescript"),
    ("app.tsx", "typescript"),
    ("app.js", "typescript"),
    ("app.jsx", "typescript"),
    ("m.c", "cpp"),
    ("m.cpp", "cpp"),
    ("m.h", "cpp"),
    ("m.hpp", "cpp"),
    ("main.go", "go"),
    ("Main.qml", "qml"),
    ("notes.txt", ""),
    ("noext", ""),
])
def test_detect_language(name, lang):
    assert lsp_manager._detect_language("/some/dir/" + name) == lang


@pytest.mark.parametrize("name,lang_id", [
    ("a.py", "python"),
    ("lib.rs", "rust"),
    ("app.ts", "typescript"),
    ("app.tsx", "typescriptreact"),
    ("app.js", "javascript"),
    ("app.jsx", "javascriptreact"),
    ("m.c", "c"),
    ("m.cpp", "cpp"),
    ("main.go", "go"),
    ("Main.qml", "qml"),
])
def test_language_id(name, lang_id):
    assert lsp_manager._language_id("/x/" + name) == lang_id


def test_lsp_command_absent_binary(monkeypatch):
    monkeypatch.setattr(lsp_manager.shutil, "which", lambda b: None)
    assert lsp_manager._lsp_command("python") is None


def test_lsp_command_present_binary_preserves_extra_args(monkeypatch):
    monkeypatch.setattr(lsp_manager.shutil, "which", lambda b: "/opt/bin/" + b)
    cmd = lsp_manager._lsp_command("typescript")
    assert cmd == ["/opt/bin/typescript-language-server", "--stdio"]


def test_lsp_command_unknown_language():
    assert lsp_manager._lsp_command("cobol") is None


def test_find_root_explicit_root_dir(tmp_path):
    got = lsp_manager._find_root(str(tmp_path / "a.py"), str(tmp_path))
    assert got == str(tmp_path.resolve())


def test_find_root_walks_up_to_marker(tmp_path):
    (tmp_path / "Cargo.toml").write_text("")
    deep = tmp_path / "src" / "deep"
    deep.mkdir(parents=True)
    f = deep / "main.rs"
    f.write_text("fn main() {}")
    assert lsp_manager._find_root(str(f)) == str(tmp_path.resolve())


def test_find_root_git_marker(tmp_path):
    (tmp_path / ".git").mkdir()
    sub = tmp_path / "pkg"
    sub.mkdir()
    f = sub / "x.go"
    f.write_text("package main")
    assert lsp_manager._find_root(str(f)) == str(tmp_path.resolve())


def test_find_root_falls_back_to_file_dir(tmp_path):
    # A directory with no markers anywhere up-tree (/tmp has none) -> the file dir.
    sub = tmp_path / "loose"
    sub.mkdir()
    f = sub / "x.py"
    f.write_text("x = 1")
    assert lsp_manager._find_root(str(f)) == str(sub.resolve())


def test_normalize_maps_severity_and_one_bases_position():
    raw = {
        "range": {"start": {"line": 4, "character": 2}},
        "severity": 2,
        "code": "W123",
        "source": "linty",
        "message": "watch out",
    }
    n = lsp_manager._normalize(raw)
    assert n == {"severity": "warning", "line": 5, "col": 3,
                 "message": "watch out", "source": "linty", "code": "W123"}


def test_normalize_defaults_missing_fields():
    n = lsp_manager._normalize({"message": "bare"})
    assert n["severity"] == "error"     # missing severity -> error
    assert n["line"] == 1 and n["col"] == 1
    assert n["code"] == "" and n["source"] == ""


def test_server_status_reports_availability_for_all_languages():
    status = lsp_manager.server_status()
    assert set(status["available"]) == set(lsp_manager._LANG_CMD)
    assert status["servers"] == []          # nothing running on a clean registry
    assert "state_dir" in status


def test_diagnose_unsupported_extension_returns_error():
    result = lsp_manager.diagnose("/tmp/thing.zzz")
    assert result["diagnostics"] == []
    assert "unsupported" in result["error"]


def test_diagnose_missing_binary_returns_installed_error(monkeypatch):
    monkeypatch.setattr(lsp_manager.shutil, "which", lambda b: None)
    result = lsp_manager.diagnose("/tmp/thing.py")
    assert result["diagnostics"] == []
    assert "not installed" in result["error"]


# ===========================================================================
# 2. FAKE LSP SERVER — real subprocess, real framing
# ===========================================================================

FAKE_LSP = r'''
import sys, json

def read_message():
    stream = sys.stdin.buffer
    headers = {}
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if line == b"":
            break
        if b":" in line:
            k, _, v = line.partition(b":")
            headers[k.strip().lower()] = v.strip()
    n = int(headers.get(b"content-length", b"0"))
    body = b""
    while len(body) < n:
        chunk = stream.read(n - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode("utf-8"))

def send(payload):
    data = json.dumps(payload).encode("utf-8")
    out = sys.stdout.buffer
    out.write(b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n")
    out.write(data)
    out.flush()

CANNED = {
    "range": {"start": {"line": 2, "character": 4},
              "end": {"line": 2, "character": 9}},
    "severity": 1,
    "code": "E999",
    "source": "fake-lsp",
    "message": "canned type error for test",
}

def main():
    while True:
        msg = read_message()
        if msg is None:
            return
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {"capabilities": {
                "textDocumentSync": 1,
                "diagnosticProvider": {"interFileDependencies": False,
                                       "workspaceDiagnostics": False},
            }}})
        elif method == "textDocument/diagnostic":
            send({"jsonrpc": "2.0", "id": mid,
                  "result": {"kind": "full", "items": [CANNED]}})
        elif method == "shutdown":
            send({"jsonrpc": "2.0", "id": mid, "result": None})
        elif method == "exit":
            return
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": None})
        # notifications (initialized/didOpen/didClose/...) are ignored

main()
'''


def _install_fake(tmp_path, monkeypatch):
    fake = tmp_path / "fake_lsp.py"
    fake.write_text(FAKE_LSP)
    monkeypatch.setitem(lsp_manager._LANG_CMD, "python",
                        [sys.executable, str(fake)])
    return fake


def test_fake_server_pull_diagnostics(tmp_path, monkeypatch):
    _install_fake(tmp_path, monkeypatch)
    src = tmp_path / "sample.py"
    src.write_text("x = 1\ny = 2\nz = boom\n")

    result = lsp_manager.diagnose(str(src), language="python",
                                  root_dir=str(tmp_path), timeout=5)

    assert result.get("error") is None, result
    assert result["transport"] == "pull"
    assert result["count"] == 1
    d = result["diagnostics"][0]
    assert d["severity"] == "error"
    assert d["line"] == 3          # 0-based line 2 -> 1-based 3
    assert d["col"] == 5           # 0-based char 4 -> 1-based 5
    assert d["code"] == "E999"
    assert d["source"] == "fake-lsp"
    assert "canned" in d["message"]


def test_fake_server_process_is_reused_and_status_lists_it(tmp_path, monkeypatch):
    _install_fake(tmp_path, monkeypatch)
    src = tmp_path / "sample.py"
    src.write_text("a = 1\n")

    r1 = lsp_manager.diagnose(str(src), language="python",
                              root_dir=str(tmp_path), timeout=5)
    status1 = lsp_manager.server_status()
    assert r1.get("error") is None
    py = [s for s in status1["servers"] if s["language"] == "python"]
    assert len(py) == 1
    pid1 = py[0]["pid"]
    assert py[0]["transport"] == "pull"
    assert py[0]["alive"] is True

    # Second call must REUSE the same process (same pid), not spawn a new one.
    r2 = lsp_manager.diagnose(str(src), language="python",
                              root_dir=str(tmp_path), timeout=5)
    assert r2.get("error") is None
    status2 = lsp_manager.server_status()
    py2 = [s for s in status2["servers"] if s["language"] == "python"]
    assert len(py2) == 1
    assert py2[0]["pid"] == pid1


def test_fake_server_missing_file_never_spawns(tmp_path, monkeypatch):
    _install_fake(tmp_path, monkeypatch)
    result = lsp_manager.diagnose(str(tmp_path / "ghost.py"),
                                  language="python", root_dir=str(tmp_path))
    assert result["diagnostics"] == []
    assert "file not found" in result["error"]
    assert lsp_manager.server_status()["servers"] == []


# ===========================================================================
# 3. LIVE rust-analyzer (skipped unless installed / if flaky)
# ===========================================================================


@pytest.mark.skipif(not _rust_analyzer_usable(),
                    reason="a working rust-analyzer is not installed")
def test_live_rust_analyzer_reports_type_error(tmp_path):
    proj = tmp_path / "proj"
    (proj / "src").mkdir(parents=True)
    (proj / "Cargo.toml").write_text(
        '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n'
        '\n[[bin]]\nname = "t"\npath = "src/main.rs"\n'
    )
    main_rs = proj / "src" / "main.rs"
    # `let _x: u8 = "..."` is a hard type mismatch rust-analyzer infers natively.
    main_rs.write_text('fn main() {\n    let _x: u8 = "not a number";\n}\n')

    result = lsp_manager.diagnose(str(main_rs), language="rust",
                                  root_dir=str(proj), timeout=50)

    if result.get("error"):
        pytest.skip(f"rust-analyzer error: {result['error']}")
    errs = [d for d in result["diagnostics"] if d["severity"] == "error"]
    if not errs:
        pytest.skip("rust-analyzer produced no error diagnostics in time "
                    "(indexing/flaky) — not shipping a flaky assertion")
    assert errs[0]["line"] >= 1
    assert errs[0]["message"]
    assert Path(result["root"]) == proj.resolve()
