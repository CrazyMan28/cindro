' Jarvis Windows launcher (HIDDEN) - no terminal window.
'
' The Start-menu/desktop shortcuts + autostart run THIS (via wscript) instead of
' the .cmd, so jarvisd + the engine (console apps) start HIDDEN (window style 0)
' and only jarvis-sidebar.exe (the GUI) shows a window. Brings up the whole stack:
'   engine (:8794, all MCP tools) -> phone server (:8801, if configured) ->
'   jarvisd -> jarvis-sidebar (UI; first run = setup wizard).
Option Explicit
Dim sh, fso, dir, p
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. computer-use engine (hidden). PyInstaller one-dir nests it:
'    engine\jarvis-engine\jarvis-engine.exe (with _internal\ beside it).
p = dir & "\engine\jarvis-engine\jarvis-engine.exe"
If fso.FileExists(p) Then sh.Run """" & p & """", 0, False

' 2. phone server (hidden) - only if the user configured it (phone.env present)
Dim node, server, phoneEnv
node    = dir & "\node\node.exe"
server  = dir & "\phone-server\dist\main.js"
phoneEnv = sh.ExpandEnvironmentStrings("%USERPROFILE%\.config\jarvis\phone.env")
If fso.FileExists(node) And fso.FileExists(server) And fso.FileExists(phoneEnv) Then
    sh.Run """" & node & """ """ & server & """", 0, False
End If

' 3. the daemon (hidden console - this is what used to pop a terminal)
p = dir & "\jarvisd.exe"
If fso.FileExists(p) Then sh.Run """" & p & """", 0, False

' let the daemon bind its control socket before the UI connects
WScript.Sleep 1500

' 4. the UI (normal window)
p = dir & "\jarvis-sidebar.exe"
If fso.FileExists(p) Then sh.Run """" & p & """", 1, True
