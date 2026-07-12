# Orin — packaging & install

This directory makes Orin launchable like a real desktop app: it builds the
C++ superbuild, drops the `jarvisd` daemon and `jarvis-sidebar` UI into
`~/.local/bin`, registers an app icon + launcher, installs a `systemd --user`
unit for the daemon, and adds a Sway keybind to toggle the sidebar.

Everything installs under `$HOME`. **No `sudo` is used or required.**

## Contents

| File                | Purpose                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `install.sh`        | Builds the superbuild and installs all of the below. Idempotent.        |
| `jarvis.desktop`    | XDG launcher entry (`__HOME__` is replaced with your `$HOME` on install). |
| `jarvis.svg`        | Scalable app icon (arc-reactor "J", cyan `#19E3FF` on a dark disc).     |
| `jarvisd.service`   | `systemd --user` unit that runs the daemon headless.                    |
| `sway-jarvis.conf`  | Reference Sway snippet (the installer writes its own `config.d/90-jarvis.conf`). |
| `mako/config`       | mako notification styling (used in later waves).                        |

## Install

```bash
bash packaging/install.sh
```

This will:

1. Configure and build the superbuild
   (`cmake -S . -B build -G Ninja && cmake --build build`).
2. Copy `build/daemon/jarvisd` and `build/desktop/jarvis-sidebar`
   to `~/.local/bin/`.
3. Install the icon to `~/.local/share/icons/hicolor/scalable/apps/jarvis.svg`.
4. Install the launcher to `~/.local/share/applications/jarvis.desktop`
   (with `__HOME__` replaced by your real home), then refresh the desktop and
   icon caches.
5. Install the daemon unit to `~/.config/systemd/user/jarvisd.service`.
6. Write `~/.config/sway/config.d/90-jarvis.conf` with the `$mod+j` keybind.

Re-running the script is safe — it rebuilds and overwrites the installed files
in place.

> Make sure `~/.local/bin` is on your `PATH` if you want to launch the binaries
> by name from a shell. The launcher and keybind use absolute paths, so they
> work regardless.

## Running the daemon

```bash
systemctl --user enable --now jarvisd     # start now + at every login
systemctl --user status jarvisd           # check it's healthy
journalctl --user -u jarvisd -f           # follow its logs
```

The daemon serves the Contract A control WebSocket on
`ws://127.0.0.1:8795/control/ws` and auto-generates its `0600` control token at
`~/.config/jarvis/control_token` on first start. It runs under
`QT_QPA_PLATFORM=offscreen` (no GUI).

## KDE — pin Orin to the taskbar

After installing, Orin shows up in the KDE application launcher
(Kickoff / Application Menu):

1. Open the launcher and search for **Orin**.
2. **Right-click** the Orin entry.
3. Choose **Pin to Task Manager** (icons-only taskbar) or **Add to Panel ▸ Add
   Widgets** style **Pin to Task Manager** — the exact wording depends on your
   Plasma version. Either keeps the Orin icon permanently on the taskbar so a
   single click launches the sidebar.

Clicking the icon launches `~/.local/bin/jarvis-sidebar`, which anchors itself
to the right edge of the screen as a `wlr-layer-shell` surface (proven working
on KWin 6). `StartupWMClass=jarvis-sidebar` ties the running window back to the
launcher entry so KDE shows it as the same task.

## How the keybind works

On **Sway**, the installer drops `~/.config/sway/config.d/90-jarvis.conf`
containing:

```
bindsym $mod+j exec ~/.local/bin/jarvis-sidebar --toggle
```

- `$mod+j` runs `jarvis-sidebar --toggle`.
- First press launches the sidebar; subsequent presses show/hide the running
  instance (single-instance toggle).

For this to take effect, your main Sway config must include the `config.d`
directory (the installer never edits your main config):

```
include ~/.config/sway/config.d/*.conf
```

Then reload Sway:

```bash
swaymsg reload
```

The sidebar must run under the Wayland platform plugin
(`QT_QPA_PLATFORM=wayland`); set that in your Sway environment if it isn't
already (e.g. `exec_always export QT_QPA_PLATFORM=wayland`, as shown in the
reference `sway-jarvis.conf`).
