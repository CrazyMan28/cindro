# Jarvis — KDE Plasma 6 widget

A panel/desktop plasmoid for quick access to the Jarvis AI co-worker.

- **Compact:** a glowing cyan/blue **arc-reactor orb** (drawn in QML `Canvas`, subtle pulse). Click it to open the popup.
- **Popup:** a `JARVIS` title plus:
  1. **Open / Toggle Sidebar** — runs `jarvis-sidebar`
  2. **Voice Mode** — runs `jarvis-sidebar --voice`
  3. a **status line** (`Jarvis` + green "ready" dot)

Commands are launched via the Plasma 6 executable engine
(`org.kde.plasma.plasma5support` → `DataSource { engine: "executable" }`).
`jarvis-sidebar` must be on `PATH` (it lives at `~/.local/bin/jarvis-sidebar`).

## Requirements

- KDE Plasma 6 / KF6 (KWin, Wayland — including the multi-seat fork)
- `kpackagetool6`

## Install

From the repo root (the directory that **contains** `kde-applet/`):

```sh
# first install
kpackagetool6 --type Plasma/Applet --install kde-applet

# updating an already-installed copy
kpackagetool6 --type Plasma/Applet --upgrade kde-applet

# remove
kpackagetool6 --type Plasma/Applet --remove org.kde.jarvis
```

This installs to `~/.local/share/plasma/plasmoids/org.kde.jarvis/`.

After installing you may need to restart plasmashell for it to appear in the
widget list (on Wayland this is safe — it respawns):

```sh
kquitapp6 plasmashell && kstart plasmashell
```

## Add it to a panel or the desktop

1. Right-click the panel (or desktop) → **Add Widgets…**
2. Search for **Jarvis**.
3. Drag it onto the panel or desktop.

The arc-reactor orb is the compact icon; click it to open the controls.

## Files

```
kde-applet/
  metadata.json              # KPlugin metadata (Plasma 6 / KPackage)
  contents/
    ui/
      main.qml               # PlasmoidItem: orb + popup + executable runner
  README.md
```
