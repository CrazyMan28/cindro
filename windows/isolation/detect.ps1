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
    # Returns "Enabled" / "Disabled" / "Absent" / "Unknown" without throwing.
    # Get-WindowsOptionalFeature needs an elevated token on some SKUs, and its
    # underlying DISM COM interop raises a raw COMException ("The requested
    # operation requires elevation") that -ErrorAction SilentlyContinue does
    # NOT suppress. Uncaught, that exception is harmless at this script's own
    # top level (PowerShell prints it and continues) but is FATAL when a
    # caller invokes this whole script via `& detect.ps1` from inside its own
    # try block (e.g. the launcher's one-liner) -- the exception escapes this
    # script entirely and aborts it before the final ConvertTo-Json ever runs,
    # silently losing recommendedMode on every non-elevated launch. A local
    # try/catch is the only thing that reliably contains it.
    try {
        $f = Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction SilentlyContinue
        if ($f -and $f.State) { return [string]$f.State }
    } catch {
        # elevation required / DISM unavailable -- fall through to Unknown
    }
    return "Unknown"
}

# ONE-TIME auto-enable attempt for the Windows Sandbox feature (jarvis#104
# auto-setup): a Pro/Ent/Edu + virtualization-capable box that just has the
# Containers-DisposableClientVM feature turned off (the common case -- it ships
# off by default) would otherwise sit on takeover forever with no way to
# self-upgrade to sandbox mode short of a user manually running an elevated DISM
# command. Enabling it needs elevation and a reboot to take effect either way, so
# "seamless" isn't achievable -- this gets as close as Windows allows: exactly ONE
# UAC prompt, ever, tracked by a marker so a declined/failed/cancelled attempt
# never repeats. Best-effort and silent on any failure.
#
# MUST NOT BLOCK (jarvis#104 Codex review follow-up): both jarvis-launch.vbs and
# jarvis-start.cmd run detect.ps1 SYNCHRONOUSLY and wait for it to finish before
# starting jarvisd/the UI. An earlier version of this function used
# `Start-Process -Verb RunAs -Wait`, which waits for both the UAC prompt AND
# dism.exe's multi-second run to complete -- if the UAC prompt just sits there
# un-clicked (the user stepped away, missed it, whatever), the ENTIRE APP LAUNCH
# hangs indefinitely, silently, with no indication why. Fixed by dropping -Wait:
# the marker is written BEFORE launching (this is a one-time-ever attempt
# regardless of outcome, not one gated on confirming success), and dism.exe is
# fired off detached -- the UAC prompt, if it appears, shows up alongside the app
# starting rather than blocking it. If the enable succeeds, the NEXT detect.ps1
# run sees currentState=Enabled and skips this function entirely (see the guard
# above); this run's own re-read of $sandboxFeat below only catches an enable
# that happens to finish (rare) before this same run's second Test-OptionalFeature
# call -- it never depends on waiting for dism.exe here.
function Try-AutoEnableSandboxFeature([bool]$proEntEdu, [bool]$virtEnabled, [string]$currentState) {
    if (-not $proEntEdu -or -not $virtEnabled) { return }
    if ($currentState -ne "Disabled") { return }
    $markerDir = Join-Path $env:LOCALAPPDATA "Jarvis"
    $marker = Join-Path $markerDir "v2-sandbox-feature-autoenable.marker"
    if (Test-Path $marker) { return }
    New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
    try {
        Set-Content -Path $marker -Value ("attempted {0}" -f (Get-Date -Format "s")) -Encoding ascii
    } catch {
        return
    }
    try {
        Start-Process -FilePath "dism.exe" -ArgumentList `
            "/Online","/Enable-Feature","/FeatureName:Containers-DisposableClientVM","/All","/NoRestart" `
            -Verb RunAs -WindowStyle Hidden -ErrorAction Stop | Out-Null
    } catch {
        # UAC declined, or dism.exe itself failed to launch -- already marked
        # above, so this never retries regardless.
    }
}

$editionId   = Get-EditionId
$proEntEdu   = Test-ProEntEdu $editionId
$virt        = Get-Virtualization
$sandboxFeat = Test-OptionalFeature "Containers-DisposableClientVM"
$hyperVFeat  = Test-OptionalFeature "Microsoft-Hyper-V"
$sandboxExe  = Test-Path (Join-Path $env:SystemRoot "System32\WindowsSandbox.exe")

Try-AutoEnableSandboxFeature -proEntEdu $proEntEdu -virtEnabled $virt.Enabled -currentState $sandboxFeat
# Re-read in case the enable above finished fast enough to matter this run (rare;
# it normally needs the pending reboot before Get-WindowsOptionalFeature reports it).
$sandboxFeat = Test-OptionalFeature "Containers-DisposableClientVM"

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
