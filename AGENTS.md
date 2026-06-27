# AGENTS.md — for AI working on Jarvis

Read this before editing. It captures the **vision**, **how the system fits together**, and the
**rules and gotchas** that aren't obvious from the code. Pair it with [`README.md`](README.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Vision

One AI **co-worker** — not a chatbot — that you can dispatch from your desktop, your phone, or your
browser, that actually *does the work*: drives the computer, edits code, runs tools, schedules
itself, remembers, and shows you what it's doing. Codex-app / Anthropic-Cowork class, but **yours**,
local-first, and cross-surface. "Coder when needed, co-worker otherwise."

Design pillars:
1. **One daemon, many surfaces.** `jarvisd` owns all state; desktop, phone, and extension are thin
   clients over the same protocol. Never put session logic in a client.
2. **Pluggable brains.** Codex / Claude CLIs and a direct-API loop all normalize to one event stream.
   A feature should work regardless of which brain is active.
3. **Visible & consent-gated computer use.** When Jarvis drives the *real* screen the user sees a
   distinct cursor + banner and approves first; otherwise it works on a nested headless desktop.
4. **Local-first, no hard cloud deps.** It must work without Firebase, without a service account,
   without an internet round-trip for core flows (notifications now ride the device WebSocket).

## How it fits together

- **`core/`** (C++/Qt6 lib): the shared model. `Brain` abstraction + `CodexBrain`/`ClaudeBrain`/
  `ApiBrain`; `*Parser` turns CLI JSONL into `NormalizedBrainEvent`; `SessionStore`, `McpRegistry`,
  `Scheduler`, `MemoryStore`, `SkillStore`, `SettingsStore`, `AuthChallengeStore`, `FcmSender`,
  `VoiceProvider`, `Connectors`. **Business logic lives here**, tested by `core/tests/*` (ctest).
- **`daemon/`**: `ControlServer` (:8795 loopback, token) for the desktop + `DeviceServer` (:8796
  tailnet, ed25519 pairing) for the phone. Both speak **Contract A**. `ControlServer::createSession`
  is the single choke-point that fans out `session.opened` to every surface.
- **`desktop/`**: `jarvis-sidebar`, QML + LayerShellQt. `Bridge` (C++) is the QML↔daemon client;
  pages live in `desktop/qml/`. The panel is instantiated **once** and reparented between a float
  window and a docked layer-shell surface, so chat state survives mode changes.
- **`computer-use/`**: the Python FastMCP engine. Tools are registered in `server.py`; key modules:
  `input.py` (per-session pointer routing + agent pointer bus), `screen.py`, `session.py`,
  `tools_widgets.py` (`render_widget` → `widgets.jsonl` bus the desktop tails), `jarvis_seat.py`
  (KWin multi-seat fork integration).
- **`android/`**: MVVM + Compose. `JarvisRepository`/`DeviceClient` own the WS; `JarvisApp` holds
  process-wide singletons; `JarvisConnectionService` is the foreground service that keeps the socket
  alive for notifications without FCM.
- **`extension/`**: `sw.js` (engine bridge + CDP), `content.js` (in-page glow cursor + actions),
  `sidepanel.*` (the daemon chat panel — unified with desktop/phone sessions).

## How to work on it

- **Find the layer.** A bug in *what Jarvis decides* → `core`/brains. *How it's shown* → `desktop/qml`
  or `android/ui`. *How it acts* → `computer-use`. *How surfaces talk* → `daemon`.
- **A feature usually spans 3+ surfaces.** Wire the daemon/core first, then desktop QML, then Android,
  then (if relevant) the extension. Keep the protocol identical across them.
- **Verify with evidence, not self-report.** There are live WS scripts in `scripts/` (e.g.
  `session_opened_ws.py`, `voice_roundtrip_test.py`, `auth_gate_check.py`, `roadmap_live_verify.py`).
  Run them against a running `jarvisd`. For QML, do an offscreen smoke load:
  `QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 build/desktop/jarvis-sidebar --demo`.
- **Tests gate everything:** `ctest --test-dir build`, the engine `pytest`, Android `assembleDebug`.

## Hard rules / gotchas (learned the hard way)

- Run **all** Python/builds with `env -u PYTHONPATH` — a user `PYTHONPATH` leaks system PIL and breaks
  the venv.
- **Never** broad-kill `foot` / `sway` / `kwin` / a running `jarvis-sidebar`/`jarvisd`. Stop by
  PID or systemd unit only.
- Secrets live in `~/.config/jarvis/` (0600) — `control_token`, `mistral_api_key`, `secrets.json`,
  device keys — **never** in git. OAuth/refresh tokens for connectors go in `secrets.json`.
