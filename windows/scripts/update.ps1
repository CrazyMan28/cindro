<#
  Cindro self-update (Windows). Called by the daemon's Updater (auto, on the
  auto_update interval) and by the manual "Check for updates" button.

    update.ps1 -Mode check          # prints JSON {current, latest, behind}
    update.ps1 -Mode apply          # downloads the latest installer, runs it silently, restarts

  A bare-machine Windows install has no build toolchain, so it can't rebuild from
  source. Instead it tracks the latest GitHub Release built from `main` (produced by
  .github/workflows/windows-build.yml) and runs that Cindro-Setup.exe. Only `main`
  (production) is tracked, respecting dev -> qa -> main.
#>
param(
  [ValidateSet("check","apply")] [string]$Mode = "check",
  [string]$Repo = "CrazyMan28/jarvis",
  [string]$CurrentVersion = $env:JARVIS_VERSION   # stamped into the build; e.g. "0.1.0"
)
$ErrorActionPreference = "Stop"
$api = "https://api.github.com/repos/$Repo/releases/latest"
function Get-Latest {
  try {
    $r = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "Cindro-Updater" }
    $asset = $r.assets | Where-Object { $_.name -like "Cindro-Setup-*.exe" } | Select-Object -First 1
    return [pscustomobject]@{ tag = $r.tag_name; url = $asset.browser_download_url; name = $asset.name }
  } catch { return $null }
}

$latest = Get-Latest
$latestTag = if ($latest) { $latest.tag -replace '^v','' } else { $null }
$behind = $false
if ($latestTag -and $CurrentVersion) {
  try { $behind = [version]$latestTag -gt [version]$CurrentVersion } catch { $behind = ($latestTag -ne $CurrentVersion) }
}

if ($Mode -eq "check") {
  @{ current = $CurrentVersion; latest = $latestTag; behind = $behind } | ConvertTo-Json -Compress
  exit 0
}

# apply
if (-not $behind -or -not $latest.url) {
  @{ updated = $false; reason = "already up to date" } | ConvertTo-Json -Compress
  exit 0
}
$tmp = Join-Path $env:TEMP $latest.name
Write-Host ">> downloading $($latest.name) …"
Invoke-WebRequest -Uri $latest.url -OutFile $tmp -Headers @{ "User-Agent" = "Cindro-Updater" }
# Inno Setup silent install (replaces the install in place). The installer's [Run]
# relaunches jarvisd + the UI, so we exit after handing off.
Write-Host ">> installing $latestTag silently …"
# /CLOSEAPPLICATIONS lets Inno stop the running jarvisd/sidebar instead of
# failing on locked files; /RESTARTAPPLICATIONS relaunches them after.
# DETACHED (no -Wait): the installer kills jarvisd — our caller — mid-install,
# so waiting here would mean the JSON result (and the daemon's audit entry)
# never gets emitted. Hand off and report immediately.
Start-Process -FilePath $tmp -ArgumentList "/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/CLOSEAPPLICATIONS","/RESTARTAPPLICATIONS"
@{ updated = $true; to = $latestTag; installer_launched = $true } | ConvertTo-Json -Compress
