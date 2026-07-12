@echo off
rem ============================================================================
rem  Cindro Windows launcher - starts the WHOLE stack (no systemd on Windows).
rem
rem  On Linux these run as systemd user services; on Windows this one launcher
rem  brings them all up so EVERY feature works:
rem    1. computer-use engine (jarvis-engine.exe)  -> 127.0.0.1:8794  (all MCP tools)
rem    2. outpost-mcp.exe -> 127.0.0.1:8798 (pair/exec/screenshot remote machines)
rem    3. phone server (bundled node + phone-server) -> 127.0.0.1:8801 (calls/SMS), if configured
rem    4. jarvisd.exe (the daemon: sessions, skills, schedules, subagents, hooks,
rem       memory, voice, plugins, connectors, phone proxy, device/pairing channel)
rem    5. jarvis-sidebar.exe (the UI; first run shows the setup wizard)
rem
rem  Installed to {app}\ ; the Start-menu shortcut + autostart point here.
rem  The engine auto-creates %USERPROFILE%\.computer-use\config.yaml (random
rem  bearer) on first run; jarvisd reads the same file, so they agree with no setup.
rem ============================================================================
setlocal
cd /d "%~dp0"

rem 0. Windows v2 "beside-you" agent desktop: pick the isolation tier for THIS box
rem    (sandbox / hyperv / takeover) and export it so the daemon's AgentDesktop
rem    tiers correctly instead of always defaulting to sandbox (a Home/no-virt box
rem    then cleanly selects takeover instead of a noisy sandbox-precondition fail).
rem    detect.ps1 emits JSON; we pull just recommendedMode. jarvisd is a child of
rem    this cmd, so it inherits the exported variable. Best-effort: on any failure
rem    the variable stays unset and AgentDesktop::resolveMode() defaults to sandbox.
rem  (no pipe in the PowerShell -- a `|` inside a for/f backtick block is fragile
rem   under cmd parsing; ConvertFrom-Json -InputObject takes the script output directly.)
if exist "%~dp0isolation\detect.ps1" (
  for /f "usebackq delims=" %%M in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (ConvertFrom-Json -InputObject (& '%~dp0isolation\detect.ps1')).recommendedMode } catch { '' }"`) do set "JARVIS_WINDOWS_ISOLATION_MODE=%%M"
)

rem 1. computer-use engine (real-screen Win32 backend; serves ALL MCP tools).
rem    PyInstaller one-dir nests it: engine\jarvis-engine\jarvis-engine.exe
if exist "engine\jarvis-engine\jarvis-engine.exe" (
  start "jarvis-engine" /b "engine\jarvis-engine\jarvis-engine.exe"
)

rem 1b. outpost-mcp (pair/exec/screenshot remote machines) -> 127.0.0.1:8798.
rem     No systemd on Windows, so this is the only thing that ever starts it.
rem     OUTPOST_AGENT_BIN_DIR points at the Go agent binaries staged as a
rem     sibling of the PyInstaller one-dir bundle (outpost\agent-bin\).
if exist "outpost\outpost-mcp\outpost-mcp.exe" (
  set "OUTPOST_AGENT_BIN_DIR=%~dp0outpost\agent-bin"
  start "outpost-mcp" /b "outpost\outpost-mcp\outpost-mcp.exe"
)

rem 2. phone server - only if the user configured it (phone.env present)
if exist "%USERPROFILE%\.config\jarvis\phone.env" (
  if exist "node\node.exe" if exist "phone-server\dist\main.js" (
    start "jarvis-phone" /b "node\node.exe" "phone-server\dist\main.js"
  )
)

rem brief stagger so the engine's bearer/config exists before the daemon talks to it
ping -n 2 127.0.0.1 >nul

rem 3. the daemon (headless)
start "jarvisd" /b "jarvisd.exe"

rem 4. the UI (foreground; closing it leaves the daemon + engine running in tray)
start "" "jarvis-sidebar.exe"
endlocal
