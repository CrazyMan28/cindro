# Jarvis — Windows edition (isolated)

**Everything Windows-specific lives in this `windows/` directory.** Deleting `windows/`
leaves the Linux/Android build byte-for-byte unaffected — that is the design rule. Windows
is **second priority**; Linux (Sway + KDE) and Android lead. See [`../docs/WINDOWS.md`](../docs/WINDOWS.md).

## What's here

```
windows/
  engine/        Windows computer-use backend (Win32 SendInput + mss) + a startup
                 shim that monkeypatches the SHARED Python engine's primitives — so
                 computer-use/computer_use_mcp/ is never modified. Run: server_windows.py
  shell/         Native Windows Qt window controller (tray + global hotkey) that reuses
                 the existing ~60 desktop/qml/* pages (no LayerShellQt).
  installer/     Inno Setup script (jarvis.iss) -> Jarvis-Setup-x.y.z.exe
  scripts/       build.ps1 — one-shot: build daemon + shell, bundle engine + node, make .exe
  dist/          build output (gitignored)
```

## How isolation is kept

- **Engine:** no edits to `computer-use/computer_use_mcp/`. `engine/server_windows.py`
  imports the shared modules and rebinds `input.move`/`screen.take_screenshot`/
  `session.get_session`/… to the Win32 backend at startup (the engine calls these by
  module attribute, so the swap is total). Windows deps live in
  `engine/requirements-windows.txt`, not the shared `pyproject.toml`.
- **Daemon/shell (C++):** the shared `jarvisd`/`core` compile on Windows via Qt6 + vcpkg
  (libsodium/libqrencode). The only Linux-only desktop piece (LayerShellQt + the layer-shell
  `WindowController`) is gated behind `if(UNIX AND NOT APPLE)` in `desktop/CMakeLists.txt`;
  the Windows window controller in `windows/shell/` is gated behind `if(WIN32)`. The nested
  agent-desktop (`core/src/AgentDesktop.cpp`, headless Sway) is stubbed under
  `#ifdef Q_OS_WINDOWS`. These are additive guards — the Linux path is never removed.

## Build (Windows)

Prereqs: Visual Studio 2022 (or MinGW-w64), CMake 3.24+, vcpkg, Qt 6.5+ (MSVC), Python 3.12, Node 18+.

```powershell
cmake -S .. -B ..\build-win -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DWINDOWS_BUILD=ON
cmake --build ..\build-win --config Release
.\scripts\build.ps1     # bundles engine + node + makes windows\dist\Jarvis-Setup-x.y.z.exe
```

## Honest limits on Windows (no Win32 equivalent)

- **Nested "beside-you" agent desktop** (Linux uses a headless Sway compositor) — Windows v1
  drives the **real screen** only (take-over UX). A child-RDP-session / Windows-Sandbox / VM
  isolation is the planned **v2**.
- **Multi-seat isolated agent cursor** (Linux forks KWin) — the agent shares your input queue,
  gated by the consent + the "Jarvis is driving" banner.
- **Layer-shell dock anchoring** — the Windows window is a normal top-level window + tray.
