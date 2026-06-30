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
# Ninja generator + the MSVC env that the CI's msvc-dev-cmd step provides (cl +
# ninja on PATH). Splat the args (the -D value is a double-quoted string so
# $toolchain expands — passing it bare made cmake see the literal "$toolchain").
$cfgArgs = @(
  '-S', $win, '-B', $build,
  '-G', 'Ninja',
  "-DCMAKE_BUILD_TYPE=$Config",
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
# The launchers: jarvis-launch.vbs (HIDDEN — what the shortcuts use, no terminal)
# + jarvis-start.cmd (visible, for manual/debug use).
Copy-Item (Join-Path $win "scripts\jarvis-launch.vbs") $payload
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

# windeployqt --compiler-runtime ships vc_redist.x64.exe (an INSTALLER), not the
# loose CRT DLLs — so on a bare machine that never runs the redist, jarvisd.exe dies
# at launch with "MSVCP140.dll was not found" (confirmed on a clean Win11 Pro VM).
# Copy the actual CRT DLLs (msvcp140*.dll, vcruntime140*.dll, concrt140.dll) next to
# the exes so the app is truly self-contained.
$crtRoots = @()
if ($env:VCToolsRedistDir) { $crtRoots += (Join-Path $env:VCToolsRedistDir "x64") }
$crtRoots += (Get-ChildItem "C:\Program Files\Microsoft Visual Studio\*\*\VC\Redist\MSVC\*\x64" `
                -Directory -ErrorAction SilentlyContinue | Select-Object -Expand FullName)
$crt = $crtRoots | ForEach-Object {
         Get-ChildItem $_ -Directory -Filter "Microsoft.VC*.CRT" -ErrorAction SilentlyContinue
       } | Sort-Object FullName | Select-Object -Last 1
if ($crt) {
  Get-ChildItem $crt.FullName -Filter *.dll | ForEach-Object { Copy-Item $_.FullName $payload -Force }
  Write-Host "    bundled MSVC CRT DLLs from $($crt.FullName)" -ForegroundColor Green
} else {
  Write-Warning "MSVC CRT redist dir not found — MSVCP140/VCRUNTIME140 NOT bundled."
}
if (-not (Test-Path (Join-Path $payload "MSVCP140.dll"))) {
  throw "MSVCP140.dll missing from payload after CRT copy — jarvisd.exe would fail to start on a bare machine. Aborting build."
}

# Third-party vcpkg runtime DLLs (libsodium.dll, qrencode.dll, + their deps) next
# to the exes. windeployqt only handles Qt + the MSVC runtime — NOT these — so
# jarvisd.exe (which links jarvis-core -> libsodium/qrencode) failed at launch with
# "libsodium.dll was not found". Copy the whole vcpkg dynamic bin dir.
$vcpkgBin = Join-Path $VcpkgRoot "installed\x64-windows\bin"
if (Test-Path $vcpkgBin) {
  Get-ChildItem $vcpkgBin -Filter *.dll | ForEach-Object { Copy-Item $_.FullName $payload -Force }
  Write-Host "    bundled vcpkg DLLs from $vcpkgBin" -ForegroundColor Green
} else {
  Write-Warning "vcpkg bin dir not found ($vcpkgBin) — libsodium/qrencode DLLs NOT bundled; jarvisd will fail to start."
}
# Sanity: libsodium.dll MUST be present next to jarvisd.exe.
if (-not (Test-Path (Join-Path $payload "libsodium.dll"))) {
  throw "libsodium.dll missing from the payload — jarvisd would fail at launch. Aborting."
}

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
$venvPy = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $venv)) { python -m venv $venv }
& $venvPy -m pip install --upgrade pip pyinstaller
if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed" }
# --no-deps: install the engine PACKAGE only — its pyproject.toml deps include the
# Linux-only evdev/dbus-fast/pywayland which can't build on Windows. The actual
# cross-platform runtime deps (+ pywin32/mss) come from requirements-windows.txt.
& $venvPy -m pip install -e (Join-Path $repo "computer-use") --no-deps
if ($LASTEXITCODE -ne 0) { throw "pip install engine (--no-deps) failed" }
& $venvPy -m pip install -r (Join-Path $win "engine\requirements-windows.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install windows requirements failed" }
# --collect-submodules computer_use_mcp guarantees EVERY tool module ships
# (tools_desktop/browser/widgets/todo/bg/phone/jarvis_ops); --collect-all mss/PIL
# + the win32 hidden-imports cover the Windows backend's lazy imports.
& (Join-Path $venv "Scripts\pyinstaller.exe") --noconfirm --name jarvis-engine `
  --distpath (Join-Path $payload "engine") --workpath (Join-Path $build "pyi") `
  --collect-submodules computer_use_mcp --collect-all mss --collect-all PIL `
  --hidden-import win32api --hidden-import win32gui --hidden-import win32con `
  --hidden-import win32process --hidden-import pywintypes `
  --paths (Join-Path $win "engine") (Join-Path $win "engine\server_windows.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller (engine) failed" }

# 3b. Windows v2 isolation assets ----------------------------------------------
# The "beside-you" agent desktop (windows/isolation). Two destinations:
#   {app}\isolation : the .wsb template + bootstrap.ps1 + detect.ps1 (AgentDesktop
#                     renders the .wsb; detect.ps1 picks the isolation mode).
#   {app}\engine    : jarvis-relay.exe + bootstrap.ps1 land NEXT TO jarvis-engine.exe
#                     so the read-only MappedFolder exposes them at C:\engine inside
#                     the sandbox (bootstrap runs the relay + engine in there).
Write-Host "==> staging Windows v2 isolation assets" -ForegroundColor Cyan
$isoSrc = Join-Path $win "isolation"
$isoDst = Join-Path $payload "isolation"
New-Item -ItemType Directory -Force -Path (Join-Path $isoDst "sandbox") | Out-Null
Copy-Item (Join-Path $isoSrc "sandbox\jarvis-agent.wsb.in") (Join-Path $isoDst "sandbox") -Force
Copy-Item (Join-Path $isoSrc "sandbox\bootstrap.ps1")       (Join-Path $isoDst "sandbox") -Force
Copy-Item (Join-Path $isoSrc "detect.ps1")                  $isoDst -Force
# The reverse-tunnel exe + bootstrap inside the engine payload (-> C:\engine).
$engineDst = Join-Path $payload "engine"
$relayExe = (Get-ChildItem -Path $build -Recurse -Filter "jarvis-relay.exe" | Select-Object -First 1).FullName
if ($relayExe) {
  Copy-Item $relayExe $engineDst -Force
  Copy-Item (Join-Path $isoSrc "sandbox\bootstrap.ps1") $engineDst -Force
  # jarvis-relay.exe runs INSIDE the sandbox (no Qt installed there) -- stage its
  # Qt Core+Network DLLs + MSVC runtime next to it so it is self-contained.
  if (Get-Command windeployqt -ErrorAction SilentlyContinue) {
    windeployqt --release --compiler-runtime --no-translations (Join-Path $engineDst "jarvis-relay.exe")
  } else { Write-Warning "windeployqt not found; jarvis-relay.exe Qt DLLs must be staged manually." }
} else {
  Write-Warning "jarvis-relay.exe not found under $build -- the sandbox reverse tunnel will be unavailable."
}

# 4. Node phone server (OPTIONAL) ----------------------------------------------
# Resilient: better-sqlite3 native builds can be finicky on CI. If it fails the
# installer still ships every other feature; the phone subsystem can be added later.
Write-Host "==> staging phone server (optional)" -ForegroundColor Cyan
try {
  Push-Location (Join-Path $repo "phone\server")
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  Pop-Location
  Copy-Item -Recurse (Join-Path $repo "phone\server\dist")         (Join-Path $payload "phone-server\dist")
  Copy-Item -Recurse (Join-Path $repo "phone\server\node_modules") (Join-Path $payload "phone-server\node_modules")
  Write-Host "    phone server bundled." -ForegroundColor Green
} catch {
  Pop-Location -ErrorAction SilentlyContinue
  Write-Warning "phone server bundling skipped ($_). The installer ships without the phone subsystem; it can be added later."
}

# 5. Installer -----------------------------------------------------------------
Write-Host "==> building installer" -ForegroundColor Cyan
iscc /DMyAppVersion=$Version (Join-Path $win "installer\jarvis.iss")
Write-Host "==> done: windows\dist\Jarvis-Setup-$Version.exe" -ForegroundColor Green
