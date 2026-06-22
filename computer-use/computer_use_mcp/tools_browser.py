"""Browser MCP tools, served by the Chrome extension over the WS bridge.

All tools are async: bridge futures resolve on the server's event loop.
tab_id is optional everywhere — the extension defaults to the active tab.
"""

import json
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP, Image

from computer_use_mcp.browser_bridge import bridge


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def _j(result: Any) -> str:
    return json.dumps(result if result is not None else {"ok": True})


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    async def browser_status() -> str:
        """Is the Chrome extension connected? Returns extension version/UA when
        it is, plus per-tab debugger attach state."""
        try:
            if not bridge.connected:
                return json.dumps({
                    "connected": False,
                    "hint": "Open Chrome with the computer-use extension loaded "
                            "(chrome://extensions, Developer mode, Load unpacked -> "
                            "extension/ dir; set token+port in its Options page).",
                })
            info = await bridge.send_command("ping")
            return json.dumps({"connected": True, "hello": bridge.hello, "ping": info})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_tabs() -> str:
        """List open tabs: id, windowId, title, url, active, status."""
        try:
            return _j(await bridge.send_command("tabs.list"))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_tab_new(url: str = "about:blank", activate: bool = True) -> str:
        """Open a new tab (returns its id)."""
        try:
            return _j(await bridge.send_command("tabs.create", {"url": url, "active": activate}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_tab_activate(tab_id: int) -> str:
        """Focus the given tab (and its window)."""
        try:
            return _j(await bridge.send_command("tabs.activate", {"tabId": tab_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_tab_close(tab_id: int) -> str:
        """Close the given tab."""
        try:
            return _j(await bridge.send_command("tabs.close", {"tabId": tab_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_navigate(url: str, tab_id: Optional[int] = None) -> str:
        """Navigate a tab (default: active tab) to a URL and wait for load.
        Also accepts 'back' or 'forward' as the url for history navigation."""
        try:
            return _j(await bridge.send_command("nav.goto", {"url": url, "tabId": tab_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_snapshot(tab_id: Optional[int] = None, max_nodes: int = 600) -> str:
        """Read the page: title/url plus an outline of interactive elements,
        each with a ref like e7. Pass refs to browser_click/browser_type/
        browser_select. Refs go stale after navigation — re-snapshot then."""
        try:
            return _j(await bridge.send_command(
                "page.snapshot", {"tabId": tab_id, "maxNodes": max_nodes}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_click(
        ref: Optional[str] = None,
        selector: Optional[str] = None,
        tab_id: Optional[int] = None,
        trusted: bool = False,
    ) -> str:
        """Click an element by snapshot ref (e.g. 'e7') or CSS selector.
        trusted=True dispatches a real input event through the debugger
        (needed for sites that ignore synthetic clicks; shows Chrome's
        'being debugged' banner)."""
        try:
            if not ref and not selector:
                raise ValueError("Pass ref or selector")
            return _j(await bridge.send_command(
                "page.click",
                {"ref": ref, "selector": selector, "tabId": tab_id, "trusted": trusted}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_type(
        text: str,
        ref: Optional[str] = None,
        selector: Optional[str] = None,
        clear: bool = True,
        submit: bool = False,
        tab_id: Optional[int] = None,
    ) -> str:
        """Type into an input/textarea/contenteditable (by ref or selector).
        clear replaces existing content; submit presses Enter after."""
        try:
            if not ref and not selector:
                raise ValueError("Pass ref or selector")
            return _j(await bridge.send_command(
                "page.type",
                {"text": text, "ref": ref, "selector": selector,
                 "clear": clear, "submit": submit, "tabId": tab_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_select(
        value: str,
        ref: Optional[str] = None,
        selector: Optional[str] = None,
        tab_id: Optional[int] = None,
    ) -> str:
        """Choose an option in a <select> by value or visible label."""
        try:
            if not ref and not selector:
                raise ValueError("Pass ref or selector")
            return _j(await bridge.send_command(
                "page.select",
                {"value": value, "ref": ref, "selector": selector, "tabId": tab_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_scroll(
        direction: str = "down",
        amount: int = 600,
        ref: Optional[str] = None,
        tab_id: Optional[int] = None,
    ) -> str:
        """Scroll the page by ~amount px (up/down), or scroll the element with
        the given ref into view."""
        try:
            return _j(await bridge.send_command(
                "page.scroll",
                {"direction": direction, "amount": amount, "ref": ref, "tabId": tab_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_screenshot(tab_id: Optional[int] = None, full_page: bool = False) -> list:
        """Screenshot a tab (default: active). full_page captures beyond the
        viewport via the debugger. Returns a PNG image."""
        try:
            result = await bridge.send_command(
                "page.screenshot", {"tabId": tab_id, "fullPage": full_page}, timeout=45)
            data_url = result.get("dataUrl", "")
            if "," not in data_url:
                raise RuntimeError(f"extension returned no image: {result}")
            import base64
            head, b64 = data_url.split(",", 1)
            fmt = "jpeg" if "jpeg" in head else "png"
            return [Image(data=base64.b64decode(b64), format=fmt),
                    json.dumps({k: v for k, v in result.items() if k != "dataUrl"})]
        except Exception as exc:
            return [_err(exc)]

    @mcp.tool()
    async def browser_eval(js: str, tab_id: Optional[int] = None) -> str:
        """Run JavaScript in the page (main world) and return the JSON-able
        result. Example: 'document.title' or '[...document.images].length'."""
        try:
            return _j(await bridge.send_command("page.eval", {"js": js, "tabId": tab_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_console(tab_id: Optional[int] = None, limit: int = 50) -> str:
        """Read recent console messages of a tab (requires the debugger to have
        been attached — it auto-attaches on first use and stays on the tab)."""
        try:
            return _j(await bridge.send_command("console.read", {"tabId": tab_id, "limit": limit}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    async def browser_cdp(method: str, params_json: str = "{}", tab_id: Optional[int] = None) -> str:
        """Escape hatch: send a raw Chrome DevTools Protocol command to a tab,
        e.g. method='Page.captureScreenshot', params_json='{"format":"png"}'.
        Attaches the debugger to the tab if needed."""
        try:
            params = json.loads(params_json) if params_json else {}
            return _j(await bridge.send_command(
                "cdp.send", {"method": method, "params": params, "tabId": tab_id}, timeout=45))
        except Exception as exc:
            return _err(exc)
