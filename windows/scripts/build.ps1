<#
  build.ps1 — one-shot Windows build + package for Jarvis.

  Steps:
    1. Configure + build the C++ daemon and Windows Qt shell from the SELF-CONTAINED
       windows/ CMake project (MSVC + Qt6 + vcpkg). It references the shared
       core/daemon/desktop sources read-only and compiles windows/shell/ copies for the
       POSIX-only ones (no LayerShellQt; the nested-Sway desktop is a Windows stub).
    2. Bundle the Python computer-use engine with PyInstaller (one-folder), including
       windows\engine\backend_windows.py + server_windows.py and the shared
       computer_use_mcp package + requirements-windows.txt deps.
    3. Stage the Node phone server (prod deps).
    4. Stage everything into windows\dist\payload\ and build the Inno Setup installer
       -> windows\dist\Jarvis-Setup-<version>.exe.

  Run from a "x64 Native Tools" / Developer PowerShell. Prereqs: Visual Studio 2022,
  CMake 3.24+, vcpkg (VCPKG_ROOT set), Qt 6.5+ (Qt6_DIR or in PATH), Python 3.12, Node 18+,
  Inno Setup 6 (iscc on PATH). This is the Windows build entry point — it never runs on Linux.
#>
param(
  [string]$Version = "0.1.0",
  [string]$Config  = "Release",
  [string]$VcpkgRoot = $env:VCPKG_ROOT
)
$ErrorActionPreference = "Stop"
$repo   = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$win    = Join-Path $repo "windows"
$build  = Join-Path $repo "build-win"
$payload= Join-Path $win "dist\payload"
Write-Host "==> Jarvis Windows build  (repo=$repo  version=$Version)" -ForegroundColor Cyan

# 1. C++ daemon + Windows shell ------------------------------------------------
# Configure the SELF-CONTAINED windows/ project (NOT the repo root) — it references
# the shared ../core, ../daemon, ../desktop sources read-only and compiles the
# windows/shell/ copies for the POSIX-only ones. The Linux dirs are never touched.
if (-not $VcpkgRoot) { throw "Set VCPKG_ROOT (vcpkg provides libsodium/libqrencode for Windows)." }
$toolchain = Join-Path $VcpkgRoot "scripts\buildsystems\vcpkg.cmake"
if (-not (Test-Path $toolchain)) { throw "vcpkg toolchain file not found: $toolchain" }
# Use the Visual Studio generator: it locates MSVC itself (via vswhere), so the
# build doesn't depend on a vcvars/MSVC env being active in this shell — the most
# reliable setup on CI. (Multi-config: exes land under <build>\<Config>\.)
# Splat the args (the -D value is a double-quoted string so $toolchain expands).
$cfgArgs = @(
  '-S', $win, '-B', $build,
  '-G', 'Visual Studio 17 2022', '-A', 'x64',
  "-DCMAKE_TOOLCHAIN_FILE=$toolchain"
)
cmake @cfgArgs
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed (exit $LASTEXITCODE)" }
cmake --build $build --config $Config
if ($LASTEXITCODE -ne 0) { throw "cmake build failed (exit $LASTEXITCODE)" }

