# Windows port — plan

> Status: **planned** (phase 2). Do this **after** the Linux work is fully shipped. Tracked
> in the build tasks; not started yet.

## Goal
Bring Jarvis to **Windows** with as much feature parity as possible, in **one repo** with
two top-level folders, each with their own subfolders:

```
linux/     ← all the existing code, moved here unchanged
windows/   ← the Windows port (Go + Win32)
```

(Same GitHub repo as today — just two main folders.)

## Approach
1. **Restructure first** — `git mv` the current tree into `linux/` (fix CMake paths,
   packaging/systemd, Android gradle refs, docs links, `.gitignore`, scripts); verify the
   Linux build still works. Then create `windows/`.
2. **Port the cross-platform core** — Contract A protocol, the daemon/session model, the MCP
   client, the phone subsystem, modes, hooks, and background jobs are OS-agnostic and port
   directly.
3. **Replace the OS layer** — the Linux computer-use engine (Wayland/KWin/Sway, `uinput`,
   `grim`/`spectacle`) has no Windows analog; reimplement against Win32: `SendInput` (mouse/
   keyboard), DXGI/GDI capture (screen), UI Automation (controls), plus device pairing.
4. **Build artifacts** — produce real Windows **`.exe`** binaries (and an installer).

## Execution
Use dynamic **Workflows + sonnet/haiku subagents** in a **build → verify loop**: a subagent
builds a slice, a verify agent checks it; if good, move on, else back to build — until each
slice compiles and the `.exe` runs. Scale the fan-out to the work.
