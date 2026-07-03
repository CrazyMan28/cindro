"""LSP diagnostics MCP tools for the co-work brain.

Exposed ON the computer-use engine (the same isolated MCP server the brain already
drives). The brain edits source files with its own CLI tools; the engine has no
file-write hook, so getting real compiler/linter feedback is an EXPLICIT step: the
model calls ``lsp_diagnostics`` after editing a file to see the actual errors,
warnings, and hints a language server reports — before claiming the change is done.

Backed by ``lsp_manager`` (raw JSON-RPC over each server's stdio; one process per
language, reused across calls). Failures return a JSON ``{"error": ...}``; the
diagnostics tool additionally always carries a ``diagnostics`` list so a missing
server or bad path degrades gracefully instead of blowing up a turn.
"""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import lsp_manager


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def lsp_diagnostics(path: str, language: str = "auto",
                        root_dir: str = "") -> str:
        """Get real-time DIAGNOSTICS (errors/warnings/info/hints) for a source file
        from its language server. CALL THIS AFTER EDITING a code file — before you
        claim the edit is done — to catch type errors, undefined names, bad
        imports, and lints that a blind edit would miss.

        It starts (or reuses) the right language server, opens the file with its
        CURRENT on-disk contents, and returns only the structured problems:
        [{severity: "error"|"warning"|"info"|"hint", line, col, message, source,
        code}]. Lines and columns are 1-BASED (as an editor shows them).

        path: the file to check. language: "auto" detects from the extension
        (.py→python/pylsp, .rs→rust/rust-analyzer, .ts/.tsx/.js/.jsx→typescript,
        .c/.cpp/.h→cpp/clangd, .go→gopls, .qml→qmlls); pass an explicit language
        key to override. root_dir: the workspace root — leave "" to auto-detect by
        walking up for Cargo.toml / pyproject.toml / package.json / go.mod / .git.

        Degrades gracefully: if the language server isn't installed, the file is
        missing, or the type is unsupported, it returns {"diagnostics": [],
        "error": "..."} rather than failing. An empty diagnostics list means the
        file is clean. Check server availability with lsp_server_status."""
        try:
            return json.dumps(lsp_manager.diagnose(path, language, root_dir))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def lsp_server_status() -> str:
        """List the language servers currently running in-process (language, pid,
        workspace root, idle time, diagnostic transport) AND which server binaries
        are available on PATH. Use it to check whether a language is supported here
        before relying on lsp_diagnostics, or to see what's still warm."""
        try:
            return json.dumps(lsp_manager.server_status())
        except Exception as exc:  # noqa: BLE001
            return _err(exc)
