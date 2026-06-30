#!/usr/bin/env python3
"""winlab — drive a Windows test VM from Linux over SSH (a local "GitHub Actions").

Lets the Linux box (and Claude, via Bash) build / install / launch / SCREENSHOT /
PowerShell-debug Jarvis on a real Windows VM — closing the loop the GitHub CI can't
(CI compiles but never RUNS the app, so GUI bugs are invisible there).

Setup: run `windows/testlab/setup-windows-vm.ps1` on the VM, then write
~/.config/jarvis/winlab.json:  {"host","user","port":22,"build_dir":"C:/jarvis-src"}

Commands:
  doctor                 test SSH connectivity + print Windows version
  ps "<powershell>"      run a PowerShell snippet on the VM, print output
  shot [local.png]       screenshot the VM desktop -> local PNG (Claude can Read it)
  push <local> <remote>  / pull <remote> <local>     file transfer (scp)
  release [version]      download the GitHub Release installer on the VM + install silently
  launch                 start Jarvis on the VM (the hidden VBS launcher)
  shoot-app [version]    release -> launch -> wait -> screenshot   (the GUI debug loop)
  build [ref]            git pull <ref> on the VM + run windows/scripts/build.ps1
  ci [ref]               build -> install -> launch -> screenshot
  logs                   pull jarvisd/sidebar logs from the VM
  kill                   stop jarvis* processes on the VM
"""
from __future__ import annotations
import base64, json, os, subprocess, sys, time
from pathlib import Path

REPO = "https://github.com/CrazyMan28/jarvis"
CFG = Path(os.path.expanduser("~/.config/jarvis/winlab.json"))
ART = Path(os.path.expanduser("~/.config/jarvis/winlab"))  # local pulled artifacts


def cfg() -> dict:
    if not CFG.exists():
        sys.exit(f"missing {CFG} — run setup-windows-vm.ps1 on the VM, then create it "
                 '(e.g. {"host":"192.168.1.50","user":"you","port":22,'
                 '"build_dir":"C:/jarvis-src"}).')
    c = json.loads(CFG.read_text())
    c.setdefault("port", 22)
    c.setdefault("build_dir", "C:/jarvis-src")
    return c


def _target(c): return f'{c["user"]}@{c["host"]}'


def _ssh_base(c):
    a = ["ssh", "-p", str(c["port"]), "-o", "StrictHostKeyChecking=accept-new",
         "-o", "ConnectTimeout=12"]
    if c.get("key"):
        a += ["-i", os.path.expanduser(c["key"])]
    return a


def ssh_raw(c, remote_cmd: str, timeout=900) -> subprocess.CompletedProcess:
    return subprocess.run(_ssh_base(c) + [_target(c), remote_cmd],
                          capture_output=True, text=True, timeout=timeout)


def ps(c, script: str, timeout=1800) -> subprocess.CompletedProcess:
    """Run PowerShell on the VM via -EncodedCommand (no quoting hell)."""
    b64 = base64.b64encode(script.encode("utf-16-le")).decode()
    return ssh_raw(c, f"powershell -NoProfile -NonInteractive -EncodedCommand {b64}", timeout)


def scp(c, src, dst):
    a = ["scp", "-P", str(c["port"]), "-o", "StrictHostKeyChecking=accept-new"]
    if c.get("key"):
        a += ["-i", os.path.expanduser(c["key"])]
    subprocess.run(a + [src, dst], check=True)


def _run_ps(c, script, label="powershell"):
    r = ps(c, script)
    if r.stdout.strip():
        print(r.stdout.rstrip())
    if r.returncode != 0:
        print(f"!! {label} exit {r.returncode}\n{r.stderr.rstrip()}", file=sys.stderr)
    return r


# ---- commands --------------------------------------------------------------

def cmd_doctor(c, _):
    r = ssh_raw(c, "powershell -NoProfile -Command "
                   '"$o=Get-CimInstance Win32_OperatingSystem; '
                   "Write-Output ('OK ' + $o.Caption + ' ' + $o.Version)\"", timeout=20)
    print((r.stdout or r.stderr).strip())
    sys.exit(r.returncode)


def cmd_ps(c, args):
    _run_ps(c, args[0] if args else "$PSVersionTable.PSVersion")


def cmd_shot(c, args):
    local = args[0] if args else None
    ART.mkdir(parents=True, exist_ok=True)
    if not local:
        local = str(ART / f"shot-{int(time.time())}.png")
    remote = "C:/Windows/Temp/jarvis-shot.png"
    shot_ps = (Path(__file__).parent / "screenshot.ps1").read_text()
    r = ps(c, shot_ps.replace('$env:TEMP\\jarvis-shot.png', remote))
    if r.returncode != 0:
        sys.exit(f"screenshot failed: {r.stderr.strip()}")
    scp(c, f'{_target(c)}:{remote}', local)
    print(local)  # Claude: Read this path to SEE the VM screen


def cmd_push(c, args):
    scp(c, args[0], f'{_target(c)}:{args[1]}')
    print(f"pushed -> {args[1]}")


def cmd_pull(c, args):
    ART.mkdir(parents=True, exist_ok=True)
    local = args[1] if len(args) > 1 else str(ART / Path(args[0]).name)
    scp(c, f'{_target(c)}:{args[0]}', local)
    print(local)


