; Cindro — Windows installer (Inno Setup 6).
; Produces windows\dist\Cindro-Setup-<version>.exe — ONE installer / ONE app
; image that the windows-build GitHub Action attaches to the Release.
; Bundles: jarvisd.exe, cindro-sidebar.exe (Windows Qt shell), the PyInstaller
; computer-use engine (one-folder), the Node phone server, the Qt runtime,
; cindro-tui.exe (the terminal UI), and the SolidJS web dashboard (web\ + a
; portable bun\bun.exe that serves it via cindro-web.cmd). The installer also
; adds {app} to the user PATH so `cindro-tui` / `cindro-web` are callable from
; any terminal (cmd / PowerShell / git-bash / WSL).
; Build the payload first with windows\scripts\build.ps1, which stages everything
; into windows\dist\payload\ and then invokes ISCC on this script.

#define MyAppName "Cindro"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppPublisher "Cindro"
#define MyAppExeName "cindro-sidebar.exe"
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
DefaultDirName={autopf}\Cindro
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=Cindro-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
; Cindro arc-reactor icon on the installer itself + Add/Remove Programs
; (the app/shortcut/taskbar icon comes from the exe's embedded RC icon —
; windows/jarvis.rc — which didn't exist before, hence the iconless app).
SetupIconFile=..\jarvis.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Per-user install needs no admin (avoids the UAC + lets %APPDATA% config work cleanly).
PrivilegesRequiredOverridesAllowed=dialog
LicenseFile={#PayloadDir}\LICENSE.txt
; We add {app} to the per-user PATH (see [Code]); this makes Inno broadcast
; WM_SETTINGCHANGE so open shells pick the change up without a reboot.
ChangesEnvironment=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "autostart"; Description: "Start the Cindro daemon when I sign in"; GroupDescription: "Startup:"

[Files]
; The whole staged payload (binaries + Qt runtime + engine folder + node server).
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; The shortcut launches the WHOLE stack (engine + phone + daemon + UI) via the
; HIDDEN VBS launcher (wscript) — so jarvisd + the engine start with NO console
; window; only cindro-sidebar (the GUI) appears. Cindro icon kept.
Name: "{group}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\jarvis-launch.vbs"""; IconFilename: "{app}\{#MyAppExeName}"
; Terminal UI v2 (cindro-tui.exe) — a console app, launched directly. Only
; created when the payload actually contains it (built on a bun-equipped runner).
Name: "{group}\Cindro Terminal (TUI)"; Filename: "{app}\cindro-tui.exe"; IconFilename: "{app}\{#MyAppExeName}"; Check: FileExists(ExpandConstant('{app}\cindro-tui.exe'))
; Web dashboard (SolidJS, served by the bundled bun runtime on :8788 via
; cindro-web.cmd). Only created when the payload actually contains the web app.
Name: "{group}\Cindro Web Dashboard"; Filename: "{app}\cindro-web.cmd"; IconFilename: "{app}\{#MyAppExeName}"; Check: FileExists(ExpandConstant('{app}\web\server.ts'))
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\jarvis-launch.vbs"""; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Bring up the full stack with NO terminal: engine + phone + daemon (all hidden) +
; the UI (first run shows the setup wizard).
Filename: "{sys}\wscript.exe"; Parameters: """{app}\jarvis-launch.vbs"""; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[Registry]
; Optional autostart for the whole stack (per-user Run key) — hidden launcher.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "Cindro"; ValueData: """{sys}\wscript.exe"" ""{app}\jarvis-launch.vbs"""; Tasks: autostart; Flags: uninsdeletevalue

[UninstallDelete]
; Leave %APPDATA%\Jarvis (user config/keys) in place on uninstall by default.
Type: filesandordirs; Name: "{app}\engine\__pycache__"

[Code]
{ Add {app} to the per-user PATH so the bundled terminal surfaces —
  cindro-tui.exe (the TUI) and cindro-web.cmd (the web dashboard) — are callable
  by name from any shell that inherits the Windows environment: cmd, PowerShell,
  git-bash, and WSL. Per-user (HKCU\Environment) matches the per-user install and
  needs no admin. ChangesEnvironment=yes makes Inno broadcast WM_SETTINGCHANGE so
  newly-opened shells see it without a reboot. Removed again on uninstall.
  This is the canonical Inno "modify PATH" recipe (idempotent add + clean remove). }
const
  EnvironmentKey = 'Environment';

procedure EnvAddPath(Path: string);
var
  Paths: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
    Paths := '';
  { Skip if this exact directory is already present (case-insensitive). }
  if Pos(';' + Uppercase(Path) + ';', ';' + Uppercase(Paths) + ';') > 0 then exit;
  if Paths = '' then
    Paths := Path
  else
    Paths := Paths + ';' + Path;
  if RegWriteStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
    Log(Format('Added [%s] to PATH', [Path]))
  else
    Log(Format('Error adding [%s] to PATH', [Path]));
end;

procedure EnvRemovePath(Path: string);
var
  Paths: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
    exit;
  { Wrap BOTH ends with ';' so a first / middle / last / only entry all match and
    delete uniformly. The classic `Delete(Paths, P - 1, ...)` form corrupts a
    FIRST or ONLY entry: when {app} is the first item P is 1, so it deletes from
    index 0 — undefined, and on a fresh box whose per-user Path was empty before
    install (so {app} is the only entry) it can wipe or mangle the whole value. }
  Paths := ';' + Paths + ';';
  P := Pos(';' + Uppercase(Path) + ';', Uppercase(Paths));
  if P = 0 then exit;
  { Remove the entry plus ONE trailing separator, leaving the leading wrap ';'. }
  Delete(Paths, P + 1, Length(Path) + 1);
  { Strip the leading + trailing ';' we wrapped with (Copy handles the now-empty
    ";" case: Count goes negative and Copy returns ''). }
  Paths := Copy(Paths, 2, Length(Paths) - 2);
  if RegWriteStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
    Log(Format('Removed [%s] from PATH', [Path]))
  else
    Log(Format('Error removing [%s] from PATH', [Path]));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    EnvAddPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    EnvRemovePath(ExpandConstant('{app}'));
end;
