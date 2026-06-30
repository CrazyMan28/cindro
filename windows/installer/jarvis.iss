; Jarvis — Windows installer (Inno Setup 6).
; Produces windows\dist\Jarvis-Setup-<version>.exe.
; Bundles: jarvisd.exe, jarvis-sidebar.exe (Windows Qt shell), the PyInstaller
; computer-use engine (one-folder), the Node phone server, and the Qt runtime.
; Build the payload first with windows\scripts\build.ps1, which stages everything
; into windows\dist\payload\ and then invokes ISCC on this script.

#define MyAppName "Jarvis"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppPublisher "Jarvis"
#define MyAppExeName "jarvis-sidebar.exe"
#define MyDaemonExeName "jarvisd.exe"
; Payload root staged by build.ps1 (relative to this .iss).
#ifndef PayloadDir
  #define PayloadDir "..\dist\payload"
#endif

[Setup]
AppId={{B6F0E7B2-7C2A-4E1D-9C3F-JARVISWIN0001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=Jarvis-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Per-user install needs no admin (avoids the UAC + lets %APPDATA% config work cleanly).
PrivilegesRequiredOverridesAllowed=dialog
LicenseFile={#PayloadDir}\LICENSE.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "Start the Jarvis daemon when I sign in"; GroupDescription: "Startup:"

[Files]
; The whole staged payload (binaries + Qt runtime + engine folder + node server).
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Start the daemon, then launch the UI (which shows the first-run setup wizard).
Filename: "{app}\{#MyDaemonExeName}"; Description: "Start Jarvis daemon"; Flags: nowait runhidden
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[Registry]
; Optional autostart for the daemon (per-user Run key).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "JarvisDaemon"; ValueData: """{app}\{#MyDaemonExeName}"""; Tasks: autostart; Flags: uninsdeletevalue

[UninstallDelete]
; Leave %APPDATA%\Jarvis (user config/keys) in place on uninstall by default.
Type: filesandordirs; Name: "{app}\engine\__pycache__"
