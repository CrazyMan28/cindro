# Cindro on Windows (experimental — second-tier)

> **Priority, stated plainly:** **Linux and Android are the priority for every new
> feature. Windows is second** — it tracks the Linux build and may lag. Windows support
> exists so people without Codex/Claude on Linux can still run Cindro; the polished,
> leading platform is Linux (Sway + KDE Plasma 6) and Android. *Maybe more Windows later.*

The Windows edition reuses the **same daemon, the same ~60 QML pages, the same Python
computer-use engine, the same Node phone server, and the same Chrome extension** as Linux.
Only the OS-glue is swapped. It is **not** a rewrite and **not** a website — it's the
native daemon plus a native Qt window. All Windows code lives in `windows/` and behind
platform guards; it never changes how Linux/Android build or run.

## What you get on Windows

| Feature | Linux | Windows v1 | How / caveat |
|---|---|---|---|
| Chat, streaming, sessions, history, brain/model picker | ✅ | ✅ | Same daemon + QML. Mistral is the default brain on a CLI-less box. |
| **Computer use** (screenshot, mouse, keyboard, scroll, windows, apps, clipboard) | ✅ | ✅ | Win32 `SendInput` + `mss` capture (see below). **Real screen.** |
| Nested "beside-you" agent desktop | ✅ headless Sway | ❌ → v2 | Windows can't nest an isolated GPU desktop in-process. Planned v2 via a child RDP session / Windows Sandbox / VM. |
| Multi-seat isolated agent cursor | ✅ forked KWin | ❌ | No compositor to fork; agent shares your input queue (gated by the take-over banner + consent). |
| Real-screen take-over (glow cursor + banner + consent + Esc) | ✅ | ✅ | Transparent click-through overlay (`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST`). |
| Voice (Voxtral STT/TTS, voice library, voice mode) | ✅ | ✅ | Voxtral is HTTP. Mic capture via Qt Multimedia (WASAPI) wherever `pw-record` doesn't exist — chat dictation, hands-free voice mode, and the clip recorder all fall back to it. |
| Video understanding (YouTube URL / local file → frames + whisper transcript) | ✅ | ✅ needs ffmpeg | Pipeline is pure Python (`computer_use_mcp/video`): yt-dlp + faster-whisper freeze into `jarvis-engine.exe`; only **ffmpeg** stays external — `winget install Gyan.FFmpeg`, then restart Cindro so the updated PATH is seen. Whisper models auto-download from Hugging Face on first use. |
| Generative widgets / canvas / pager / Home pins / live widgets | ✅ | ✅ | Daemon/engine-driven; QML renderer reused. |
| Agents / subagents, scheduler, memory, skills, hooks, modes, permissions | ✅ | ✅ | Core is cross-platform. |
| Plugins (signed Ed25519, install) | ✅ | ✅ render/install; ⚠ sandbox | The Linux `systemd-run` sandbox has no Win32 equal → Windows uses a Job-Object/restricted-token sandbox (or runs with explicit consent). |
| Phone subsystem (Node server, calls/SMS, screening) | ✅ | ✅ server + UI | Node runs on Windows. PSTN/SIM-SMS still ride Twilio + the paired Android SIM. |
| Outpost (pair/exec/screenshot remote machines) | ✅ systemd | ✅ | `outpost-mcp` frozen with PyInstaller (`windows/outpost/`), launched by `jarvis-launch.vbs`/`jarvis-start.cmd` (no systemd on Windows to auto-start it) — see `docs/OUTPOST.md`. |
| 2FA / biometric cross-device unlock + local PIN | ✅ | ✅ | Desktop side portable; the biometric approver stays the phone. |
| Chrome extension (side-panel + in-page agent) | ✅ | ✅ | Loads in Chrome/Edge on Windows unchanged. |
| First-launch setup wizard (name, voice, key) | ✅ | ✅ | Shared flow; see the installer. |

**Honest limits (no Win32 equivalent):** the nested headless-compositor "agent desktop",
the KWin multi-seat cursor, and the Wayland layer-shell dock. These are Linux-only; on
Windows the agent drives your **real screen** with a visible glowing cursor + banner +
consent, mirroring the Linux *take-over* UX.

## Computer use on Windows — how it's built

The Linux engine funnels every input/screen tool through one coordinate layer
(`screen.map_to_desktop()` + `move/click/drag/scroll/key_press/type_text/take_screenshot`).
Windows swaps only the **backend** beneath those tools (`computer_use_mcp/backend_windows.py`,
selected by `platform.system()`); the model-facing MCP tool schema is **byte-identical**.

