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
| **Windows-only computer-use extras** (smooth held drags, modifier/triple clicks, hover, fine scroll, paced typing, spreadsheet paste/read, UI Automation, desktop Office COM) | — | ✅ | `windows/engine/tools_windows.py` — see "Windows-only tools" below. Built for Excel for the web in Chrome as much as desktop apps. |
| Nested "beside-you" agent desktop | ✅ headless Sway | ⚠ v2, opt-in | Windows Sandbox tier — validated end-to-end on real hardware 2026-07-13, but still gated behind `JARVIS_ENABLE_V2=1` pending wider-machine validation before it's the default. See `windows/isolation/DESIGN.md`. |
| Multi-seat isolated agent cursor | ✅ forked KWin | ❌ | No compositor to fork; the v2 Sandbox tier isolates via an OS-level VM boundary instead (see above), not a second cursor on your live desktop. Without v2 opted in, the agent shares your input queue (gated by the take-over banner + consent). |
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
| **Terminal UI** (`cindro-tui.exe`) — the full-screen terminal agent | ✅ | ✅ | The TS/OpenTUI TUI v2, cross-compiled to `cindro-tui.exe` and shipped inside the **same** installer. Start-menu **"Cindro Terminal (TUI)"**, or run `cindro-tui` from any terminal (it's on PATH). |
| **Web dashboard** — every GUI page in the browser | ✅ | ✅ | The SolidJS console (`web/`) built to static files and served by a **bundled portable `bun` runtime** on `http://127.0.0.1:8788`. Start-menu **"Cindro Web Dashboard"**, or run `cindro-web` (on PATH). Talks straight to the loopback control WS — nothing to install. |

**Honest limits (no Win32 equivalent):** the KWin multi-seat cursor and the Wayland
layer-shell dock are Linux-only outright. The nested agent desktop now *does* have a
Windows equivalent — the Windows Sandbox v2 tier (`windows/isolation/DESIGN.md`), opt-in
via `JARVIS_ENABLE_V2=1` — but it's not yet the default while it accumulates validation
across more real machines. Without opting in, or on a Home/no-virtualization box where v2
can't run, the agent drives your **real screen** with a visible glowing cursor + banner +
consent, mirroring the Linux *take-over* UX.

## Computer use on Windows — how it's built

The Linux engine funnels every input/screen tool through one coordinate layer
(`screen.map_to_desktop()` + `move/click/drag/scroll/key_press/type_text/take_screenshot`).
Windows swaps only the **backend** beneath those tools (`computer_use_mcp/backend_windows.py`,
selected by `platform.system()`); every tool the Linux engine has keeps the **same schema**
on Windows. Windows additionally registers its own extra tools (below), so the Windows tool
list is a **superset** of Linux's.

| Primitive | Linux | Windows |
|---|---|---|
| Mouse move/click/drag | evdev uinput / KWin seat / sway-IPC | Win32 `SendInput` absolute (0–65535 over the virtual desktop) |
| Scroll | evdev / wlr axis | `SendInput` `MOUSEEVENTF_WHEEL` (`WHEEL_DELTA=120`) |
| Keyboard / type | ydotool / vkbd | `SendInput`; `KEYEVENTF_UNICODE` for full-Unicode typing |
| Screenshot | grim / spectacle | `mss` (DXGI) + PIL downscale/crop (reused) |
| Windows/apps | sway-IPC / KWin DBus | `EnumWindows`/`SetForegroundWindow`/`ShowWindow`, `os.startfile` |
| Clipboard | wl-copy / wl-paste | `win32clipboard` (`CF_UNICODETEXT`, plus TSV/`HTML Format` tables) |
| Workspaces | sway / KWin virtual desktops | Windows virtual desktops (registry + `ctrl+win+←/→/d`); rename unsupported |

### Windows-only tools

Registered by `windows/engine/tools_windows.py` on the engine's own FastMCP instance (same
trust/plan-mode gate as every engine tool). Nothing under `computer-use/` changes.

