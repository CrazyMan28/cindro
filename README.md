# Jarvis — a unified AI co-worker

Jarvis is a single AI co-worker that lives in a polished sidebar on your Linux desktop,
can **drive your computer** (mouse / keyboard / screen + Chrome), works **beside you on its
own virtual desktop** or **takes over your real screen** with a distinct glowing cursor, and
is fully controllable from a companion **Android app** and a **Chrome extension** — chat,
photos, voice, live session view, scheduling, memories, skills, and push.

One brain, many hands: it can be a **coder** when you need one and a **co-worker** otherwise.

> Status: actively built, single-developer project. Desktop (Sway + KDE Plasma 6), Android,
> and the Chrome extension all run today against the local daemon.

---

## What it does

| Area | Capability |
|---|---|
| **Brains** | `CodexBrain` (`codex exec`), `ClaudeBrain` (`claude -p`), `ApiBrain` (direct OpenAI/Anthropic/Ollama). Per-session model + brain picker. |
| **Computer use** | Pixel-accurate mouse/keyboard/screen on KDE **and** Sway via the Python engine. Runs on a **nested headless agent desktop** by default, or **takes over your real screen** on request (approval-gated, distinct blue cursor + "Jarvis is driving" banner). |
| **Chrome** | MV3 extension with a full Jarvis side-panel that sees your tabs and acts in-page (Chrome-only mode, blue cursor + "controlling Chrome" banner). |
| **Voice** | Hands-free voice mode (just talk — energy VAD auto-sends, no hold-to-talk), STT/TTS via Mistral Voxtral with **pluggable local providers** (whisper.cpp / piper), animated arc-reactor orb. |
| **Generative renderer** | The model calls `render_widget` to pop up **custom widgets** (charts, lists, buttons, a duck) — draggable in chat & voice, plus a persistent Canvas tab. |
| **Mobile** | Kotlin/Compose app: pair via QR, chat + photos, sessions, queue, live video, file receive, push. Background WebSocket service delivers notifications **without Firebase**. |
| **Security** | 2FA + biometric **cross-device unlock** (open desktop → approve on phone with fingerprint), SSH allow-list, prompt-injection gating, strict per-brain **MCP isolation** with opt-in CLI MCP toggles. |
| **Productivity** | Scheduler (cron + natural language), memories, skills + "today" digest, custom MCP servers, a plugin registry, and Google connectors (Calendar/Docs/Drive/Gmail) framework. |

---

## Architecture

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
        API["ApiBrain<br/>OpenAI/Anthropic/Ollama"]
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
`tool_call`, `tool_result`, `diff`, `approval`, `final`, `error`, `driving_state`).

| Port | Channel | Bind | Auth |
|---|---|---|---|
| `8795` | control WS (desktop ↔ daemon) | loopback | shared token (`~/.config/jarvis/control_token`) |
| `8796` | device WS (phone ↔ daemon) | tailnet | ed25519 pairing handshake |
| `8794` | computer-use engine (MCP) | loopback | bearer token |

---

## Repository layout

```
core/         C++/Qt6 shared lib — session model, Brain abstraction, MCP registry,
              scheduler, memories, skills, SSH allow-list, settings, FCM sender, voice
daemon/       jarvisd — headless service: ControlServer (:8795) + DeviceServer (:8796),
              pairing, session orchestration, Jarvis-MCP server, auth challenges
desktop/      jarvis-sidebar — QML/Quick + LayerShellQt UI (chat, voice, canvas, computer,
              browser, schedules, memory, skills, sessions, settings, MCP, plugins)
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

## Build & run

**Desktop (C++/Qt6 + Python engine)**
```bash
cmake -S . -B build -G Ninja          # configure once
cmake --build build                   # builds jarvisd + jarvis-sidebar
ctest --test-dir build                # unit tests
# engine deps:
cd computer-use && python -m venv .venv && .venv/bin/pip install -e . && cd -
env -u PYTHONPATH computer-use/.venv/bin/python -m pytest computer-use/tests -q
```
Install + run: copy `build/daemon/jarvisd` and `build/desktop/jarvis-sidebar` to `~/.local/bin`,
start `jarvisd` (a systemd user unit lives in `packaging/`), then launch `jarvis-sidebar`
(`--voice` boots straight into voice mode).

**Android**
```bash
cd android && ./gradlew :app:assembleDebug
```

**Chrome extension** — load `extension/` unpacked at `chrome://extensions` (Developer mode).

> ⚠️ Always run Python/builds with `env -u PYTHONPATH` (a user site-packages `PYTHONPATH` leak
> breaks the engine venv). Never broad-kill `foot` / `sway` / `kwin`; stop processes by PID/unit.

---

## Docs

- [`docs/STATUS.md`](docs/STATUS.md) — **where the project actually is** (done vs partial vs next)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design
- [`docs/COMPUTER_USE.md`](docs/COMPUTER_USE.md) — the computer-use engine
- [`docs/JARVIS_VOICE_AND_RENDERER.md`](docs/JARVIS_VOICE_AND_RENDERER.md) — voice + generative renderer
- [`docs/JARVIS_GOOGLE_CONNECTORS.md`](docs/JARVIS_GOOGLE_CONNECTORS.md) — Google connectors
- [`docs/KWIN_MULTISEAT_FORK.md`](docs/KWIN_MULTISEAT_FORK.md) — the agent's own seat/cursor
- [`AGENTS.md`](AGENTS.md) — **read this first if you're an AI working on the repo**

---

## License

Personal project — all rights reserved (no license granted yet).
