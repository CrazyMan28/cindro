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
- **Daemon/shell (C++):** a SELF-CONTAINED CMake project, `windows/CMakeLists.txt`
  (`cmake -S windows -B build-win`), builds `jarvisd.exe` + `jarvis-sidebar.exe` on Windows via
  Qt6 + vcpkg (libsodium/libqrencode). It NEVER edits `core/`, `daemon/`, `desktop/`, or the root
  `CMakeLists.txt`:
  - It **references the unmodified shared sources read-only** by their Linux path (all of
    `core/src/*` except two, the `daemon/src/*`, the desktop `Bridge`/`FrameProvider`, and the
    entire `desktop/qml/*` UI via `qt_add_qml_module`).
  - For the handful of POSIX-only sources it compiles a **copy under `windows/shell/`** and
    excludes the original: `AgentDesktop.cpp` (nested headless Sway → "not available on Windows
    (v2)" stub), `PluginSandbox.cpp` (systemd-run → consent-gated QProcess fallback),
    `main.cpp` (selects the Windows controller via include order), and
    `WindowController.{h,cpp}` (tray + global hotkey, **no LayerShellQt**).
  - `windows/shell/posix_compat.h` is **force-included** (`/FI`) into every Windows target so the
    referenced-as-is sources find `getuid`/`kill`/`SIGTERM`/`SIGKILL`/`pid_t` under MSVC — the
    C++ analogue of the engine's `os.getuid` shim. (The daemon's `systemctl`/`sway` calls go
    through `QProcess` at runtime, so they compile clean and simply no-op on Windows.)

## Build (Windows)

Prereqs: Visual Studio 2022 (or MinGW-w64), CMake 3.24+, vcpkg, Qt 6.5+ (MSVC), Python 3.12, Node 18+.

```powershell
# Self-contained: configure windows/, NOT the repo root.
cmake -S ..\..\windows -B ..\..\build-win -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build ..\..\build-win --config Release
.\build.ps1     # bundles engine + node + makes windows\dist\Jarvis-Setup-x.y.z.exe
```

## Honest limits on Windows (no Win32 equivalent)

- **Nested "beside-you" agent desktop** (Linux uses a headless Sway compositor) — Windows v1
  drives the **real screen** only (take-over UX). A child-RDP-session / Windows-Sandbox / VM
  isolation is the planned **v2**.
- **Multi-seat isolated agent cursor** (Linux forks KWin) — the agent shares your input queue,
  gated by the consent + the "Jarvis is driving" banner.
- **Layer-shell dock anchoring** — the Windows window is a normal top-level window + tray.
