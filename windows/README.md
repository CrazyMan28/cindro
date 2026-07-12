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
  outpost/       PyInstaller entry point (run_outpost_mcp.py) that freezes the SHARED
                 outpost-mcp/ package as-is — no Win32 shim needed, it's a plain relay
                 server. No systemd on Windows, so jarvis-launch.vbs/jarvis-start.cmd
                 are what actually start the frozen outpost-mcp.exe.
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
    excludes the original: `AgentDesktop.cpp` (nested headless Sway → **Windows Sandbox v2**
    orchestrator: renders `windows/isolation/sandbox/jarvis-agent.wsb`, launches
    `WindowsSandbox.exe`, runs the engine inside bound `0.0.0.0:<port>`, and re-exposes it on the
    host at `127.0.0.1:<port>` via the in-process reverse tunnel — see `isolation/DESIGN.md`),
    `PluginSandbox.cpp` (systemd-run → consent-gated QProcess fallback),
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

## Windows v2 — the isolated "beside-you" agent desktop

The v2 tier (default: **Windows Sandbox**) is implemented under `windows/isolation/` +
`windows/shell/AgentDesktop.cpp`. The engine runs INSIDE a disposable Hyper-V micro-VM, so its
`SendInput` + `mss` are scoped to that desktop by the OS boundary (the Windows analogue of Linux's
nested-Sway seat), streamed to the side pane; a take-over button falls back to v1. Two
`windows/`-local seams make the rest of the pipeline reuse unchanged: (1) `which="agent"` is
env-gated by `JARVIS_AGENT_INSANDBOX=1` in `backend_windows.get_session`, and (2) reachability via
the in-sandbox reverse tunnel (`isolation/relay/`). `isolation/detect.ps1` picks the tier
(`sandbox`/`hyperv`/`takeover`), exported at launch as `JARVIS_WINDOWS_ISOLATION_MODE`.

> The host side compiles + unit-tests on Linux (`windows/engine/tests`), but actually spinning a
> Sandbox can only be validated on a real **Windows Pro/Ent/Edu** box with virtualization on — see
> `isolation/DESIGN.md`. `childsession`/`hyperv` are staged (typed-degrade to v1 today).

## Honest limits on Windows (no Win32 equivalent)

- **Multi-seat isolated agent cursor on the REAL screen** (Linux forks KWin) — on Windows the
  agent's isolation comes from the Sandbox/session/VM boundary (v2 above), not a second seat on the
  user's own desktop. When isolation is unavailable (Home / no-virt) the **v1 take-over** fallback
  shares your input queue, gated by consent + the "Jarvis is driving" banner.
- **Layer-shell dock anchoring** — the Windows window is a normal top-level window + tray.
