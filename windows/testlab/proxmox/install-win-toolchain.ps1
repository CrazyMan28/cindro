# Installs the toolchain a self-hosted Windows runner needs to run windows-build.yml:
# Chocolatey, Git, CMake, Ninja, VS 2022 Build Tools (C++ workload), and vcpkg
# (+ VCPKG_INSTALLATION_ROOT / VCPKG_ROOT machine env). Qt/Python/Node/Inno are
# installed per-run by the workflow's own actions. Idempotent; logs to C:\toolchain.log.
$ErrorActionPreference = 'Continue'
Start-Transcript -Path C:\toolchain.log -Append | Out-Null
function log($m){ Write-Host ("==> " + $m) }

# 1. Chocolatey
if (-not (Test-Path "$env:ProgramData\chocolatey\bin\choco.exe")) {
  log "installing Chocolatey..."
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = 3072
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
}
$choco = "$env:ProgramData\chocolatey\bin\choco.exe"

# 2. Core CLI tools
log "installing git, cmake, ninja, 7zip..."
& $choco install -y --no-progress git cmake ninja 7zip

# 3. VS 2022 Build Tools + the C++ (vctools) workload  -- big, ~20-40 min
log "installing VS 2022 Build Tools + C++ workload (this is the long one)..."
& $choco install -y --no-progress visualstudio2022buildtools
& $choco install -y --no-progress visualstudio2022-workload-vctools

# 4. vcpkg + machine env (the workflow's vcpkg step reads VCPKG_INSTALLATION_ROOT)
if (-not (Test-Path C:\vcpkg\vcpkg.exe)) {
  log "cloning + bootstrapping vcpkg..."
  if (-not (Test-Path C:\vcpkg)) { & "$env:ProgramData\chocolatey\bin\git.exe" clone https://github.com/microsoft/vcpkg C:\vcpkg }
  & C:\vcpkg\bootstrap-vcpkg.bat -disableMetrics
}
[Environment]::SetEnvironmentVariable('VCPKG_INSTALLATION_ROOT','C:\vcpkg','Machine')
[Environment]::SetEnvironmentVariable('VCPKG_ROOT','C:\vcpkg','Machine')

log "DONE. cmake=$(Test-Path 'C:\Program Files\CMake\bin\cmake.exe' -ErrorAction SilentlyContinue) vcpkg=$(Test-Path C:\vcpkg\vcpkg.exe)"
"toolchain-done $(Get-Date -Format o)" | Out-File C:\toolchain-done.txt
Stop-Transcript | Out-Null
