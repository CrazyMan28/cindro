$ErrorActionPreference = 'Continue'
$name = "actions.runner.CrazyMan28-jarvis.win-runner-1"
$svc = Get-Service $name -ErrorAction SilentlyContinue
if ($null -eq $svc) {
    Write-Host "[runner] service $name NOT FOUND — listing actions.runner services:"
    Get-Service | Where-Object { $_.Name -like 'actions.runner*' } | Select-Object Name, Status | Format-Table -AutoSize | Out-String | Write-Host
} else {
    Write-Host "[runner] status=$($svc.Status) starttype=$($svc.StartType)"
    Set-Service $name -StartupType Automatic
    if ($svc.Status -ne 'Running') {
        Write-Host "[runner] starting..."
        Start-Service $name
        Start-Sleep 6
    }
    Write-Host "[runner] now=$((Get-Service $name).Status)"
}
Write-Host "[runner] cpu_cores=$env:NUMBER_OF_PROCESSORS"