- **MCP isolation is intentional:** codex runs `--ignore-user-config` with an isolated `CODEX_HOME`;
  claude runs `--strict-mcp-config --mcp-config`. The brain only sees Jarvis's built-in computer-use
  plus servers the user explicitly re-enables (CLI MCP toggles). Don't "helpfully" re-add user MCPs.
- Installing over a running binary → `ETXTBSY`. Copy to a temp name then `mv -f` over it.
- **KWin fork deploy:** NEVER `ninja install` the fork (`~/projects/kwin-jarvis-fork`)
  while it's the LIVE compositor — it overwrites the mmap'd `libkwin.so` and SIGSEGVs
  the whole desktop. Build is safe; install via **atomic rename** (`cp build/bin/
  libkwin.so.6.7.0 ~/projects/kwin-build/lib64/x.new && mv -f x.new …libkwin.so.6.7.0`)
  then **relogin** to load it (KWin can't hot-reload its core lib). Stock "Plasma" at
  SDDM is the always-safe fallback. The agent drives the real screen via the
  independent `jarvis` wl_seat (DBus `org.kde.KWin.JarvisSeat`), never `seat0` — and
  `notifyPointerEnter`'s 3rd arg is the surface GLOBAL ORIGIN (`pos - local`), not the
  local offset (passing the offset drops every click).
- `render_widget` writes `~/.local/share/jarvis/widgets.jsonl`; **both** the desktop
  and the daemon (for the phone) **tail** it by byte offset from EOF. Records carry
  `target` (canvas/chat/voice/both) + `session_id`; ad-hoc draws = CANVAS, saved
  reusable ones (`saved_widgets.json`) = WIDGETS. `op:remove`/`op:clear` are delete
  markers. See `docs/WIDGETS_CANVAS.md`.
- **Live widgets are viewer-gated (battery).** ONE supervisor process
  (`live_widgets.py`, pid-file `widget_supervisor.pid`) runs every job; a job only
  does work while a fresh **viewer lease** covers it (daemon-owned
  `widget_viewers/*.json`, 45 s TTL, wiped on daemon start). Desktop sends
  `widget.viewing`; phone sends `widget.viewing`/`widget.pin`/`widget.unpin`. Pinned
  home-screen widgets get a 60 s floor + relay throttle and only heartbeat while the
  phone is unlocked. Deleting a canvas/widget (any path, incl. the desktop "✕" bus
  marker) STOPS its job — don't reintroduce the old "remove render only" behavior.
  The `WidgetLeaseRegistry` (core) is the single writer; leases are ephemeral
  (rebuilt from live connections), never persisted across a daemon restart.
- **Home-screen widget (Android)** draws the DSL to a bitmap headlessly
  (`WidgetBitmapRenderer`) shown in a classic `AppWidgetProvider` RemoteViews — NO
  Glance (RemoteViews can't host Compose). Updates are push-driven over the device
  WS (`updatePeriodMillis=0`); never add a polling `updatePeriodMillis`.
- Notifications do **not** use Firebase in this setup (no service account). The Android foreground
  `JarvisConnectionService` holds the device WS open and posts local notifications off it —
  `session.opened`, `file.offer`, and **`auth.challenge`** (the desktop/Chrome unlock prompt).
- **Cross-device unlock semantics** (subtle, get these right):
  - A reachable approver = a phone **connected AND authed over the device WS** (`auth.challenge` is
    pushed to it) OR a real FCM backend + token. If neither, `handleAuthRequest` **fail-opens** so the
    user is never bricked. Mere pairing is not "reachable".
  - "phone connected ≠ authed-by-biometric": a connected phone gets the challenge and must clear
    `BiometricPrompt` (fingerprint) → `auth.approve` over its authed WS → desktop unlocks.
  - A **deliberate phone action** (the user starts a chat from the authed app) calls
    `grantDeviceAuthGrace()` → a short window where the desktop **auto-approves** unlock (the user is
    demonstrably present at an unlocked phone) and any waiting LockGate unlocks. Connection alone does
    NOT grant grace.
- Brain output schemas drift between CLI versions — parsers are defensive; prefer adding a case over
  tightening existing ones.

## Conventions

- C++: match surrounding Qt style; logic in `core` with a `core/tests` ctest; daemon/desktop stay thin.
- QML: reuse `Theme.*` and existing components (`ArcReactor`, `WidgetRenderer`, `HudFrame`,
  `FloatingWidgetLayer`). Keep pages stateless where possible; the `Bridge` is the single client.
- Android: MVVM, `StateFlow<UiState>`, Room/DataStore (not raw SharedPreferences for new code),
  one `@Composable` screen per file. After any Android change, build the APK and push it to the phone.
- Bump `versionCode`/`versionName` on every shippable Android change.
