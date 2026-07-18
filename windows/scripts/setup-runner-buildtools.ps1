# Pre-installs the BUILD toolchain on the self-hosted runner so windows-build does
# ZERO per-run downloads (mirrors the Linux prebuilt CI image). Installs:
#   - Python 3.12 (real, on PATH; for the PyInstaller engine venv + aqt)
#   - Qt 6.10.3 win64_msvc2022_64 + qtwebsockets + qtmultimedia (via aqtinstall -> C:\Qt)
#   - Ninja (CMake generator)
#   - Node 20 (npm ci for the phone server)
#   - Go (latest stable, cross-compiles outpost-agent for all 6 pairing targets)
#   - bun (builds cindro-tui.exe AND the web/ SolidJS dashboard)
# and sets machine env: CMAKE_PREFIX_PATH + PATH (Qt\bin, ninja, node, go\bin, bun).
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

# ---- 4b. CMake ------------------------------------------------------------
$cmake = "C:\Program Files\CMake\bin\cmake.exe"
if (-not (Test-Path $cmake)) {
    $url = "https://github.com/Kitware/CMake/releases/download/v4.3.3/cmake-4.3.3-windows-x86_64.msi"
    $o = "$env:TEMP\cmake.msi"
    Log "downloading CMake 4.3.3..."
    Invoke-WebRequest -Uri $url -OutFile $o
    Log ("installing CMake (" + (Get-Item $o).Length + " bytes)...")
    Start-Process msiexec.exe -ArgumentList '/i', "`"$o`"", '/qn', '/norestart', 'ADD_CMAKE_TO_PATH=System' -Wait
}
if (Test-Path $cmake) { Log ("cmake OK: " + (& $cmake --version | Select-Object -First 1)) } else { Log "CMAKE INSTALL FAILED" }

# ---- 4c. Go (cross-compiles outpost-agent for all 6 targets) --------------
$goDir = "C:\go-portable"
$goExe = "$goDir\go\bin\go.exe"
if (-not (Test-Path $goExe)) {
    Log "resolving latest stable Go release..."
    $release = Invoke-RestMethod -Uri "https://go.dev/dl/?mode=json"
    $file = $release[0].files | Where-Object { $_.os -eq "windows" -and $_.arch -eq "amd64" -and $_.kind -eq "archive" } | Select-Object -First 1
    if ($file) {
        $o = "$env:TEMP\$($file.filename)"
        Log "downloading $($file.filename)..."
        Invoke-WebRequest -Uri "https://go.dev/dl/$($file.filename)" -OutFile $o
        New-Item -ItemType Directory -Force -Path $goDir | Out-Null
        Expand-Archive -Force $o $goDir
    } else { Log "could not resolve a windows-amd64 Go archive from go.dev" }
}
if (Test-Path $goExe) { Log ("Go OK: " + (& $goExe version)) } else { Log "GO INSTALL FAILED" }

# ---- 4d. bun (builds cindro-tui.exe + the web/ SolidJS dashboard) ----------
# build.ps1 also self-heals bun if it's missing, but pre-installing it here
# avoids a ~90 MB per-run download and keeps the TUI + web dashboard in the
# installer even on a cold cache. Portable zip from GitHub releases -> C:\bun.
$bunDir = "C:\bun"
$bunExe = "$bunDir\bun.exe"
if (-not (Test-Path $bunExe)) {
    # Resolve 'latest' to a concrete LOGGED tag and verify the zip against that
    # release's SHASUMS256.txt before trusting bun.exe (same integrity gate as
    # windows/scripts/build.ps1's self-heal). A mismatch/error leaves bun absent
    # so the build's self-heal can retry rather than caching a bad binary.
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/oven-sh/bun/releases/latest" -Headers @{ 'User-Agent' = 'cindro-runner' }
        $tag = $rel.tag_name
        if (-not $tag) { throw "could not resolve latest bun tag" }
        Log "downloading bun $tag (portable)..."
        $o = "$env:TEMP\bun-windows-x64.zip"
        $sums = "$env:TEMP\bun-SHASUMS256.txt"
        $dl = "https://github.com/oven-sh/bun/releases/download/$tag"
        Invoke-WebRequest -Uri "$dl/bun-windows-x64.zip" -OutFile $o
        Invoke-WebRequest -Uri "$dl/SHASUMS256.txt"       -OutFile $sums
        $line = Get-Content $sums | Where-Object { $_ -match 'bun-windows-x64\.zip\s*$' } | Select-Object -First 1
        if (-not $line) { throw "bun-windows-x64.zip not listed in SHASUMS256.txt for $tag" }
        $expected = (($line -split '\s+')[0]).ToLower()
        $actual   = (Get-FileHash $o -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) { throw "bun SHA256 mismatch for $tag (expected $expected, got $actual)" }
        Expand-Archive -Force $o "$env:TEMP\bun-extract"
        $found = Get-ChildItem -Path "$env:TEMP\bun-extract" -Recurse -Filter "bun.exe" | Select-Object -First 1
        if ($found) {
            New-Item -ItemType Directory -Force -Path $bunDir | Out-Null
            Copy-Item $found.FullName $bunExe -Force
        }
    } catch { Log "bun install skipped ($_) — build.ps1 self-heal will retry" }
}
if (Test-Path $bunExe) { Log ("bun OK: " + (& $bunExe --version)) } else { Log "BUN INSTALL FAILED" }

# ---- 5. machine env: CMAKE_PREFIX_PATH + PATH -----------------------------
[Environment]::SetEnvironmentVariable("CMAKE_PREFIX_PATH", $qtDir, "Machine")
[Environment]::SetEnvironmentVariable("Qt6_DIR", "$qtDir\lib\cmake\Qt6", "Machine")
$machPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
foreach ($d in @("$qtDir\bin", $ninjaDir, $nodeDir, "C:\Program Files\CMake\bin", "C:\Program Files\Python312", "C:\Program Files\Python312\Scripts", "$goDir\go\bin", $bunDir)) {
    if ((Test-Path $d) -and ($machPath -notlike "*$d*")) { $machPath = "$machPath;$d"; Log "PATH += $d" }
}
[Environment]::SetEnvironmentVariable("Path", $machPath, "Machine")
Log ("CMAKE_PREFIX_PATH=" + [Environment]::GetEnvironmentVariable("CMAKE_PREFIX_PATH", "Machine"))

# ---- 6. restart runner(s) to pick up the new env --------------------------
# Iterate every installed runner service (was hardcoded to win-runner-1, so a
# provisioning run on win-runner-2 never restarted its own runner and the new
# machine env stayed invisible until the next reboot).
$runnerSvcs = Get-Service "actions.runner.*" -ErrorAction SilentlyContinue
if (-not $runnerSvcs) { Log "no actions.runner.* service found — start the runner manually to pick up the env" }
foreach ($svc in $runnerSvcs) {
    Restart-Service $svc.Name -Force
    Start-Sleep 4
    Log ("runner=" + $svc.Name + " " + (Get-Service $svc.Name).Status)
}
Log "BUILDTOOLSDONE"
