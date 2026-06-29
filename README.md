<div align="center">

# 🤖 Jarvis

### One AI co-worker for your **Linux desktop**, **Android phone**, and **Chrome** — that actually *uses* your computer.

Drives mouse / keyboard / screen · works on its own virtual desktop *beside* you · takes over your real screen on request · voice · generative live widgets · cross-device biometric unlock.

[![Stars](https://img.shields.io/github/stars/CrazyMan28/jarvis?style=for-the-badge&logo=github&color=3DD6FF&labelColor=0A0E16)](https://github.com/CrazyMan28/jarvis/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-39E6A0?style=for-the-badge&labelColor=0A0E16)](LICENSE)
[![Platforms](https://img.shields.io/badge/Linux_·_Android_·_Chrome-5B8CFF?style=for-the-badge&labelColor=0A0E16)](#)
[![Last commit](https://img.shields.io/github/last-commit/CrazyMan28/jarvis?style=for-the-badge&color=B28BFF&labelColor=0A0E16)](https://github.com/CrazyMan28/jarvis/commits)

[Demo](#-demo) · [Why it exists](#-why-jarvis-exists) · [Features](#-what-it-does) · [Architecture](#-architecture) · [Build & run](#-build--run) · [Docs](#-docs) · [Roadmap & limits](#-known-limitations--roadmap)

</div>

---

## 🎬 Demo

<div align="center">

<!-- To embed: drag-and-drop a screen recording onto this section in the GitHub web editor
     (GitHub hosts it and renders an inline <video>), or commit it to docs/media/ and link it. -->

[![▶ Watch Jarvis drive a computer, talk, and draw live widgets](https://img.shields.io/badge/▶%20Watch%20the%20demo-3DD6FF?style=for-the-badge&labelColor=0A0E16)](docs/media/jarvis-demo.mp4)

*A 60-second tour: ask Jarvis to open Chrome on its own desktop → watch it live in chat →
pin a live widget to your home screen → unlock the desktop from your phone's fingerprint.*

</div>

---

## 💡 Why Jarvis exists

I daily-drive **Linux** (Sway + KDE Plasma 6), and the polished "AI that uses your computer" products simply don't meet me there:

- **OpenAI's Codex / ChatGPT desktop** computer-use and **Anthropic's Claude** computer-use / "co-work" desktop apps are **macOS- and Windows-first — there's no real Linux story.**
- The excellent agentic **CLIs** (`codex`, `claude`) are headless brains: superb reasoning, but no *body* on a Linux desktop — no GUI, no phone, no voice, no live screen-share, no shared memory across your devices.

So Jarvis is the missing body. **One local daemon** gives those brains (and a direct API brain) **hands**:

- a **pixel-accurate computer-use engine** that works on **KDE *and* Sway**,
- a **nested "agent desktop"** so it can work *beside* you without hijacking your screen — or **take over your real screen** with a distinct glowing cursor when you ask,
- and **one coherent world** — sessions, memory, skills, widgets, scheduling — reachable from a **desktop sidebar**, an **Android app**, and a **Chrome extension**.

Local-first. Your keys, your machine, your data. One brain, many hands: a **coder** when you need one, a **co-worker** the rest of the time.

---

## ✨ What it does

| Area | Capability |
|---|---|
| **Brains** | `CodexBrain` (`codex exec`), `ClaudeBrain` (`claude -p`), `ApiBrain` (direct OpenAI / Anthropic / Mistral / Ollama, **with vision** — attached photos reach the model). Per-session model + brain picker. |
| **Desktop UX** | A **Home dashboard** (greeting, active-agent card, quick actions, recent sessions, a **live CPU/RAM/GPU mini-dashboard** from real `/proc` + `nvidia-smi`), a **⌘K command palette** (jump to any page/session), a Claude-Code-style **"/" command palette** in the composer (commands + agents + skills), and a unified **right-side panel** (the model's PLAN on top of an in-chat agent peek that mirrors the nested desktop live). Premium arc-reactor HUD theme. |
| **Agents (subagents)** | Define **custom agents** (name · what it does · *when to call it* · brain/model/profile · system prompt); Jarvis dispatches tasks to them via MCP tools (`agent_start`/`agent_list`/`agent_stop`), each running as a **child session** that reports back (shown in the sub-agent tree). Manage them on desktop, phone, and via `/` in chat. → [`docs/AGENTS_AND_COMMANDS.md`](docs/AGENTS_AND_COMMANDS.md) |
| **Computer use** | Pixel-accurate mouse/keyboard/screen on **KDE and Sway** via the Python engine. Runs on a **nested headless agent desktop** by default (watchable live in chat *and* on the phone), or **takes over your real screen** on request — approval-gated, distinct blue cursor + "Jarvis is driving" banner. The model can `desktop_reset` its own desktop. → [`docs/COMPUTER_USE.md`](docs/COMPUTER_USE.md) |
| **Chrome** | MV3 extension with a full Jarvis side-panel that sees your tabs and acts in-page (Chrome-only mode, blue cursor + "controlling Chrome" banner). |
| **Voice** | Hands-free voice mode (just talk — energy-VAD auto-sends, no hold-to-talk), STT/TTS via Mistral Voxtral with **pluggable local providers** (whisper.cpp / piper), animated arc-reactor orb. → [`docs/VOICE.md`](docs/VOICE.md) |
| **Generative renderer** | The model calls `render_widget` to draw **custom UI** from a safe JSON DSL — containers, text, charts, SVG/canvas art, buttons, animation, and **multi-page `pager`** widgets (tap-to-advance quizzes with right/wrong feedback, **no model round-trip**). **Live** canvases auto-refresh (`widget_live`); pin any to the **desktop Home** (`home_pin`, drag to reorder) or to a **real Android home-screen widget** (sizes to its content). Renders on desktop **and** phone. → [`docs/WIDGETS_CANVAS.md`](docs/WIDGETS_CANVAS.md) |
| **Plan & permissions** | The model keeps a live **plan/checklist** (`todo_write` + granular add/edit/done/del) in an animated side panel. A **permission level** (cautious / balanced / autonomous) auto-ranks tools and makes Jarvis `ask_user` before risky actions. |
| **Mobile** | Kotlin/Compose app: pair via QR, chat + **photos to the model**, sessions, queue, **live agent-desktop video** (watch + drive remotely), file receive, push, real home-screen widgets, interactive `pager` quizzes. Background WebSocket service delivers notifications **without Firebase**. Bundles the **entire Agent Phone app, vendored verbatim** (Calls/Inbox/Agents/HUD/Settings) in the one APK — see **Phone** below. |
| **Phone** | Jarvis can **call and text you on your real phone** — and **answers when you call or text** its number (Jarvis is extension 101; it wakes **headlessly** — voice on a call, a reply on a text — and can call/text you back mid-conversation). In-app + real PSTN calls, **free SMS off your phone's own SIM**, an inbox, AI call screening, a war room, voice profiles — **~56 tools**. A native subsystem in the one repo; the full app ships on Android, desktop, and Chrome. → [`docs/PHONE.md`](docs/PHONE.md) |
| **Security** | 2FA + biometric **cross-device unlock** (open desktop → approve on phone with fingerprint), plus a **local PIN fallback** when the phone can't approve. SSH allow-list, prompt-injection gating, strict per-brain **MCP isolation**. |
| **Productivity** | Scheduler (cron + natural language) → [`docs/SCHEDULES.md`](docs/SCHEDULES.md), memories + skills + a "today" digest → [`docs/HERMES_FEATURES.md`](docs/HERMES_FEATURES.md), custom MCP servers, a plugin registry, and a Google connectors framework → [`docs/JARVIS_GOOGLE_CONNECTORS.md`](docs/JARVIS_GOOGLE_CONNECTORS.md). |

> 📍 **Where it actually is** (done vs. partial vs. next) lives in [`docs/STATUS.md`](docs/STATUS.md) — the honest single source of truth.

---

## 🏗 Architecture

```mermaid
flowchart TD
    subgraph Desktop["🖥️  Linux desktop"]
        SB["jarvis-sidebar<br/>(Qt6/QML + LayerShellQt)"]
        KDE["KDE plasmoid"]
    end
    subgraph Phone["📱  Android"]
        APP["Jarvis app<br/>(Kotlin/Compose)"]
    end
    subgraph Chrome["🌐  Chrome"]
        EXT["MV3 extension<br/>(side-panel + in-page agent)"]
    end

    DJ["**jarvisd** (daemon)<br/>sessions · scheduler · memories ·<br/>skills · pairing · MCP server"]

    subgraph Brains["🧠  Brains (pluggable)"]
        CX["CodexBrain<br/>codex exec --json"]
        CL["ClaudeBrain<br/>claude -p stream-json"]
        API["ApiBrain<br/>OpenAI/Anthropic/Mistral/Ollama"]
    end

    ENG["**computer-use engine**<br/>(Python / FastMCP)<br/>mouse·kbd·screen·Chrome·render_widget"]

    SB    <-->|"Contract A · control WS :8795 (loopback+token)"| DJ
    KDE   --> SB
    APP   <-->|"Contract A · device WS :8796 (tailnet, ed25519 pairing)"| DJ
    EXT   <-->|"engine bridge WS :8794 + control WS"| DJ
    DJ    --> CX & CL & API
    CX & CL & API -->|"MCP (bearer)"| ENG
    EXT   -->|"CDP / in-page actions"| ENG
```

**Contract A** is the wire protocol on every channel: a JSON request `{v,id,method,params}`,
a reply `{v,id,ok,result|error}`, and server-pushed events
`{v,event:"session.event",data:{session_id,ev:<NormalizedBrainEvent>}}`. Brain output (codex /
claude JSONL) is parsed into one **normalized event stream** (`thinking`, `message`,
`tool_call`, `tool_result`, `diff`, `approval`, `final`, `error`, `driving_state`). Full spec: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

| Port | Channel | Bind | Auth |
|---|---|---|---|
| `8795` | control WS (desktop ↔ daemon) | loopback | shared token (`~/.config/jarvis/control_token`) |
| `8796` | device WS (phone ↔ daemon) | tailnet | ed25519 pairing handshake |
| `8794` | computer-use engine (MCP) | loopback | bearer token (per-session engines on `8810+`) |

---

## 📦 Repository layout

```
core/         C++/Qt6 shared lib — session model, Brain abstraction, MCP registry,
              scheduler, memories, skills, SSH allow-list, settings, FCM sender, voice
daemon/       jarvisd — headless service: ControlServer (:8795) + DeviceServer (:8796),
              pairing, session orchestration, Jarvis-MCP server, auth challenges
desktop/      jarvis-sidebar — QML/Quick + LayerShellQt UI (Home dashboard, chat + in-chat
              agent peek, voice, canvas, widgets, sessions, memory, skills, schedules,
              activity, MCP, plugins, ssh, settings) + ⌘K command palette
computer-use/ Python FastMCP engine (mouse/kbd/screen, Chrome bridge, render_widget,
              nested agent desktop, per-session input routing, agent pointer bus)
extension/    Chrome MV3 "Computer Use Bridge" + Jarvis side-panel
android/      Kotlin/Compose app (MVVM, Room, DataStore, foreground WS service)
kde-applet/   Plasma 6 applet to toggle the sidebar
plugins/      Plugin SDK + signed-package format + registry
packaging/    systemd user units, Sway keybind, install scripts
docs/         Architecture, build spec, feature specs (see docs/ARCHITECTURE.md)
scripts/      Live verification scripts (WS round-trips, voice, auth gate, etc.)
```

---

## 🚀 Build & run

**Desktop (C++/Qt6 + Python engine)**
```bash
cmake -S . -B build -G Ninja          # configure once
cmake --build build                   # builds jarvisd + jarvis-sidebar
ctest --test-dir build                # C++ unit + GUI smoke tests
# engine deps:
cd computer-use && python -m venv .venv && .venv/bin/pip install -e . && cd -
env -u PYTHONPATH computer-use/.venv/bin/python -m pytest computer-use/tests -q
```
The one-shot installer copies the binaries to `~/.local/bin`, installs the desktop entry +
systemd user units, and the Sway keybind:
```bash
./packaging/install.sh                # build + install jarvisd, jarvis-sidebar, units
```
Then `systemctl --user start jarvisd` and launch **jarvis-sidebar** (`--voice` boots straight
into voice mode; `$mod+j` toggles it under Sway).

**Android**
```bash
cd android && ./gradlew :app:assembleDebug
```

**Chrome extension** — load `extension/` unpacked at `chrome://extensions` (Developer mode).

> ⚠️ Always run Python/builds with `env -u PYTHONPATH` (a user site-packages `PYTHONPATH` leak
> breaks the engine venv). Never broad-kill `foot` / `sway` / `kwin`; stop processes by PID/unit.

---

## 🧭 Known limitations & roadmap

Honest about the rough edges (full status in [`docs/STATUS.md`](docs/STATUS.md)):

- **Battery: auto-killing an unused nested desktop is not done yet — on purpose.** When you're
  not watching a session, the *expensive* parts are already paused (live-widget loops and the
  video mirror are viewer-gated), so an idle, unwatched agent desktop sits near 0% CPU. Fully
  **tearing it down** to "save battery" would look like a win but would silently **break the
  agent's computer link**: the brain (codex/claude) has its computer-use engine's address +
  token *baked in at spawn*, so a torn-down desktop comes back on a new port/token the brain
  can't reach. The correct fix is **lazy-provisioning the engine at a stable, deterministic
  per-session port** so it can be stopped and restarted transparently — a real refactor, tracked
  rather than rushed.
- **Phone-approved unlock can occasionally hang** (root cause needs a live repro). Mitigated:
  a **local PIN** shows on the lock screen *while it's still waiting on the phone*, so you never
  have to relaunch.
- **Android widget sizing is best-effort.** An app can only *request* a home-screen tile size;
  most launchers honor the content-height hint, a few keep your manual drag size.
- This is a **single-developer, actively-built** project (Sway + KDE Plasma 6, Android, Chrome).
  Packaging beyond `packaging/install.sh` is minimal.

---

## 📚 Docs

- [`docs/STATUS.md`](docs/STATUS.md) — **where the project actually is** (done vs partial vs next)
- [`docs/PHONE.md`](docs/PHONE.md) — **native phone** subsystem: the full agent-phone UI on desktop (QML), Android (Compose v0.10.6+), and Chrome (MV3) — Calls (real dialpad + ext chips), Inbox (text-an-agent), per-agent voice/model config, call screening, Bluetooth relay, SMS agent, setup wizard. Jarvis = ext 101. Two daemon proxies: `phone.mcp` (MCP tools) + `phone.http` (REST API, bearer in daemon). Feature inventory: [`docs/AGENT_PHONE_FEATURE_MAP.md`](docs/AGENT_PHONE_FEATURE_MAP.md)
- [`docs/BACKGROUND_JOBS.md`](docs/BACKGROUND_JOBS.md) — background jobs, `monitor`, sleep/wake (auto session-wake)
- [`docs/HOOKS.md`](docs/HOOKS.md) — Claude-Code-style lifecycle hooks · [`docs/MODES.md`](docs/MODES.md) — plan/build/co-worker modes
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design + Contract A/B/C protocols
- [`docs/COMPUTER_USE.md`](docs/COMPUTER_USE.md) — the computer-use engine + nested agent desktop
- [`docs/AGENTS_AND_COMMANDS.md`](docs/AGENTS_AND_COMMANDS.md) — the "/" command palette + custom agents (subagents)
- [`docs/WIDGETS_CANVAS.md`](docs/WIDGETS_CANVAS.md) — canvases, widgets, `pager`, Home pins, home-screen widgets
- [`docs/JARVIS_VOICE_AND_RENDERER.md`](docs/JARVIS_VOICE_AND_RENDERER.md) / [`docs/VOICE.md`](docs/VOICE.md) — voice + generative renderer
- [`docs/SCHEDULES.md`](docs/SCHEDULES.md) · [`docs/HERMES_FEATURES.md`](docs/HERMES_FEATURES.md) · [`docs/JARVIS_GOOGLE_CONNECTORS.md`](docs/JARVIS_GOOGLE_CONNECTORS.md) · [`docs/TAKEOVER_UX.md`](docs/TAKEOVER_UX.md) · [`docs/KWIN_MULTISEAT_FORK.md`](docs/KWIN_MULTISEAT_FORK.md)
- [`AGENTS.md`](AGENTS.md) — **read this first if you're an AI working on the repo**

---

## 📄 License

[MIT](LICENSE) © 2026 kihi2024.

<div align="center">
<sub>Built because the Linux desktop deserves a real AI co-worker too. ⭐ it if you agree.</sub>
</div>
