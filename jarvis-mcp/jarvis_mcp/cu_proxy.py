"""Re-export the computer-use engine (:8794) under a `jarvis_cu_*` namespace.

ONE Jarvis-MCP endpoint must give external agents (Claude Code / Codex) both
Jarvis orchestration *and* full computer use. Rather than hand-mirror the 32
computer-use tools (which drift), we DISCOVER them at startup over an MCP
streamable-http client (tools/list) and register one passthrough proxy per tool:

- the proxy's reported inputSchema is the UPSTREAM schema, verbatim (so callers
  see the exact same parameters);
- a tools/call is forwarded unchanged to the engine and the result content is
  returned.

A passthrough is built by constructing a FastMCP Tool directly with an arg model
that accepts arbitrary fields (extra="allow"), bypassing FastMCP's signature
introspection so the upstream schema is preserved exactly.
"""

from contextlib import asynccontextmanager
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.tools import Tool
from mcp.server.fastmcp.utilities.func_metadata import ArgModelBase, FuncMetadata
from pydantic import ConfigDict

from jarvis_mcp import config

NAMESPACE = "jarvis_cu_"


class _PassThruArgs(ArgModelBase):
    """Validation model that keeps every supplied field (extra='allow') so the
    proxy forwards arbitrary upstream args without re-validating them here."""

    model_config = ConfigDict(extra="allow", arbitrary_types_allowed=True)

    def model_dump_one_level(self) -> dict[str, Any]:
        return dict(self.__pydantic_extra__ or {})


@asynccontextmanager
async def _session():
    url, token = config.computer_use_endpoint()
    headers = {"Authorization": f"Bearer {token}"} if token else None
    async with streamablehttp_client(url, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def list_upstream_tools() -> list[Any]:
    """tools/list against the computer-use engine. Returns mcp.types.Tool list."""
    async with _session() as session:
        return (await session.list_tools()).tools


def _content_to_jsonable(result: Any) -> Any:
    """Flatten a CallToolResult into something MCP can re-serialise. Prefer the
    upstream structuredContent; else collapse text/other content blocks."""
    if getattr(result, "structuredContent", None):
        return result.structuredContent
    blocks: list[Any] = []
    for c in getattr(result, "content", []) or []:
        if getattr(c, "type", None) == "text":
            blocks.append(c.text)
        else:
            blocks.append(c.model_dump() if hasattr(c, "model_dump") else str(c))
    if len(blocks) == 1:
        return blocks[0]
    return blocks


def _make_forwarder(upstream_name: str):
    async def forward(**kwargs: Any) -> Any:
        try:
            async with _session() as session:
                result = await session.call_tool(upstream_name, kwargs)
        except Exception as exc:  # engine down / network
            return {"error": "computer_use_unreachable",
                    "message": str(exc), "tool": upstream_name}
        if getattr(result, "isError", False):
            return {"error": "computer_use_tool_error",
                    "tool": upstream_name,
                    "detail": _content_to_jsonable(result)}
        return _content_to_jsonable(result)

    forward.__name__ = f"{NAMESPACE}{upstream_name}"
    return forward


def _register_proxy(mcp: FastMCP, up: Any) -> str:
    proxied = f"{NAMESPACE}{up.name}"
    desc = up.description or ""
    desc = (f"[computer-use proxy -> {up.name}] " + desc).strip()
    schema = up.inputSchema or {"type": "object", "properties": {}}
    tool = Tool(
        fn=_make_forwarder(up.name),
        name=proxied,
        title=getattr(up, "title", None),
        description=desc,
        parameters=schema,
        fn_metadata=FuncMetadata(arg_model=_PassThruArgs),
        is_async=True,
        context_kwarg=None,
        annotations=getattr(up, "annotations", None),
    )
    mcp._tool_manager._tools[proxied] = tool
    return proxied


async def register_all(mcp: FastMCP) -> list[str]:
    """Discover + register every computer-use tool as a jarvis_cu_* proxy.

    Returns the list of registered proxy names. Tolerant of the engine being
    down at startup (returns [] so the Jarvis-only surface still serves).
    """
    url, token = config.computer_use_endpoint()
    if not url or not token:
        print("jarvis-mcp: computer-use bearer/url not configured; "
              "skipping re-export")
        return []
    try:
        upstream = await list_upstream_tools()
    except Exception as exc:
        print(f"jarvis-mcp: could not reach computer-use engine to re-export "
              f"({url}): {exc}")
        return []
    names = [_register_proxy(mcp, up) for up in upstream]
    print(f"jarvis-mcp: re-exported {len(names)} computer-use tools under "
          f"'{NAMESPACE}*'")
    return names
