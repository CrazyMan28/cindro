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

# DIAG (test-only, payload copy): log to the writable host-mapped folder so the
# disposable box's bootstrap trace survives teardown. Written BEFORE
# $ErrorActionPreference/anything else so a marker lands even if everything below
# throws immediately -- isolates "script never started" from "started but crashed".
if (Test-Path "C:\hostlog") { $diag = "C:\hostlog" } else { $diag = $env:USERPROFILE }
try { Set-Content -Path (Join-Path $diag "IMMEDIATE-MARKER.txt") -Value ("alive {0}" -f (Get-Date -Format "HH:mm:ss.fff")) -Encoding ascii } catch {}

$ErrorActionPreference = "Stop"
$engineDir = "C:\engine"
$log = Join-Path $diag "jarvis-bootstrap.log"
function Log([string]$m) {
    $line = ("{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $m)
    Add-Content -Path $log -Value $line -Encoding ascii
}

try {

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
Start-Process -FilePath $engineExe -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $diag "engine.out") -RedirectStandardError (Join-Path $diag "engine.err")
Log "started jarvis-engine.exe"

# 5. Start the reverse-tunnel dialer (outbound to the host rendezvous; splices to
#    the local engine). Skip gracefully if absent / no gateway (e.g. childsession
#    where loopback is host-global and no relay is needed). Deliberately BEFORE
#    the /ready self-probe loop below: that loop can run up to ~2 minutes, and
#    the daemon's own /health polling depends on the relay dialing out promptly
#    -- delaying it here would starve the real pairing the daemon is waiting on,
#    exactly the kind of self-inflicted stall this issue was already about.
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
    Start-Process -FilePath $relayExe -ArgumentList $relayArgs -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $diag "relay.out") -RedirectStandardError (Join-Path $diag "relay.err")
    Log ("started jarvis-relay.exe dial -> {0}:{1}" -f $HostIp, $Rendezvous)

    # REPORT (code review, jarvis#104): this used to open a diagnostic TcpClient
    # probe to the same host:rendezvous port purely to log reachability. Removed:
    # ReverseTunnel's rendezvous listener (windows/isolation/relay/ReverseTunnel.cpp)
    # accepts ANY inbound connection with no handshake and pairs it FIFO with a
    # waiting host-side client, so the probe's own throwaway socket could win a
    # pairing meant for a real relay tunnel -- stealing the exact connection this
    # script exists to establish, and reproducibly causing the /health-never-ready
    # symptom the probe was added to diagnose. ReverseTunnel.cpp now has qDebug/
    # qWarning logging on every state transition (bind, listen, connect, pair,
    # disconnect), which gives the same reachability visibility without a
    # competing connection.
} else {
    Log "jarvis-relay.exe not started (missing exe or no gateway); engine is bound 0.0.0.0 -- use a host portproxy if needed"
}

Log "bootstrap done"

# 6. DIAG, opt-in only (same $diag opt-in as everything else marked DIAG in this
# script -- skipped entirely unless C:\hostlog is actually mapped in, i.e.
# JARVIS_SANDBOX_DIAG_DIR was set on the host): self-probe our OWN /ready
# straight from inside the box, AFTER everything functional has already started
# (see the ordering note on step 5). /ready returns 503 {"ready":false,
# "reason":"..."} until the deep capture gate passes (see
# computer_use_mcp/server.py) -- the daemon's httpGetOk() only ever sees the
# HTTP status code, so the actual "reason" (e.g. an mss/monitor-enumeration
# exception on this specific WDAG desktop) is otherwise invisible from the
# host. Loopback, unauthenticated (like /health), so no bearer needed. Widened
# from an original 8x1s to 60x2s (~2 min, matching the daemon's own ~120s
# startupMs budget) after observing this is genuinely INTERMITTENT --
# sometimes ready within ~2s, sometimes still 503 past 8s -- so a short window
# was seeing "always not-ready" even on runs that later succeeded. Its own
# result is never consumed by anything (the daemon's waitForEngineReady() is
# the real gate) -- purely a human-readable trace for diagnosing a future
# /ready failure, so it stays gated rather than costing every production boot
# up to 2 minutes of inert polling.
if ($diag -eq "C:\hostlog") {
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/ready" -f $Port) -UseBasicParsing -TimeoutSec 3
            Log ("READY PROBE #{0}: HTTP {1} - {2}" -f $i, [int]$resp.StatusCode, $resp.Content)
            if ($resp.StatusCode -eq 200) { break }
        } catch {
            $code = $null
            if ($_.Exception.Response) {
                try { $code = [int]$_.Exception.Response.StatusCode } catch {}
            }
            $body = $_.ErrorDetails.Message
            if (-not $body -and $_.Exception.Response) {
                try {
                    $stream = $_.Exception.Response.GetResponseStream()
                    $stream.Position = 0
                    $reader = New-Object System.IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                } catch {}
            }
            Log ("READY PROBE #{0}: HTTP {1} - {2} (exc: {3})" -f $i, $code, $body, $_.Exception.Message)
        }
        Start-Sleep -Seconds 2
    }
}

} catch {
    # DIAG (test-only): capture the exception so a mid-script throw is visible on
    # the host instead of silently vanishing (LogonCommand has no console).
    try { Add-Content -Path $log -Value ("EXCEPTION: {0}`n{1}" -f $_.Exception.Message, $_.ScriptStackTrace) -Encoding ascii } catch {}
    try { Set-Content -Path (Join-Path $diag "EXCEPTION.txt") -Value ($_ | Out-String) -Encoding ascii } catch {}
}
