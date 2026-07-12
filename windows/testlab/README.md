# winlab — a local "GitHub Actions" for a Windows test VM

GitHub CI **compiles** the Windows build but never **runs** it, so GUI/runtime bugs
(like "the window doesn't appear") are invisible there. `winlab` closes that loop: it
drives a real **Windows VM** from the Linux box over SSH so you (and Claude, via the
shell) can **install the release, launch Jarvis, screenshot the desktop, run PowerShell,
read logs, and even build from source** — a fast Windows debug loop on your own machine.

```
 Linux box ──ssh/scp──▶ Windows VM
  winlab.py            OpenSSH Server + PowerShell + screenshot.ps1
                       (Jarvis installs/runs here; screenshots come back as PNGs)
```

## One-time setup

1. **On the Windows VM** (elevated PowerShell):
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\setup-windows-vm.ps1 -PubKey "ssh-ed25519 AAAA... (your linux box's ~/.ssh/id_ed25519.pub)"
   #   add -InstallBuildTools to also install VS BuildTools/CMake/Python/Node/Inno Setup
   ```
   It installs OpenSSH Server, makes PowerShell the SSH shell, opens the firewall,
   authorizes your key, and prints the VM IP + the config to paste below.

2. **On the Linux box**, create `~/.config/jarvis/winlab.json`:
   ```json
   { "host": "192.168.1.50", "user": "you", "port": 22, "build_dir": "C:/jarvis-src" }
   ```
   (Reach the VM by its LAN IP, a host-only adapter, or Tailscale. Add `"key": "~/.ssh/id_ed25519"`
   if you use a non-default key.)

3. Verify: `python windows/testlab/winlab.py doctor` → `OK Microsoft Windows 11 …`

## The GUI debug loop (what unblocks the "no window" bug)

```bash
python windows/testlab/winlab.py shoot-app 0.12.2   # install that release -> launch -> screenshot
#   prints a local PNG path; open it to SEE the actual VM desktop
```
or step by step:
```bash
winlab release 0.12.2     # download + silently install the GitHub Release installer on the VM
winlab launch             # start Jarvis (hidden launcher)
winlab shot               # screenshot the VM -> ~/.config/jarvis/winlab/shot-*.png
winlab ps "Get-Process jarvisd,cindro-sidebar,jarvis-engine"   # is the GUI process even alive?
winlab logs               # pull diagnostics
```

## Build from source on the VM (needs `-InstallBuildTools` + Qt/vcpkg)

```bash
winlab build main         # git pull main on the VM + run windows/scripts/build.ps1
winlab ci   main          # build -> install -> launch -> screenshot
```
> The **canonical** build is still the GitHub Actions `windows-build.yml` (clean, reproducible).
> The VM build is for fast local iteration/debug; for releases, push a `v*` tag and let CI build it.

## All commands

`doctor · ps "<powershell>" · shot [out.png] · push <l> <r> · pull <r> [l] · release [ver] ·
launch · shoot-app [ver] · build [ref] · ci [ref] · logs · kill`

PowerShell is sent via `-EncodedCommand` (base64) so any quotes/newlines work. Screenshots
capture the full virtual desktop (all monitors). Nothing here runs on Linux except the CLI;
the VM is a pure test target.
