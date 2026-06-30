@echo off
rem ============================================================================
rem  Jarvis Windows launcher - starts the WHOLE stack (no systemd on Windows).
rem
rem  On Linux these run as systemd user services; on Windows this one launcher
rem  brings them all up so EVERY feature works:
rem    1. computer-use engine (jarvis-engine.exe)  -> 127.0.0.1:8794  (all MCP tools)
rem    2. phone server (bundled node + phone-server) -> 127.0.0.1:8801 (calls/SMS), if configured
rem    3. jarvisd.exe (the daemon: sessions, skills, schedules, subagents, hooks,
rem       memory, voice, plugins, connectors, phone proxy, device/pairing channel)
rem    4. jarvis-sidebar.exe (the UI; first run shows the setup wizard)
rem
rem  Installed to {app}\ ; the Start-menu shortcut + autostart point here.
rem  The engine auto-creates %USERPROFILE%\.computer-use\config.yaml (random
rem  bearer) on first run; jarvisd reads the same file, so they agree with no setup.
rem ============================================================================
setlocal
cd /d "%~dp0"

rem 1. computer-use engine (real-screen Win32 backend; serves ALL MCP tools)
if exist "engine\jarvis-engine.exe" (
  start "jarvis-engine" /b "engine\jarvis-engine.exe"
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