def cmd_release(c, args):
    ver = args[0] if args else ""
    tag = f"download/v{ver.lstrip('v')}" if ver else "latest/download"
    name = f"Jarvis-Setup-{ver.lstrip('v')}.exe" if ver else None
    # If no version: query the latest release asset name on the VM.
    print(f"==> downloading + installing {'v'+ver if ver else 'the latest release'} on the VM…")
    script = fr"""
$ErrorActionPreference='Stop'
$ver='{ver.lstrip('v')}'
if ($ver) {{
  $url="{REPO}/releases/download/v$ver/Jarvis-Setup-$ver.exe"
}} else {{
  $j = Invoke-RestMethod "https://api.github.com/repos/CrazyMan28/jarvis/releases/latest" -Headers @{{'User-Agent'='winlab'}}
  $url = ($j.assets | Where-Object {{ $_.name -like 'Jarvis-Setup-*.exe' }} | Select-Object -First 1).browser_download_url
  $ver = ($j.tag_name -replace '^v','')
}}
$exe="$env:TEMP\Jarvis-Setup-$ver.exe"
Write-Output "downloading $url"
Invoke-WebRequest $url -OutFile $exe -Headers @{{'User-Agent'='winlab'}}
Write-Output "installing silently…"
Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait
Write-Output "installed v$ver"
"""
    _run_ps(c, script, "release-install")


def cmd_launch(c, _):
    # The installer puts Jarvis under %ProgramFiles%\Jarvis (per-machine) or
    # %LocalAppData%\Programs\Jarvis (per-user). Find the launcher + run it.
    script = r"""
$cands = @("$env:ProgramFiles\Jarvis","${env:ProgramFiles(x86)}\Jarvis",
           "$env:LocalAppData\Programs\Jarvis")
$dir = $cands | Where-Object { Test-Path "$_\jarvis-launch.vbs" } | Select-Object -First 1
if (-not $dir) { throw "Jarvis install not found in $($cands -join ', ')" }
Write-Output "launching from $dir"
Start-Process wscript.exe -ArgumentList "`"$dir\jarvis-launch.vbs`""
"""
    _run_ps(c, script, "launch")


def cmd_kill(c, _):
    _run_ps(c, "Get-Process jarvisd,jarvis-sidebar,jarvis-engine -ErrorAction SilentlyContinue | "
               "Stop-Process -Force; Write-Output 'killed'", "kill")


def cmd_shoot_app(c, args):
    """The GUI debug loop: install the release -> launch -> wait -> screenshot."""
    cmd_kill(c, [])
    cmd_release(c, args)
    cmd_launch(c, [])
    print("==> waiting 8s for the UI to appear…")
    time.sleep(8)
    cmd_shot(c, [])


def cmd_build(c, args):
    ref = args[0] if args else "main"
    bd = c["build_dir"]
    print(f"==> sync {ref} + build on the VM ({bd})…")
    script = fr"""
$ErrorActionPreference='Stop'
$bd='{bd}'
if (Test-Path "$bd\.git") {{ git -C $bd fetch --all --tags --quiet; git -C $bd checkout {ref} --quiet; git -C $bd pull --quiet }}
else {{ git clone --quiet {REPO} $bd; git -C $bd checkout {ref} --quiet }}
$sha = (git -C $bd rev-parse --short HEAD)
Write-Output "building $sha…"
& "$bd\windows\scripts\build.ps1" -Version "0.0.0-$sha"
"""
    _run_ps(c, script, "build")


def cmd_ci(c, args):
    ref = args[0] if args else "main"
    bd = c["build_dir"]
    cmd_kill(c, [])
    cmd_build(c, [ref])
    # install whatever build.ps1 produced, then launch + shot
    _run_ps(c, fr"""
$exe = Get-ChildItem "{bd}\windows\dist\Jarvis-Setup-*.exe" | Select-Object -First 1
if (-not $exe) {{ throw "no installer produced" }}
Start-Process -FilePath $exe.FullName -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait
""", "ci-install")
    cmd_launch(c, [])
    time.sleep(8)
    cmd_shot(c, [])


def cmd_logs(c, _):
    ART.mkdir(parents=True, exist_ok=True)
    # jarvisd logs to its console; capture via the daemon's journal if present, else
    # grab the config dir for diagnostics.
    script = r"""
$dst="$env:TEMP\jarvis-logs.txt"
"=== jarvis processes ===" | Out-File $dst
Get-Process jarvisd,jarvis-sidebar,jarvis-engine -ErrorAction SilentlyContinue |
  Format-Table Name,Id,StartTime -Auto | Out-String | Add-Content $dst
"=== %APPDATA%\jarvis ===" | Add-Content $dst
Get-ChildItem "$env:APPDATA\jarvis" -Recurse -ErrorAction SilentlyContinue |
  Select-Object FullName,Length | Out-String | Add-Content $dst
Write-Output $dst
"""
    r = ps(c, script)
    print(r.stdout.strip())
    scp(c, f'{_target(c)}:C:/Windows/Temp/jarvis-logs.txt', str(ART / "jarvis-logs.txt"))
    print(str(ART / "jarvis-logs.txt"))


CMDS = {
    "doctor": cmd_doctor, "ps": cmd_ps, "shot": cmd_shot, "push": cmd_push,
    "pull": cmd_pull, "release": cmd_release, "launch": cmd_launch, "kill": cmd_kill,
    "shoot-app": cmd_shoot_app, "build": cmd_build, "ci": cmd_ci, "logs": cmd_logs,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd not in CMDS:
        sys.exit(f"unknown command {cmd!r}. Try: {', '.join(CMDS)}")
    CMDS[cmd](cfg(), sys.argv[2:])


if __name__ == "__main__":
    main()
