<#
  setup-windows-vm.ps1 — turn a Windows VM into a Jarvis test/build target.
  Run THIS on the Windows VM, in an ELEVATED (Administrator) PowerShell:

      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\setup-windows-vm.ps1 -PubKey "ssh-ed25519 AAAA... linux-box"        # test target
      .\setup-windows-vm.ps1 -PubKey "..." -InstallBuildTools               # + full build toolchain

  It (1) installs/enables the built-in **OpenSSH Server**, (2) makes **PowerShell**
  the default SSH shell, (3) opens the firewall, (4) authorizes the Linux box's
  public key, and (5) optionally installs the build toolchain (VS Build Tools, CMake,
  Qt, vcpkg, Python, Node, Inno Setup) via winget. Then it prints the exact
  `winlab` config to drop on the Linux box.

  After this, the Linux side drives the VM with `windows/testlab/winlab.py`:
  screenshots, PowerShell, build, install, launch, logs — a local GitHub-Actions.
#>
param(
  [string]$PubKey = "",
  [switch]$InstallBuildTools,
  [int]$SshPort = 22
)
$ErrorActionPreference = "Stop"
function info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an ELEVATED (Administrator) PowerShell."
}

# 1. OpenSSH Server -----------------------------------------------------------
info "Installing the OpenSSH Server feature…"
$cap = Get-WindowsCapability -Online -Name OpenSSH.Server* | Select-Object -First 1
if ($cap.State -ne "Installed") { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service sshd -StartupType Automatic
Start-Service sshd

# 2. Default SSH shell = PowerShell (so `ssh vm "..."` runs PowerShell) --------
info "Setting PowerShell as the default SSH shell…"
$ps = (Get-Command powershell.exe).Source
New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value $ps `
  -PropertyType String -Force | Out-Null

# 3. Firewall -----------------------------------------------------------------
info "Opening the firewall for sshd on port $SshPort…"
if (-not (Get-NetFirewallRule -Name "Jarvis-OpenSSH" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "Jarvis-OpenSSH" -DisplayName "Jarvis OpenSSH" -Enabled True `
    -Direction Inbound -Protocol TCP -Action Allow -LocalPort $SshPort | Out-Null
}

# 4. Authorize the Linux box's key (admins use a SHARED authorized_keys file) --
if ($PubKey) {
  info "Authorizing the Linux box's public key…"
  $akFile = "$env:ProgramData\ssh\administrators_authorized_keys"
  if (-not (Test-Path $akFile)) { New-Item -ItemType File -Path $akFile -Force | Out-Null }
  if (-not (Select-String -Path $akFile -SimpleMatch $PubKey -Quiet)) {
    Add-Content -Path $akFile -Value $PubKey
  }
  # Lock down ACLs the way sshd requires (Administrators + SYSTEM only).
  icacls $akFile /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
} else {
  Write-Warning "No -PubKey given: you'll auth with a PASSWORD. Re-run with -PubKey for key auth."
}

# 5. Optional: the full build toolchain (winget) ------------------------------
if ($InstallBuildTools) {
  info "Installing the build toolchain via winget (this takes a while)…"
  $pkgs = @(
    "Microsoft.VisualStudio.2022.BuildTools",   # MSVC (add 'Desktop development with C++' workload)
    "Kitware.CMake", "Ninja-build.Ninja", "Python.Python.3.12",
    "OpenJS.NodeJS.LTS", "JRSoftware.InnoSetup", "Git.Git"
  )
  foreach ($p in $pkgs) {
    try { winget install --id $p -e --accept-source-agreements --accept-package-agreements --silent } catch { Write-Warning "winget $p: $_" }
  }
  Write-Host "  NOTE: also install Qt 6 (MSVC) + vcpkg, and add the VS 'Desktop C++' workload." -ForegroundColor Yellow
  Write-Host "        winlab uses GitHub Actions for the canonical build; the VM is mainly for RUN/DEBUG." -ForegroundColor Yellow
}

# 6. Report -------------------------------------------------------------------
$ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } |
       Select-Object -First 1).IPv4Address.IPAddress
if (-not $ip) { $ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike "169.*" -and $_.IPAddress -ne "127.0.0.1" } |
       Select-Object -First 1).IPAddress }
$user = "$env:USERNAME"
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " VM ready. On the LINUX box, write ~/.config/jarvis/winlab.json:" -ForegroundColor Green
Write-Host @"
{
  "host": "$ip",
  "user": "$user",
  "port": $SshPort,
  "build_dir": "C:/jarvis-src"
}
"@ -ForegroundColor White
Write-Host " Then:  python windows/testlab/winlab.py doctor" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
