# Provisions the self-hosted Windows Actions runner (win-runner-1) with the build
# toolchain the windows-build workflow needs but a fresh box lacks: git (for
# actions/checkout), vcpkg (libsodium + libqrencode), and Inno Setup (iscc).
# VS Build Tools 2022 (MSVC) is already present. Qt / Ninja / Python / Node are
# fetched by the workflow's setup actions and persist in the runner tool cache.
#
# Idempotent: every step is skipped if already installed. Transparent (no piped
# remote scripts) — each installer is the official signed release, run silently.
# Run:  powershell -ExecutionPolicy Bypass -File setup-runner-tools.ps1

$ProgressPreference = 'SilentlyContinue'   # avoids Invoke-WebRequest console-buffer error over SSH
$ErrorActionPreference = 'Continue'

function Log($m) { Write-Host "[setup] $m" }

# ---- 1. Git ---------------------------------------------------------------
$git = "C:\Program Files\Git\cmd\git.exe"
if (-not (Test-Path $git)) {
    Log "downloading Git for Windows..."
    $gu = "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.1/Git-2.55.0-64-bit.exe"
    $go = "$env:TEMP\git-inst.exe"
    Invoke-WebRequest -Uri $gu -OutFile $go
    Log ("downloaded " + (Get-Item $go).Length + " bytes; installing silently...")
    Start-Process -FilePath $go -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/CLOSEAPPLICATIONS' -Wait
}
if (Test-Path $git) { Log ("git OK: " + (& $git --version)) } else { Log "GIT INSTALL FAILED" }

# ---- 2. vcpkg + deps ------------------------------------------------------
$vcpkgRoot = "C:\vcpkg"
if (-not (Test-Path "$vcpkgRoot\vcpkg.exe")) {
    Log "cloning + bootstrapping vcpkg..."
    if (-not (Test-Path $vcpkgRoot)) { & $git clone --depth 1 https://github.com/microsoft/vcpkg $vcpkgRoot }
    & "$vcpkgRoot\bootstrap-vcpkg.bat" -disableMetrics
}
if (Test-Path "$vcpkgRoot\vcpkg.exe") {
    Log "installing libsodium + libqrencode (x64-windows)..."
    & "$vcpkgRoot\vcpkg.exe" install libsodium libqrencode --triplet x64-windows
    [Environment]::SetEnvironmentVariable("VCPKG_INSTALLATION_ROOT", $vcpkgRoot, "Machine")
    Log "vcpkg OK; VCPKG_INSTALLATION_ROOT=$vcpkgRoot (machine)"
} else { Log "VCPKG BOOTSTRAP FAILED" }

# ---- 3. Inno Setup --------------------------------------------------------
$iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) {
    Log "downloading Inno Setup (latest stable)..."
    $io = "$env:TEMP\innosetup.exe"
    Invoke-WebRequest -Uri "https://jrsoftware.org/download.php/is.exe" -OutFile $io
    Log ("downloaded " + (Get-Item $io).Length + " bytes; installing silently...")
    Start-Process -FilePath $io -ArgumentList '/VERYSILENT','/NORESTART','/SP-','/SUPPRESSMSGBOXES' -Wait
}
if (Test-Path $iscc) { Log "Inno Setup OK" } else { Log "INNO SETUP INSTALL FAILED" }

# ---- 4. Machine PATH (git + iscc) so the runner service sees them ---------
$gitCmd = "C:\Program Files\Git\cmd"
$innoDir = "C:\Program Files (x86)\Inno Setup 6"
$machPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
foreach ($d in @($gitCmd, $innoDir)) {
    if ((Test-Path $d) -and ($machPath -notlike "*$d*")) {
        $machPath = "$machPath;$d"
        Log "added to machine PATH: $d"
    }
}
[Environment]::SetEnvironmentVariable("Path", $machPath, "Machine")

Log "DONE"
