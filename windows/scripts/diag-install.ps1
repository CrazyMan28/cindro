$ErrorActionPreference = 'Continue'
# Are any jarvis processes still holding files?
Get-Process jarvis-sidebar, jarvisd -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "[diag] running: $($_.Name) pid=$($_.Id)"; $_ | Stop-Process -Force -ErrorAction SilentlyContinue }
Start-Sleep 2
$exe = "C:\actions-runner\_work\jarvis\jarvis\windows\dist\Jarvis-Setup-0.1.0-9197979.exe"
$log = "C:\Users\kihi2024\inno-install.log"
Remove-Item $log -Force -ErrorAction SilentlyContinue
Write-Host "[diag] installing with /LOG..."
$p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=$log" -Wait -PassThru
Write-Host "[diag] exit = $($p.ExitCode)"
Write-Host "[diag] installed = $(Test-Path 'C:\Program Files\Jarvis\jarvisd.exe')"
Write-Host "[diag] --- inno log tail ---"
Get-Content $log -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "[log] $_" }
