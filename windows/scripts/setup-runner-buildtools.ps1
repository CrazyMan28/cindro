# Pre-installs the BUILD toolchain on the self-hosted runner so windows-build does
# ZERO per-run downloads (mirrors the Linux prebuilt CI image). Installs:
#   - Python 3.12 (real, on PATH; for the PyInstaller engine venv + aqt)
#   - Qt 6.10.3 win64_msvc2022_64 + qtwebsockets + qtmultimedia (via aqtinstall -> C:\Qt)
#   - Ninja (CMake generator)
#   - Node 20 (npm ci for the phone server)
# and sets machine env: CMAKE_PREFIX_PATH + PATH (Qt\bin, ninja, node).
# VS Build Tools, git, vcpkg(+libs), Inno, pwsh are already provisioned.
# Idempotent. Run: powershell -ExecutionPolicy Bypass -File setup-runner-buildtools.ps1
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
function Log($m) { Write-Host "[buildtools] $m" }

# ---- 1. Python 3.12 -------------------------------------------------------
$py = "C:\Program Files\Python312\python.exe"
if (-not (Test-Path $py)) {
    $url = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe"
    $o = "$env:TEMP\python312.exe"
    Log "downloading Python 3.12.8..."
    Invoke-WebRequest -Uri $url -OutFile $o
    Log ("installing Python (" + (Get-Item $o).Length + " bytes)...")
    Start-Process -FilePath $o -ArgumentList '/quiet','InstallAllUsers=1','PrependPath=1','Include_pip=1','Include_test=0' -Wait
}
if (Test-Path $py) { Log ("python OK: " + (& $py --version)) } else { Log "PYTHON INSTALL FAILED" }

# ---- 2. aqt + Qt 6.10.3 ---------------------------------------------------
$qtDir = "C:\Qt\6.10.3\msvc2022_64"
if (-not (Test-Path "$qtDir\bin\windeployqt.exe")) {
    Log "pip install aqtinstall..."
    & $py -m pip install --upgrade pip aqtinstall 2>&1 | Select-Object -Last 2
    Log "aqt install Qt 6.10.3 win64_msvc2022_64 + qtwebsockets qtmultimedia (this downloads ~1.5GB)..."
    & $py -m aqt install-qt windows desktop 6.10.3 win64_msvc2022_64 --modules qtwebsockets qtmultimedia --outputdir C:\Qt 2>&1 | Select-Object -Last 3
}
if (Test-Path "$qtDir\bin\windeployqt.exe") { Log "Qt OK: $qtDir" } else { Log "QT INSTALL FAILED" }

# ---- 3. Ninja -------------------------------------------------------------
$ninjaDir = "C:\ninja"
if (-not (Test-Path "$ninjaDir\ninja.exe")) {
    $url = "https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip"
    $o = "$env:TEMP\ninja-win.zip"
    Log "downloading Ninja..."
    Invoke-WebRequest -Uri $url -OutFile $o
    New-Item -ItemType Directory -Force -Path $ninjaDir | Out-Null
    Expand-Archive -Force $o $ninjaDir
}
if (Test-Path "$ninjaDir\ninja.exe") { Log "Ninja OK" } else { Log "NINJA INSTALL FAILED" }

# ---- 4. Node 20 -----------------------------------------------------------
$nodeDir = "C:\node20"
if (-not (Test-Path "$nodeDir\node.exe")) {
    $url = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip"
    $o = "$env:TEMP\node20.zip"
    Log "downloading Node 20..."
    Invoke-WebRequest -Uri $url -OutFile $o
    Expand-Archive -Force $o "$env:TEMP\node20-extract"
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    Copy-Item "$env:TEMP\node20-extract\node-v20.18.1-win-x64\*" $nodeDir -Recurse -Force
}
if (Test-Path "$nodeDir\node.exe") { Log ("Node OK: " + (& "$nodeDir\node.exe" --version)) } else { Log "NODE INSTALL FAILED" }

# ---- 5. machine env: CMAKE_PREFIX_PATH + PATH -----------------------------
[Environment]::SetEnvironmentVariable("CMAKE_PREFIX_PATH", $qtDir, "Machine")
[Environment]::SetEnvironmentVariable("Qt6_DIR", "$qtDir\lib\cmake\Qt6", "Machine")
$machPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
foreach ($d in @("$qtDir\bin", $ninjaDir, $nodeDir, "C:\Program Files\Python312", "C:\Program Files\Python312\Scripts")) {
    if ((Test-Path $d) -and ($machPath -notlike "*$d*")) { $machPath = "$machPath;$d"; Log "PATH += $d" }
}
[Environment]::SetEnvironmentVariable("Path", $machPath, "Machine")
Log ("CMAKE_PREFIX_PATH=" + [Environment]::GetEnvironmentVariable("CMAKE_PREFIX_PATH", "Machine"))

# ---- 6. restart runner to pick up the new env -----------------------------
Restart-Service "actions.runner.CrazyMan28-jarvis.win-runner-1" -Force
Start-Sleep 4
Log ("runner=" + (Get-Service "actions.runner.CrazyMan28-jarvis.win-runner-1").Status)
Log "BUILDTOOLSDONE"
