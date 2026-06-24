# Jarvis — Project Status

Single source of truth for **where this project actually is**. Honest about done vs.
partial vs. not-started. Pair with [`../README.md`](../README.md) (overview + architecture)
and [`../AGENTS.md`](../AGENTS.md) (how to work on it + gotchas).

_Last updated: 2026-06-24._

---

## What even is this?

**Jarvis** is one AI co-worker you can drive from your **Linux desktop**, your **Android
phone**, and a **Chrome extension** — all talking to one local daemon. It chats, **drives
your computer** (its own nested desktop or your real screen, with a glowing cursor +
consent), **talks** (hands-free voice), pops up **custom widgets**, runs **scheduled** tasks,
keeps **memories/skills**, and can pull in **MCP tools** (incl. Google connectors). "Coder
when needed, co-worker otherwise."

**Shape:** `core/` (C++/Qt6 shared lib) · `daemon/` (jarvisd: control WS :8795 + device WS
:8796) · `desktop/` (jarvis-sidebar, QML) · `computer-use/` (Python FastMCP engine :8794) ·
`android/` (Kotlin/Compose) · `extension/` (Chrome MV3). Brains: **codex** / **claude** CLIs +
a direct **api** loop, all normalized to one event stream (Contract A).

---

## ✅ Done & verified

Verified = unit tests pass, live WS check, and/or exercised on the running daemon.

- **Core/daemon:** sessions, the 3 brains, Contract A on all channels, scheduler (cron +
  natural language), memories, skills, SSH allow-list, prompt-injection gating, plugin
  registry. **15/15 ctest, 32/32 engine pytest.**
- **Strict MCP isolation** per brain (codex `--ignore-user-config`, claude
  `--strict-mcp-config`) + opt-in CLI-MCP toggles.
- **Desktop chat:** streaming/typewriter, brain+model picker, stop button, auto-titled
  sessions, in-conversation thinking orb + funny phrases.
- **Session management (isolation) — verified with logs:** desktop / phone / Chrome / voice
  sessions are **separate**. The daemon broadcasts every session's events to all clients, so the
  desktop FILTERS: it renders only its own session's events. Proven live — a simulated Chrome
  session logs `session.opened -> focus-only` then `DROP foreign session.event …`, never
  reaching the chat. A foreign session opening only raises the window (never hijacks the chat);
  opening an old session **resumes** it (re-spawns the brain) instead of "inactive session";
  `+ New` clears + drops the session; sessions are a flat, openable, deletable list. Belt-and-
  suspenders QML guard + `Bridge[session]` logging added.
- **Voice orb animation:** smooth "breathing" while thinking/speaking + a soft mic-level swell
  while listening (replaced the abrupt size-jump).