| Group | Tools | What for |
|---|---|---|
| Human-style input | `mouse_drag_smooth`, `mouse_click_ex`, `mouse_down`/`mouse_up`, `key_down`/`key_up`, `input_release_all`, `mouse_hover`, `mouse_position`, `scroll_smooth`, `type_text_paced`, `wait_for_screen_change`, `wait_for_screen_idle` | Real hold→glide→release drags (fill handle, range select, column resize, drag-and-drop), shift/ctrl-click, triple-click, long-press, tooltips, sub-notch scrolling, typing web editors don't drop, waiting for loads. Held keys/buttons auto-release after 15s. |
| Spreadsheets | `sheet_paste_table`, `sheet_read_selection`, `sheet_goto`, `clipboard_set_table`, `clipboard_get_table`, `clipboard_formats` | Fill or read a whole range in one action through the clipboard (TSV) — works in Excel for the web, Google Sheets and desktop Excel. |
| UI Automation | `ui_tree`, `ui_find`, `ui_focused`, `ui_element_at`, `ui_click`, `ui_set_value`, `ui_toggle`, `ui_expand`, `ui_select` | Read and drive native controls by name with exact rects (dialogs, Settings, Explorer, desktop Office). For web page content prefer the extension's `browser_*` tools. |
| Desktop Office (COM) | `office_status`, `office_open`, `excel_read_range`, `excel_write_range`, `excel_run`, `word_read`, `word_insert`, `word_find_replace`, `word_save_as`, `ppt_list_slides`, `ppt_add_slide`, `ppt_set_text`, `ppt_export` | Only when desktop Office is installed; clean "not installed" error otherwise. |

`desktop_calibrate` and `desktop_reset` are replaced with Windows versions. The calibration
reads back `GetCursorPos`, and `desktop_reset` refuses to run on the real screen, because there
it would close the user's own windows.

## Install (end users) — assumes a BARE machine, bundles everything

**You need nothing pre-installed** — no Python, no Node.js, no Qt, no Visual C++ runtime,
no bun. **One** `Cindro-Setup.exe` (the single artifact the release Action attaches) ships
them all: the Qt runtime + MSVC runtime via `windeployqt --compiler-runtime`, the
computer-use engine frozen with PyInstaller (incl. its own Python), a portable Node runtime
under `node\`, the **terminal UI** (`cindro-tui.exe`), and the **web dashboard** (`web\`)
with a portable **bun** runtime under `bun\` to serve it. Just:

1. Download **`Cindro-Setup-x.y.z.exe`** from the Releases page.
2. Run it. (Unsigned for now → Windows SmartScreen shows "More info → Run anyway"; a signing
   cert is a future item.) It installs to `%ProgramFiles%\Jarvis`, adds Start-menu entries,
   adds the install dir to your PATH, and offers autostart.
3. Launch **Cindro** from the Start menu. The first-launch **setup wizard** asks your
   assistant's name, a voice, and (if you have no Codex/Claude CLI) a Mistral API key.

### The three front-ends, all in the one installer

The installer creates three Start-menu entries — the desktop **GUI** (default), **Cindro
Terminal (TUI)**, and **Cindro Web Dashboard** — and puts the install dir on your PATH, so
from any terminal (cmd, PowerShell, git-bash, WSL) you can also run:

- `cindro-tui` — the full-screen terminal agent (`cindro-tui.exe`).
- `cindro-web` — build-free launcher that serves the dashboard on
  `http://127.0.0.1:8788` via the bundled bun and opens your browser (close the window to
  stop it; override the port with `%JARVIS_WEB_PORT%`). It prints the control token to paste
  into the dashboard's Setup screen — or pair with a code from the desktop app's *Settings →
  Browser Extension*.

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
libsodium/libqrencode), **Qt 6.5+** (MSVC), **Python 3.12**, **Node 18+**, and **bun**
(builds `cindro-tui.exe` + the web dashboard). If bun is missing, `build.ps1` self-heals it
(downloads the portable `bun-windows-x64.zip`), the same way it self-heals Qt and Go — so a
runner without bun still produces the full installer rather than dropping the TUI/web.

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
