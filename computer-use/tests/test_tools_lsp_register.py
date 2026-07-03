"""Registration + schema tests for tools_lsp.register().

Mirrors tests/test_tools_bg_register.py: it pins the exact set of tools the LSP
module exposes, checks their inputSchemas / descriptions, and exercises the _err
helper and the tool call path (JSON wrapping + graceful-degrade returns).

Hermetic: JARVIS_LSP_DIR is redirected to a fresh tmp_path so nothing touches real
user state, and every diagnostics call in here targets a missing/unsupported file
so NO real language server is ever spawned.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from mcp.server.fastmcp import FastMCP

from computer_use_mcp.tools_lsp import _err, register

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXPECTED_TOOLS = frozenset({"lsp_diagnostics", "lsp_server_status"})

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_LSP_DIR", str(tmp_path / "lsp"))
    yield


@pytest.fixture()
def mcp():
    m = FastMCP("test-lsp")
    register(m)
    return m


def _call(mcp_instance: FastMCP, tool: str, **kwargs) -> dict:
    result = asyncio.run(mcp_instance.call_tool(tool, kwargs))
    return json.loads(result[0][0].text)


# ===========================================================================
# 1. REGISTRATION — tool presence, schemas, and descriptions
# ===========================================================================


def test_both_tools_are_registered(mcp):
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert names == EXPECTED_TOOLS


def test_no_extra_tools_registered(mcp):
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert names - EXPECTED_TOOLS == set()


def test_every_tool_has_nonempty_description(mcp):
    for t in asyncio.run(mcp.list_tools()):
        assert t.description and t.description.strip(), \
            f"{t.name}: description is blank"


def test_description_tells_model_when_to_use_it(mcp):
    by_name = {t.name: t for t in asyncio.run(mcp.list_tools())}
    # The whole point of this tool: run it AFTER editing, BEFORE claiming done.
    desc = by_name["lsp_diagnostics"].description.lower()
    assert "after" in desc and "edit" in desc


def test_required_params_match_spec(mcp):
    by_name = {t.name: t for t in asyncio.run(mcp.list_tools())}
    req = {n: set(t.inputSchema.get("required", [])) for n, t in by_name.items()}
    assert req["lsp_diagnostics"] == {"path"}
    assert req["lsp_server_status"] == set()


def test_optional_params_present_in_schema(mcp):
    by_name = {t.name: t for t in asyncio.run(mcp.list_tools())}
    props = set(by_name["lsp_diagnostics"].inputSchema["properties"])
    assert {"path", "language", "root_dir"} <= props


def test_two_independent_mcp_instances_both_get_all_tools():
    a, b = FastMCP("a"), FastMCP("b")
    register(a)
    register(b)
    assert {t.name for t in asyncio.run(a.list_tools())} == EXPECTED_TOOLS
    assert {t.name for t in asyncio.run(b.list_tools())} == EXPECTED_TOOLS


# ===========================================================================
# 2. _err HELPER — exception-to-JSON wrapping
# ===========================================================================


def test_err_returns_valid_json():
    parsed = json.loads(_err(ValueError("boom")))
    assert isinstance(parsed, dict)


def test_err_has_error_key_with_exception_message():
    assert json.loads(_err(RuntimeError("nope")))["error"] == "nope"


def test_err_handles_various_exception_types():
    for exc in [OSError("disk full"), KeyError("missing"), TypeError("bad")]:
        parsed = json.loads(_err(exc))
        assert "error" in parsed
        assert str(exc) in parsed["error"]


def test_err_escapes_special_chars_in_message():
    parsed = json.loads(_err(ValueError('path "C:\\x" not found')))
    assert "error" in parsed


# ===========================================================================
# 3. TOOL CALL SEMANTICS — graceful degradation (no server spawned)
# ===========================================================================


def test_diagnostics_unsupported_extension_degrades(mcp):
    """An unsupported file type returns a diagnostics list + error, never raises."""
    result = _call(mcp, "lsp_diagnostics", path="/tmp/whatever.zzz")
    assert result["diagnostics"] == []
    assert "error" in result


def test_diagnostics_missing_file_degrades(mcp, tmp_path):
    """A supported extension whose file is absent returns a graceful error.

    (pylsp is typically not installed on CI, in which case the 'not installed'
    branch fires first — either way it degrades to a diagnostics list + error and
    spawns nothing.)"""
    result = _call(mcp, "lsp_diagnostics",
                   path=str(tmp_path / "nope.py"))
    assert result["diagnostics"] == []
    assert "error" in result


def test_diagnostics_result_always_has_diagnostics_key(mcp):
    result = _call(mcp, "lsp_diagnostics", path="/does/not/exist.qml")
    assert "diagnostics" in result
    assert isinstance(result["diagnostics"], list)


def test_server_status_shape(mcp):
    result = _call(mcp, "lsp_server_status")
    assert "servers" in result and isinstance(result["servers"], list)
    assert "available" in result and isinstance(result["available"], dict)
    # every known language key is reported as available/absent
    assert {"python", "rust", "typescript", "cpp", "go", "qml"} \
        <= set(result["available"])


def test_server_status_honors_state_dir_env(mcp, tmp_path):
    result = _call(mcp, "lsp_server_status")
    assert str(tmp_path / "lsp") in result["state_dir"]
