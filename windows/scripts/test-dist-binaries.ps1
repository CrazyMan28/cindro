# Tests the NEW build's binaries DIRECTLY from the staged dist/ payload (bypasses the
# installer). dist/ is the full app dir (jarvisd.exe + cindro-sidebar.exe + all DLLs),
# so the binaries run as-installed. Proves the shipped build works.
$ErrorActionPreference = 'Continue'
function Log($m) { Write-Host "[dist] $m" }

Get-Process cindro-sidebar, jarvisd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

$dist = "C:\actions-runner\_work\jarvis\jarvis\windows\dist"
$jd = Join-Path $dist "jarvisd.exe"
$sb = Join-Path $dist "cindro-sidebar.exe"
Log "jarvisd in dist = $(Test-Path $jd)  mtime=$((Get-Item $jd -ErrorAction SilentlyContinue).LastWriteTime)"
Log "sidebar in dist = $(Test-Path $sb)  mtime=$((Get-Item $sb -ErrorAction SilentlyContinue).LastWriteTime)"

# root-cause token test with the NEW jarvisd
$tok = "$env:USERPROFILE\.config\jarvis\control_token"
Remove-Item $tok -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $jd -PassThru -WindowStyle Hidden
Start-Sleep 10
Log "control_token created at ~/.config/jarvis = $(Test-Path $tok)"
if (Test-Path $tok) { Log "token length = $(((Get-Content $tok -Raw)).Trim().Length) chars" }
$listen = (Get-NetTCPConnection -LocalPort 8795 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
Log "jarvisd listening 127.0.0.1:8795 = $($listen -gt 0)"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

# NEW sidebar QML selftest offscreen
$env:QT_QPA_PLATFORM = 'offscreen'
$sp = Start-Process -FilePath $sb -ArgumentList '--selftest' -Wait -PassThru -NoNewWindow -RedirectStandardError "$env:TEMP\sbd.txt"
Log "NEW sidebar --selftest exit = $($sp.ExitCode)  (0 = full QML tree incl. maximize + name fields loaded)"
Get-Content "$env:TEMP\sbd.txt" -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Log "  stderr: $_" }
Log "DISTTESTDONE"
