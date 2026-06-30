<#
  setup-windows-vm.ps1 — turn this Windows VM into a Jarvis test target, in ONE command.

  Run this single line in ANY PowerShell on the VM (it self-elevates via UAC):

    irm https://raw.githubusercontent.com/CrazyMan28/jarvis/main/windows/testlab/setup-windows-vm.ps1 -OutFile "$env:TEMP\jvm.ps1"; & "$env:TEMP\jvm.ps1"

  It: (1) self-elevates, (2) installs the built-in OpenSSH Server + makes PowerShell the
  SSH shell + opens the firewall, (3) authorizes the Linux box's key (baked in below),
  (4) installs Tailscale + brings it up so the Linux box can reach the VM, and (5) prints
  the Tailscale IP + the exact winlab config to give Claude. No cloning, no cd, one line.
#>
param(
  # The Linux box's (Claude's) public key — baked in so the one-liner needs no args.
  [string]$PubKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM4yiBFYSrDHjt6LAZmgxt/L5NgpvQ5EsXqYMjAzYUan k2-gha-runner",
  [switch]$InstallBuildTools,
  [int]$SshPort = 22,
  [switch]$NoTailscale
)
$ErrorActionPreference = "Stop"
function info($m){ Write-Host "==> $m" -ForegroundColor Cyan }

# 0. Self-elevate (re-launch this file as Administrator, keep the window open) ----
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  if (-not $PSCommandPath) { throw "Run via the one-liner (downloads to a file); piping to iex can't self-elevate." }
  Write-Host "Elevating (accept the UAC prompt)…" -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-NoExit","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`"","-PubKey","`"$PubKey`""
  )
  return
}

# 1. OpenSSH Server -----------------------------------------------------------
info "Installing the OpenSSH Server feature…"
$cap = Get-WindowsCapability -Online -Name OpenSSH.Server* | Select-Object -First 1
if ($cap.State -ne "Installed") { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service sshd -StartupType Automatic
Start-Service sshd

# 2. Default SSH shell = PowerShell -------------------------------------------
info "Setting PowerShell as the default SSH shell…"
New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value (Get-Command powershell.exe).Source -PropertyType String -Force | Out-Null

# 3. Firewall -----------------------------------------------------------------
info "Opening the firewall for sshd (port $SshPort)…"
if (-not (Get-NetFirewallRule -Name "Jarvis-OpenSSH" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "Jarvis-OpenSSH" -DisplayName "Jarvis OpenSSH" -Enabled True `
    -Direction Inbound -Protocol TCP -Action Allow -LocalPort $SshPort | Out-Null
}

# 4. Authorize the Linux box's key (admins share one authorized_keys file) -----
info "Authorizing the Linux box's key…"
$ak = "$env:ProgramData\ssh\administrators_authorized_keys"
if (-not (Test-Path $ak)) { New-Item -ItemType File -Path $ak -Force | Out-Null }
if (-not (Select-String -Path $ak -SimpleMatch $PubKey -Quiet)) { Add-Content -Path $ak -Value $PubKey }
icacls $ak /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

# 5. Tailscale so the Linux box can reach the VM ------------------------------
$tsIp = $null
if (-not $NoTailscale) {
  info "Installing Tailscale (so Claude's box can reach this VM)…"
  try {
    if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
      winget install --id tailscale.tailscale -e --accept-source-agreements --accept-package-agreements --silent
    }
    $ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
    info "Bringing Tailscale up — a browser/URL will open; sign in with YOUR Tailscale account…"
    & $ts up
    Start-Sleep 3
    $tsIp = (& $ts ip -4 2>$null | Select-Object -First 1)
  } catch { Write-Warning "Tailscale step skipped ($_). Use the VM's LAN IP instead." }
}

# 6. Optional build toolchain -------------------------------------------------
if ($InstallBuildTools) {
  info "Installing build toolchain via winget (long)…"
  foreach ($p in @("Microsoft.VisualStudio.2022.BuildTools","Kitware.CMake","Ninja-build.Ninja",
                   "Python.Python.3.12","OpenJS.NodeJS.LTS","JRSoftware.InnoSetup","Git.Git")) {
    try { winget install --id $p -e --accept-source-agreements --accept-package-agreements --silent } catch {}
  }
}

# 7. Report -------------------------------------------------------------------
$lan = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
          $_.IPAddress -notlike "169.*" -and $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown"
        } | Select-Object -First 1).IPAddress
$ip = if ($tsIp) { $tsIp } else { $lan }
Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " VM READY. Tell Claude:  host=$ip  user=$env:USERNAME" -ForegroundColor Green
Write-Host " (Claude writes ~/.config/jarvis/winlab.json and drives it.)" -ForegroundColor Green
Write-Host "   tailscale IP: $tsIp     LAN IP: $lan" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Green
