"""PyInstaller entry point for the bundled outpost-mcp server on Windows.

outpost_mcp ships a console_scripts entry (outpost-mcp = outpost_mcp.server:main)
but no __main__.py, and PyInstaller needs a concrete script to analyze — this is
that script. outpost_mcp itself has no Windows-specific code (see windows/README.md:
only the computer-use engine needs a Win32 rebinding shim), so it's frozen as-is
from the shared outpost-mcp/ package, unlike windows/engine/server_windows.py.
"""
from outpost_mcp.server import main

if __name__ == "__main__":
    main()
