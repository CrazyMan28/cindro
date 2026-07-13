@echo off
rem ============================================================================
rem  Cindro Web Dashboard launcher.
rem
rem  Serves the built SolidJS dashboard (web\dist\) over the bundled portable Bun
rem  runtime on http://127.0.0.1:8788 and opens it in your browser. This is the
rem  Windows analogue of Linux's `cindro web start` — it runs the SAME
rem  web\server.ts (a Bun.serve static server), just with the bun\bun.exe shipped
rem  inside the installer, so nothing has to be pre-installed.
rem
rem  The dashboard talks DIRECTLY to jarvisd's loopback control WebSocket
rem  (ws://127.0.0.1:8795/control/ws); this launcher only serves static files and
rem  prints the control token to paste into the Setup screen.
rem
rem  Installed to {app}\cindro-web.cmd and (because the installer adds {app} to
rem  PATH) callable as `cindro-web` from cmd / PowerShell / git-bash / WSL.
rem  Override the port with %JARVIS_WEB_PORT%. Close this window (or Ctrl+C) to
rem  stop the dashboard.
rem ============================================================================
setlocal
cd /d "%~dp0"
set "PORT=8788"
if not "%JARVIS_WEB_PORT%"=="" set "PORT=%JARVIS_WEB_PORT%"

if not exist "%~dp0bun\bun.exe" (
  echo [cindro-web] bundled bun runtime missing - this installer was built without the web dashboard.
  echo             ^(rebuild on a bun-equipped runner, or run `cindro web start` from a repo checkout^)
  pause
  exit /b 1
)
if not exist "%~dp0web\server.ts" (
  echo [cindro-web] web\server.ts missing - this installer was built without the web dashboard.
  pause
  exit /b 1
)

echo Cindro web dashboard: http://127.0.0.1:%PORT%
echo Close this window to stop the dashboard.
rem Open the browser only once the server is actually accepting connections on
rem the port (up to ~15s), rather than after a blind fixed delay — otherwise a
rem slow/failed start or a busy port lands the user on "connection refused".
rem Runs in the background (minimized) so the server itself owns this console.
start "" /min powershell -NoProfile -Command "$u='http://127.0.0.1:%PORT%'; foreach($i in 1..60){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%PORT%); $c.Close(); break }catch{ Start-Sleep -Milliseconds 250 } }; Start-Process $u"
"%~dp0bun\bun.exe" "%~dp0web\server.ts" --port %PORT%
endlocal