| Primitive | Linux | Windows |
|---|---|---|
| Mouse move/click/drag | evdev uinput / KWin seat / sway-IPC | Win32 `SendInput` absolute (0–65535 over the virtual desktop) |
| Scroll | evdev / wlr axis | `SendInput` `MOUSEEVENTF_WHEEL` (`WHEEL_DELTA=120`) |
| Keyboard / type | ydotool / vkbd | `SendInput`; `KEYEVENTF_UNICODE` for full-Unicode typing |
| Screenshot | grim / spectacle | `mss` (DXGI) + PIL downscale/crop (reused) |
| Windows/apps | sway-IPC / KWin DBus | `EnumWindows`/`SetForegroundWindow`/`ShowWindow`, `os.startfile` |

## Install (end users) — assumes a BARE machine, bundles everything

**You need nothing pre-installed** — no Python, no Node.js, no Qt, no Visual C++ runtime.
`Cindro-Setup.exe` ships them all (the Qt runtime + MSVC runtime via `windeployqt
--compiler-runtime`, the computer-use engine frozen with PyInstaller incl. its own Python, and
a portable Node runtime under `node\`). Just:

1. Download **`Cindro-Setup-x.y.z.exe`** from the Releases page.
2. Run it. (Unsigned for now → Windows SmartScreen shows "More info → Run anyway"; a signing
   cert is a future item.) It installs to `%ProgramFiles%\Jarvis`, adds a Start-menu entry,
   and offers autostart.
3. Launch **Cindro** from the Start menu. The first-launch **setup wizard** asks your
   assistant's name, a voice, and (if you have no Codex/Claude CLI) a Mistral API key.

Config lives in `%APPDATA%\Jarvis`. See [`MISTRAL_SETUP.md`](MISTRAL_SETUP.md).

### Linux equivalent (bare machine)

`packaging/bootstrap-install.sh` is the Linux counterpart: on a machine with nothing, it
detects the package manager (dnf/apt/pacman/zypper), installs every dependency (Qt6,
LayerShellQt, libsodium, libqrencode, Python, Node, and the computer-use runtime tools
grim/spectacle/ydotool/wl-clipboard), sets up the engine venv + phone server, builds, and
installs — then `systemctl --user start jarvisd` + launch `cindro-sidebar`.

### How the whole stack starts (Windows has no systemd)

On Linux the computer-use engine and phone server run as **systemd user services**. Windows has
none, so a single launcher — **`jarvis-start.cmd`** (what the Start-menu shortcut + autostart
point at) — brings up everything so **every feature works**: (1) the **computer-use engine**
(`jarvis-engine.exe`) on `127.0.0.1:8794` serving **all** MCP tools, (2) the **phone server**
(bundled Node) on `:8801` if you've configured it, (3) **`jarvisd.exe`** (sessions, skills,
schedules, subagents, hooks, memory, voice, plugins, connectors, the phone proxy, and the
device/pairing channel), and (4) **`cindro-sidebar.exe`** (the UI). The engine self-creates
`%USERPROFILE%\.computer-use\config.yaml` (random bearer) on first run and `jarvisd` reads the
same file, so they agree with no setup. *(Known v1 limitation: the per-session **nested** agent
desktop is Linux-only, so on Windows computer-use drives the real screen; and the daemon's
`systemctl`-based phone-restart on a voice-default change no-ops on Windows.)*

### CLI brains (claude / codex) on Windows

- **MCP tools:** since the nested agent desktop can't come up on Windows v1,
  `jarvisd` injects the **global** `:8794` engine's MCP config into claude, codex, and
  api sessions whenever "Let Cindro use a computer" is on (the v1 real-screen contract).
  Claude gets `--mcp-config` + `bypassPermissions` (headless `claude -p` otherwise stalls
  on MCP permission prompts); codex gets `-c mcp_servers.*` overrides.
- **Skills:** Cindro mirrors its skills into `%USERPROFILE%\.claude\skills` and
  `%USERPROFILE%\.codex\skills` at daemon start (and at skill creation). If you install
  Claude Code / Codex **after** Cindro, restart Cindro once and the mirrors (e.g.
  `/internal_docs`) appear.
- **Codex auth:** the per-session isolated `CODEX_HOME` mirrors `~/.codex/auth.json` via a
  hard link (or copy) — never `QFile::link`, which on Windows plants a binary `.lnk`
  payload that kills codex with `stream did not contain valid UTF-8`.

## Build from source (Windows)

Prereqs: **Visual Studio 2022** (or MinGW-w64), **CMake 3.24+**, **vcpkg** (for
libsodium/libqrencode), **Qt 6.5+** (MSVC), **Python 3.12**, **Node 18+**.

```powershell
# from the repo root
cmake -S . -B build-win -G "Ninja" `
  -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake `
  -DWINDOWS_BUILD=ON            # gates off LayerShellQt + stubs AgentDesktop's nested-Sway
cmake --build build-win --config Release
# bundle engine + node + make the installer:
windows\scripts\build.ps1       # -> windows\dist\Cindro-Setup-x.y.z.exe (Inno Setup)
```

The Windows seams are additive and guarded (`#ifdef Q_OS_WINDOWS` in C++,
`platform.system()` in Python); the Linux build is unaffected. See
[`../windows/README.md`](../windows/README.md).
