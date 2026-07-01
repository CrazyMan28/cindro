# Installs PowerShell 7 (pwsh) on the self-hosted runner so Actions' `shell: pwsh`
# steps + build.ps1 run in the same PowerShell 7 the GitHub-hosted runner used.
# Windows only ships Windows PowerShell 5.1 (powershell.exe); the runner needs pwsh.
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
function Log($m) { Write-Host "[pwsh] $m" }

$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
if (-not (Test-Path $pwsh)) {
    $url = "https://github.com/PowerShell/PowerShell/releases/download/v7.6.3/PowerShell-7.6.3-win-x64.msi"
    $msi = "$env:TEMP\pwsh7.msi"
    Log "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $msi
    Log ("downloaded " + (Get-Item $msi).Length + " bytes; installing silently...")
    # ADD_PATH=1 puts pwsh on the machine PATH so the runner service finds it.
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart', 'ADD_PATH=1' -Wait
}
if (Test-Path $pwsh) {
    Log ("pwsh OK: " + (& $pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'))
    # Belt-and-suspenders: ensure the install dir is on the machine PATH.
    $dir = "C:\Program Files\PowerShell\7"
    $machPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machPath -notlike "*$dir*") {
        [Environment]::SetEnvironmentVariable("Path", "$machPath;$dir", "Machine")
        Log "added pwsh dir to machine PATH"
    }
} else { Log "PWSH INSTALL FAILED" }

Restart-Service "actions.runner.CrazyMan28-jarvis.win-runner-1" -Force
Start-Sleep 4
Log ("runner=" + (Get-Service "actions.runner.CrazyMan28-jarvis.win-runner-1").Status)
Log "PWSHDONE"
