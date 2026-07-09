"""PairingStore — one-shot, 10-minute bootstrap codes + the OS install scripts.

A bootstrap_id is the one-shot secret handed to the target machine. The install
script (served open at /pair/<id>/sh|ps1) downloads the agent binary (gated by
the still-valid bootstrap_id), POSTs /pair/<id>/complete to redeem it exactly
once for {machine_id, token, ws_url}, persists the token 0600, and installs
itself: a systemd --user unit on Linux/macOS, a Scheduled Task in the
INTERACTIVE session on Windows (a session-0 service captures a blank desktop —
see windows/testlab/winlab.py)."""

import secrets
import time
from typing import Any, Optional

from outpost_mcp import config

_SH_TEMPLATE = r"""#!/usr/bin/env bash
set -euo pipefail
BASE="__BASE__"
BID="__BID__"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
esac
DIR="$HOME/.local/share/outpost-agent"
mkdir -p "$DIR"
BIN="$DIR/outpost-agent"
echo "Outpost: downloading agent ($OS/$ARCH)..."
# Stage to a temp file and rename: writing straight onto $BIN fails with
# ETXTBSY (curl exit 23) while an agent from a previous pairing is running.
TMP=$(mktemp "$DIR/.outpost-agent.XXXXXX")
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$BASE/agent/download/$BID/$OS/$ARCH" -o "$TMP"
chmod +x "$TMP"
mv -f "$TMP" "$BIN"
trap - EXIT
echo "Outpost: registering this machine..."
RESP=$(curl -fsSL -X POST "$BASE/pair/$BID/complete" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$(hostname)\",\"os\":\"$OS\",\"arch\":\"$ARCH\"}")
CFG="$HOME/.config/outpost-agent"
mkdir -p "$CFG"
printf '%s' "$RESP" > "$CFG/agent.json"
chmod 600 "$CFG/agent.json"
UNIT="$HOME/.config/systemd/user/outpost-agent.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=Outpost agent (dials Jarvis outpost-mcp)
After=network-online.target
[Service]
ExecStart=$BIN
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
# Stop any agent left from a previous pairing so exactly one runs with the
# new token ("enable --now" alone would leave a running old agent untouched).
# pkill -x: exact-cmdline match — plain -f would also kill any unrelated
# process that merely has this path somewhere in its argv.
HAVE_SYSTEMD=0
command -v systemctl >/dev/null 2>&1 && HAVE_SYSTEMD=1
[ "$HAVE_SYSTEMD" = 1 ] && systemctl --user stop outpost-agent.service 2>/dev/null || true
pkill -xf "$BIN" 2>/dev/null || true
# Start in the foreground: `systemctl ... || nohup ... &` would background
# the WHOLE and-or list, letting the script exit before the start is even
# attempted (and unprotected from the pipe teardown of `curl | bash`).
STARTED=0
if [ "$HAVE_SYSTEMD" = 1 ]; then
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now outpost-agent.service 2>/dev/null && STARTED=1 || true
fi
if [ "$STARTED" = 0 ]; then
  nohup "$BIN" >/dev/null 2>&1 &
fi
echo "Outpost agent installed."
"""

