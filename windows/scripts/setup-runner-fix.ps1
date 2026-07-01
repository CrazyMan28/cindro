# Idempotent retry for the 3 gaps left by setup-runner-tools.ps1:
# libsodium (re)install, VCPKG_INSTALLATION_ROOT machine env, and Inno Setup.
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
function Log($m) { Write-Host "[fix] $m" }

Log "vcpkg install libsodium libqrencode (idempotent)..."
& "C:\vcpkg\vcpkg.exe" install libsodium libqrencode --triplet x64-windows
Log ("sodium_h=" + (Test-Path "C:\vcpkg\installed\x64-windows\include\sodium.h"))
Log ("qrencode_h=" + (Test-Path "C:\vcpkg\installed\x64-windows\include\qrencode.h"))

[Environment]::SetEnvironmentVariable("VCPKG_INSTALLATION_ROOT", "C:\vcpkg", "Machine")
Log ("VCPKG_ROOT=" + [Environment]::GetEnvironmentVariable("VCPKG_INSTALLATION_ROOT", "Machine"))

$iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) {
    $io = "$env:TEMP\innosetup.exe"
    $url = "https://files.jrsoftware.org/is/6/innosetup-6.2.2.exe"
    Log "downloading Inno Setup: $url"
    Invoke-WebRequest -Uri $url -OutFile $io
    Log ("downloaded " + (Get-Item $io).Length + " bytes; installing silently...")
    Start-Process -FilePath $io -ArgumentList '/VERYSILENT','/NORESTART','/SP-','/SUPPRESSMSGBOXES','/NOICONS' -Wait
}
Log ("iscc=" + (Test-Path $iscc))

$machPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
foreach ($d in @("C:\Program Files\Git\cmd", "C:\Program Files (x86)\Inno Setup 6")) {
    if ((Test-Path $d) -and ($machPath -notlike "*$d*")) { $machPath = "$machPath;$d"; Log "PATH += $d" }
}
[Environment]::SetEnvironmentVariable("Path", $machPath, "Machine")

Restart-Service "actions.runner.CrazyMan28-jarvis.win-runner-1" -Force
Start-Sleep 4
Log ("runner=" + (Get-Service "actions.runner.CrazyMan28-jarvis.win-runner-1").Status)
Log "FIXDONE"
