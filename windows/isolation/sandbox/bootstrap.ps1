<#
  bootstrap.ps1 -- runs INSIDE the Windows Sandbox (the v2 agent desktop).

  Launched by the rendered jarvis-agent.wsb LogonCommand. It:
    1. Marks this engine as the in-sandbox instance (JARVIS_AGENT_INSANDBOX=1) so
       backend_windows.get_session('agent') returns THIS desktop (DESIGN gap #1).
    2. Writes the engine config (per-session bearer + port, bind 0.0.0.0) so
       jarvis-engine.exe serves the host with the exact token/port the daemon was
       told at spawn -- no interactive setup in the disposable box.
    3. Starts the engine bound to 0.0.0.0:<port>.
    4. Starts the reverse-tunnel dialer (jarvis-relay.exe dial) which dials OUT to
       the host rendezvous port and splices it to the local engine -- this is what
       makes the in-box engine reachable from the host at 127.0.0.1:<port>
       (DESIGN gap #2). Outbound-only, so no inbound firewall change is needed.

  ASCII-ONLY (Windows PowerShell 5.1 reads .ps1 as ANSI; non-ASCII breaks parsing).
  Everything here is read-only-mapped at C:\engine; the engine writes its config to
  the writable user profile.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Bearer,
    [Parameter(Mandatory = $true)][int]$Rendezvous,
    [string]$HostIp = "auto",
    [string]$Session = ""
)

$ErrorActionPreference = "Stop"
$engineDir = "C:\engine"
$log = Join-Path $env:USERPROFILE "jarvis-bootstrap.log"
function Log([string]$m) {
    $line = ("{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $m)
    Add-Content -Path $log -Value $line -Encoding ascii
    Write-Host $line
}

Log ("bootstrap start: session={0} port={1} rendezvous={2} hostip={3}" -f $Session, $Port, $Rendezvous, $HostIp)

# 1. In-sandbox marker so which='agent' resolves to THIS desktop. Set on the
#    process env so the engine + relay children inherit it.
$env:JARVIS_AGENT_INSANDBOX = "1"
$env:COMPUTER_USE_PORT = "$Port"
$env:COMPUTER_USE_BEARER = "$Bearer"
# Deep /ready gate: server.py computes is_agent from JARVIS_AGENT_WAYLAND_DISPLAY /
# JARVIS_AGENT_SWAYSOCK (the Linux env names). Without one of them set, /ready
# short-circuits to {ready:true,kind:host} and NEVER proves capture works -- so the
# daemon's waitForEngineReady() would pass on a half-up engine (the first-tool-call
# race the /ready gate exists to close). Export a truthy sentinel so is_agent=True
# and /ready runs a REAL mss grab via grab_jpeg_frame(which='agent'). This is inert
# to session routing: the Windows backend keys ONLY off JARVIS_AGENT_INSANDBOX
# (backend_windows.get_session ignores the Wayland env entirely).
$env:JARVIS_AGENT_WAYLAND_DISPLAY = "jarvis-sandbox"

# 2. Engine config: per-session bearer + port, bound to 0.0.0.0 so the relay can
#    reach it. The engine reads %USERPROFILE%\.computer-use\config.yaml.
$cfgDir = Join-Path $env:USERPROFILE ".computer-use"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfgFile = Join-Path $cfgDir "config.yaml"
$cfg = @(
    "bearer_token: $Bearer",
    "host: 0.0.0.0",
    "port: $Port",
    "advertise_host: 127.0.0.1"
) -join "`n"
Set-Content -Path $cfgFile -Value $cfg -Encoding ascii
Log ("wrote engine config: {0}" -f $cfgFile)

# 3. Resolve the host gateway (the host as seen from the box) when not pinned.
if ([string]::IsNullOrWhiteSpace($HostIp) -or $HostIp -eq "auto") {
    $gw = (Get-NetIPConfiguration |
        Where-Object { $_.IPv4DefaultGateway } |
        Select-Object -First 1).IPv4DefaultGateway.NextHop
    if ([string]::IsNullOrWhiteSpace($gw)) {
        $gw = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
            Sort-Object RouteMetric |
            Select-Object -First 1).NextHop
    }
    $HostIp = $gw
}
Log ("resolved host gateway: {0}" -f $HostIp)

# 4. Start the engine (binds 0.0.0.0:<port>). Background so bootstrap can return;
#    the sandbox desktop stays up regardless of this script exiting.
$engineExe = Join-Path $engineDir "jarvis-engine.exe"
if (-not (Test-Path $engineExe)) {
    Log ("FATAL: engine not found at {0}" -f $engineExe)
    exit 1
}
Start-Process -FilePath $engineExe -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden
Log "started jarvis-engine.exe"

# 5. Start the reverse-tunnel dialer (outbound to the host rendezvous; splices to
#    the local engine). Skip gracefully if absent / no gateway (e.g. childsession
#    where loopback is host-global and no relay is needed).
$relayExe = Join-Path $engineDir "jarvis-relay.exe"
if ((Test-Path $relayExe) -and -not [string]::IsNullOrWhiteSpace($HostIp)) {
    $relayArgs = @(
        "dial",
        "--host", $HostIp,
        "--rendezvous", "$Rendezvous",
        "--engine-port", "$Port",
        "--engine-host", "127.0.0.1",
        "--pool", "4"
    )
    Start-Process -FilePath $relayExe -ArgumentList $relayArgs -WindowStyle Hidden
    Log ("started jarvis-relay.exe dial -> {0}:{1}" -f $HostIp, $Rendezvous)
} else {
    Log "jarvis-relay.exe not started (missing exe or no gateway); engine is bound 0.0.0.0 -- use a host portproxy if needed"
}

Log "bootstrap done"