# 2. Stage payload -------------------------------------------------------------
if (Test-Path $payload) { Remove-Item -Recurse -Force $payload }
New-Item -ItemType Directory -Force -Path $payload | Out-Null
# Find the exes wherever the generator put them (build root for Ninja, <Config>\
# for the multi-config VS generator).
$jarvisdExe = (Get-ChildItem -Path $build -Recurse -Filter "jarvisd.exe"       | Select-Object -First 1).FullName
$sidebarExe = (Get-ChildItem -Path $build -Recurse -Filter "jarvis-sidebar.exe" | Select-Object -First 1).FullName
if (-not $jarvisdExe) { throw "jarvisd.exe not found under $build" }
if (-not $sidebarExe) { throw "jarvis-sidebar.exe not found under $build" }
Copy-Item $jarvisdExe $payload
Copy-Item $sidebarExe $payload
Copy-Item (Join-Path $repo "LICENSE") (Join-Path $payload "LICENSE.txt")
# The launcher that brings up the WHOLE stack on Windows (no systemd).
Copy-Item (Join-Path $win "scripts\jarvis-start.cmd") $payload
# The Chrome/Edge extension (unpacked) — staged so the in-app guide can point
# Chrome at {app}\extension (chrome://extensions -> Developer mode -> Load unpacked).
Copy-Item -Recurse (Join-Path $repo "extension") (Join-Path $payload "extension")
# Qt runtime + the MSVC C/C++ runtime DLLs next to the exes (app-local deploy:
# --compiler-runtime ships vcruntime/msvcp so a BARE machine with no Visual C++
# Redistributable still runs Jarvis). Target both exes so jarvisd's deps land too.
if (Get-Command windeployqt -ErrorAction SilentlyContinue) {
  windeployqt --qmldir (Join-Path $repo "desktop\qml") --release --compiler-runtime `
    (Join-Path $payload "jarvis-sidebar.exe")
  windeployqt --release --compiler-runtime (Join-Path $payload "jarvisd.exe")
} else { Write-Warning "windeployqt not found; Qt + MSVC runtime DLLs must be staged manually." }

# Portable Node RUNTIME so the phone server runs with NOTHING installed by the user.
Write-Host "==> bundling a portable Node runtime (no Node install required)" -ForegroundColor Cyan
$nodeVer = "v20.18.1"
$nodeDir = Join-Path $payload "node"
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
$nodeZip = Join-Path $build "node-$nodeVer-win-x64.zip"
if (-not (Test-Path $nodeZip)) {
  Invoke-WebRequest "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip" -OutFile $nodeZip
}
Expand-Archive -Force $nodeZip (Join-Path $build "node-extract")
Copy-Item (Join-Path $build "node-extract\node-$nodeVer-win-x64\node.exe") $nodeDir
# (jarvisd launches the phone server via {app}\node\node.exe — see the Windows
#  shell wiring; never assume a system `node` on PATH.)

# 3. Python engine (PyInstaller one-folder) ------------------------------------
Write-Host "==> bundling computer-use engine" -ForegroundColor Cyan
$venv = Join-Path $win "engine\.venv-win"
if (-not (Test-Path $venv)) { python -m venv $venv }
& (Join-Path $venv "Scripts\python.exe") -m pip install --upgrade pip pyinstaller | Out-Null
& (Join-Path $venv "Scripts\python.exe") -m pip install -e (Join-Path $repo "computer-use") | Out-Null
& (Join-Path $venv "Scripts\python.exe") -m pip install -r (Join-Path $win "engine\requirements-windows.txt") | Out-Null
# --collect-submodules computer_use_mcp guarantees EVERY tool module ships
# (tools_desktop/browser/widgets/todo/bg/phone/jarvis_ops); --collect-all mss/PIL
# + the win32 hidden-imports cover the Windows backend's lazy imports.
& (Join-Path $venv "Scripts\pyinstaller.exe") --noconfirm --name jarvis-engine `
  --distpath (Join-Path $payload "engine") --workpath (Join-Path $build "pyi") `
  --collect-submodules computer_use_mcp --collect-all mss --collect-all PIL `
  --hidden-import win32api --hidden-import win32gui --hidden-import win32con `
  --hidden-import win32process --hidden-import pywintypes `
  --paths (Join-Path $win "engine") (Join-Path $win "engine\server_windows.py")

# 4. Node phone server ---------------------------------------------------------
Write-Host "==> staging phone server" -ForegroundColor Cyan
Push-Location (Join-Path $repo "phone\server")
npm ci --omit=dev
npm run build
Pop-Location
Copy-Item -Recurse (Join-Path $repo "phone\server\dist") (Join-Path $payload "phone-server\dist")
Copy-Item -Recurse (Join-Path $repo "phone\server\node_modules") (Join-Path $payload "phone-server\node_modules")

# 5. Installer -----------------------------------------------------------------
Write-Host "==> building installer" -ForegroundColor Cyan
iscc /DMyAppVersion=$Version (Join-Path $win "installer\jarvis.iss")
Write-Host "==> done: windows\dist\Jarvis-Setup-$Version.exe" -ForegroundColor Green
