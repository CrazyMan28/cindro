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
- **Permission level is a SOFT policy, not the sandbox.** `permission_level`
  (`high`/`medium`/`low`, default `medium`; SettingsStore + `settings.get`/`set`) is
  turned into a clause by `ControlServer::permissionPolicyClause()` and appended to the
  per-session co-work preamble (right after the long `guide` string, gated by
  `m_coworkGuided`). It auto-ranks tools HIGH/MEDIUM/LOW and tells the model to call
  `ask_user` before risky actions. It does **not** touch the capability tiers / bypass
  flags — don't wire it into the sandbox; it only changes what the model is told to ask
  about. Configurable in Settings → Permissions on desktop and phone.
- **Model TODO** (`tools_todo.py`, `todo_write`/`todo_read`/`todo_clear`) persists per
  session to `~/.local/share/jarvis/todos/<session>.json` AND renders a checklist card to
  the widget bus under stable id `__todo__:<session>` (target `chat`). It reuses the
  widget renderer — no new UI. Re-writes replace the card in place; `normalize_items`
  coerces bare strings + unknown statuses to `pending`. See `docs/WIDGETS_CANVAS.md`.
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
- **Custom agents (subagents)** live as `AGENT.md` files in
  `~/.local/share/jarvis/agents/<slug>/` via `core/AgentStore` (mirrors `SkillStore`;
  also mirrors to `~/.claude/agents`). A dispatched agent runs as a CHILD session:
  `session.create` takes `parent_session_id` + `agent` (sets the two new `sessions`
  columns and injects the agent's system prompt on turn 1). Contract A
  `agents.list/get/create/remove/dispatch/running`; model MCP tools `agent_*`
  (`tools_jarvis_ops.py`). The SubAgentTree only renders because `parent_session_id`
  is now real — don't drop it. See `docs/AGENTS_AND_COMMANDS.md`.
- **The "/" palette** is per-surface (`SlashPalette.qml` / `ui/chat/SlashPalette.kt`
  / the extension dropdown). It lists commands + agents + skills. The desktop
  `CommandPalette.qml` (Ctrl+K page jumper) is SEPARATE — keep both. Picking a SKILL
  RUNS it (no args); picking an AGENT fills `/dispatch <name> ` (needs a task).
- **Skill invoke is injected by the CHAT panel.** `JarvisPanel` owns the single
  `bridge.onSkillInvoked -> injectSkill` handler (the chat page is always loaded), so
  a skill invoked from the "/" palette OR a typed `/name` lands in chat even when the
  Skills page was never opened. The Skills page's `onRunSkill` only switches to chat —
  it must NOT also inject (that double-rendered).
- **`SkillStore::invoke()` returns a DIRECTIVE, not an FYI** (Claude-Code style): a
  `[SKILL INVOKED] … read it IN FULL and APPLY it now` header + the WHOLE rendered
  body delimited by `BEGIN SKILL` / `END SKILL`, so the model executes the skill
  instead of just acknowledging the co-work preamble. Don't water this back down to a
  `# Skill:` label — that read as background and the model ignored it.
- **TTS is one strict FIFO.** Voice mode AND the chat "Speak replies" path BOTH go
  through `Bridge::playTtsAudio` (single shared `QMediaPlayer` + `m_ttsQueue`) with
  requests serialized one-in-flight (`pumpTtsRequests`); Android `TtsPlayer` mirrors
  this (a shared player + queue). NEVER reintroduce a per-clip player / second
  playback path — that's what made replies talk over each other.
- **The right-side peek panel opens ONLY** on a new TODO or a real agent-desktop
  spin-up (`driving`/coworker), NOT on `hasAgentDesktop` (which fires on the first
  message via auto computer-use). The PLAN card lives INSIDE that panel, on top of
  the agent-desktop view (`JarvisPanel.qml`).
- **Skills:** the model MUST create skills via the `create_skill` MCP tool, not its
  CLI's own skill files (the SKILLS preamble says so). The Skills list uses
  `SkillStore::listAll()` (root + `~/.codex/skills` + `~/.claude/skills`, dedup by
  name, **skipping dotted/`.system` CLI internals**) so a skill always shows up.
  `get()`/`read()`/`invoke()`/`remove()` ALSO resolve via `listAll()`, so a CLI-only
  skill is viewable/runnable/removable — not just visible (the earlier bug:
  list showed it but get/invoke returned `no_skill`). `remove()` deletes the root +
  both CLI mirror copies so a deleted skill can't resurface. CLI scanning + mirroring
  are gated on the DEFAULT root (`m_root.isEmpty()`) so a temp-root unit test stays
  isolated and never touches the real `~/.codex` / `~/.claude` dirs.
- **Chrome extension widgets:** the side panel subscribes via control-WS
  `widget.subscribe` and the daemon tails `widgets.jsonl` → broadcasts
  `widget.render/remove/clear` to opted-in control clients ONLY. The desktop tails
  the file itself and never subscribes, so it doesn't double-render. Don't broadcast
  widgets to all control clients.

## Conventions

- C++: match surrounding Qt style; logic in `core` with a `core/tests` ctest; daemon/desktop stay thin.
- QML: reuse `Theme.*` and existing components (`ArcReactor`, `WidgetRenderer`, `HudFrame`,
  `FloatingWidgetLayer`). Keep pages stateless where possible; the `Bridge` is the single client.
- Android: MVVM, `StateFlow<UiState>`, Room/DataStore (not raw SharedPreferences for new code),
  one `@Composable` screen per file. After any Android change, build the APK and push it to the phone.
- Bump `versionCode`/`versionName` on every shippable Android change.
