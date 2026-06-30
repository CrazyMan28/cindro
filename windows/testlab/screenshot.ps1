<#
  screenshot.ps1 - capture the Windows VM's screen to a PNG. Run on the VM (winlab
  invokes it over SSH, then pulls the PNG back). Captures the FULL virtual desktop
  (all monitors). Usage:  powershell -File screenshot.ps1 -Out C:\jarvis-shot.png
#>
param([string]$Out = "$env:TEMP\jarvis-shot.png")
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$vs  = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $Out
