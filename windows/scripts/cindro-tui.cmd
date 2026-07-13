@echo off
rem ============================================================================
rem  Cindro Terminal (TUI) launcher.
rem
rem  cindro-tui.exe is only a control-WebSocket CLIENT of jarvisd. Launched
rem  straight after a reboot with autostart OFF, the daemon isn't running and the
rem  raw exe opens OFFLINE. So — unlike double-clicking the exe — this wrapper
rem  brings the daemon (+ the computer-use engine) up FIRST when they aren't
rem  already listening on the control port, HIDDEN and DETACHED (they survive
rem  closing the TUI) and WITHOUT opening the desktop GUI, then hands off to the
rem  TUI in this console. Idempotent: if jarvisd is already up (autostart, the
rem  GUI, or a prior launch) the port check skips the bring-up.
rem
rem  The Start-menu "Cindro Terminal (TUI)" shortcut points here. Override the
rem  control port with %JARVIS_CONTROL_PORT%.
rem ============================================================================
setlocal
cd /d "%~dp0"
set "CTRLPORT=8795"
if not "%JARVIS_CONTROL_PORT%"=="" set "CTRLPORT=%JARVIS_CONTROL_PORT%"

rem If jarvisd isn't already listening on the control port, start the engine +
rem daemon hidden & detached (Start-Process, not `start /b`, so they DON'T die when
rem this console closes). One PowerShell call: connect-probe in the try, bring-up in
rem the catch. Kept on a single line — cmd's `^` continuation is fragile with quotes.
powershell -NoProfile -Command "try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%CTRLPORT%); $c.Close() }catch{ $d='%~dp0'; $e=Join-Path $d 'engine\jarvis-engine\jarvis-engine.exe'; if(Test-Path $e){ Start-Process -WindowStyle Hidden -FilePath $e }; Start-Sleep -Milliseconds 800; Start-Process -WindowStyle Hidden -FilePath (Join-Path $d 'jarvisd.exe'); Start-Sleep -Milliseconds 1500 }"

"%~dp0cindro-tui.exe"
endlocal
