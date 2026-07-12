# Clean-install + smoke-test the freshly built Cindro .exe on the runner box.
# Kills the pre-existing (running) Cindro so the installer can replace the binaries,
# then verifies: NEW binaries in place, jarvisd writes control_token to
# $HOME\.config\jarvis (where the fixed sidebar reads it) + listens on 8795, and the
# sidebar QML loads offscreen (--selftest) — proving the new UI (maximize + name
# fields) instantiates.
$ErrorActionPreference = 'Continue'
function Log($m) { Write-Host "[test] $m" }

# Kill any running Cindro + the launcher (wscript) so files aren't in use.
Get-Process jarvis-sidebar, jarvisd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*jarvis*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 3

# Uninstall the old build if present, so the new one installs clean.
$unins = "C:\Program Files\Jarvis\unins000.exe"
if (Test-Path $unins) { Log "uninstalling old..."; Start-Process $unins -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait; Start-Sleep 3 }

$exe = "C:\actions-runner\_work\jarvis\jarvis\windows\dist\Jarvis-Setup-0.1.0-9197979.exe"
Log "installing new build..."
$p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru
Log "install exit = $($p.ExitCode)"
$sb = "C:\Program Files\Jarvis\jarvis-sidebar.exe"
$jd = "C:\Program Files\Jarvis\jarvisd.exe"
Log "sidebar installed = $(Test-Path $sb); mtime = $((Get-Item $sb -ErrorAction SilentlyContinue).LastWriteTime)"

# --- root-cause token test (fresh jarvisd) ---
$tok = "$env:USERPROFILE\.config\jarvis\control_token"
Remove-Item $tok -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $jd -PassThru -WindowStyle Hidden
Start-Sleep 10
Log "control_token created at ~/.config/jarvis = $(Test-Path $tok)"
if (Test-Path $tok) { Log "token length = $(((Get-Content $tok -Raw)).Trim().Length) chars" }
$listen = (Get-NetTCPConnection -LocalPort 8795 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
Log "jarvisd listening 127.0.0.1:8795 = $($listen -gt 0)"

# --- sidebar QML selftest offscreen (new build) ---
$env:QT_QPA_PLATFORM = 'offscreen'
$sp = Start-Process -FilePath $sb -ArgumentList '--selftest' -Wait -PassThru -NoNewWindow -RedirectStandardError "$env:TEMP\sb2.txt"
Log "sidebar --selftest exit = $($sp.ExitCode) (0 = full QML tree loaded)"
Get-Content "$env:TEMP\sb2.txt" -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Log "  stderr: $_" }

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Log "TESTDONE"
