"""The six outpost_* MCP tools — thin wrappers over the registry, pairing store,
and agent hub. An external agent (Claude Code / Codex) uses these to pair a
machine and then run gated shell commands / grab screenshots on it by name."""

from typing import Any

from mcp.server.fastmcp import FastMCP


def register(mcp: FastMCP, registry: Any, pairing: Any, hub: Any) -> list[str]:
    """Register every outpost_* tool; return their names."""

    @mcp.tool()
    async def outpost_list_machines() -> dict[str, Any]:
        """List paired Outpost machines: {machines:[{id,name,os,transport,status,last_seen}]}."""
        return {"machines": registry.list()}

    @mcp.tool()
    async def outpost_pair_start(name: str = "", os_hint: str = "") -> dict[str, Any]:
        """Begin pairing a NEW machine. Returns a one-shot 10-minute bootstrap +
        ready-to-paste install one-liners for Linux/macOS and Windows. Run the
        matching one-liner ON the target machine to register it."""
        return pairing.start(name, os_hint)

    @mcp.tool()
    async def outpost_pair_status(bootstrap_id: str) -> dict[str, Any]:
        """Poll a pairing: status is pending | paired | expired | unknown
        (and machine_id once paired)."""
        return pairing.status(bootstrap_id)

    @mcp.tool()
    async def outpost_exec(machine: str, cmd: str, timeout: float = 30.0,
                           shell: str = "auto") -> dict[str, Any]:
        """Run a shell command on a paired machine (by name OR id). shell:
        "auto" = PowerShell on Windows, sh on Linux/macOS. Returns
        {ok, exit_code, output, error}. Full trust — no post-pairing allow-list."""
        return await hub.exec(machine, cmd, timeout, shell)

    @mcp.tool()
    async def outpost_screenshot(machine: str) -> dict[str, Any]:
        """Grab a screenshot from a paired machine (by name OR id). Returns
        {ok, image_base64, width, height, captured_at}."""
        return await hub.screenshot(machine)

    @mcp.tool()
    async def outpost_revoke(machine: str) -> dict[str, Any]:
        """Unpair a machine (by name OR id): drops its live socket and deletes its
        token. Returns {ok, revoked}."""
        m = registry.get(machine)
        if not m:
            return {"ok": False, "revoked": False}
        hub.unregister(m["id"])
        ok = registry.revoke(m["id"])
        return {"ok": ok, "revoked": ok}

    return [
        "outpost_list_machines", "outpost_pair_start", "outpost_pair_status",
        "outpost_exec", "outpost_screenshot", "outpost_revoke",
    ]