- **Voice mode:** hands-free (no hold-to-talk) capture via **pw-record** (the path that
  actually works on this PipeWire box), RMS VAD calibrated to the mic noise floor (~0.5s
  end-of-turn), brain/model/**speaker** pickers, live mic-level orb. Mistral Voxtral
  **STT+TTS round-trip verified.**
- **Generative renderer:** `render_widget` tool + a brain primer that tells the model to call
  it; widgets render as **draggable floating cards** in chat & voice + a persistent Canvas tab.
- **2FA + fingerprint cross-device unlock:** desktop/Chrome lock → challenge pushed over the
  device WS → phone notification → BiometricPrompt → approve → unlock. **Fail-open anti-brick**
  when no phone is reachable. Desktop lock defaults on.
- **Notifications without Firebase:** Android foreground `JarvisConnectionService` holds the
  device WS open and posts local notifications (new session, file offer, **auth challenge**).
- **Android app:** chat (typewriter + visible tools), **photo send** (crash-proofed),
  **Speak-replies** toggle (default off), sessions, MCP CLI toggles, biometric app-gate. Built
  + pushed to the phone store (current **vc9 / 0.5.4**).
- **Mic routing (system fix):** the working built-in DMIC array wasn't exposed by PipeWire
  (its card profile was "off"; the default source was a dead analog jack). Added a PipeWire
  source for it + set it default + sane gain. Capture verified.
- **KDE plasmoid** to toggle the sidebar.
- **Live video to the phone (MJPEG):** the daemon mirrors a session's screen as
  `mirror.frame` binary frames over the device WS; the Android Computer screen decodes
  + displays them. (Works today; WebRTC below is a smoother upgrade, not a prerequisite.)
- **Plugin marketplace:** `PluginRegistry` + `plugins.catalog`/`plugins.install`, a desktop
  `PluginsPage`, an Android `PluginsScreen`, signed-package format + a seeded sample. Functional
  (UI polish is the only open bit).
- **Model-generated session titles:** an async Mistral call names each session from its first
  message ("…segfault in my C++ code" → "Debugging C++ Pointer Segfault"). Verified.
- **Real Google Docs/Drive MCP:** both route through `@modelcontextprotocol/server-gdrive`.
- **GUI integration test:** `jarvis-sidebar --selftest` loads the whole UI offscreen + verifies
  it renders → the `gui_selftest` ctest (16/16 total).
- **KWin multi-seat fork — DONE & running live:** a forked `kwin 6.7.0`
  (`~/projects/kwin-build/bin/kwin_wayland`, source in `~/projects/kwin-jarvis-fork/`)
  gives the agent its own seat/cursor on the real screen. (Confirmed: it's the active
  compositor.)

---

## ⚠️ Partial / works-but-with-caveats / needs your action

- **Google connectors:** framework + Settings UI (per-service Client ID/secret/refresh-token
  form) + in-app Google-Cloud setup guide are done, and real creds now **enable** the
  connector (= the brain gets it as an MCP server + its tools). **Caveats:** you must supply
  OAuth creds; **Calendar** (`@cocal/google-calendar-mcp`) and **Gmail**
  (`@gongrzhe/server-gmail-autoauth-mcp`) use real npm packages, but **Docs/Drive** point at
  `@google/*` packages that may not exist yet (those won't provide tools until a real package
  is wired). Connectors are desktop/control-only (not exposed on the phone channel).
- **2FA unlock end-to-end:** code-complete + the WS path is wired, but the **full phone↔desktop
  biometric loop hasn't been exercised on the real device** by me. Needs the phone app open
  (the foreground service must be connected) to be a reachable approver.
- **Voice mode tuning:** working, but the VAD/gain are calibrated to **this machine's** DMIC
  noise floor — a different mic/room may need re-tuning. The DMIC PipeWire source uses
  `hw:3,0`, which could change if ALSA card ordering changes on reboot.
- **Session titles:** auto-titled from the **first user message** (truncated). The requested
  **model-generated** title (a short summary) is **not done** — it needs an extra LLM call.

---

## ⛔ Not started / next up

Most of the earlier "next up" list is now **done** (titles, Docs/Drive MCP, DMIC by-name, 2FA
flow verified, GUI test) and KWin was already done. What genuinely remains:

1. **WebRTC live video (Wave C)** — **deferred by user decision** (kept out for now; MJPEG live
   video covers it). A smoother 30fps upgrade: GStreamer `webrtcbin` pipeline + signaling over
   the device WS + an Android **libwebrtc** client + ICE/STUN. Deps verified present
   (GStreamer 1.28 + webrtcbin + VP8), so it's a clean future build — just multi-day.
2. **Plugin marketplace UI polish** — the registry/install/pages all work; this is cosmetic.
3. **Richer renderer widgets** (more DSL node types), and a true **clicking** GUI test (the
   `gui_selftest` covers load/render, not interaction).
4. **2FA on real hardware:** the WS flow is verified (`auth_gate_check.py` OK); only the
   physical phone's fingerprint UI is untested from here.

---

## How to verify quickly

```bash
cmake --build build && ctest --test-dir build           # 15/15
cd computer-use && env -u PYTHONPATH .venv/bin/python -m pytest tests -q   # 32/32
cd android && ./gradlew :app:assembleDebug              # APK
QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 build/desktop/jarvis-sidebar --demo  # QML loads clean
env -u PYTHONPATH uv run --with websockets python scripts/roadmap_live_verify.py         # live daemon checks
env -u PYTHONPATH uv run --with websockets python scripts/voice_roundtrip_test.py        # Mistral STT/TTS
```
