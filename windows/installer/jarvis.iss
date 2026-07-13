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

[InstallDelete]
; [Files] only ADDS/overwrites — it never removes payload entries that vanished
; between builds. So a reinstall/upgrade whose build DROPPED the web dashboard
; (e.g. bun was unavailable that run) would otherwise leave the PREVIOUS install's
; stale web\ + bun\ behind, and the "Cindro Web Dashboard" shortcut's guard would
; still see them. Wipe both BEFORE copying the new payload (InstallDelete runs
; before [Files]) so the shortcut and the on-disk dashboard reflect THIS build.
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\bun"

[Icons]
; The shortcut launches the WHOLE stack (engine + phone + daemon + UI) via the
; HIDDEN VBS launcher (wscript) — so jarvisd + the engine start with NO console
; window; only cindro-sidebar (the GUI) appears. Cindro icon kept.
Name: "{group}\{#MyAppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\jarvis-launch.vbs"""; IconFilename: "{app}\{#MyAppExeName}"
; Terminal UI v2 (cindro-tui.exe) — a console app, launched directly. Only
; created when the payload actually contains it (built on a bun-equipped runner).
Name: "{group}\Cindro Terminal (TUI)"; Filename: "{app}\cindro-tui.exe"; IconFilename: "{app}\{#MyAppExeName}"; Check: FileExists(ExpandConstant('{app}\cindro-tui.exe'))
; Web dashboard (SolidJS, served by the bundled bun runtime on :8788 via
; cindro-web.cmd). Guarded by WebDashboardStaged (server.ts AND bun.exe AND the
; built dist) — the launcher needs all three, so the shortcut must too, not just
; server.ts (a partially-staged payload would otherwise show a broken shortcut).
Name: "{group}\Cindro Web Dashboard"; Filename: "{app}\cindro-web.cmd"; IconFilename: "{app}\{#MyAppExeName}"; Check: WebDashboardStaged
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
// Add {app} to the per-user PATH so the bundled terminal surfaces —
// cindro-tui.exe (the TUI) and cindro-web.cmd (the web dashboard) — are callable
// by name from any shell that inherits the Windows environment: cmd, PowerShell,
// git-bash, and WSL. Per-user (HKCU\Environment) matches the per-user install and
// needs no admin. ChangesEnvironment=yes makes Inno broadcast WM_SETTINGCHANGE so
// newly-opened shells see it without a reboot. Removed again on uninstall.
// NOTE: these MUST be // line comments, not Pascal { } comments — a { } comment
// can't contain {app} (its `}` closes the comment early and breaks iscc).
const
  EnvironmentKey = 'Environment';
  AppRegKey = 'Software\Cindro';   // where we record that WE added {app} to PATH

// True only when the web dashboard payload is FULLY present. cindro-web.cmd needs
// all three (the launcher, the bun runtime, and the built SPA), so the Start-menu
// shortcut guards on all three — not just server.ts.
function WebDashboardStaged: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\web\server.ts')) and
            FileExists(ExpandConstant('{app}\bun\bun.exe')) and
            FileExists(ExpandConstant('{app}\web\dist\index.html'));
end;

// True if Dir is already a PATH entry (semicolon-wrapped, case-insensitive).
function PathHas(const Paths, Dir: string): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0;
end;

// Rebuild a ';'-separated PATH, dropping empty tokens and (case-insensitively)
// Dir. Split + rejoin with a single ';' — this sidesteps the index-math and
// stray-';;' pitfalls of in-place deletion for a first / middle / last / only
// entry (which is what the earlier Delete()-based version got wrong).
function PathWithout(const Paths, Dir: string): string;
var
  Rest, Item, Acc: string;
  SepPos: Integer;
begin
  Acc := '';
  Rest := Paths;
  while Rest <> '' do
  begin
    SepPos := Pos(';', Rest);
    if SepPos = 0 then
    begin
      Item := Rest;
      Rest := '';
    end
    else
    begin
      Item := Copy(Rest, 1, SepPos - 1);
      Rest := Copy(Rest, SepPos + 1, Length(Rest));
    end;
    if (Item <> '') and (Uppercase(Item) <> Uppercase(Dir)) then
    begin
      if Acc <> '' then Acc := Acc + ';';
      Acc := Acc + Item;
    end;
  end;
  Result := Acc;
end;

procedure EnvAddPath(Path: string);
var
  Paths: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
    Paths := '';
  // If {app} is ALREADY on PATH (a manual add, or an older build), we did NOT add
  // it — leave it and DON'T record ownership, so uninstall won't strip a PATH
  // entry the user had before Cindro.
  if PathHas(Paths, Path) then exit;
  if Paths = '' then
    Paths := Path
  else if Copy(Paths, Length(Paths), 1) = ';' then
    Paths := Paths + Path              // existing trailing ';' — don't create ';;'
  else
    Paths := Paths + ';' + Path;
  // Write back as REG_EXPAND_SZ — the user's Path is normally REG_EXPAND_SZ (it
  // holds entries like %USERPROFILE%\AppData\Local\Microsoft\WindowsApps). A plain
  // RegWriteStringValue would DOWNGRADE it to REG_SZ, after which those %VAR%
  // entries stop expanding and app aliases already on PATH break.
  if RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) then
  begin
    RegWriteDWordValue(HKEY_CURRENT_USER, AppRegKey, 'AddedToPath', 1);  // we own it
    Log(Format('Added [%s] to PATH', [Path]));
  end
  else
    Log(Format('Error adding [%s] to PATH', [Path]));
end;

procedure EnvRemovePath(Path: string);
var
  Paths: string;
  Owned: Cardinal;
begin
  // Only remove {app} if THIS installer added it (ownership marker) — never a
  // pre-existing user entry.
  if not RegQueryDWordValue(HKEY_CURRENT_USER, AppRegKey, 'AddedToPath', Owned) then exit;
  if Owned <> 1 then exit;
  if RegQueryStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', Paths) and PathHas(Paths, Path) then
  begin
    // REG_EXPAND_SZ on the way out too (same reason as EnvAddPath).
    if RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvironmentKey, 'Path', PathWithout(Paths, Path)) then
      Log(Format('Removed [%s] from PATH', [Path]))
    else
      Log(Format('Error removing [%s] from PATH', [Path]));
  end;
  RegDeleteValue(HKEY_CURRENT_USER, AppRegKey, 'AddedToPath');   // clear ownership
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
