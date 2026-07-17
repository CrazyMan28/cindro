# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [`AGENTS.md`](AGENTS.md) first — it's the primary, actively-maintained reference** for this
repo's vision, architecture, and the hard-won gotchas that aren't obvious from the code (dated
"New subsystems" sections track what's changed recently). This file is a quick-start companion to
it: commonly-used commands plus a condensed map of the codebase, so you don't have to read five
files before making your first edit. Pair both with [`README.md`](README.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Contract A/B/C protocol details).

## Repository layout

This is a monorepo for **Cindro**, an AI co-worker with a desktop app, Android app, Chrome
extension, terminal client, and web dashboard, all driven by one daemon:

| Dir | Language/stack | What it is |
|---|---|---|
| `core/` | C++/Qt6 | Shared business logic: `Brain` abstraction (`CodexBrain`/`ClaudeBrain`/`ApiBrain`), `SessionStore`, `Scheduler`, `MemoryStore`, `McpRegistry`, `SkillStore`, `SettingsStore`, etc. Tested by `core/tests/*` (ctest). |
| `daemon/` | C++/Qt6 | `jarvisd`: `ControlServer` (:8795 loopback, desktop) + `DeviceServer` (:8796 tailnet, phone). Both speak Contract A. |
| `desktop/` | C++/QML | `cindro-sidebar` — the desktop app. `Bridge` is the QML↔daemon client. |
| `android/` | Kotlin/Compose | MVVM, Gradle build. |
| `iphone_app/` | Swift/SwiftUI | The iOS app — a 1:1 port of `android/` over the same Contract C device WebSocket. XcodeGen (`project.yml`), no committed `.xcodeproj`. See `iphone_app/README.md`. |
| `extension/` | JS (MV3) | Chrome extension: `sw.js` (engine bridge), `content.js`, `sidepanel.*`. |
| `computer-use/` | Python (uv) | The FastMCP engine that actually drives the screen/browser — `computer_use_mcp/` package, tools registered in `server.py`. |
| `cli/` | Python (uv) | `cindro` terminal client — a Textual TUI (`jarvis_cli/tui/`) plus `doctor`/`status`/`service` commands, over the daemon's Contract A control WebSocket. |
| `outpost-mcp/` | Python (uv) + Go | Pairs remote machines; `outpost-agent` (Go) runs on the paired machine, `outpost-mcp` (Python) is the relay/pairing server. |
| `proxmox-mcp/` | Python (uv) | Tool server for the always-on Proxmox workload-manager agent (see `docs/PROXMOX_WORKLOAD_MANAGER.md`). |
| `web/` | TypeScript/SolidJS (Bun) | Browser dashboard mirroring the desktop's page set, talking straight to the daemon's control WebSocket. |
| `windows/` | — | The Windows edition. Changes here must NEVER touch `core/`/`daemon/`/`desktop/`/`computer-use/` (see `AGENTS.md`). |
| `packaging/` | — | systemd units, `install.sh` (local, no-sudo install/rebuild), release packaging. |
| `website/` | PHP (Laravel 13) | Marketing/billing site — Breeze auth, Cashier/Stripe, Filament admin, `/api/license/verify`. Self-contained, no CMake integration. See `website/README.md`. |

**A feature usually spans 3+ of these** (e.g. daemon RPC → desktop QML → CLI/TUI → web). Wire the
daemon/core first, then the surfaces, keeping the protocol identical across them.

## Commands

### C++ (core/daemon/desktop) — CMake + Ninja superbuild
```bash
cmake -S . -B build -G Ninja      # configure (once, or after adding new source files/targets)
cmake --build build               # build everything
ninja -C build <target>           # build one target, e.g. jarvisd, cindro-sidebar, api_brain_tools_test
ctest --test-dir build            # run all C++ tests
ctest --test-dir build -R <name>  # run one test by name (regex)
build/core/<test_binary>          # or just run a test binary directly for full output
```
Local install (no sudo — rebuilds and installs into `~/.local`/`~/.config`, idempotent):
```bash
packaging/install.sh
systemctl --user restart jarvisd  # after install.sh, if jarvisd is already running, to pick up the new build
```

### Python packages (`computer-use/`, `cli/`, `outpost-mcp/`, `proxmox-mcp/`) — uv-managed venvs
Each has its own `.venv`. **The host exports a Python 3.14 `PYTHONPATH` that breaks these 3.12 venvs
— always run with `env -u PYTHONPATH`** (this is why `packaging/*.service` units set
`Environment=PYTHONPATH=`):
```bash
cd <package-dir>
env -u PYTHONPATH .venv/bin/python3 -m pytest tests/ -q      # all tests
env -u PYTHONPATH .venv/bin/python3 -m pytest tests/test_foo.py::test_name  # one test
env -u PYTHONPATH .venv/bin/uv run <entry-point>              # e.g. outpost-mcp, proxmox-mcp
```

### Web (`web/`) — Bun + Vite + SolidJS
```bash
cd web
bun run dev         # dev server
bun run build        # production build (vite build)
bun run typecheck    # bunx tsc --noEmit
```

### Android (`android/`)
```bash
cd android
./gradlew assembleDebug
```
Bump `versionCode`/`versionName` on every shippable change, then build + push to the phone.

### Website (`website/`) — Laravel + Breeze + Cashier + Filament
```bash
cd website
composer install
npm install
php artisan migrate:fresh --seed   # local sqlite, seeds a demo admin + one user per tier
php artisan serve                  # + `npm run dev` for the Vite dev server
php artisan test                   # in-memory sqlite, no setup needed
```

## Verification philosophy

Don't just self-report a fix worked — there are live smoke scripts in `scripts/` (e.g.
`session_opened_ws.py`, `voice_roundtrip_test.py`, `auth_gate_check.py`) that exercise a running
`jarvisd` over the real WebSocket protocol. For QML changes, an offscreen smoke load catches
binding/type errors without a display:
```bash
QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 build/desktop/cindro-sidebar --demo
```

## Git

Three long-lived branches, `main` protected (PR-only): work on `dev` → push → test → promote
`dev → qa` → test → PR `qa → main` → user merges. Never push directly to `main`, never merge your
own PR into it — see `AGENTS.md`'s "Branches & flow" / "GitHub / CI / releases" sections for the
full detail (self-hosted CI runners, auto-release-on-merge-to-main, etc).