_PS1_TEMPLATE = r"""$ErrorActionPreference = 'Stop'
$Base = '__BASE__'
$Bid  = '__BID__'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
$dir = Join-Path $env:LOCALAPPDATA 'outpost-agent'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bin = Join-Path $dir 'outpost-agent.exe'
$tmp = Join-Path $dir 'outpost-agent.new.exe'
Write-Host "Outpost: downloading agent (windows/$arch)..."
# Stage to a temp file: a running old agent locks $bin, and downloading
# before stopping anything means a failed download leaves the old, working
# agent untouched instead of an agentless machine.
Invoke-WebRequest "$Base/agent/download/$Bid/windows/$arch" -OutFile $tmp
Write-Host "Outpost: registering this machine..."
$body = @{ name = $env:COMPUTERNAME; os = 'windows'; arch = $arch } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post "$Base/pair/$Bid/complete" -ContentType 'application/json' -Body $body
$cfgdir = Join-Path $env:APPDATA 'outpost-agent'
New-Item -ItemType Directory -Force -Path $cfgdir | Out-Null
($resp | ConvertTo-Json) | Set-Content -Path (Join-Path $cfgdir 'agent.json') -Encoding UTF8
# Only now stop any agent left from a previous pairing so the locked exe can
# be swapped. Match by image name — reading a process's Path property can
# throw on protected processes and abort the script under EAP=Stop.
Get-ScheduledTask -TaskName 'OutpostAgent' -ErrorAction SilentlyContinue |
  Stop-ScheduledTask -ErrorAction SilentlyContinue
$old = Get-Process -Name 'outpost-agent' -ErrorAction SilentlyContinue
if ($old) {
  $old | Stop-Process -Force -ErrorAction SilentlyContinue
  $old | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
}
# Brief retry: a just-killed process (or AV scanning the exe) can hold the
# lock a moment longer than Stop/Wait-Process report.
$moved = $false
for ($i = 0; $i -lt 10 -and -not $moved; $i++) {
  try { Move-Item -Force $tmp $bin; $moved = $true }
  catch { Start-Sleep -Milliseconds 300 }
}
if (-not $moved) { Move-Item -Force $tmp $bin }
# Install as a Scheduled Task in the INTERACTIVE session so screenshots see a
# real desktop (a session-0 service returns a blank capture).
$act  = New-ScheduledTaskAction -Execute $bin
$me   = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$prin = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$trig = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'OutpostAgent' -Action $act -Trigger $trig -Principal $prin -Force | Out-Null
Start-ScheduledTask -TaskName 'OutpostAgent'
Write-Host 'Outpost agent installed.'
"""


class PairingStore:
    def __init__(self, ttl_seconds: int = config.BOOTSTRAP_TTL_SECONDS):
        self._ttl = ttl_seconds
        self._bootstraps: dict[str, dict[str, Any]] = {}

    def start(self, name: str = "", os_hint: str = "") -> dict[str, Any]:
        bid = secrets.token_urlsafe(24)
        now = time.time()
        code = f"{secrets.randbelow(1000000):06d}"
        self._bootstraps[bid] = {
            "bootstrap_id": bid, "pairing_code": code,
            "name": name, "os_hint": os_hint,
            "created_at": now, "expires_at": now + self._ttl,
            "redeemed": False, "machine_id": "",
        }
        base = config.advertise_base_url()
        return {
            "pairing_code": code,
            "bootstrap_id": bid,
            "expires_at": int((now + self._ttl) * 1000),
            "install_cmd_linux": f"curl -fsSL {base}/pair/{bid}/sh | bash",
            "install_cmd_windows": (
                f"irm {base}/pair/{bid}/ps1 -OutFile "
                f"$env:TEMP\\outpost-install.ps1; & $env:TEMP\\outpost-install.ps1"
            ),
        }

    def valid(self, bootstrap_id: str) -> bool:
        b = self._bootstraps.get(bootstrap_id)
        return bool(b) and not b["redeemed"] and time.time() < b["expires_at"]

    def status(self, bootstrap_id: str) -> dict[str, Any]:
        b = self._bootstraps.get(bootstrap_id)
        if not b:
            return {"status": "unknown"}
        if b["redeemed"]:
            return {"status": "paired", "machine_id": b["machine_id"]}
        if time.time() >= b["expires_at"]:
            return {"status": "expired"}
        return {"status": "pending", "expires_at": int(b["expires_at"] * 1000)}

    def redeem(self, bootstrap_id: str) -> Optional[dict[str, Any]]:
        if not self.valid(bootstrap_id):
            return None
        b = self._bootstraps[bootstrap_id]
        b["redeemed"] = True
        return b

    def mark_paired(self, bootstrap_id: str, machine_id: str) -> None:
        if bootstrap_id in self._bootstraps:
            self._bootstraps[bootstrap_id]["machine_id"] = machine_id

    def render_sh(self, bootstrap_id: str) -> str:
        return (_SH_TEMPLATE
                .replace("__BASE__", config.advertise_base_url())
                .replace("__BID__", bootstrap_id))

    def render_ps1(self, bootstrap_id: str) -> str:
        return (_PS1_TEMPLATE
                .replace("__BASE__", config.advertise_base_url())
                .replace("__BID__", bootstrap_id))
