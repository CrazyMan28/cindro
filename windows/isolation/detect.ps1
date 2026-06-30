<#
  detect.ps1 -- pick the Windows v2 agent-desktop isolation mode for THIS box.

  Emits a single compressed JSON object on stdout describing the host's
  capabilities and the recommended `windows.isolation.mode`:

    sandbox      Windows Sandbox (Hyper-V micro-VM, disposable). Default tier.
                 Needs Pro/Enterprise/Education + hardware virtualization (VT-x/
                 AMD-V) + the Containers-DisposableClientVM optional feature, and
                 the host must not itself be a non-nested guest.
    hyperv       A persistent Hyper-V guest (Pro+ with the Hyper-V feature) --
                 chosen when Sandbox is unavailable but Hyper-V is.
    childsession RDP child session (own input desktop, no VM, no relay). NOT
                 auto-selected here -- it needs WTSEnableChildSessions wiring; it
                 is reported as "available" so an operator can opt in.
    takeover     Fallback: no isolation available (Home / VT-x off / nested) ->
                 v1 drives the user's REAL screen via take-over.

  ASCII-ONLY (Windows PowerShell 5.1 reads .ps1 as ANSI). No non-ASCII bytes.
  Consumed by the launcher/installer to set JARVIS_WINDOWS_ISOLATION_MODE (read
  by the daemon's AgentDesktop) or the windows.isolation.mode config knob.

  Usage:   powershell -ExecutionPolicy Bypass -File detect.ps1
           powershell -ExecutionPolicy Bypass -File detect.ps1 | ConvertFrom-Json
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "SilentlyContinue"

function Get-EditionId {
    $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    return (Get-ItemProperty -Path $key -Name EditionId).EditionId
}

function Test-ProEntEdu([string]$editionId) {
    if (-not $editionId) { return $false }
    $e = $editionId.ToLower()
    foreach ($m in @("professional", "enterprise", "education", "pro")) {
        if ($e.Contains($m)) { return $true }
    }
    return $false
}

function Get-Virtualization {
    # Win32_Processor exposes the firmware/SLAT virtualization flags. SLAT
    # (Second Level Address Translation) is required by both Sandbox and Hyper-V.
    $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
    $fw = $false
    $slat = $false
    if ($cpu) {
        if ($cpu.VirtualizationFirmwareEnabled -ne $null) {
            $fw = [bool]$cpu.VirtualizationFirmwareEnabled
        }
        if ($cpu.SecondLevelAddressTranslationExtensions -ne $null) {
            $slat = [bool]$cpu.SecondLevelAddressTranslationExtensions
        }
    }
    # When a hypervisor is already present the firmware flag often reads $false
    # even though virtualization is on (the host hypervisor owns VT-x). Treat a
    # present hypervisor as virtualization-capable.
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem
    $hv = $false
    if ($cs -and $cs.HypervisorPresent -ne $null) { $hv = [bool]$cs.HypervisorPresent }
    return [pscustomobject]@{
        FirmwareEnabled   = $fw
        Slat              = $slat
        HypervisorPresent = $hv
        Enabled           = ($fw -or $hv)
    }
}

function Test-OptionalFeature([string]$name) {
    # Returns "Enabled" / "Disabled" / "Absent" / "Unknown" without throwing
    # (Get-WindowsOptionalFeature needs an elevated token on some SKUs).
    $f = Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction SilentlyContinue
    if ($f -and $f.State) { return [string]$f.State }
    return "Unknown"
}

$editionId   = Get-EditionId
$proEntEdu   = Test-ProEntEdu $editionId
$virt        = Get-Virtualization
$sandboxFeat = Test-OptionalFeature "Containers-DisposableClientVM"
$hyperVFeat  = Test-OptionalFeature "Microsoft-Hyper-V"
$sandboxExe  = Test-Path (Join-Path $env:SystemRoot "System32\WindowsSandbox.exe")

# A box is "sandbox-ready" when it is Pro/Ent/Edu, has virtualization, and either
# the DisposableClientVM feature is enabled or WindowsSandbox.exe is present.
$sandboxReady = $proEntEdu -and $virt.Enabled -and `
    (($sandboxFeat -eq "Enabled") -or $sandboxExe)
$hyperVReady  = $proEntEdu -and $virt.Enabled -and ($hyperVFeat -eq "Enabled")

if ($sandboxReady)      { $mode = "sandbox" }
elseif ($hyperVReady)   { $mode = "hyperv" }
else                    { $mode = "takeover" }

# childsession is reported as available on Pro+ (the operator can opt in); it is
# never the auto-pick because it needs WTSEnableChildSessions wiring (Phase 2).
$childSessionAvailable = $proEntEdu

$result = [ordered]@{
    edition                = $editionId
    isProEntEdu            = $proEntEdu
    virtualizationEnabled  = $virt.Enabled
    virtualizationFirmware = $virt.FirmwareEnabled
    slat                   = $virt.Slat
    hypervisorPresent      = $virt.HypervisorPresent
    sandboxFeature         = $sandboxFeat
    sandboxExe             = $sandboxExe
    hyperVFeature          = $hyperVFeat
    sandboxReady           = $sandboxReady
    hyperVReady            = $hyperVReady
    childSessionAvailable  = $childSessionAvailable
    recommendedMode        = $mode
}

$result | ConvertTo-Json -Compress
