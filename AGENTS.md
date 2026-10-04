# AGENTS.md — for AI working on Cindro

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
3. **Visible & consent-gated computer use.** When Cindro drives the *real* screen the user sees a
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
- **`desktop/`**: `cindro-sidebar`, QML + LayerShellQt. `Bridge` (C++) is the QML↔daemon client;
  pages live in `desktop/qml/`. The panel is instantiated **once** and reparented between a float
  window and a docked layer-shell surface, so chat state survives mode changes.
- **`computer-use/`**: the Python FastMCP engine. Tools are registered in `server.py`; key modules:
  `input.py` (per-session pointer routing + agent pointer bus), `screen.py`, `session.py`,
  `tools_widgets.py` (`render_widget` → `widgets.jsonl` bus the desktop tails), `jarvis_seat.py`
  (KWin multi-seat fork integration).
- **`android/`**: MVVM + Compose. `JarvisRepository`/`DeviceClient` own the WS; `JarvisApp` holds
  process-wide singletons; `JarvisConnectionService` is the foreground service that keeps the socket
  alive for notifications without FCM.
- **`iphone_app/`**: SwiftUI + Combine, a 1:1 port of `android/`'s `com.cindro.app` over the SAME
  Contract C device WebSocket + Ed25519 pairing. Same layering: `DeviceClient`/`PairingClient`/
  `JarvisRepository` (networking), `AppState` (the `JarvisApp`-equivalent singletons), `UI/*`
  (SwiftUI screens with `ObservableObject` view models). No daemon changes — a thin client like the
  others. The `.xcodeproj` is generated from `project.yml` (XcodeGen), never committed.
- **`extension/`**: `sw.js` (engine bridge + CDP), `content.js` (in-page glow cursor + actions),
  `sidepanel.*` (the daemon chat panel — unified with desktop/phone sessions).

## How to work on it

- **Find the layer.** A bug in *what Cindro decides* → `core`/brains. *How it's shown* → `desktop/qml`
  or `android/ui`. *How it acts* → `computer-use`. *How surfaces talk* → `daemon`.
- **A feature usually spans 3+ surfaces.** Wire the daemon/core first, then desktop QML, then Android,
  then (if relevant) the extension. Keep the protocol identical across them.
- **Verify with evidence, not self-report.** There are live WS scripts in `scripts/` (e.g.
  `session_opened_ws.py`, `voice_roundtrip_test.py`, `auth_gate_check.py`, `roadmap_live_verify.py`).
  Run them against a running `jarvisd`. For QML, do an offscreen smoke load:
  `QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 build/desktop/cindro-sidebar --demo`.
- **Tests gate everything:** `ctest --test-dir build`, the engine `pytest`, Android `assembleDebug`.

## Hard rules / gotchas (learned the hard way)

- Run **all** Python/builds with `env -u PYTHONPATH` — a user `PYTHONPATH` leaks system PIL and breaks
  the venv.
- **Never** broad-kill `foot` / `sway` / `kwin` / a running `cindro-sidebar`/`jarvisd`. Stop by
  PID or systemd unit only.
- Secrets live in `~/.config/jarvis/` (0600) — `control_token`, `mistral_api_key`, `secrets.json`,
  device keys — **never** in git. OAuth/refresh tokens for connectors go in `secrets.json`.
  `secrets.json` is additionally OS-protected at rest via `SecretCipher` (Windows DPAPI always;
  Linux Secret Service when a keyring daemon is reachable) — see the 2026-07-15 entry below.
- **MCP isolation is intentional:** codex runs `--ignore-user-config` with an isolated `CODEX_HOME`;
  claude runs `--strict-mcp-config --mcp-config`. The brain only sees Cindro's built-in computer-use
  plus servers the user explicitly re-enables (CLI MCP toggles). Don't "helpfully" re-add user MCPs.
  Corollary: a **separate HTTP MCP server never reaches the isolated brain** — so the **phone tools
  live ON the computer-use engine** (`computer-use/computer_use_mcp/tools_phone.py`, proxied via
  jarvisd's `phone.mcp`), not as a standalone server. Put brain-facing tools on computer-use.
- Installing over a running binary → `ETXTBSY`. Copy to a temp name then `mv -f` over it.
- **KWin fork deploy:** NEVER `ninja install` the fork (`~/projects/kwin-jarvis-fork`)
  while it's the LIVE compositor — it overwrites the mmap'd `libkwin.so` and SIGSEGVs
  the whole desktop. Build is safe; install via **atomic rename** (`cp build/bin/
  libkwin.so.6.7.0 ~/projects/kwin-build/lib64/x.new && mv -f x.new …libkwin.so.6.7.0`)
  then **relogin** to load it (KWin can't hot-reload its core lib). Stock "Plasma" at
  SDDM is the always-safe fallback. The agent drives the real screen via the
  independent `jarvis` wl_seat (DBus `org.kde.KWin.JarvisSeat`), never `seat0` — and
  `notifyPointerEnter`'s 3rd arg is the surface GLOBAL ORIGIN (`pos - local`), not the
  local offset (passing the offset drops every click). The seat must ALSO send
  `wl_keyboard.modifiers` from its own per-seat xkb_state — clients never derive
  modifiers from raw keys, so without it every `ctrl+x` combo just types the letter
  (fixed 2026-07-10; see `docs/KWIN_MULTISEAT_FORK.md`). Deploy with the fork's
  `deploy-libkwin.sh`; test NESTED with `--virtual --no-lockscreen` (a locked logind
  session otherwise puts a greeter window over the nested output that swallows every
  jarvis hit-test) driving `/JarvisSeat` on the nested instance's unique bus name;
  live smoke after relogin: `scripts/jarvis_seat_type_check.py`. Engine side:
  `jarvis_seat.available()` must never cache a negative probe forever — the engine
  can start before KWin registers the iface, and a sticky False silently exiles all
  real-screen input to the shared seat (mixing).
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
  is now real — don't drop it. A dispatched subagent's task is appended with a
  "end with a SUMMARY" instruction, and when its turn finishes `onTurnFinished`
  WAKES the parent (`m_subagentPendingWake` → `subagentSummary` → `sendToSession`)
  with a `[SUBAGENT DONE]` summary+status turn, so the parent acts on the result
  instead of redoing it. `agents.result` / `agent_result` fetch a summary on demand.
  See `docs/AGENTS_AND_COMMANDS.md`.
- **Subagents are ISOLATED.** A child session (non-empty `parentSessionId`) gets ONLY
  its agent system prompt + the task — `sendToSession` SKIPS the memory prefetch, the
  co-work guide, and the post-turn memory write for it (`isSubagent`). Don't leak the
  main agent's memory/context into a subagent.
- **No per-message MultiEffect brightness layers.** The chat bubble edge bar is a SOLID
  color, not a `layer.effect: MultiEffect{brightness}` — those always-on layers
  intermittently flood the whole bubble bright (the "random bright text" bug) and cost
  a GPU layer per message. Keep glows off per-delegate (or gate on `Qt.application.active`).
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
- **Page index gotcha:** Home is index 0, **Chat is index 1** (Home was added after
  Chat). `Main.qml::onSessionOpened` navigates to **1** — anything that opens a session
  (incl. clicking a subagent → `bridge.openSession` → `sessionOpened`) must land on Chat,
  not Home. Don't reintroduce a `currentIndex = 0` "= Chat" assumption.
- **Desktop Home is full CRUD for the model:** `home_list` / `home_pin` / `home_unpin` /
  `home_move` / `home_clear` (`tools_widgets.py`, Contract A `home.*`). A child session
  viewing shows a "← Main agent" pill (`JarvisPanel.currentParentId` from the tree).
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

## New subsystems (2026-06-28) — gotchas

- **Phone is VENDORED, not rewritten.** `phone/server` is the agent-phone server copied
  byte-for-byte (`diff -rq` clean). The **original agent-phone repo is untouched and still
  runs as its own separate process** — the Cindro copy is a snapshot only. Don't hand-edit
  `phone/server` to "fix" things — re-vendor from the source if it must change. Secrets live
  in `~/.config/jarvis/phone.env` (0600, gitignored); never commit them.
- **Jarvis is extension 101 on the phone server.** Codex = 102, Copilot = 103, Echo = 104,
  Hermes = 105, Claude = 106, Mistral Screener = 107. Don't reassign 101 — that's the Jarvis
  identity used for enrollment, MCP calls, and the per-agent config routes.
- **Two daemon proxies, not one.** `seedPhoneMcp()` seeds the `phone` MCP row for the brain.
  The UIs use **two** Contract A methods:
  - **`phone.mcp`** (`{name, arguments}` → `{data|text, tool, error?}`) — forwards an MCP
    tool call to the phone server; bearer stays in the daemon. Exposed on control + device.
  - **`phone.http`** (`{method, path, body?}` → `{status, data}`) — forwards a raw HTTP
    request to the phone server's REST API; bearer stays in the daemon. Used by the Phone
    UI for everything MCP doesn't cover: per-agent voice/model config
    (`/api/extensions/<ext>/voice`, `/api/extensions/<ext>/model`), screening
    (`/api/screening`), SMS agent (`/api/sms-agent`), voice catalog (`/api/voices`), call
    list (`/api/calls`). UI surfaces must NEVER hold the admin bearer themselves.
- **Full-screen Phone UI on all three surfaces.** The entire agent-phone app UI is embedded
  in Cindro as a Phone section (Calls/Inbox/Agents/HUD/Settings nav). On Android the Phone
  section hides Cindro's main bottom nav (full-screen); backing out restores it. A new QML
  page MUST be added to `desktop/CMakeLists.txt` `QML_FILES` or it loads as "X is not a
  type" (gui_selftest catches this).
- **Background jobs wake via `session.wake`** (`bg_jobs.py` → daemon), the generalized form
  of the subagent wake — queued if the session is mid-turn. Don't add a second wake path.
- **Hooks fire points are mostly observational.** Only UserPromptSubmit blocks/injects and
  SessionStart injects; tool/Stop/Notification hooks can't abort (the brain's CLI runs MCP
  tools itself). `HookStore::run()` is a no-op when an event has no hooks — keep it that way
  so fire points stay free by default.
- **Modes & wake-notify are SOFT** (`agent_mode`, `wake_notify` in SettingsStore, like
  `permission_level`) — preamble clauses only, never the sandbox.

## New subsystems (2026-07-01) — gotchas

- **Trust policies are ENFORCED, not advisory (jarvis#71).** The daemon owns
  `~/.config/jarvis/trust_policies.json` (`core/TrustPolicyStore`, Contract A
  `policy.*`); the computer-use engine ENFORCES it by wrapping FastMCP's
  `ToolManager.call_tool` in `computer_use_mcp/policy.py` (`policy.install(mcp)`
  in `server.py`). deny → the tool raises; ask → blocks on the ask-bus. The C++
  `TrustPolicyStore::evaluate` is a MIRROR of the Python matcher (most-specific
  wins, tie→earliest, tool case-sensitive, app case-insensitive) — keep the two
  in sync if you change matching. `permission_level` is the SOFT policy; this is
  the enforced one. Both are separate from the capability sandbox.
- **Self-heal wraps input tools (jarvis#67).** `selfheal.run(tool, which, action)`
  in `tools_desktop.py` wraps click/drag/scroll/key/type: transient retry +
  before/after screen-hash → adds a `self_heal` block to the (dict) result. Do
  NOT wrap read-only tools (screenshots etc.) in it — only screen-mutating ones,
  and pass `expect_change=false` if a mutation legitimately may not repaint.
- **Committee mode is a plain tool (jarvis#69).** `agent_committee` in
  `tools_jarvis_ops.py` just fans out `agents.dispatch` + polls `agents.result`
  + an optional judge dispatch — no daemon change. It relies on the subagent
  parent-link + done-wake, so don't break those.
- **Anomaly watcher = a bg_jobs "watch" kind (jarvis#68).** Runner `_run_watch`
  in `bg_jobs.py` drives the PURE `anomaly.py` core (JSON-roundtrippable state
  persisted in job.json across the detached runner). If you add a bg tool, update
  `tests/test_tools_bg_register.py`'s pinned `EXPECTED_TOOLS`.
- **Replay reuses session.history, un-gated (jarvis#66).** `bridge.loadReplay`
  tags its request `__replay__:<sid>` so the reply is NOT dropped by the
  active-session guard and KEEPS per-event `ts`. `ReplayPage.qml` rebuilds the
  transcript to a scrub cursor with the SAME ChatDelegate. `agent_desktop.info`
  is likewise now tagged `__agentdesk__:<sid>` and dropped on session mismatch —
  don't remove those guards (they stop stale replies painting the wrong session).
- **Subagents ≠ chats, everywhere.** Child sessions (non-empty
  `parent_session_id`) are filtered out of the top-level session list on ALL
  three surfaces (desktop `SessionsPage`, Android `SessionsViewModel`, extension
  `loadSessions`), never fan `session.opened`/FCM (createSession gates on
  `parentSessionId.isEmpty()`), and don't raise the "task done" toast. The peek
  SUBAGENTS card only shows running/error children (finished ones disappear).
- **The peek panel's auto-open is snooze-aware.** `JarvisPanel` records
  `peekSnoozedSession` on ✕ / "▣ Hide"; `autoOpenPeek()` respects it. Don't
  reintroduce a bare `peekOpen = true` on a level signal (that was the
  un-dismissable-panel bug) and don't auto-open on `hasSubagents` (it flickers
  on every session switch).
- **AppShell page count is DERIVED.** The page `Repeater` uses
  `rail.items.length`, not a literal — adding a NavRail item automatically gets a
  page slot (the old `model: 17` vs 18 items left Settings blank). Keep the
  switch cases in lock-step with the item order.

## New subsystems (2026-07-03 follow-up wave)

- **`cli/` — the cindro terminal** (own venv, like acp-bridge): `cindro` = textual
  TUI (Chat/Sessions/Memory/Skills/Agents/Queue/Settings over ONE streaming
  Contract A client); subcommands status/doctor/start/stop/web/ask/sessions/
  search/version. Tests use a threaded MockDaemon (`tests/harness.py
  DaemonThread`) because sync entry points call `asyncio.run` themselves — a
  plain `asyncio.run`-started mock dies with the first loop. GOTCHA: rich's
  number highlighter injects ANSI mid-string ("9.9.9" → "9.9" + "." + "9"), so
  test assertions on captured output must strip ANSI first.
- **Release-based self-update** (`core/src/Updater.cpp`): three strategies —
  AppImage ($APPIMAGE set → download release asset, verify ELF magic, atomic
  std::rename over self), Windows packaged (no repo scripts → silent Inno
  installer with /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS), git checkouts (the
  old script flow). `auto_update_apply` (default OFF) makes the periodic check
  install automatically. The ps1's $env:JARVIS_VERSION default was NEVER set →
  Updater now passes -CurrentVersion explicitly.
- **Compose GOTCHA** (ChatScreen attach button): IconButton's internal
  clickable CONSUMES taps before a Modifier.pointerInput detectTapGestures can
  resolve onTap — for tap+long-press dual gestures use a plain Box with
  pointerInput, never IconButton(onClick={}).

## New subsystems (2026-07-03, jarvis#76) — gotchas

- **Cross-session search rides an FTS mirror (item 1).** `events_fts` in
  SessionStore mirrors message/thinking text + tool outputs (8KB body cap,
  delete-then-insert sync exactly like `memories_fts`, one-time backfill for old
  DBs). `session.search` (control+device, read tier) / the `session_search`
  tool return ranked hits with a ±N context window. If you add a new event
  writer, it MUST go through `appendEvent` or search won't see it.
- **Skill curation never deletes (item 2).** `_stats.json` sidecars (use_count/
  last_used_at/pinned) live IN the skill dir but are never mirrored to the CLI
  dirs; the hourly daemon sweep ARCHIVES stale self-authored unpinned skills to
  `<root>/_archived/` (builtins + pinned exempt; mtime fallback protects fresh
  skills). `skills.pin` / `skills.list_archived` / `skills.unarchive` +
  `pin_skill`/`unarchive_skill` tools. `list()` skips `/_archived/` — keep that
  filter if you touch the scanner. Threshold = `skill_archive_days` (0 = off).
- **Tool-loop guardrails run in onBrainEvent (item 4).** `ToolLoopGuard`
  (pure, InjectionGuard-style) hashes (tool,args,result) per session: 3 exact
  repeats → a queued `[TOOL LOOP WARNING]` turn (never clobbers a queued user
  turn, once per turn), 5 → error card + audit + queued re-plan directive +
  deferred `brain->cancel()`. Windows are per-turn; result-varying churn on an
  identical call trips at 2x. State cleared on turn end/cancel/delete.
- **Credential pools are comma-separated keys (item 5).** A provider's
  secrets.json value may hold several keys (comma/newline). `apiKey()` returns
  the FIRST; `apiKeyPool()` the list; ApiBrain rotates the pool cursor on HTTP
  429 (read via the reply's HttpStatusCodeAttribute — the Qt error enum never
  says 429) and only errors when all keys are exhausted in one turn.
- **PreCompact actually fires now (item 6).** When `api_context_max_tokens` > 0
  and the estimated prompt exceeds it, ApiBrain fires the PreCompact hook (its
  `injectedContext` becomes the digest) then `compressHistory()` collapses old
  turns into ONE labelled digest message. The kept tail must never START on a
  `{role:"tool"}` row (orphaned tool results are a hard API error) — that
  slide-forward logic is load-bearing.
- **The work queue is durable and claims-based (item 7).** `KanbanStore`
  (`work_queue` in jarvis.db): the 5s daemon dispatcher heartbeats live
  workers, reclaims stale ones (3 min silence; also at daemon start), and fills
  ≤2 worker slots by claiming pending items (guarded UPDATE — no double-claim)
  into TOP-LEVEL sessions titled "Queue: …". The item resolves done/error with
  the session summary at turn end. `queue.*` Contract A + `queue_add/list/
  cancel` tools live in tools_jarvis_ops (NO pinned-count test there).
- **Self-improve + auto-continue are daemon-wired but opt-in (items 8+9).**
  Both default OFF (`self_improve`, `auto_continue`). The post-turn review is a
  cheap async mistral-small call (mirrors generateSessionTitle; silent no-op
  without a key) that may write ONE memory — it must NEVER sendToSession. Goal
  auto-continue re-wakes a session with a non-empty `goals` column
  ([AUTO-CONTINUE n/cap]); the cap (capped=3, on=25) resets on every REAL
  session.send and on goal change; subagents/queue workers/error states are
  excluded. The model clears its goal via `set_goal("")`.
- **MoA is advisory, committee decides (item 10).** `agent_moa` fans one prompt
  to N brain/model combos and returns their answers as context for the CALLER
  to weigh; `agent_committee` adds a judge. Both are pure tools over
  agents.dispatch/result.
- **Command scanner is the LAST line before shell exec (item 12).**
  `cmd_scan.py` (pure weighted cues) runs inside policy.py's call_tool wrapper
  for `bg_start`/`monitor`/`watch`/`widget_live` — the detached runners give no
  second window. Flagged → the ask-bus Allow/Deny flow; decisions audited to
  the policy log; `JARVIS_CMD_SCAN=0` disables. Add new free-form-command tools
  to `policy._CMD_TOOLS`. It's calibrated for ~zero false positives — don't add
  broad cues.
- **OSV gate fires at mcp.add time only (item 12).** The daemon never spawns
  npx/uvx servers itself (codex does, next launch), so `handleMcpAdd` is the
  ONLY window: `OsvAdvisory` queries api.osv.dev for MAL-* advisories (3s,
  FAIL-OPEN offline with an audit breadcrumb) and returns the plugins.install
  `needs_approval` shape unless re-sent with `approve:true`.
- **LSP diagnostics are a model tool, not a hook (item 13).** The engine has no
  file-write hook (brains edit via their own CLIs), so the brain calls
  `lsp_diagnostics(path)` after editing. `lsp_manager.py` speaks raw
  Content-Length JSON-RPC to one live server per language (idle-reaped 120s,
  pull + push diagnostics). If you add an LSP tool, update
  `tests/test_tools_lsp_register.py`'s pinned EXPECTED_TOOLS.
- **ACP bridge is a stdio process the EDITOR spawns (item 14).** `acp-bridge/`
  (Python) translates newline-delimited ACP JSON-RPC ⇄ Contract A. It
  subscribes (session.subscribe) IMMEDIATELY after session.create — keep that
  scoping order. No systemd unit on purpose.
- **Profiles = two env vars, read in ONE resolver each (item 15).**
  `JARVIS_CONFIG_DIR` (Config::configDir) + `JARVIS_DATA_DIR` (DataPaths
  dataDir); unset = byte-identical paths. New stores MUST route through
  `dataDir()` / `Config::configDir()` — never raw `~/.local/share/jarvis` or
  `~/.config/jarvis` literals. The sidebar resolves the control PORT from the
  profile's config.toml too (helpers in Bridge.cpp; it links no jarvis-core).
- **web/ dashboard is a no-build static SPA (item 16).** It speaks the
  extension's exact client dialect (both scoping layers!) straight to :8795;
  `web/serve.py` only serves files. ControlServer stays loopback-only — remote
  use = port-forward, never a bind flag.
- **The Windows engine freeze needs explicit data/metadata flags.** PyInstaller
  from a CACHED venv (stale hooks-contrib) drops jsonschema_specifications'
  schemas and the mcp dist-info → the frozen engine CRASHES AT IMPORT (that was
  the whole "widgets never render on Windows" saga). `windows/scripts/build.ps1`
  and `packaging/build-appimage.sh` pass `--collect-data
  jsonschema_specifications --collect-data jsonschema --copy-metadata mcp` —
  keep them if you touch the freeze.
- **Shared-engine session stamping asks the daemon (Windows todo link).** When
  `JARVIS_AGENT_SESSION` is absent (global engine), tools_todo/widgets_bus
  resolve the single state=running session via
  `daemon_client.current_session_id()` (2s cache; ambiguous → empty;
  `JARVIS_SESSION_RESOLVE=0` for hermetic tests) so todos/widgets link to THEIR
  chat instead of bleeding across sessions.
- **Phone events PUSH now (item 3).** The daemon holds one client socket on the
  phone server's /ws authed as ext 100 (device role = multi-socket safe) and
  fans call/screening frames as `phone.event` to OPTED-IN control clients
  (`phone.event.subscribe`, widget.subscribe pattern) + all authed devices.
  The old fast polls are demoted to slow fallbacks — don't re-add 2s timers.
- **Clipboard paste is vision-gated with a NOTICE (bonus).** All three
  composers attach clipboard images; a non-vision brain/model shows a friendly
  inline message (`supportsVision` predicates in Bridge.cpp / sidepanel.js) —
  never a silent drop. Keep the desktop/extension predicates in sync.

## New subsystems (2026-07-06) — Proxmox workload manager gotchas

- **ApiBrain 429 no longer means instant fail.** Credential-pool rotation
  (item 5 above) still happens first; ONCE THAT'S EXHAUSTED, a session with
  `Options::maxBackoffRetries > 0` now backs off (exponential + full jitter,
  `ApiBrain::backoffDelayMs`) and retries the whole pool again, up to that
  many times, before genuinely erroring the turn. Default 0 preserves
  today's interactive-session behavior; only the Proxmox agent's scheduled
  session opts in (see `docs/PROXMOX_WORKLOAD_MANAGER.md`).
- **`proxmox.*` is desktop/TUI/web only, same rationale as `outpost.*`.**
  It IS an `outpost.exec` proxy under the hood (no new transport), so it's
  rejected at the phone/device channel boundary in `DeviceServer.cpp`
  identically to `outpost.*` — don't remove that check if you touch either.
- **`proxmox.restart_vm` is the ONLY code path that runs `qm reboot`,
  anywhere in this feature.** The scheduled agent's own tool catalog
  (`proxmox-mcp/tools_proxmox.py`) never registers a VM-power tool at all —
  this is enforced structurally, not by prompting. Preserve this invariant
  if you touch `proxmox_tune` or `handleProxmoxRestartVm`. (2026-07-09:
  the catalog DOES gain `proxmox_guest_service`, which can start/restart a
  *service inside a guest* — see the 2026-07-09 VM-scout gotchas below for
  why that's not an exception: it has no stop verb and `scout.py` refuses
  any name that looks like a systemd power/sleep target.)
- **`proxmox.report` is sync-then-recall, not a blind recall.** The remote
  agent's memory lives in ITS OWN sqlite db on the Proxmox host (durable
  independent of the laptop); the RPC pulls rows newer than the newest
  `created` already present locally for that agent (self-describing
  watermark — no separate watermark file) into the laptop's own
  agent-scoped memory, THEN searches. Calling `handleMemorySearch` directly
  for a `proxmox-*` agent without syncing first will look empty/stale.
- **`SessionRow::targetRef` is new plumbing, not decorative.** It didn't
  reach `makeBrain` at all before this — `fireScheduledJob` dropped
  `ScheduleRow::targetRef` on the floor. If you add another schedule-fired,
  non-default-engine session type, reuse this field/column rather than
  inventing a second one.
- **`outpost.install_workload` fetches jarvisd from a GitHub Release, not a
  transferred binary.** A plain AppImage is ~300MB — far past what
  `writeRemoteFile`'s base64-over-exec is for. The remote host `curl`s the
  latest release via the GitHub API and `--appimage-extract`s it itself; only
  small text (config/secrets/systemd units) goes through writeRemoteFile.
  Verified end-to-end against a real paired host (config/secrets seeding),
  but the fetch-from-release step needs an actual release to exist — it
  can't be exercised until this ships to `main` and a release is cut.

## New subsystems (2026-07-09) — Windows field-bug wave gotchas

- **The take-over banner/glow only auto-arms off `agent_bus` publishes, and
  Windows wasn't making them.** Linux's real-screen mouse primitives
  (`computer_use_mcp/input.py`) call `agent_bus.publish(..., session="real")`
  on every move/click/drag/scroll; the desktop tails that bus
  (`Bridge::readPointerTail`) to flip `driving=true`. `windows/engine/
  backend_windows.py` reimplements the same primitives via Win32 `SendInput`
  but is a SEPARATE module (monkeypatched over `input.py` by
  `server_windows.py`, not a subclass) — it must publish to `agent_bus`
  itself; nothing does that for it automatically. If you add a new Windows
  input primitive, publish to `agent_bus` there too (mirror `_pointer_session()`
  for the `which=="agent"` vs real-screen tag).
- **`SendInput` can report success while the cursor never moves — verified
  live, root cause unconfirmed.** Dangerous because `click()`/`drag()` fire
  button-down/up as a SEPARATE zero-relative `SendInput` call that lands
  wherever the cursor CURRENTLY is, so a swallowed move silently misdirects
  the click. `backend_windows._mouse_move_abs()` now reads back
  `GetCursorPos` and falls back to `SetCursorPos` on a mismatch (>2px) —
  keep this readback if you touch that function; it's the only defense
  against a whole class of "clicks land somewhere else" reports.
- **MSVC's classic preprocessor cannot parse a bare `#ifdef` inside a macro
  call's argument list.** `QStringLiteral("a" #ifdef X "b" #endif "c")`
  fails with `C2121: '#': invalid character` — GCC/Clang tolerate this,
  MSVC's default (non-`/Zc:preprocessor`) one doesn't. Any per-platform text
  embedded in a `QStringLiteral`/similar macro call (e.g. the co-work
  preamble's `widget_live` CPU example in `ControlServer.cpp`) must be
  hoisted to its own `#define WHOLE_ARG ... #else ... #endif` BEFORE the
  call, used as a bare token inside it, then `#undef`'d after.
- **`<iphlpapi.h>`/`<netioapi.h>` (`GetIfTable2`, used for Windows NET stats
  in `Bridge::pollStats`) need `<winsock2.h>` + `<ws2tcpip.h>` included
  FIRST.** This repo sets `WIN32_LEAN_AND_MEAN` globally (`posix_compat.h`,
  force-included into every Windows TU), which stops `<windows.h>` from
  pulling in legacy Winsock — so unlike a default Windows build, you must
  add those two includes yourself before any iphlpapi-family header, or
  `MIB_IF_TABLE2`/`GetIfTable2`/etc. are silently "undeclared identifier"
  with no hint about the real cause.
- **`Bridge::pollStats()` is a SHARED file (`desktop/src/Bridge.cpp`,
  referenced read-only by `windows/CMakeLists.txt`), not a windows/-only
  copy** — unlike `WindowController`/`AgentDesktop`/`PluginSandbox`, which
  get COPY-and-edit Windows variants under `windows/shell/`. Its CPU/RAM/NET
  stats are `#ifdef Q_OS_WIN` branches inside the one function, not a
  separate file. Follow that same pattern (guard in place, not a new copy)
  for future additions to this function — a copy would drift from the Linux
  `/proc` path silently.
- **The `widget_live` command example in the co-work preamble is
  platform-conditional now** (`ControlServer.cpp`, `JARVIS_LIVE_CPU_CMD_EXAMPLE`)
  — Linux gets `top -bn1 | awk …`, Windows gets a `Get-Counter` PowerShell
  one-liner, because `widget_live`'s `command` runs through
  `subprocess(shell=True)` (`/bin/sh` vs `cmd.exe`) and a Linux pipeline
  silently produces no `{{value}}` on Windows ("no data" widget). If you add
  another OS-specific example to that preamble, mirror this pattern — don't
  give the model a single-OS example it'll copy verbatim regardless of what
  Cindro is actually running on.

## New subsystems (2026-07-09, Outpost re-pair + Proxmox deploy) — gotchas

- **Re-pairing a machine with a live agent used to be impossible** — the
  install script downloaded straight onto the running binary (ETXTBSY /
  locked exe). The templates in `outpost-mcp/outpost_mcp/pairing.py` now
  stage-and-swap; `tests/test_pairing.py` pins the load-bearing shape
  (staged download, exact-match `pkill -xf`, stop-before-start ordering, no
  `$_.Path` reads on Windows). Don't "simplify" any of those back out — each
  one was a verified live failure.
- **`/pair/complete` REPLACES same-name registry rows** (`server.py`). The
  registry's `get()` returns the first id-or-name match, so appending on
  re-pair left a dead duplicate shadowing the new machine forever. Two
  DIFFERENT hosts that share a hostname will evict each other — name
  machines uniquely when pairing.
- **`pkill -f "<path>"` over `ssh host '<cmd>'` kills the remote shell
  itself** — the pattern substring-matches the shell's own command line;
  ssh dies with exit 255 and looks like a connection failure. Use
  `pkill -x <name>` / `pkill -xf <exact-cmdline>` in anything remote-exec'd.
- **The GitHub repo is PRIVATE — nothing remote can anonymously clone it or
  fetch release assets.** `outpost.install_workload` needs a `github` API
  key configured locally (Settings → API keys); it rides to the host as a
  0600 file read via `GIT_ASKPASS` (never argv), and release assets come
  through the authenticated assets API (`browser_download_url` 404s with a
  token on private repos).
- **Release AppImages built on the Fedora CI box (glibc 2.43) do NOT run on
  a Debian-trixie Proxmox host (2.41)** — jarvisd + Qt only need ≤2.38; the
  linuxdeploy-swept distro extras (glib/libssh/libcrypt/samba/ffmpeg) are
  the problem. Workaround (applied on pve, see
  `docs/PROXMOX_WORKLOAD_MANAGER.md` troubleshooting §7): quarantine
  bundled libs whose max GLIBC exceeds the host's, keep bundled
  `libsasl2.so.3` (Debian's soname is `.so.2`) with a
  `libcrypt.so.2 → .so.1` symlink, and move the glib family as ONE unit
  (mixing bundled gobject with system glib aborts on `g_string_copy`). Real
  fix: pin the CI AppImage build to an older baseline image.
- **The workload-manager schedule seeder ships in-repo**
  (`proxmox-mcp/packaging/seed_schedule.py`, idempotent) — never hand-roll
  `schedule.create` JSON. **2026-07-10: no longer a manual step at all** —
  `outpost.install_workload` runs it itself, detached, via `outpost.exec`;
  the manual venv-python invocation is now only a fallback for when the
  automatic seed doesn't stick (see the 2026-07-10 gotchas below).

## New subsystems (2026-07-14) — iOS app (`iphone_app/`) gotchas

The iOS app is a **structural port of `android/`** — when you change the phone protocol or a
device-facing daemon method, update BOTH `android/` and `iphone_app/` (they're peers, not one
derived from the other). Load-bearing truths:

- **The wire contract is identical to Android and must stay byte-compatible.** The daemon can't
  tell the two clients apart beyond the `name` in the `hello` frame. Ed25519 is CryptoKit
  `Curve25519.Signing` (bare 32-byte pubkey, 64-byte detached sig — same shape libsodium
  `crypto_sign_verify_detached` wants, the reason Android uses Tink's raw primitive); device id =
  `sha256(pubkey)` first-16-hex. If you change the handshake or an envelope field, change it in
  `android/`, `iphone_app/`, AND the daemon together.
- **Parsing DEFAULTS must match Android exactly** — they're not cosmetic. `McpServer.enabled`
  defaults **true**, `TrustRule.action`/`TrustPolicies.default` default **"allow"**,
  `createSession` sends `profile="coworker"` + `brain="codex"`. A mismatch makes the same daemon
  payload render opposite toggle/guardrail state on iPhone vs Android (a real bug caught in the
  first code review). The `JSONObject` helpers deliberately use `CFBooleanGetTypeID` so a JSON bool
  never reads as an int and vice-versa (JSONSerialization boxes both as `NSNumber`).
- **The `.xcodeproj` is GENERATED, never committed** (`project.yml` → `xcodegen generate`), the same
  discipline as the Android app being pure-Gradle: a hand-edited pbxproj drifts. CI runs
  `xcodegen generate` before every `xcodebuild`.
- **`ios-build.yml` runs on GitHub-hosted `macos-latest`** — the one sanctioned exception to the
  "100% self-hosted / zero GitHub-hosted minutes" rule below (`website-ci.yml`/`android-build.yml`
  moved to the self-hosted fleet too — see that section), because iOS needs Xcode on macOS and
  the Proxmox fleet is Windows + Linux only. The owner opted into the Actions minutes. It rides the
  SAME `v*` tag `auto-release.yml` already creates, so merge-to-main attaches an **unsigned** `.ipa`
  next to the `.exe`/`.apk`/AppImage with no tagger change. Signed TestFlight/App Store builds need
  Apple signing secrets (not wired yet).
- **iOS platform gaps that are NOT parity bugs** (documented in `iphone_app/README.md`): no
  persistent background socket (Android's `dataSync` foreground service has no iOS equivalent — real
  push needs APNs, which the daemon's build-gated-off `push.register` path would drive); no
  always-listening "Hey Cindro" wake word; the `render_widget` DSL renderer and full voice UI are
  tracked follow-ups (the repository methods for them are already wired).
- **Authored without a Mac** — the first `xcodebuild` in CI is the first real compile. Don't assume a
  green local state; treat CI (and a device smoke test) as the source of truth until it's built once.

## Branches & flow

Three long-lived branches; **`main` is protected** (PR-only, no direct pushes, no
force-push, no deletion). Promote up, never push straight to `main`:

```
work on dev  →  push  →  test  →  promote dev → qa  →  test  →  PR qa → main  →  merge
```

Do day-to-day work on **`dev`**. When it's good, fast-forward/merge into **`qa`** and
test. When qa passes, open a **PR into `main`** and merge it. Never commit directly to
`main` (the branch protection will reject it). `website/` follows the exact same flow —
it just has its own lightweight `website-ci.yml` gate instead of the platform build
workflows, and a website-only merge is deliberately excluded (`paths-ignore`) from
triggering `auto-release.yml`'s version bump (see below).

## GitHub / CI / releases (how Issac runs this repo)

- **CI is 100% self-hosted for the product build workflows — ZERO GitHub-hosted minutes.**
  Windows builds run on `win-runner-1` (the winvm / Proxmox VM 106 box); Linux CI/release/
  auto-release/website-ci/android-build all run on the six `pve-ubuntu-runner-*` (VM 104, raw
  Ubuntu host — only linux-ci/linux-release additionally run inside the baked `jarvis-ci`
  container via `container:`, since website-ci/android-build's toolchains (PHP/Node/JDK/Android
  SDK) come from their own setup actions instead). **Never** switch one of these six workflow
  files to `windows-latest` / `ubuntu-latest` — they use `runs-on: [self-hosted, …]`.
  (`ios-build.yml` is the one sanctioned GitHub-hosted exception — see above; `website-ci.yml`/
  `android-build.yml` moved off `ubuntu-latest` once GitHub-hosted minutes ran out, so what were
  GitHub-hosted-only tools now get provisioned per-run: `android-actions/setup-android` for the
  Android SDK, `shivammathur/setup-php` + `actions/setup-node` for PHP/Node — same as before, just
  running on the self-hosted fleet instead.) The Windows
  runner is **prebuilt** (git, vcpkg + libsodium/libqrencode, Inno Setup, VS Build Tools,
  PowerShell 7, Python, Qt, Ninja, CMake, Node) via `windows/scripts/setup-runner-*.ps1`, so
  the workflow does **no per-run tool downloads** (mirrors the Linux prebuilt CI image). After
  a winvm reboot the runner service may need `Start-Service "actions.runner.CrazyMan28-jarvis.win-runner-1"`
  (or `sc.exe start …`); it does not always auto-start after a hard power cycle.
- **Releases are automatic: merging to `main` = a new release.** `auto-release.yml` finds the
  highest `vX.Y.Z` tag, bumps the **patch**, and creates that tag → `windows-build` +
  `linux-release` fire on the tag and attach `Cindro-Setup-<ver>.exe` + the AppImage to a new
  GitHub Release. **Do NOT hand-edit a version number** to cut a release. (Want a minor/major
  bump? cut the tag yourself, e.g. `gh release create v0.13.0`; auto-bump continues from it.)
  Requires the `RELEASE_PAT` repo secret — a `GITHUB_TOKEN`-created tag can't trigger the
  release builds (GitHub anti-recursion).
- **Agents open PRs; the USER merges to `main`.** Never merge a PR to `main` yourself — open it
  with an honest body (what's proven vs. what needs a live box) and leave it for Issac.
- **When CI goes red, READ THE ACTION LOG and fix — never guess.** `gh run view <id> --log-failed`.
  (e.g. a self-hosted Windows runner lacks `bash`/`pwsh`/CMake/ExecutionPolicy that hosted
  runners have — fix the runner or the workflow, don't paper over it.)
- **Windows-edition changes stay under `windows/` ONLY** — never `core/` / `daemon/` / `desktop/`
  / `computer-use/`. A cross-platform bug fix that's *motivated* by Windows lives in the shared
  dirs (there is no separate Windows UI), but it must be a no-op on Linux and build-verified.
- **Self-hosted Windows runner (`win-runner-1`) recovery — learned the hard way:**
  - **After ANY winvm reboot, the clock skews (~hours off) → the runner's OAuth session tokens
    are rejected → it loops "registration has been deleted, please re-configure" even after you
    re-register.** FIX THE CLOCK FIRST: `w32tm /resync /force` (config a manual peer if needed),
    then `Restart-Service actions.runner.CrazyMan28-jarvis.win-runner-1`. Clock skew masquerades
    as a registration problem — check `Get-Date` vs real time before re-registering.
  - **A runner offline too long (e.g. during a Windows Update) gets AUTO-DEREGISTERED by GitHub.**
    Re-register with `config.cmd remove --token <remove-token>` then `config.cmd --url … --token
    <reg-token> --name win-runner-1 --labels jarvis-win --runasservice --unattended` (tokens:
    `gh api -X POST repos/CrazyMan28/jarvis/actions/runners/{registration-token,remove-token}`).
    `--replace` alone does NOT reconfigure a locally-configured runner — you must `remove` first.
  - **winvm's `build.ps1` takes ~40 min** (compile + PyInstaller + npm + Inno on limited cores) —
    that is NORMAL, not a hang. Don't cancel/reboot before ~45 min.
  - **When SSH is flaky (loaded host), reach winvm via the QEMU guest agent:**
    `ssh pve 'qm guest exec 106 -- powershell -NoProfile -Command "…"'`.

## New subsystems (2026-07-09, VM scout + profiles + Pinged) — gotchas

The Proxmox workload manager grew agentless guest scouting (QEMU guest agent /
`pct exec`), per-VM `JARVIS.md` profiles, an agent→user interview mailbox, a
user→agent task mailbox (`proxmox.ask_agent` + run-now kick), and "Pinged"
watch rules. See `docs/PROXMOX_WORKLOAD_MANAGER.md` for the design; these are
the load-bearing truths:

- **`systemctl` is in `_GUEST_EXEC_DENYLIST` — the scout batteries deliberately
  list services from `/sys/fs/cgroup/*/system.slice` instead. NEVER weaken the
  denylist to make a battery nicer.** The ONE sanctioned bypass is
  `scout.guest_service()` → `proxmox_ops._exec_via_agent_unchecked` /
  `scout._pct_exec_unchecked`: argv built in code from a regex-validated
  service name and a closed verb set {start, restart, status} — deliberately
  no `stop`, no power verbs. **The name regex ALONE is not enough** — a
  syntactically valid unit name like `poweroff.target` is a full VM-power
  bypass, so `scout._service_dangerous()` separately refuses anything ending
  `.target` or matching a power/sleep denylist (`poweroff`, `reboot`, `halt`,
  `shutdown`, `emergency`, `rescue`, `sleep`, `suspend`, `hibernate`, …) — a
  bug found and fixed 2026-07-10, tested in
  `test_guest_service_rejects_power_targets`. Never expose the `_unchecked`
  functions to a tool that accepts caller-supplied argv.
- **Every long host-side operation must run detached** (`setsid … & echo ok`):
  `outpostHttp` has a hard 60s event-loop wall and outpost-agent caps exec
  output at 256KB. That's why the fleet scout is a console script
  (`proxmox-scout`) writing `scout_status.json`, not an RPC that streams.
- **Free text NEVER rides inline in a remote command.** Answers/tasks are
  base64-appended (like directives); pinged rules travel as a base64 JSON
  payload file run through the HOST's own `pinged_store` (one validator, no
  C++ re-implementation); `proxmox.agent_reply` fetches ALL replies and
  filters daemon-side because the rid is caller-supplied.
- **Daemon one-liners: double quotes INSIDE, single quotes OUTSIDE** (the
  whole `python3 -c '…'` body is single-quoted for `sh`). One stray `'`
  inside the python breaks the shell quoting — same discipline
  `handleProxmoxStatus` established.
- **`update_observed()` must preserve user sections byte-for-byte** — a
  re-scan that eats `## Purpose`/`## Preferences` silently undoes the whole
  interview flow (unit-tested in `test_profile_store.py`).
- **Pinged schedule dueness is decided in code** (`pinged_store.due_rules`:
  due when past today's HH:MM and `last_checked_at` < today's trigger), and
  `proxmox_record_pinged` must be called for every handled rule **fired or
  not** — recording is what stops a daily rule re-firing every 5-minute tick.
- **The notification poll dedupes via `<data>/proxmox_seen_notifications.json`**
  (`machine:qid|eid`), pruned only for machines actually reached that round —
  pruning on an unreachable machine would re-ping everything when it returns.
  **UI reads (`proxmox.questions` / `proxmox.pinged_list`) deliberately do
  NOT mark seen** — "Outpost page + inbox ping" means BOTH, and marking seen
  on read would let anyone with a dashboard open silently never get the
  promised phone ping. `handleProxmoxAnswer` is the one exception (an
  answered question is genuinely resolved, so it marks that qid seen so it
  isn't re-pinged). Inbox pings go through the phone proxy and silently skip
  when `phone.env` is absent.
- **`registerProxmoxMachine` is called from EXACTLY TWO places**:
  `outpost.install_workload` (preflighted with a real `qm`/`pvesh` check) and
  `proxmox.status` when its python one-liner's `has_proxmox` flag (a real
  `shutil.which("qm") and shutil.which("pvesh")`) is true. No other
  `proxmox.*` handler self-registers — most of those execs succeed on ANY
  paired machine with python3 (empty jsonl files just read back as `[]`),
  which proved nothing and would silently enroll ordinary laptops in a
  forever, un-removable 5-minute remote-exec poll (found and fixed
  2026-07-10). Don't add a `registerProxmoxMachine` call to a handler unless
  its success genuinely proves the workload manager is installed.
- **`seed_schedule.py` is an upsert now** — rerunning it updates the tick
  prompt in place; that + re-running `outpost.install_workload` (sparse clone
  tracks `main`, so the host only gets MERGED code) is the whole upgrade path
  for an existing install. `websockets` became a real proxmox-mcp dependency
  (the kick helper needs it) — no more manual pip step.
- **`scout_status.json` is also the concurrency lock**: `running` is only
  believed while `started_at` <30min AND the recorded pid is alive — a killed
  runner never wedges scouting; don't "simplify" the pid check away.

## New subsystems (2026-07-10, live install chat + auto-seed) — gotchas

`outpost.install_workload` now opens a live, interactive Cindro chat (scout +
interview right in the conversation) and auto-seeds the tick schedule instead
of leaving it a manual step. Found by directly reading `createSession`'s
internals during review — not by trusting an earlier research pass that
missed both of these:

- **NEVER pass `profile="coworker"` to `createSession` for a headless/tool-
  only session.** `createSession` defaults `target` to `"agent"` whenever
  `profile=="coworker"` and no explicit target is given, which triggers
  `AgentDesktop::ensure()` — a full nested Sway/Wayland compositor + a
  per-session computer-use engine, ~45-60s blocking on the daemon's main
  thread — for a session that will never drive a screen. The install-chat
  session (and `fireScheduledJob`'s recurring tick, its longstanding
  precedent) both use an **empty** profile (→ `"coder"` default) precisely
  to avoid this.
- **`createSession`'s `autoComputer` auto-spawn gate now excludes any
  `scheduleTargetRef`-routed session** (`ControlServer.cpp` ~2261,
  `scheduleTargetRef.isEmpty()` added to the condition). Without this, ANY
  session routed via `scheduleTargetRef` — not just the new install-chat one,
  but the pre-existing recurring proxmox tick too — would auto-provision the
  same expensive nested desktop whenever the user's global "let Cindro use a
  computer" setting happens to be on, since that setting alone was enough to
  trigger it for literally any session before this fix. If you add a new
  kind of `scheduleTargetRef`-routed session, this exclusion already covers
  you; don't re-litigate it per-caller.
- **`createSession` unconditionally broadcasts `session.opened` to every
  connected client** for any top-level (non-subagent) session — this is NOT
  something a caller opts into. Desktop's own handling of that broadcast is
  deliberately raise-only for any client that didn't explicitly open the
  session itself (`Bridge.cpp` ~3745, `sessionFocusRequested` vs.
  `sessionOpened`) — it never steals another window's active chat. Don't
  add a second "notify the UI a session was created" mechanism assuming
  `createSession` is silent; it isn't, and the existing raise-only design is
  already the answer to "don't hijack other windows."
- **Long-running best-effort exec steps inside `handleOutpostInstallWorkload`
  should be detached** (`setsid … & echo started`, matching the scout kick),
  not awaited, when nothing downstream actually reads the result — the
  schedule-seed step was awaited for up to 25s for no reason before this was
  caught; every extra awaited step there adds straight to the install RPC's
  latency and delays the live chat the user is waiting to land in.
- **A best-effort step's failure must be surfaced in the install `note`, not
  just `qWarning`** — the install response is the ONLY thing telling the user
  what actually happened; a `qWarning`-only failure for something the note
  otherwise implies succeeded ("Initial VM scout started...") is invisible
  to anyone who isn't tailing the daemon's log.
- **Desktop `outpost.install_workload` fires and returns in under a second on
  a failure path** (e.g. no `github` key configured → the private-repo clone
  fails immediately) — a fast failure reads as "nothing happened" if the only
  feedback is the exec console further down a long page. Fixed 2026-07-10:
  `OutpostPage.qml`'s machine row now shows the install result inline on
  itself (`page.lastInstallResult`), not just in the console. If you add
  another install-adjacent action with its own failure mode, give it the
  same treatment — don't rely solely on a scrollable log for a result the
  user is actively waiting on right after clicking a button.

## New subsystems (2026-07-11) — dynamic model discovery

`modelsForBrain()` (`daemon/src/ControlServer.cpp`) was a hardcoded array of
codex/claude model ids per brain, feeding the `model.list` RPC every client
surface (desktop/Android/web/TUI/CLI/extension) already just renders — so it
went stale every time OpenAI/Anthropic shipped a model, and `coerceModelForBrain`
(the cross-brain-mismatch guard) would silently discard a valid-but-unlisted
model a session tried to use.

- **codex has a real (if unofficial) catalog command: `codex debug models
  --bundled`.** Live-verified (codex 0.144.1) shape is a top-level JSON
  OBJECT with a `"models"` array of `{slug, visibility, ...}` — NOT a bare
  array, which an earlier draft of this feature assumed from research alone
  and only caught by actually running the command and watching `model.list`
  silently fail to pick up new entries. Parsing lives in
  `jarvis::parseCodexModelCatalog` (`core/src/ModelCatalog.cpp`), filtering
  out `visibility:"hide"` entries, and fails open (`ok=false`, keep the
  static list) on ANY shape mismatch — this is an undocumented debugging
  subcommand with no stable spec to trust blindly.
- **claude has no CLI list-models command, but the CLI's own OAuth session
  can call the PUBLIC, documented Anthropic Models API directly.** `GET
  https://api.anthropic.com/v1/models` accepts the Claude Code OAuth bearer
  token (read from `.credentials.json`'s `claudeAiOauth.accessToken`) with
  `anthropic-beta: oauth-2025-04-20` (the same header a third-party plugin,
  `CrazyMan28/claude_knows`'s `bin/ck-usage`, already uses in production
  against the sibling `/api/oauth/usage` endpoint for Claude Code's own
  `/usage` command) plus the standard `anthropic-version` header every `/v1`
  call needs. **Must read the token from `m_settings.claudeConfigDir()`**
  (the SAME pro/max-account resolver `ClaudeBrain` itself is spawned with) —
  an earlier draft tried `CLAUDE_CONFIG_DIR` / `~/.claude` /
  `~/.claude-secondary` in a fixed fallback order, which can silently pick a
  DIFFERENT account's token than the one actually driving the CLI (stale Pro
  credentials on disk while the setting is "max"), reintroducing the exact
  ambient-`CLAUDE_CONFIG_DIR` bug `ClaudeBrain`'s own `configDir` default was
  written to prevent.
- **Fetches are async and TTL-cached, never blocking.** `ControlServer` runs
  on ONE event loop that also pumps every connected brain's process I/O — a
  blocking spawn/HTTP call in `model.list`'s handler would stall live chat
  streaming for every connected surface, not just whoever opened a dropdown.
  `refreshLiveModelCatalog()` answers instantly from whatever's cached
  (300s TTL on success, 30s on failure) and kicks a background refresh;
  `handleModelList`'s `force` param drops the TTL guard for a manual
  refresh. `coerceModelForBrain` (converted from a free function to a
  `ControlServer` member so it can read the cache) and `settings.get`'s
  `models_by_brain` (the Settings page's default-model dropdown) both read
  the same merged cache — don't let either regress back to the static-only
  list, or they'll drift from what `model.list` shows the chat picker.
  `firstModelForBrain()` deliberately keeps reading the STATIC list, not the
  merged one — live entries are always appended, never prepended, so a
  brand-new/possibly-preview model becoming selectable never silently
  changes what a fresh session defaults to.
- **The codex child process's stderr MUST be drained**, even though only
  stdout is parsed — `debug models` is unofficial and could write more than
  the OS pipe buffer to stderr; with `SeparateChannels` and nothing reading
  that pipe, the child blocks on the write and never exits (the bounded
  timeout still catches it, but every call would eat the full timeout
  instead of a live catalog).
- Parse/merge logic (`parseCodexModelCatalog`/`parseClaudeModelCatalog`/
  `mergeModelCatalogs`) lives in `core/src/ModelCatalog.cpp`, not inline in
  `ControlServer.cpp`, specifically so it's unit-testable
  (`core/tests/model_catalog_test.cpp`) without a full `ControlServer`
  instance — daemon stays thin, business logic stays in `core/`, per this
  file's own Conventions section below.

## New subsystems (2026-07-11) — cross-surface security + bug hardening wave

A full-repo review (all surfaces + cross-surface contracts) landed a batch of
feature-preserving fixes. These are the load-bearing invariants — don't
regress them:

- **The DeviceServer (phone/tailnet :8796) channel is allow-by-family-minus-
  denylist, and the denylist is security-critical.** `dispatchAuthed()` rejects,
  at the channel boundary, methods that are legitimate over the loopback control
  channel but must never be driven from a paired phone: `outpost.*`/`proxmox.*`
  and `schedule.webhook_token` (pre-existing), plus **`hooks.*`** (HookStore does
  unsandboxed `sh -c` → RCE), **`file.push{path}`** (arbitrary host-file read;
  the `path` source is rejected over the device channel via the new `remote` flag
  threaded through `ControlServer::dispatchConfigMethod` — phones must send
  `b64`), **`devices.revoke`** for any id ≠ the caller's own (self-unpair only),
  and **`diff.*`** (runs real `git commit`/`push`/`gh pr create` on the host).
  A new config/ops method that can write host state MUST be added to this reject
  set if it isn't safe for the phone.
- **Daemon-side gated approvals use a random, registry-tracked id, never a
  pattern.** `m_pendingApprovals` (random `takeover-`/`inject-`-prefixed ids +
  sessionId + TTL) is the authority: `respondApprovalFor()` only honors an id
  that is actually pending for that exact session, so a forged/enumerated
  `takeover-<sid>` can't arm real-screen take-over. `reapPendingApprovals()`
  prunes expired + dedups per (session,kind) before each insert so the map can't
  grow unbounded. Don't revert to `startsWith("takeover-")` matching.
- **Never block the daemon's single Qt event loop.** The pairing brute-force
  throttle (`PairingManager::consume`) is a purely non-blocking counter+cooldown
  (5 fails → drop pending codes + 30s cooldown) — it must NOT `QThread::msleep`
  (that froze every client = trivial DoS). Same rule the async model.list work
  established; the PIN gate (`m_pinLockedUntilMs`) and outpost timeout clamp
  (`qBound(60000, …, 600000)` so a caller `timeout` can't pin `outpostHttp`'s
  nested loop open) follow it. Successful pairing is now `audit.record`ed.
- **The permission/mode/trust-policy preamble fires once per NON-subagent
  session (`m_policyGuided`), independent of whether an agent desktop exists.**
  Previously it was gated behind the co-work screen-targeting guide, so
  computer-off / scheduled / background sessions silently got zero ask-before-
  risky guidance while Settings showed "Cautious". Keep the screen-targeting
  guide gated on `m_agentDesktops.has()`; keep the policy clauses ungated.
- **Brain context resumes after a respawn.** `CodexBrain::Options.resumeThreadId`
  / `ClaudeBrain::Options.resumeSessionId` are seeded by `makeBrain()` from
  `row.threadId` so a second turn on an existing session continues the CLI's
  thread instead of starting a fresh model conversation. **ApiBrain history
  replay is deliberately deferred** (a TODO stub — needs human review to avoid
  resending unresolved tool_calls); don't "finish" it blindly.
- **Trust-policy glob parity is now testable, not hand-waved.**
  `TrustPolicyStore::globMatch` passes `QRegularExpression::NonPathWildcardConversion`
  and neutralizes a leading `^` inside `[...]` so it matches Python `fnmatch`
  (the engine's real enforcement in `policy.py`). A shared fixture
  `core/tests/fixtures/trust_policy_vectors.json` is consumed by BOTH
  `core/tests/trust_policy_test.cpp` and `computer-use/tests/test_policy.py` —
  add divergent cases there, keep both readers in sync.
- **Model-authored content is scheme-gated at every render sink.** The widget
  `image` node applies a `{data:image/, http:, https:}` allow-list on ALL four
  surfaces (desktop QML, web TSX, Android, **and the extension** — the extension
  was the one missed in the first pass); the extension `svg` node is sanitized
  (no raw `innerHTML`). `supportsVision` was inverted to allow-unless-known-text-
  only (was blocking the api-brain default + llava) and ported to Android
  (`VisionSupport.kt`). Keep these predicates/allow-lists in sync across
  surfaces — there's no shared wire format, only the same rule copied.
- **Android Contract C hardening:** envelope/event frames are dropped until
  `authed==true` (`DeviceClient`), so a pre-handshake host can't push a spoofed
  `auth.challenge`; the QR-pinned `daemonFingerprint` is the trust anchor and is
  **compared, never overwritten** by the plaintext pairing ack (TOFU only when no
  pin exists); Agents create/dispatch/remove is biometric-gated client-side; the
  plaintext keystore-fallback secret is excluded from backup. The daemon proves
  its identity by echoing `fp` in the reconnect ack (field name is exactly
  `"fp"`).
- **chmod-hardening has two flavors — pick deliberately.** `config.toml`'s 0600
  is **best-effort** (already durably committed; a chmod failure logs a warning
  but must NOT fail `saveConfig()`, or it spuriously aborts callers' follow-up).
  The claude per-turn `--mcp-config` temp file (holds a live bearer) is
  **fail-closed**: it's chmod'd 0600 on the empty file BEFORE the secret is
  written, and on failure the MCP config is dropped for that turn rather than
  handed over world-readable.
- **Windows copies must mirror new core methods.** `PluginSandbox::isSandboxed`
  was added to `core/src/PluginSandbox.cpp` AND the Windows copy
  `windows/shell/PluginSandbox.cpp` (returns `false` there — Windows plugins run
  the weaker plain-QProcess fallback, which is the honest state the visibility
  audit wants). A new method on a COPY-variant class (WindowController /
  AgentDesktop / PluginSandbox) needs the same mirror or the Windows build won't
  link (compile-only checks miss it — link `jarvisd` to catch it).

## New subsystems (2026-07-12) — Android drawer redesign gotchas

The Android app's bottom-tab bar + Home dashboard were replaced with a
Claude/ChatGPT-style navigation drawer + chat-first launch (see `docs/STATUS.md`
for the feature writeup). Load-bearing details found the hard way, in code
review, before this ever ran on a device:

- **Every non-pairing/non-approve route MUST go through `Gated()`** (bottom of
  `android/app/src/main/java/com/cindro/app/ui/AppNav.kt`) — the same
  `appUnlocked` biometric app-open check `CHAT_HOME`/`CHAT` apply inline.
  `appUnlocked` is plain `remember` state, not `rememberSaveable`, so it resets
  to locked on process recreation; Navigation-Compose's saved back stack can
  restore straight onto a non-start destination after process death, and a
  route with no `Gated()` wrapper renders its private content with zero gate.
  A NEW top-level route added to this graph needs `Gated()` too — this is easy
  to forget since the old `Shell()` was a single gate point for six screens at
  once and that's gone now.
- **Drawer destinations are pushed FROM chat, not siblings under one shared
  start like the old bottom tabs were.** The `onNavigate` callback in both the
  `CHAT_HOME` and `CHAT` composable blocks does
  `nav.navigate(route) { popUpTo(entry.destination.id) { inclusive = false }; launchSingleTop = true }`
  — popping back to THIS chat entry before pushing, so repeated drawer hops
  never grow the back stack past `[chat, oneDestination]`. This relies on the
  drawer only ever being reachable from a chat screen (it isn't rendered on
  Sessions/Canvas/etc.) — if you add a drawer to another screen, its
  `onNavigate` needs the same `popUpTo(thatEntry.destination.id)` pattern, not
  a bare `launchSingleTop`.
- **`PendingFirstMessage` (`android/app/src/main/java/com/cindro/app/ui/chat/ChatModels.kt`)
  is a one-shot, single-slot global handoff — NOT a queue.** `NewChatScreen`
  has no session id to send against until `session.create` returns, so it
  stashes the typed draft/photos keyed by the new session id;
  `ChatViewModel.init()` consumes it (a normal `send()` call — same optimistic
  bubble/haptics/slash-command handling as any other message). Because it's a
  single overwritable slot, `NewChatScreen` must never let two `createSession()`
  calls race (that clobbers slot 1 with slot 2's session id, and session 1's
  `consume()` returns null — a silent "ghost" empty session) — guarded by
  checking `state.creating` before firing `sendFirst()`/`startVoiceChat()`, and
  by the mic button no longer firing while a draft/attachment is already
  pending. Don't add a third path that can call `createSession()` from
  `NewChatScreen` without the same guard.
- **Promoting a screen out of a gated shell into a top-level route also drops
  its "how do I get back" story if you don't add one.** Sessions/Canvas/
  Computer/Phone/Settings used to be bottom tabs (no back concept needed);
  they're pushed routes now, each with its own `onBack` param wired to
  `nav.popBackStack()` and a `navigationIcon` back arrow — a screen promoted
  the same way in the future needs the same treatment, not just a route entry.
- **The Home/`NewChatScreen` "coworker" default is a Windows landmine
  (jarvis#107, see `docs/STATUS.md`'s matching bug-fix entry).** Every
  phone-initiated `createSession()` (New chat, Voice, Home) defaults to
  `profile = "coworker"` with no `target` override, which
  `ControlServer::createSession()` resolves to `target = "agent"` — an
  EXPLICIT co-work request. On Linux `AgentDesktop::nestedDesktopSupported()`
  is always true so this quietly works; on stock Windows (no `JARVIS_ENABLE_V2`
  opt-in) it's always false, and `createSession()` used to treat that as FATAL,
  so every phone session hard-failed server-side there while the row still
  landed in `jarvis.db` — a red herring that looked like a broken cross-device
  unlock hand-off. Fixed by only treating `ensure()` failure as fatal when
  `nestedDesktopSupported()` is true; otherwise it degrades to the global
  `:8794` engine like the AUTO-computer path already did. Also: `onVoice`/
  `onNewChat`/`startVoiceChat()` now pass `createSession`'s `onError` — it
  didn't before, so this (or any other) `session.create` failure surfaced as
  total silence on the phone.

## New subsystems (2026-07-13) — phone permissions, Twilio verify, call-voice clones

Three Cindro-side enhancements to the native Phone subsystem — **no edits to the
vendored `phone/server`** (see docs/PHONE.md). Load-bearing truths:

- **`PhonePolicyStore` (core) = "what Cindro may do over the phone."** A FIXED
  capability map at `~/.config/jarvis/phone_policy.json` (not glob rules like
  `TrustPolicyStore`). Contract A `phone.policy.list/set/reset/test` — **device-
  exposed** (`isConfigMethod` + `dispatchConfigMethod`). Enforcement is layered
  and the UI badges each capability honestly: **hard** deny at the daemon
  `handlePhoneMcp` choke point (every surface AND the brain's `tools_phone.py`
  funnel through it) + **hard** interactive `ask` at the computer-use `policy.py`
  gate (the ONLY layer with an ask-bus); **config** for `answer_calls` (the daemon
  flips the phone server's screening via `phone.mcp` — `screen_unknown`→enable,
  `allowed_only`→disable, because screening-OFF rejects unknown callers per the
  feature map); **soft/guidance** for `computer_use_on_call`/`access_files` (the
  inbound ext-101 agent runs in the vendored server with no daemon choke point —
  steered only via the seeded `/phone` skill v3 preamble).
- **The tool→capability map is DUPLICATED and must stay in sync**:
  `core/src/PhonePolicyStore.cpp` `buildToolMap()` (C++, daemon deny-gate) and
  `computer-use/computer_use_mcp/policy.py` `_PHONE_TOOL_CAPS` + `_PHONE_CAP_DEFAULTS`
  (Python, brain ask-gate). Billed PSTN tools map to BOTH their per-action cap and
  `spend_money`; `decisionForTool` returns the STRICTER. Two argument-dependent
  refinements mirror across both readers too: `call_user_and_wait` with
  `escalate_to_twilio=true` folds in `spend_money` (its plain in-app path is free),
  and `twilio_screening_enable/disable` are DENIED when they'd contradict the
  current `answer_calls` (so the brain can't desync that policy by toggling
  screening directly — the internal `applyAnswerCallsScreening` push always calls
  the MATCHING tool, so it is never self-blocked). Same drift hazard as the
  trust-policy engine — keep both readers aligned.
- **`phone_policy.json` path must mirror `Config::configDir()`** (JARVIS_CONFIG_DIR-
  aware, NOT XDG). `policy.py` uses `daemon_client.py`'s idiom
  (`os.environ.get("JARVIS_CONFIG_DIR") or ~/.config/jarvis`); using XDG_CONFIG_HOME
  there instead makes the engine read a different file than the daemon under a
  profile and silently fails `ask` OPEN (deny is still caught daemon-side).
- **Twilio Verified Caller ID RPCs are control/loopback-ONLY** (secret-touching,
  like `phone.config`): `phone.twilio_verify_start/status` + `phone.twilio_caller_
  ids_list` read the Twilio auth token from `phone.env` and hit the Twilio REST API
  — deliberately absent from `isConfigMethod`, never on the device channel; the
  token is never echoed. `verify_start` also adds the number to the app allowlist.
- **Twilio form/query values must be percent-encoded** (`QUrl::toPercentEncoding` +
  `QUrl::fromEncoded`), not `QUrlQuery::toString(FullyEncoded)` — the latter leaves
  `+` literal, which a form/query decoder reads as a space, so an E.164 `+1…`
  arrives as ` 1…` and Twilio rejects it.
- **`handlePhoneMcp` takes a `timeoutMs` (default 300000 for `*_and_wait`)** — the
  internal quick pushes (screening config, allowlist add) pass 20s so a half-open
  phone server can't pin the daemon's single event loop for minutes. It returns
  `ok=true` even on an MCP-LEVEL error (tucked in `result["error"]`), so internal
  callers that care must check that key too, not just `.ok`.
- **Mirroring rules honored**: `PhonePolicyStore.cpp` added to BOTH
  `core/CMakeLists.txt` and `windows/CMakeLists.txt`; `PhonePermissionsTab.qml`
  added to `desktop/CMakeLists.txt` QML_FILES (Windows globs `desktop/qml/*.qml`).
  Android is a Cindro-native `ui/phone/PhonePermissions{Screen,ViewModel}.kt` (its
  own drawer destination, `Gated()`), version bumped 0.15.0→0.16.0.

## New subsystems (2026-07-13) — Windows Sandbox v2 real-hardware validation, jarvis#104

First-ever real-hardware run of `windows/shell/AgentDesktop.cpp`'s sandbox tier (CI can't
boot nested Hyper-V, so this path only ever compiled before). Four bugs surfaced, none
reproducible without an actual booting Windows Sandbox VM — see `docs/STATUS.md`'s
2026-07-13 entry for the full writeup. Gotchas worth carrying forward:

- **`WindowsSandbox.exe` is NOT a long-lived process — it exits ~1s after a successful
  launch.** The original design assumed it stayed resident for the sandbox's whole
  lifetime (a plausible mirror of "the process handle IS the boundary," true for the
  Linux nested-Sway twin) and tracked it as the liveness signal for the health/ready
  waiters. Wrong on real Windows: it's a thin launcher that hands the live box off to
  service-hosted `WindowsSandboxRemoteSession`/`WindowsSandboxServer`/
  `vmmemWindowsSandbox` processes and exits. Treating its exit as "the box died" failed
  every real launch on the very first poll. If you ever need to check "is the sandbox
  actually still up," check for those THREE process names, not `WindowsSandbox.exe`
  itself — and expect `vmmemWindowsSandbox` in particular to linger 5-15 minutes after
  teardown even when everything else is cleaned up (a real Hyper-V VM-worker-release
  delay, not a bug to chase).
- **A rendered `.wsb` with anything before `<Configuration>` (XML prolog, doc comments)
  is silently treated as unparseable by Windows Sandbox**, which then boots a bare
  default sandbox with NO `LogonCommand` — no error anywhere, the VM just boots and
  sits there. `jarvisd` runs headless/Session 0 so even a GUI parse-error dialog, if
  one exists, is never seen. Any future edit to `windows/isolation/sandbox/jarvis-agent.wsb.in`
  or its rendering in `AgentDesktop.cpp::ensure()` must keep the emitted file starting
  directly at `<Configuration>` — keep documentation only in the `.wsb.in` source, never
  in the rendered output.
- **`Write-Host` inside anything invoked by Windows Sandbox's `LogonCommand` deadlocks
  forever** — no attached console to drain it in that non-interactive context. Any script
  reached via `LogonCommand` (`bootstrap.ps1` today, anything added later) must log via
  `Add-Content`/`Out-File` only, never a console cmdlet.
- **Don't block the Qt thread that owns an in-process `QTcpServer`/`QTcpSocket` relay**
  (`windows/isolation/relay/ReverseTunnel.cpp`) **with `QThread::msleep()` or similar** —
  that thread's event loop is what accepts incoming connections; blocking it stalls the
  relay even though the underlying kernel-level TCP connect succeeds. Use
  `QEventLoop`/`QTimer` for any polling/delay logic sharing a thread with the tunnel.
- **Update, same day: the `JARVIS_ENABLE_V2=1` opt-in gate is lifted for `sandbox`.**
  `resolveMode()` now activates it automatically whenever `detect.ps1` recommends it —
  every future installer download gets it by default, no configuration. Keep
  `JARVIS_ENABLE_V2=0`/`false`/`no`/`off` working as the opt-*out* escape hatch.
- **`Get-WindowsOptionalFeature -Online -ErrorAction SilentlyContinue` can still throw.**
  Its underlying DISM COM interop raises a raw `COMException` ("requires elevation") that
  `-ErrorAction` does not suppress. Harmless at a script's own top level (PowerShell prints
  and continues) but FATAL when the whole script is invoked via `& 'script.ps1'` from
  inside a *caller's* `try` block (exactly what `jarvis-start.cmd`/`jarvis-launch.vbs` do
  around `detect.ps1`) — the exception escapes and aborts the callee before it can produce
  output. Any `Get-WindowsOptionalFeature`/DISM call in `detect.ps1` needs its own local
  `try`/`catch`, not just `-ErrorAction`, or the launcher silently loses
  `JARVIS_WINDOWS_ISOLATION_MODE` on every non-elevated real-user launch.

## New subsystems (2026-07-13) — chat-view fixes: streaming reveal, wheel scroll, large-session crash

Three long-standing chat-transcript bugs (desktop QML + Android), all rooted in how the
transcript recycles/renders rows:

- **The typewriter reveal must be latched off in the MODEL when it finishes, or a
  recycled delegate replays it.** `ChatDelegate.qml`'s reveal is gated purely on the
  `streaming` model role, and `JarvisPanel.qml` set that role once at append and **never
  cleared it**. With `reuseItems:true` + a finite `cacheBuffer`, any completed assistant
  message that scrolled out and back re-derived `shown=0` and re-typed itself. Fix: the
  delegate emits `revealed()` when `shown>=text.length`; the panel handles it with
  `chatModel.setProperty(index, "streaming", false)`. Do NOT clear `streaming` on the
  `"final"` turn-terminator instead — `final` usually arrives right after the single
  full-text `message` event, so clearing there snaps the reveal to full and kills the
  animation for the last message of every turn. Also reset `shown` in
  `ChatDelegate`'s `ListView.onReused` — the Timer breaks the `shown` binding by assigning
  it, so a pooled delegate keeps the previous row's count until re-derived.
- **The chat `WheelHandler` must snap to the ends via `positionViewAtBeginning/End()`, not
  clamp against `contentHeight`.** For a ListView of variable-height reused delegates
  `contentHeight` is only an estimate (and the `busy` footer changes it 0↔58), so the old
  `Math.min(maxY, …)` clamp overshot past the last message and never reliably hit the true
  top/bottom. Also pick the wheel step per device: trackpads report smooth `ev.pixelDelta`,
  mice report `ev.angleDelta` in 120-unit notches — the old fixed `*2.0` on angleDelta was
  ~240px/notch for mice yet applied the same factor to fine trackpad deltas.
- **Android: message + "thinking" bubbles were the only chat renderers with NO length cap.**
  Every other renderer caps the string it hands to layout (tool `.take(2000)`, diff
  `.take(400)`) because Compose measures/wraps the WHOLE string on the main thread; one very
  long message (a pasted file / base64 dump) OOMs/ANRs the app the instant a large session
  opens (small ones are fine — that's the "chat #1 crashes on phone" report). `ChatBubble.kt`
  now caps the DISPLAYED text at `MAX_MESSAGE_RENDER_CHARS` (12k) with a truncation notice;
  the full text stays in `item.text` so long-press → select → copy is unaffected. Note the
  data layer already swallows an OOM during the whole-session JSON parse via `runCatching`
  (history silently vanishes rather than crashes), so the render path was the visible crash.

## New subsystems (2026-07-13) — Windows installer now ships the TUI + web dashboard

The single `Cindro-Setup-<ver>.exe` (the ONLY artifact the `windows-build`
Action attaches to the Release) previously shipped just the GUI + engine +
phone + outpost. It now also bundles the **terminal UI** (`cindro-tui.exe`) and
the **SolidJS web dashboard** (`web/`). Load-bearing details:

- **The common dependency is `bun`, and it was silently absent.** Both the TUI
  (`tui/` → `bun run build win`) and the web dashboard (`web/` → `vite build`)
  are built with bun. `windows/scripts/build.ps1` gated the TUI behind a bare
  `if (Get-Command bun)` — with NO self-heal, unlike the Qt and Go blocks — and
  `windows-build.yml`'s toolchain-verify step never provisioned bun. So on the
  self-hosted runner the TUI just warned-and-skipped, and web was never wired in
  at all. Fix: a `Resolve-BunExe` self-heal (mirrors the Qt/Go pattern —
  downloads the portable `bun-windows-x64.zip` to `C:\bun-portable` when bun is
  absent) drives BOTH builds, so they always ship. `setup-runner-buildtools.ps1`
  also pre-installs bun now (fast path); the self-heal is the safety net. Do NOT
  add `bun` to the `windows-build.yml` hard-requirement preflight — a runner not
  yet re-provisioned would fail there before build.ps1 could self-heal.
- **The web dashboard needs a runtime, not just static files.** `web/server.ts`
  is a `Bun.serve` script (not Node), so a portable `bun.exe` is staged into
  `payload\bun\bun.exe` next to `payload\web\{dist,server.ts,package.json}`. The
  new `windows/scripts/cindro-web.cmd` launcher runs `bun\bun.exe web\server.ts
  --port 8788` and opens the browser — the Windows analogue of Linux's `cindro
  web start`, running the SAME `server.ts`. The control token resolves
  identically on both (`%USERPROFILE%\.config\jarvis\control_token`), so the
  launcher prints it for the Setup screen with no extra wiring.
- **Both installer shortcuts are `Check: FileExists(...)`-guarded**, so a build
  on a runner where bun genuinely can't be installed still produces a valid
  GUI-only installer instead of a shortcut to a missing file. Every bun-driven
  block in build.ps1 is `try/catch` non-fatal, same resilience as the phone/
  outpost stages.
- **The installer now adds `{app}` to the per-user PATH** (`ChangesEnvironment=yes`
  + the canonical HKCU\Environment add/remove `[Code]` recipe in `jarvis.iss`),
  so `cindro-tui` and `cindro-web` are callable from cmd/PowerShell/git-bash/WSL.
  The Linux counterpart is `packaging/install.sh`'s new `add_local_bin_to_path`
  step, which seeds `~/.local/bin` into `~/.bashrc`, `~/.zshrc`, and the pwsh
  profile (zsh/pwsh don't read `~/.profile`) — idempotent, guarded by a marker.

## New subsystems (2026-07-14) — collapsible "thinking" indicator across all 6 chat surfaces

Every surface already received real reasoning/thinking text via Contract B's `{"kind":"thinking",
"text":...}` event (sourced from Claude's `thinking` blocks, Codex's `reasoning`/`agent_reasoning`
items, and the API brain's `thinking_delta`/`reasoning_content` deltas), but only Android rendered
it as more than a throwaway one-line status string — and even Android's version was always fully
expanded and fragmented into a new bubble per chunk instead of one growing block. Desktop's live
chat discarded the text entirely (only flipped a busy boolean for the whimsical-phrase footer).

Now every surface — desktop QML, `cli/` (Textual), `tui/` (Bun/OpenTUI), the extension, Android,
and the web dashboard (including both replay views) — renders one accumulating block per turn:
collapsed by default, a live "Thinking… Ns" ticking while active, frozen to "Thought for Ns" once
the turn's first non-thinking event arrives, expand on click/tap. No protocol/daemon/core changes
were needed — elapsed time is computed client-side (timestamp on first `thinking` event of a turn,
freeze on the first `message`/`tool_call`/`diff`/`approval`/`error`/`final`). The one exception is
`cli/`'s `RichLog`-based transcript, which is append-only and can't host a live-updating clickable
widget — it reuses the same "persistently-mounted widget outside RichLog" trick the typewriter
reveal (`#typing-preview`) already established, via a `textual.widgets.Collapsible`.

Two latent bugs got fixed as a side effect: the extension wasn't freezing its thinking timer on
plain assistant replies (only on tool-call/error paths, since `message` never routed through
`endLiveBubble()`) and leaked the ticker/DOM ref across session switches; and `web/replay.tsx` was
discarding the daemon's real per-event `ts` timestamps before they reached the fold logic, so
replay now shows actual recorded "Thought for Ns" durations instead of none.

## New subsystems (2026-07-15) — secrets.json OS-backed encryption

`secrets.json` (API key values, per-MCP bearer tokens) was flat plaintext JSON, protected only by
chmod 0600 — fine against other users on the box, but readable by anything that can read files as
*you* (a naive backup tool, an accidental `git add`, a blind `*.json`/`*.env` grab). `jarvisd` starts
unattended (systemd `--user`, no login prompt), so a user-entered master password was off the table —
whatever protects the file must unlock with zero password. `core/SecretCipher`
(`core/include/jarvis/SecretCipher.h` + `core/src/SecretCipher.cpp`) instead leans on what the OS
already ties to the logged-in user: **Windows** DPAPI (`CryptProtectData`/`CryptUnprotectData`,
`CRYPTPROTECT_UI_FORBIDDEN` so it never blocks on a prompt — ships with every Windows install, no
extra dependency) and **Linux** the freedesktop Secret Service via `libsecret`
(gnome-keyring/kwalletd) when a keyring daemon answers on the session/system bus.

`SettingsStore::saveSecrets()` now writes `{"_cindro_secret_v1":true,"backend":"dpapi"|
"secretservice","data":"<base64>"}` instead of the flat `{provider:value}` shape; `load()` accepts
either transparently, so an old plaintext file self-migrates to the envelope on its next save — no
explicit migration step, no format-version flag day. On Linux the envelope's `data` is just a marker
("secretservice") — the real bytes live in one fixed Secret Service item
(schema `org.cindro.jarvis.secrets`, attribute `purpose=secrets_json`), not on disk at all.

**Never-block guarantee:** `SecretCipher::available()` gates every write; when it's false (headless
Linux box with no keyring session, or libsecret wasn't present at build time) `saveSecrets()` falls
straight back to today's plaintext+chmod-0600 shape — a save is never lost or blocked for want of a
keyring. `pkg_check_modules(LIBSECRET QUIET ...)` in `core/CMakeLists.txt` is deliberately **not**
`REQUIRED`: a missing `libsecret-1-dev` compiles a stub (`available()` hard-`false`) instead of
failing the configure step, so older dev boxes / CI images that predate this feature keep building.
`bootstrap-install.sh` and `infra/ci-image/Dockerfile` now install `libsecret-1-dev`/`libsecret-devel`
going forward — **the self-hosted Linux CI image still needs a manual rebuild+push**
(`infra/ci-image/build.sh`) to actually pick it up; until then `linux-ci` keeps building fine, it
just exercises the plaintext-fallback path, not the real Secret Service one. `windows/CMakeLists.txt`
links `Crypt32` unconditionally (always present, no vcpkg package needed).

## New subsystems (2026-07-16) — Proxmox dashboard operator chat + Home board gotchas

The Cindro Proxmox dashboard's operator chat (`web/src/pve/chat.tsx`) and Home widget grid
(`web/src/pve/widgets/`) got a round of fixes. The hard-won bits:

- **Chat history is client-side, not a resumed session.** `ChatController` persists the transcript
  (+ the picked model) to `localStorage` (`cindro.pve.chat.transcript.v1` / `.model.v1`) and rehydrates
  on construct. It is **display continuity only** — the dashboard WS-proxy (`dashboard_server.py`)
  scopes `session.send`/`session.subscribe` to sessions the *current* socket created (`allowed_sessions`),
  so a daemon session **cannot** be resumed across a browser reload. On reload the transcript is shown
  read-only and the next message opens a fresh session. `sanitizeForStore` freezes items for replay:
  assistant `live:false`, thinking `endedAt` set, a still-`running` tool card → `failed`, and an
  unresolved `approval` → `deny` (fail-closed — a reloaded page can't answer it).
- **The in-chat model picker only lists operator-capable models.** The operator MCP routing wires tools
  **only** for a non-Anthropic `api` brain, so the picker (and the session default) filter out
  `claude*`/`anthropic*` ids — a Claude model would open a chat with zero Proxmox tools. Switching model
  starts a fresh session on the next turn (model is fixed at `session.create`), keeping the transcript.
  Picker/new-conversation are disabled while `busy()` — switching mid-turn would blank the sid an
  in-flight `ensureSession` still depends on (a race that strands the switch + spins a tool card forever).
- **Tile shape had TWO bugs, not one.** The operator model emitted (a) descriptive `type` names
  (`cluster_status`/`vm_list`/`tasks_board`/…) that no renderer matched → "unsupported tile", AND
  (b) a flat `col/row/width/height` grid instead of `grid:{x,y,w,h}` → tiles collapsed to defaults.
  Fixed on both sides: `tiles.tsx` gained `cluster_status`/`recent_backups`/`tasks_board` renderers +
  a `TILE_ALIASES` map + `canonicalTileType`; `WidgetGrid.normalizeTile` accepts the flat grid; and
  server-side `operator_store.normalize_tiles` (called by `save_layout`) rewrites model-authored layouts
  into the canonical shape. **The alias/type tables are mirrored in TS (`tiles.tsx`) and Python
  (`operator_store.py`) — change both.** The `proxmox_dashboard_layout_set` docstring now enumerates the
  exact catalog so the model picks valid types. The `tasks_board` tile is the only one that needs the
  daemon client (reads `proxmoxop.tasks_list`); the rest read `pve-api` (direct REST).
- **The docked chat rail is drag-resizable** (`App.tsx` `onDockResizeDown`, width in
  `cindro.pve.dock.width.v1`, clamped 300–760px). The `.cx-dock.collapsed` width uses `!important` so
  the inline width doesn't fight the 46px collapsed rule; the resize grip is `display:none` while
  collapsed (expand via the toggle first).
- **`.cx-chat-scroll` is a flex COLUMN, so pin its rows with `.cx-chat-scroll > * { flex-shrink: 0 }`.**
  Without it, once the transcript overflows, flexbox shrinks the children to fit instead of scrolling;
  text bubbles resist (their text sets a min height) but the approval card (`overflow:hidden`) gets
  squished and its Authorize/Always/Deny buttons are clipped away — invisible AND unclickable. That
  looked like "the approval buttons aren't there" but they were being flex-squished off the card.

## New subsystems (2026-07-16) — auto-spawned chats now get a REAL isolated agent desktop again

Bug report: asking Cindro for "an agent desktop" during an **auto-spawned** chat (the "let Cindro use
a computer" toggle, no explicit co-work session) visibly switched the user's real KDE screen to a
new, empty virtual desktop instead of quietly spinning up the nested headless-Sway agent desktop.

Root cause: `ControlServer::createSession()`'s `autoComputer` branch deliberately skipped
`AgentDesktop::ensure()` (up to a ~45s synchronous nested-compositor + engine cold-start, avoided on
every plain chat's first turn) and instead injected the **GLOBAL** `:8794` engine under the **same**
`computer_use` MCP tool name that an explicit coworker+agent session uses for its truly isolated
nested engine. That global engine's `which="active"` default resolves to whatever the real host
compositor is (KDE here) — it drives the user's REAL screen, not an isolated one. The one-time
co-work preamble that explains the `real_screen` vs `computer_use` split was gated on
`m_agentDesktops.has(sessionId)`, false on this fallback path, so the model never learned any of
this. Asked for "your own" / "an agent" desktop with only the mislabeled real-screen tools available,
it improvised — calling `workspace_create`/`switch_workspace` (`computer_use_mcp/workspaces.py`),
which switches the user's actual visible KDE desktop.

**First pass (prompt-level, superseded below):** extended the one-time co-work guide to also fire for
`m_autoGlobalEngineSessions` sessions with a clause telling the model the truth about that fallback.
Kept as a safety net (see below) but not the real fix — the user explicitly asked for the
architectural fix instead of papering over it with instructions the model could still ignore.

**Real fix — restore actual isolation.** Investigating turned up that the daemon already has a full
battery-aware lifecycle for exactly this case, just fed from nowhere: `m_autoComputerSessions` (a
session set marked "auto-provisioned, ok to idle-teardown"), `sweepIdleDesktops()` (tears the
compositor+engine down after 8 min unviewed/idle, keeping the reserved port+bearer), and a
BATTERY re-provision check at the top of `sendToSession()` (`if
(m_autoComputerSessions.contains(sessionId) && !m_agentDesktops.has(sessionId)) ensure(...)` —
transparently revives the SAME reserved engine so a brain that baked the MCP config at spawn keeps
working). Nothing in the current codebase ever called `m_autoComputerSessions.insert(...)` — this
machinery was orphaned when the `m_autoGlobalEngineSessions` shortcut was introduced. The
`autoComputer` branch now calls `m_agentDesktops.ensure()` synchronously (identical to the explicit
`explicitAgent` branch) and feeds success back into `m_autoComputerSessions`, so auto-spawned chats
get the SAME real nested-Sway isolation an explicit co-work session gets, complete with idle-teardown
and re-provisioning. `m_autoGlobalEngineSessions` (+ the prompt-level guide clause from the first
pass) is now reserved for the two cases where isolation is genuinely unavailable: stock Windows
without the v2 sandbox opt-in (`!AgentDesktop::nestedDesktopSupported()` — the documented v1
take-over default) — a real `ensure()` failure on a platform that CAN isolate just skips computer-use
for that session entirely rather than silently degrading to the mislabeled real screen again.

**Trade-off, accepted deliberately:** `createSession()` now pays the same up-to-45s synchronous
provisioning cost on an auto-spawned chat's first turn that an explicit co-work session already pays.
`AgentDesktop::ensure()`'s internal waits use nested `QEventLoop::exec()` polling, which still pumps
the daemon's event loop, so other sessions/clients are not frozen — only this one request's response
is delayed. Chosen over the previous shortcut because the shortcut silently broke isolation; the cost
is a one-time hit per session, not per turn (idle-teardown reuses the same reserved port+bearer).

**Codex review follow-ups on PR #130 (same day):**
- The co-work guide's "SHOWING YOUR WORK" clause was still unconditional — it told the model
  `desktop_screenshot` captures "your agent screen" and the peek panel "mirrors your desktop" even
  on the no-isolation `autoGlobalEngine` fallback, where that tool actually captures the user's REAL
  screen. Contradicted the `coworkClause` warning right above it. Split into a
  `showingWorkClause`, branched the same way as `coworkClause`.
- `sandbox_busy:` (Windows Sandbox single-instance guard reporting transient contention, not a real
  failure) was falling into the generic "real provisioning failure" `else` branch in the new
  `autoComputer` path, landing the session in NEITHER `m_autoComputerSessions` nor
  `m_autoGlobalEngineSessions` — so the BATTERY re-provision check in `sendToSession()` (which only
  looks at `m_autoComputerSessions`) never retried it, permanently starving that session of
  computer-use even after the sandbox freed up. Added a `transientBusy` branch (mirroring the
  existing check in `explicitAgent`) that tracks it in `m_autoComputerSessions` instead, so the next
  turn's `ensure()` retries automatically.

## New subsystems (2026-07-16) — Plan Mode: real enforcement + subagent steering

Cindro's `plan` `agent_mode` used to be 100% prompt text (`ControlServer::modePolicyClause()`
telling the model to research read-only and ask before executing) — nothing actually stopped a
write tool call. Now it's enforced at the tool layer, has a second self-initiated entry path the
model can use on its own judgment (mirroring how Claude Code's own plan mode works), and a
dispatched subagent can be steered with a follow-up message instead of only fire-and-`agent_wait`.

**The real enforcement lives in ONE place**, not per-brain: `computer_use_mcp/policy.py`'s
`_plan_mode_gate`, wired first in `gated_call_tool` — the same choke point every brain's MCP tool
call already passes through. It calls a new Contract A `plan.status{session_id}` (session-scoped,
~2s TTL cache — the shared global `:8794` engine serves multiple concurrent sessions, so this must
NOT be a process-global cache) and hard-denies anything off a small allowlist (`_PLAN_SAFE_TOOLS`).
**Deliberately fails CLOSED** on an unreachable daemon — the one place in `policy.py` that departs
from the file's usual fail-open philosophy, because PLAN mode's whole contract is a safety
guarantee, not a convenience default.

**Two brain-specific gaps, found empirically, not guessed:**
- **CodexBrain**: `driveMcp` (set whenever computer-use is injected — true for any session that
  also needs `present_plan`/`agent_start`) unconditionally forces `--sandbox danger-full-access` in
  the ctor, overriding whatever `makeBrain()` sets for PLAN mode. So Codex sessions get PLAN
  enforcement for MCP tools only — Codex's **native** shell/apply_patch tools are NOT hard-blocked.
  Documented, not fixed — `core/tests/codex_buildargs_test.cpp` asserts this is intentional.
- **ClaudeBrain**: `--permission-mode plan` (Claude Code's own real plan mode) was tried FIRST and
  **live-tested against a real throwaway MCP server, then rejected** — it blanket-denies every MCP
  tool call with no allowlist override (`--allowedTools` does NOT help), which would also break
  `present_plan`/`agent_start`/`todo_write` (themselves MCP tools). The verified working mechanism:
  `--permission-mode bypassPermissions` (so MCP tools — gated separately by `policy.py` — still run
  headless) + a new `--disallowedTools Write,Edit,NotebookEdit,Bash,Task` to remove Claude's native
  mutating tools, which are invisible to the MCP-side gate. `Task` is included so subagent dispatch
  is forced through Cindro's own gated `agent_start`.

**Dual entry, one exit tool:** the existing global `agent_mode == "plan"` (Settings-driven) still
requires `present_plan`'s "Approve & Build" to exit. A NEW `enter_plan_mode(reason)` tool lets the
model go read-only on its own judgment, for just that session (`ControlServer::m_selfPlanModeSessions`,
in-memory, never persisted) — `exit_plan_mode(summary)` leaves it with no user approval needed.
`present_plan`'s approve action calls both `plan.exit` (clears the self-initiated flag, if set) and
`plan.approve` (grants a per-session override, `m_planApprovedSessions`, checked first in
`handlePlanStatus`) — it deliberately never flips the global `agent_mode` setting, so approving one
session's plan can't silently unblock a different concurrently-running plan-restricted session.

**`agent_send(session_id, message)`** (`tools_jarvis_ops.py`) steers an already-`agent_start`-ed
subagent. Turned out to need zero new C++: `agent_start` already spins up a real daemon session
(`agents.dispatch` → `createSession()` + `sendToSession()`), and `sendToSession()` already queues a
turn if the target is busy — so `agent_send` is a thin wrapper over the same `session.send` path
`agent_stop` already reuses via `session.cancel`. It does **not** interrupt a subagent mid-task
(codex/claude run one non-interruptible process per turn) — the message is delivered as the
subagent's next turn, not injected into its current one. True mid-tool-call interrupt (only
architecturally possible for ApiBrain today, which owns its tool loop directly) is a follow-up.

**Follow-ups explicitly NOT in this change:** true mid-task subagent interrupt; `outpost_exec`/
`outpost_screenshot` gate coverage (referenced in existing skill text but not found in any
`computer_use_mcp/tools_*.py` — needs its own investigation); phone-tool read-only allowlist beyond
`notify_user`; a shared-fixture mechanism to keep the C++ `--disallowedTools` list and Python
`_PLAN_SAFE_TOOLS` in sync automatically instead of by hand.

**Post-review fixes (2026-07-17, `/code-review high`):** `makeBrain()`'s `planMode` originally only
checked the global Settings value, never `m_selfPlanModeSessions` — self-initiated plan mode
(`enter_plan_mode`) got zero brain-level `Options` defense-in-depth (ClaudeBrain's
`--disallowedTools` never applied). Fixed to check both. Relatedly, `handleAgentsDispatch` didn't
propagate a self-initiated restriction to a dispatched subagent, letting a plan-restricted session
delegate the actual writing to an unrestricted child — fixed by inserting the child into
`m_selfPlanModeSessions` when the parent is restricted that way. **Known residual caveat** (shared
with the pre-existing Settings-driven path, not new to this fix): brain `Options` are baked in at
construction time and reused for every turn's subprocess respawn, so calling `enter_plan_mode()`
mid-conversation restricts tools *immediately* via the `policy.py` MCP gate, but this
defense-in-depth layer only picks it up the next time the Brain object itself is (re)constructed
(new session, or a respawn after daemon restart/idle-teardown) — this is why the MCP gate, not the
brain `Options`, is documented as the real source of truth.

**One finding deliberately left as a documented limitation, not fixed:** `present_plan`'s
"Approve & Build" path can return `decision:"approve"` even if the underlying `plan.exit`/
`plan.approve` calls silently failed (network hiccup) — it fails *safe*, not open: the model's
very next write attempt gets denied again by the (unrelated, still-live) `policy.py` gate, so the
worst outcome is one confusing turn, not an actual restriction bypass.

**Reconciled with a parallel fix (2026-07-17, later same day):** a separate session pushed its own
fix for the SAME concurrency bug (global-flip-on-approve) directly to `dev` while this PR's fixes
were in flight, plus two findings this PR hadn't addressed: `_plan_status()` now fails CLOSED
("ambiguous_session") when `current_session_id()` can't disambiguate 2+ concurrent sessions instead
of silently reporting unrestricted, and `video_watch` (can download remote videos / invoke cloud
transcription) was removed from `_PLAN_SAFE_TOOLS` alongside `video_setup`/`video_configure`. Their
approach used a dedicated `plan.approve` RPC + `m_planApprovedSessions` instead of extending
`plan.exit` with an `approved` flag — adopted theirs as the canonical mechanism on merge (one
approval path, not two) and layered this PR's `createSession()`/`handleAgentsDispatch` ordering fix
and `wakeParentForSubagent`'s queued-turn defer on top, since their commit didn't include either.

## New subsystems (2026-07-17) — `website/` marketing/billing site scaffold

Built the Laravel site sell.md's "Laravel plan" section specs: Breeze (Blade auth) + Cashier
(Stripe) + Filament (admin) + Tailwind, styled dark/"hacker meets macOS" (terminal-window chrome,
monospace accents). Self-contained under `website/` — own `composer.json`/`package.json`, zero
CMake integration, same as `web/`/`android/`/`computer-use/`. See `website/README.md` for setup,
the `/api/license/verify` contract, and the full "known limitations" list. Load-bearing points:

- **Not Laravel 11.** sell.md specified Laravel 11, but every Laravel 11.x release recent enough
  to still be installable had unpatched security advisories by build time (Composer's audit-block
  refused them). Used the current stable major (Laravel 13) instead — same stack, not an EOL
  version. Re-check this if you ever touch `website/composer.json`'s framework constraint.
- **`License` (not Cashier's `Subscription`) is the source of truth `/api/license/verify` reads.**
  A `SyncLicenseFromStripeWebhook` listener (on Cashier's `WebhookHandled` event) projects Stripe
  subscription state into the local `licenses` table on `customer.subscription.*` events — this is
  the one piece of real business logic tying billing to licensing. Manually-issued licenses (via
  Filament's "Issue Manual License" action) simply have `stripe_subscription_id = null`.
- **No `core/` changes.** `/api/license/verify`'s JSON contract is designed for a future `core/`
  `LicenseStore` (mirroring `SettingsStore`'s shape) to consume, but that class doesn't exist yet —
  sell.md lists its design as an explicit open question. Don't assume it's wired up.
- **Everything Stripe/GitHub-token-dependent is code-complete but placeholder-only.** No real
  Stripe test keys or `GITHUB_TOKEN` were available at build time — checkout/webhooks are only
  tested via `Http::fake()`/mocked events, and `/download` only exercises its no-token fallback
  path. See `website/README.md`'s "Known limitations" for the full list (also: the product repo
  being **private** means even a real `GITHUB_TOKEN` doesn't make GitHub's release *asset* URLs
  anonymously downloadable — flagged as a `// TODO` in `GitHubReleaseService`, not solved).
- **CI**: `website-ci.yml` (self-hosted `pve-ubuntu-runner-*` — see the CI section above) runs
  `composer install` + `npm run build` + `php artisan test`, gated to `paths: ['website/**']`. All
  six workflows (`auto-release.yml` + the five product build workflows) got
  `paths-ignore: ['website/**']` added so a website-only PR/merge doesn't bump a product version or
  burn self-hosted/GitHub-hosted runner time on unrelated platform builds.

## New subsystems (2026-07-17, later) — third Codex review round on PR #130 (qa→main)

By this point PR #130 had absorbed dev's full history — including the Plan Mode feature above and
the Proxmox dashboard work — so Codex's third review pass on the combined diff surfaced findings
across all of it, not just the original agent-desktop fix. Fixed:

- **`vm-create.tsx` regression I introduced earlier the same day:** `resetAll()` (called every time
  the modal reopens) didn't reset the `created` signal from the "finalize creation when only start
  fails" fix — reopening left `created()` true from the PREVIOUS VM, so `submit()`'s `if
  (!created())` guard skipped the create call entirely and tried to start a VMID that was never
  created this time. Added `setCreated(false)` to `resetAll()`.
- **`ControlServer.cpp` sandbox-busy brain rebind:** the earlier `transientBusy` fix (tracking the
  session in `m_autoComputerSessions` so `sendToSession()`'s BATTERY check retries `ensure()`) wasn't
  enough — the BRAIN itself was already constructed with `agentOverrides` empty, and codex/claude
  bake their MCP config at spawn, so even once the desktop came up later that SAME brain object still
  had no connection to it. Added `m_pendingComputerUseRebind`: the first time the BATTERY check finds
  the desktop up for one of these (and the brain isn't mid-turn), it tears down and reconstructs the
  brain with the now-available overrides.
- **Plan Mode, revisiting the "deliberately left as limitations" note above** — the user asked for
  these to actually be fixed once Codex flagged them as P1s, not just documented:
  - `policy._plan_status()` now fails CLOSED on an ambiguous empty `current_session_id()` (0 or 2+
    sessions on the shared global engine) instead of querying `plan.status` with `""`, which could
    read as "unrestricted" and cache that for the real (restricted) session for up to the TTL.
  - `present_plan`'s "Approve & Build" no longer flips the GLOBAL Settings `agent_mode` from `"plan"`
    to `"build"` — that un-restricted EVERY session under global Plan Mode, not just the approved
    one. New `plan.approve` RPC + `m_planApprovedSessions` (checked first in `handlePlanStatus` and
    in `makeBrain()`'s `planMode` computation) exempts only that session, per-session, in-memory.
  - `_PLAN_SAFE_TOOLS` wrongly allowlisted `video_setup`/`video_configure`/`video_watch` — all three
    have real side effects (multi-GB model download, persistent settings + cache-clearing, remote
    video download + cloud transcription) despite the "consumption only" comment. Allowlisted tools
    skip `_plan_status()` entirely, so these ran even under a hard Plan Mode restriction. Removed;
    kept the genuinely read-only `video_info`/`video_analyze`/`video_detail`.
- **Proxmox dashboard WS proxy, two more gaps in the session-scoping work above:**
  - `backend_to_browser()` relayed EVERY `session.event`/`session.opened` frame from the daemon
    straight to the browser BEFORE checking `allowed_sessions` — jarvisd's own scoping
    (`m_scopedClients`) only kicks in once a client sends `session.subscribe`, which this proxy never
    does on the backend connection's own behalf, so a fresh connection (or one that never chats) sat
    in "legacy broadcast" indefinitely, leaking other sessions' events. Now filtered client-side
    against `allowed_sessions` (starts empty, so nothing leaks before an operator session exists),
    independent of whatever scoping state the daemon connection happens to be in.
  - A transient WebSocket reconnect rebuilds `allowed_sessions` from empty (it's per-connection,
    in-memory), permanently stranding a `ChatController` that kept its old `sid` — every future
    `session.send` came back `method_not_allowed` forever. Rather than trying to let the proxy
    re-verify cross-connection session ownership (a bigger, riskier change), `chat.tsx`'s `send()`
    now detects that specific rejection (`CindroError.code === "method_not_allowed"`) and
    transparently starts a fresh operator session once, instead of repeating the same failure.
  - `App.tsx` constructs `ChatController` synchronously, before `checkAuth()`/login resolves, but the
    constructor used to eagerly read the (cookie-userid-namespaced) persisted transcript — reading
    either a STALE cookie's history (previous operator, not yet expired client-side) or the wrong
    (unnamespaced) key if no cookie was present yet. Deferred to a new
    `loadForAuthenticatedUser()`, called only once `checkAuth()` succeeds or a fresh login completes.

## New subsystems (2026-07-17, night) — fourth Codex review round on PR #130

A fourth review pass (triggered by the third round's push) found 14 more findings spanning the
agent-desktop/Plan-Mode/dashboard-proxy work above AND the unrelated `website/` Laravel site that
also happened to be sitting on this PR. Fixed 13; one left as a documented, deliberate limitation
(explained below, not skipped by oversight).

**My own follow-ups:**
- `chat.tsx`'s reconnect self-heal fix (round 3) had added `setBusy(false)` right after the
  `session.send` RPC resolved — but that RPC only confirms the daemon ACCEPTED the turn, not that
  the brain finished. Re-enabled the composer mid-turn, letting a rapid follow-up get silently
  coalesced into the still-active turn. Removed; the event pump already clears `busy` on
  `final`/`error`.
- `cancelSession()`: an AUTO-computer session's brain has its MCP config (port+bearer) baked in at
  construction. A routine `session.cancel` (interrupt THIS turn — a very ordinary "stop, let me
  rephrase") used to unconditionally `releaseSession()` (drops the port/bearer reservation too) and
  stop tracking the session in `m_autoComputerSessions`, so `sendToSession()`'s BATTERY
  re-provision check never fired again — the very next cancel permanently orphaned computer-use for
  the rest of that chat. Auto-computer sessions now get the lighter `teardown()` (keeps the
  reservation) and stay tracked, same as an idle-teardown; an explicit coworker+agent session keeps
  the existing full-release behavior (cancel really is its close signal there).
- `AgentDesktop::ensure()`'s up-to-45-60s synchronous provisioning (the deliberate
  correctness-over-latency trade-off from earlier today) exceeds the Chrome extension's generic 30s
  RPC safety timeout (`extension/sidepanel.js`) for `session.create` specifically, when "let Cindro
  use a computer" is on and the extension's `profile:"coder"` session qualifies for `autoComputer`.
  Rather than touch the sensitive cross-platform `AgentDesktop` timeout (would need a build/test
  loop this environment can't run), gave `session.create` its own 65s timeout client-side — a
  1-line, zero-risk JS change that closes the actual mismatch without reopening the isolation
  decision.
- `vm-create.tsx`: reopening the still-mounted modal while a PREVIOUS `submit()` coroutine was still
  running (e.g. closed during a long task poll, allowed since round 3) reset `creating`/`created`
  and presented a fresh, submittable form — a second `submit()` could then run CONCURRENTLY with the
  first, both mutating the same shared signals. Added a plain (non-reactive) `submitInFlight` guard:
  the reopen effect skips the reset while one is in flight, so the modal just reopens showing that
  same in-progress state.

**Plan Mode, two more gaps:**
- `makeBrain()`'s `planMode` precedence didn't account for `m_planApprovedSessions` (round 3's
  per-session approval) in the OTHER direction: once approved, `handlePlanStatus` always returned
  unrestricted before even checking `m_selfPlanModeSessions` — so if the model later called
  `enter_plan_mode` for a NEW risky task in the same (already-approved) session, the self-restriction
  was recorded but `plan.status` still reported "approved" and the MCP gate let writes through.
  Reordered: an active self-initiated restriction now wins over a prior approval.
- `agent_create`/`agent_send` were wrongly in `_PLAN_SAFE_TOOLS` — `agent_create` persists/overwrites
  a reusable agent definition (a write), and `agent_send` can direct an EXISTING child dispatched
  BEFORE the parent entered self-initiated Plan mode (so the child never inherited the restriction)
  to perform the writes the parent itself can no longer perform. `agent_start`/`agent_committee`/
  `agent_moa` stay — all three route through `handleAgentsDispatch`, which already propagates the
  restriction to new children.

**Left as a documented, deliberate limitation, NOT fixed this round:** Codex re-flagged that a
Plan-mode Codex session with computer-use injected gets `driveMcp=true`, and `CodexBrain`'s ctor
unconditionally overrides `sandboxMode` back to `danger-full-access` whenever `driveMcp` is set —
so Codex's NATIVE shell/`apply_patch` tools are NOT actually blocked in Plan Mode for a
computer-use-enabled session, only MCP tool calls are (via `policy.py`'s gate). This is not an
oversight: `core/tests/codex_buildargs_test.cpp` has an EXISTING assertion (`"plan mode + drive:
sandboxMode=read-only is still overridden to danger-full-access (native codex tools are NOT
hard-blocked here)"`) proving the original Plan Mode author already investigated this and
deliberately left it — because `--sandbox` is a single, whole-process setting: loosening it to
`danger-full-access` is what stops codex auto-cancelling MCP tool calls headless (proven live-tested
per the ClaudeBrain comparison above), and there's no evident way to keep MCP calls working while
blocking codex's OWN native tools without either (a) redesigning codex's sandboxing in a way this
environment can't build/test against a real `codex` CLI, or (b) disabling computer-use entirely for
Plan-mode Codex sessions, which would ALSO break the genuinely-safe MCP tools Plan Mode explicitly
wants available (`desktop_screenshot`, `present_plan`, `todo_write`, etc., all in
`_PLAN_SAFE_TOOLS`). Shipping an unverified change to a security-critical sandbox mechanism felt
like the wrong call versus leaving the existing, deliberate, tested trade-off in place.

**`website/` findings (unrelated feature, same PR):** Stripe webhook sync unconditionally set
license status to "active" for both created/updated events regardless of Stripe's own subscription
status (`past_due`/`unpaid`/`incomplete`/`paused` kept granting a valid license) — now mapped via
Stripe's status (note: the `status` column is a DB-level enum `active|suspended|revoked|expired`, so
Stripe's raw status strings had to be MAPPED, not passed through verbatim — caught this the hard way
via the actual Laravel test suite, see below). `User` had `MustVerifyEmail` commented out despite the
`verified` middleware and Breeze's verify-email routes already being fully wired — every unverified
address could reach the dashboard. Account deletion left every license (`user_id` is `nullOnDelete`)
still "active" forever with an orphaned row and no way for a later Stripe webhook to fix it (looks
the user up by `stripe_id`, now gone) — now cancels live Cashier subscriptions and marks licenses
`revoked` before the user row disappears. `PricingCatalog::booleanFeatureFlags()` flagged EVERY
string-valued pricing cell as `true`, including explicit exclusions like Starter's cloned_voice "not
included" — so `/api/license/verify` told a Starter client features were available that the pricing
table explicitly excludes; now only strings NOT starting with "not included" flag true.

**Verification note:** PHP/Composer/`php artisan test` turned out to be available on this box —
actually ran the full website test suite (not just `php -l` syntax checks) for the first time this
session, which is how the enum-mismatch in the Stripe status mapping got caught before shipping (the
DB would have rejected the raw Stripe status string on the first webhook). 15/15 targeted tests
passed after the fix. Two unrelated pre-existing failures (`Vite manifest not found` — no frontend
build in this environment) are environmental, not regressions.

## New subsystems (2026-07-17, CI-speed wave) — self-hosted runner speedups + gotchas

Instrumented the Proxmox self-hosted fleet end-to-end (per-step timings from real runs + in-guest
checks) and attacked the measured hot spots. Baseline: windows-build took ~26 min solo / 40–49 min
when both win-runners built concurrently; ~10 of those min were the engine PyInstaller stage, ~6 C++,
~3 outpost PyInstaller, ~3 LZMA compression, and up to 8 min of "checkout" that was actually
`git clean -ffdx` deleting the previous build from the shared ROTATIONAL disk. Changes:

- `windows-build.yml` checks out with `clean: ${{ github.event_name != 'pull_request' }}` — PR
  builds now KEEP `windows/build-win/` + both `.venv-win`s between runs (incremental ninja/pip);
  tag builds still fully clean. GOTCHA: anything cached in the tree must tolerate staleness —
  `build.ps1` now deletes the stale payload AND stale `Cindro-Setup-*.exe` up front (the old
  installer would otherwise ALSO match the upload/release glob).
- `build.ps1` runs its five C++-independent stages (engine PyInstaller, outpost-mcp PyInstaller,
  Go cross-compiles, phone-server npm, portable-Node fetch) as `Start-Job` BACKGROUND PROCESSES
  overlapped with the foreground C++/bun/windeployqt work, joined before the isolation-assets
  stage. Process (not thread) jobs on purpose: the Go stage mutates `GOOS`/`GOARCH` env.
  Fatality preserved: engine + node-runtime fatal, go/outpost/phone warn-and-continue.
- PR installers compress with `zip` (`-FastCompress` -> `/DFastCompress` -> `#ifdef` in
  `jarvis.iss`); tag/release builds keep `lzma2`+solid. The Node zip now caches in `C:\ci-cache`
  (outside the repo) so even clean tag builds skip the download.
- `setup-runner-buildtools.ps1` restarts EVERY `actions.runner.*` service (was hardcoded to
  win-runner-1 — provisioning win-runner-2 never restarted its own runner).
- android-build (self-hosted since the infra/self-hosted-website-android merge): sherpa AAR now
  cached at `~/ci-cache` on the runner VM's persistent disk (actions/cache restore of that one
  56 MB file measured ~1m40s); `setup-gradle` remote cache disabled (`cache-disabled: true`) —
  `~/.gradle` persists locally, the GitHub round-trip was pure overhead.
- NEW `.github/workflows/runner-maintenance.yml` (workflow_dispatch only): the Linux runner VM
  (`gh-runner-linux`, VMID 104) has NO ssh key authorized and NO qemu-guest-agent running, so a CI
  job is the only management path onto it. It pre-installs PHP 8.4+composer (makes website-ci's
  per-run `setup-php` apt-install a no-op) and qemu-guest-agent (VM config has `agent:enabled=1`
  but the agent was never installed in-guest). GOTCHA: `workflow_dispatch` only becomes
  runnable once the file exists on `main` — dispatch it after the promotion PR merges.
- Proxmox host side (done live over SSH, not in-repo): VM 104 got `cpu: host` (was the ancient
  `kvm64` default — no SSE4/AES/POPCNT exposed to compilers), `cpuunits 200`, and
  `cache=writeback` on its disk — cpu/cache apply at its NEXT power-cycle. Win-runner VMs
  106/107 still want the same treatment (+6 cores each) plus Windows Defender exclusions for
  `C:\actions-runner`/`C:\Qt`/`C:\vcpkg` + build processes (both VMs measured with RTP on and
  ZERO exclusions — the classic Windows CI tax); those needed explicit user approval.
- Fleet topology gotcha: all six `pve-ubuntu-runner*` slots live on ONE 6-vCPU VM, and a PR into
  main fires linux-ci + linux-release + android + website simultaneously — 4 concurrent jobs
  each assuming `nproc` parallelism on 6 shared vCPUs (plus everything else on a 24-thread
  2010-era host). Fewer slots or more vCPUs is the lever if linux jobs feel slow.
## New subsystems (2026-07-17, later still) — fifth Codex review round on PR #130

A fifth review pass (triggered by the fourth round's push) found 6 more findings: one in my own
`tools_plan.py` fix, three more in the `website/` billing logic (compounding on round 4's fixes),
and a CI path-filter gap affecting six workflow files.

- **`tools_plan.py`**: `present_plan` resolved `sid = daemon_client.current_session_id()` AFTER the
  blocking `ask_bus.ask()` call (which can wait up to a day). On the shared global engine,
  `current_session_id()` only resolves reliably while this is the SOLE running session — by the time
  a slow approval came back, another session could easily be running too, resolving empty and
  silently failing both `plan.exit` and `plan.approve` (swallowed) while `present_plan` still
  reported `"decision": "approve"`. Moved the resolve to before the blocking wait.
- **`SyncLicenseFromStripeWebhook.php`, two more gaps on top of round 4's status-mapping fix:**
  - The "upgrade an existing no-subscription license in place" fallback matched ANY active license
    with no `stripe_subscription_id` — including a manually issued one (e.g. a Filament-granted
    lifetime enterprise license). Buying an unrelated Starter subscription and later canceling it
    would overwrite and eventually expire that manual grant. Scoped the fallback to `tier=trial`,
    the only kind Stripe webhooks are ever meant to upgrade in place.
  - `grantFoundingMemberStatusIfSlotAvailable()` ran for every recognized event, including the
    `incomplete`/`past_due`/`unpaid`/`paused` ones round 4 mapped to `"suspended"` — an abandoned or
    failed checkout consumed a founding-member slot, excluding a later paying customer. Gated it on
    `$status === 'active'`.
- **`DashboardController.php`**: picked the "primary" license solely by `latest('issued_at')`, so a
  user holding multiple licenses (explicitly allowed by the admin resources) could have downloads
  denied and an invalid license displayed while an OLDER, still-valid license sat unused —
  `/api/license/verify` would have accepted that valid key. Now prefers a currently-valid license
  (newest among valid ones), falling back to the newest overall only when none are valid.
- **`CheckoutController.php`**: `subscribe()` always started a brand-new Stripe Checkout session,
  even for a user who already has an active `default` subscription — the pricing page stays
  reachable and the subscriptions table doesn't enforce one row per user/type, so a repeat visit (or
  picking a different tier) could complete a second concurrent subscription and double-bill them.
  Already-subscribed users are now redirected to the billing portal instead.
- **CI**: `paths-ignore: ['website/**']` (on six workflows: the five product-build gates' PR
  triggers + `auto-release.yml`'s push trigger) didn't cover `.github/workflows/website-ci.yml`
  itself, which lives outside `website/`. A PR that only edited the website's own CI config still
  ran every product build AND (on merge to main) bumped/tagged a product release for a change that
  belongs solely to the non-versioned site. Added that workflow file to all six `paths-ignore` lists.

**Verification:** ran the FULL website test suite this round (not just the targeted files) —
45/58 passed; all 13 failures are the identical pre-existing `Vite manifest not found` error (no
frontend build in this environment — confirmed by trying `npm install && npm run build`, which hit
an unrelated native-module resolution issue with the `rolldown` bundler on this Windows box).
None of the 13 touch any file changed this round. All 6 modified GitHub Actions workflow files
parsed clean with PyYAML.

## New subsystems (2026-07-17, sixth round) — sixth Codex review round on PR #130

A sixth review pass found 5 more findings: two in `ControlServer.cpp`'s auto-desktop/Plan-Mode
tracking (both in-memory-only-state gaps of the same shape rounds 3-5 already fixed elsewhere),
one Plan-Mode/session-cancel interaction, one more `SyncLicenseFromStripeWebhook.php` gap, and one
in `website/`'s license verification (unenforced per-seat licensing). Plus one leftover
`_PLAN_SAFE_TOOLS` overbreadth Codex flagged alongside them.

- **`ControlServer.cpp`/`.h` — auto-desktop tracking didn't survive session resume:**
  `m_autoComputerSessions`/`m_autoGlobalEngineSessions`/`m_pendingComputerUseRebind` are in-memory
  only, never persisted. Resuming a session (daemon restart, or reopening a chat whose brain was
  never live) called `makeBrain()` with empty MCP overrides regardless of whether the session
  originally had a nested desktop — computer-use silently vanished from every resumed
  auto-computer/coworker chat until the user deleted and recreated it. Extracted the existing
  `createSession()` auto-desktop logic into a new shared `provisionAutoComputerDesktop(row)`
  helper (also collapsing what was a 4-way up/unsupported/transient/failure branch into 3, since
  transient-contention and genuine failure now get identical retry+rebind treatment — a leftover
  round-3 finding) and call it from `sendToSession()`'s resume path too, reconstructing the
  original classification from the persisted `profile`/`brain`/`targetRef` fields (the one edge
  case that can't be reconstructed exactly — an explicit `target="real"` take-over — resumes as a
  plain non-computer-use session instead; judged rare and non-harmful, documented inline).
- **`ControlServer.cpp`/`.h` — Plan Mode state changes didn't reach a live Claude brain:**
  `ClaudeBrain`'s `--disallowedTools` (Write/Edit/NotebookEdit/Bash/Task) is baked in at
  construction. `enter_plan_mode`/`exit_plan_mode`/`plan.approve` update the tracking sets
  (`m_selfPlanModeSessions`/`m_planApprovedSessions`) but a live brain kept its ORIGINAL
  permissions until the session was next fully rebuilt — a session that entered Plan Mode
  mid-conversation could still have its live ClaudeBrain accept writes, and one that exited Plan
  Mode stayed needlessly restricted. Added `m_pendingPlanModeRebind` (same "mark now, rebind on
  next idle turn" pattern as `m_pendingComputerUseRebind`) via a new
  `markPlanRebindIfClaudeLive(sessionId)`, called from all three Plan-Mode handlers; a new block
  in `sendToSession()` tears down and rebuilds the brain the first time it's next found idle.
  CodexBrain has no equivalent fix — its `--sandbox` is one whole-process setting that also gates
  MCP tool auto-cancel, so tightening it on Plan entry would break computer-use; that gap stays
  deliberately unfixed (see `core/tests/codex_buildargs_test.cpp`), same call as round 5.
- **`ControlServer.cpp` — `cancelSession()` cleared Plan-Mode state on a mere turn interruption:**
  it was clearing `m_selfPlanModeSessions`/`m_planApprovedSessions` for `sessionId`, but
  `session.cancel` only interrupts the current turn — `enter_plan_mode`'s own contract says Plan
  Mode "lasts until exit_plan_mode/present_plan", not until the next cancel. Canceling a turn while
  self-initiated Plan Mode was active silently dropped out of Plan Mode. Removed those two lines
  from `cancelSession()`; they remain correctly cleared in `deleteSession()` (which now also clears
  the new `m_pendingPlanModeRebind`).
- **`SyncLicenseFromStripeWebhook.php`, a third gap on top of rounds 4-5's fixes:** Stripe doesn't
  guarantee webhook delivery order, so an out-of-order-delivered older event (e.g. a stale
  `customer.subscription.updated` arriving after a newer `deleted`) could revert a license's status
  backwards. Added a nullable `licenses.last_stripe_event_at` column (new migration) and an
  `$isStale` check (event's own `created` timestamp vs. the license's stored one) short-circuiting
  both the `subscription.deleted` path and the create/update path before writing anything. Also
  folded in two smaller gaps found alongside it: `expires_at` wasn't cleared on an update/create
  (a previously-expired license that later got a fresh subscription could still read as expired
  until its next natural verify), and a resolvable-tier-but-existing-license event with an
  unresolvable price ID silently skipped the status sync entirely instead of at least updating
  `status` on the license Stripe already knows about.
- **`LicenseVerifyController.php` (P2) — per-seat licensing was unenforceable:** `device_id` was
  accepted in the request and documented in the docblock, but never recorded or checked, so a
  single one-seat Business license returned `valid: true` for arbitrarily many devices. Added a new
  `license_activations` table (migration + `LicenseActivation` model + `License::activations()`
  HasMany) recording one row per `(license, device_id)` pair actually seen; a device already on
  file is always allowed (and its `last_seen_at` refreshed), a genuinely new device beyond
  `license->seats` is rejected with a new `seat_limit_exceeded` reason, and omitting `device_id`
  (still nullable) skips enforcement entirely since there's no identity to track. Added four new
  tests to `LicenseVerifyTest.php` covering: repeat calls from a known device, a new device beyond
  the seat count, multiple devices up to the seat count, and the no-`device_id` bypass.
- **`computer_use_mcp/policy.py` — `_PLAN_SAFE_TOOLS` still had two side-effecting entries:**
  `video_analyze` and `video_detail` were left in the Plan-Mode allowlist from round 5's
  `video_watch` fix, but both call `resolve_source()` (which can download a not-yet-cached YouTube
  URL), and `video_analyze(transcription=true)` can additionally invoke cloud transcription and
  write an analysis manifest, while `video_detail` extracts and caches frames to disk. Only
  `video_info` is genuinely side-effect-free (its own docstring says it probes YouTube URLs WITHOUT
  downloading). Removed both, leaving only `video_info`. `agent_send` was likewise removed
  separately — it can direct an EXISTING child agent dispatched before the parent entered Plan Mode
  (so the child never inherited the restriction) to perform writes the parent itself no longer can;
  it must now be denied like any other write/execute tool. Updated `test_policy.py` to match both.

**Verification:** ran the full website test suite (62 tests) — 49 passed, 13 failed, all 13 the
same pre-existing `Vite manifest not found` gap from rounds 3-5 (confirmed none touch any file
changed this round); the new `LicenseVerifyTest` seat-enforcement tests (8/8 in that file) pass in
isolation too. `php -l` clean on all 7 touched/new PHP files. `computer-use`'s `policy.py`/
`test_policy.py` parse clean (`ast.parse`). The C++ changes were reviewed manually line-by-line
against the existing rebind pattern (compilation isn't available in this environment).

## New subsystems (2026-07-17, seventh wave) — live-testing bug wave on Plan Mode

Three bugs surfaced by actually running the rebuilt daemon/desktop and using it, not by review —
found and fixed in parallel with (and independent of) the fourth-through-sixth Codex review rounds
above, before this branch merged their work in:

- **ClaudeBrain sessions "acted like plain Claude Code"** — denied having Cindro's phone/computer-use
  tools, self-identified as "Claude Code" and even "Claude Code (Cindro)". Root cause: the co-work
  guide + policy preamble (tool grants, permission policy, mode policy) were PREPENDED into the
  first user-turn's text, same as every other brain — but Claude Sonnet 5 correctly recognizes an
  unsigned "[Cindro co-work — READ FIRST]" block riding inside user-turn text as a plausible prompt
  injection and refuses to adopt the persona or trust the tools it lists, even when those tools are
  genuinely wired up and reachable. Fixed by giving `Brain` a new virtual `setSystemPromptAppend(text)`
  (no-op default) and routing the preamble through it for ClaudeBrain specifically
  (`ControlServer::sendToSession`), which wires to the real `claude` CLI's system-prompt channel
  (`ClaudeBrain::Options::systemPromptAppend`, accumulates across calls — the guide can fire on
  a later turn than the policy preamble, e.g. once an agent desktop comes up). It is handed over as
  `--append-system-prompt-file <tmp path>`, NEVER inline: the accumulated guide + preamble is ~17 KB,
  and on Windows `CliResolve` launches a `claude.cmd` shim through `cmd.exe /c`, which hard-caps the
  whole command line at 8191 chars — an inline `--append-system-prompt` killed every turn with
  "The command line is too long." / "claude exited with code 1". CodexBrain/ApiBrain
  keep the legacy prepend-to-user-turn-text convention (ApiBrain already has a real system prompt
  channel via its own `Options`; Codex has neither issue nor fix here). Also added `identityClause()`
  — one explicit "You are {assistant_name}" sentence at the very front of the preamble, since
  CLI-shelled brains have no equivalent of `ApiBrain`'s memory-block identity opener.
- **"Request Changes" on a plan card gave the model nothing to act on** — tapping it submitted the
  literal label as `present_plan`'s answer, so the model got back `note:"Request Changes"` with zero
  actual feedback, and (per user reports) sometimes went hunting for a nonexistent "edit plan" tool
  instead of just re-reading the existing plan. Fixed in two places: `ChatDelegate.qml`'s plan-decision
  card now detects `present_plan`'s fixed two-option shape and opens "Request Changes" into a focused
  "What should Cindro change?" text field instead of submitting immediately (Enter with nothing typed
  still sends an explicit "no specific feedback given yet" note, never the bare label); and
  `present_plan`/`enter_plan_mode`/`exit_plan_mode`'s docstrings plus `modePolicyClause()`/
  `planToolsClause()` now say outright that there is no separate edit/update-plan tool and that empty
  feedback should prompt a clarifying question, not a blind re-call.
- **A session stuck in Plan Mode despite Build mode being selected in Settings** — traced to
  `ask_bus`'s Allow/Deny-style gates doing an exact-string `answer == "allow"` match; anything else
  (including some legitimate free-text affirmatives typed into the generic question card's custom
  text field) fell through to the deny/timeout path. Added `ask_bus.is_affirmative(answer, yes_label)`
  — exact match against the button's own label wins first, then a small literal whitelist of common
  affirmatives, then a narrow `"yes "`/`"sure "`/etc. prefix match (deliberately not fuzzy/substring,
  to keep fail-closed behavior for genuinely ambiguous replies) — and wired it into all four
  `policy.py` gates (`gate()`, `_phone_gate()`, `_scan_command()`, `_scan_tui_layout()`) plus
  `present_plan`'s own approve check. The specific stuck session also had an ambiguous
  `current_session_id()` at the moment `plan.exit`/`plan.approve` were called (see the "resolve sid
  BEFORE the blocking ask_bus.ask() call" comment in `tools_plan.py` — those calls can block up to a
  day, by which point another session may well be running too) — needed manual DB clearing, not a
  code fix; if a session is ever stuck the same way again, cancel/delete it rather than trying to
  message it back to a working state.

**Also, unrelated to the bugs above:** the user reset their local `trust_policies.json` `default`
from `"ask"` to `"allow"` after the Allow/Deny fix — that's a local config change, not a repo one.

**Reconciled with rounds 4-6 above on merge:** round 6 removed `agent_send` from `_PLAN_SAFE_TOOLS`
(it can direct an existing child dispatched before the parent's Plan Mode restriction) — that stayed
removed; nothing here re-adds it. Round 6's `m_pendingPlanModeRebind`/`markPlanRebindIfClaudeLive`
(rebuilds a live ClaudeBrain's baked-in `--disallowedTools` when Plan Mode state changes mid-session)
and this wave's `setSystemPromptAppend()`/`identityClause()` routing both touch `sendToSession()`'s
brain-dispatch path but are independent — the rebind block tears down/reconstructs the `Brain*`
object, after which the (also per-call) system-prompt routing still applies to whichever brain
pointer is live by the time it runs. Verified by re-reading the merged `sendToSession()` top to
bottom, not just trusting a clean auto-merge. **This verification turned out to be incomplete** — see
the `/code-review high` wave below, which caught what it missed.

## New subsystems (2026-07-17, eighth wave) — `/code-review high` on the full Plan Mode diff

Ran a full multi-angle review (8 finder angles × independent 1-vote verification) against everything
in this file's Plan Mode history vs. `main`, not just the latest commit. 7 of 9 surfaced findings were
independently CONFIRMED by 2-3 finder angles each — a strong signal the review was worth doing, not a
formality. Fixed:

- **The single most severe finding: a plan-mode/computer-use brain rebind silently discarded the
  ENTIRE system-prompt preamble forever, reintroducing the exact "acts like plain Claude Code" bug
  the whole seventh-wave section above was written to fix.** Root cause the earlier verification note
  above missed: `sendToSession()`'s two rebind blocks (`m_pendingComputerUseRebind`,
  `m_pendingPlanModeRebind`) tear down and reconstruct the `Brain*` with a fresh, empty
  `Options::systemPromptAppend` — correct so far — but `guide`/`policyPreamble` (the strings actually
  passed to `setSystemPromptAppend()`) are gated by `m_policyGuided`/`m_coworkGuided`, ONE-TIME flags
  set on turn 1 and never cleared except on session delete. Once ANY plan-mode transition
  (`enter_plan_mode`/`exit_plan_mode`/`plan.approve`) triggers a rebind mid-session, both flags are
  already set, so `guide + policyPreamble` stay empty strings on every subsequent turn and
  `setSystemPromptAppend()` is never called again — the identity clause, permission/mode/plan-tools
  policy text, and co-work guide vanish for the rest of that session, right at the moment Plan Mode
  state changes, which is precisely when they matter most. Fixed by clearing both flags at the end of
  each rebind block, forcing the preamble to recompute and redeliver to the new brain on the SAME turn
  the rebind happens.
- **`ask_bus.is_affirmative()`'s prefix-match tier silently approved a plan revision request.**
  present_plan reuses `is_affirmative()` (built for simple Allow/Deny asks) to decide "Approve &
  Build" vs. "Request Changes" against the user's free-typed revision NOTE. A perfectly natural
  revision like "yeah but shorten the intro" or "ok change the deploy target" starts with an
  affirmative word, so the old `answer.startswith(word + " ")` rule matched it as approval — silently
  discarding the user's requested change and letting the model execute the un-revised plan. Fixed by
  replacing the open-ended prefix match with a narrow trailing-punctuation strip (`"yes!"`/`"sure."`
  still match a bare whitelisted word; a longer sentence's opening word no longer does). Added
  `computer-use/tests/test_ask_bus.py` — no dedicated test file existed for this function at all
  despite gating 5 call sites (4 policy.py gates + present_plan).
- **`exit_plan_mode` still had a truthfulness gap even after the seventh wave's fix**: it always
  returned `"ok": true` even when `still_restricted` was also true, handing the model a
  self-contradictory response (top-level "success" alongside "you're still blocked") and trusting it
  to correctly prioritize the nested field. `ok` now reflects reality directly (`not still_restricted`)
  so there's no contradiction to misread. Also: the docstring claimed `restriction_source` "will be
  settings" when `still_restricted` is true, but `policy._plan_status()` can also return `"self"`,
  `"unreachable"`, or `"ambiguous_session"` — softened the docstring so the model doesn't wrongly tell
  the user to check Settings when the real cause is a retryable transient failure. Also fixed a real
  efficiency issue in the same function: `bust_plan_cache()` immediately followed by `_plan_status()`
  guaranteed a cache miss (2 sequential blocking daemon round-trips instead of 1), and `_plan_status()`
  separately re-resolved `current_session_id()` even though the caller already had it — gave
  `_plan_status()` an optional `sid` param so a caller holding its own resolved sid skips that.
- **The new PLAN DOC sidebar card (seventh wave) never cleared `planDocText`/`planDocSession` on
  session switch or new chat**, unlike the sibling `todoSpec`/`todoSpecSession` it was modeled on which
  explicitly does — reopening a session that once showed a plan doc re-displayed the stale text with
  no cache invalidation. Fixed by adding the same clears in both `onSessionIdChanged()` and
  `startNewChat()`.
- **Plan-card detection was fragile, hardcoded string-matching duplicated across two QML files**:
  both `ChatDelegate.qml`'s `isPlanDecision` and `JarvisPanel.qml`'s `onAgentQuestion` independently
  checked the exact literal "Approve & Build"/"Request Changes" option strings to decide "is this a
  plan card" — a future relabeling would silently break one or both. Threaded an explicit `kind`
  through the whole pipeline instead: `ask_bus.ask(kind=...)` writes it into the question file,
  `Bridge::scanQuestions()` reads it and the `agentQuestion` Qt signal gained a 4th `kind` parameter,
  `present_plan` passes `kind="plan"`, and both QML files now check `parsed.kind === "plan"` instead of
  literal option-label matching. `ask_user` (no `kind`) is unaffected — defaults to `""`.
- **Left as a documented, low-risk tradeoff, NOT changed:** `ChatDelegate.qml`'s plan-card Markdown
  rendering (`Text.MarkdownText`) can in theory misrender a literal underscore in unescaped
  model-authored text (e.g. a file path like `my_file_name.py`) as emphasis. Investigated rather than
  reflexively patched: CommonMark (which Qt's `md4c`-based Markdown importer implements) has a
  deliberate "intraword emphasis" exception specifically so `foo_bar_baz`-style identifiers do NOT
  render as emphasis in a spec-compliant parser — the same reason this doesn't visibly break on GitHub.
  The theoretical mechanism is real; the practical risk for the common case (file paths, flags) is
  much lower than it first appears. Not escaping preemptively avoids introducing a new bug (literal
  backslashes showing up) to guard against a risk that's likely already mitigated upstream.
- **Left as a documented architectural gap, NOT changed:** `ApiBrain` doesn't get the
  `setSystemPromptAppend()` treatment — its system prompt is set once at construction
  (`memorySystemBlock()`) and never updated per-turn, so the dynamic identity/mode preamble still gets
  stale-prepended into user-turn text for ApiBrain sessions. Investigated whether this reproduces the
  actual bug this wave fixes: it does NOT — the original bug was specifically that the `claude` CLI
  establishes its OWN competing "Claude Code" identity that conflicts with an injected preamble;
  `ApiBrain` talks to the raw model API under full system-role control with no competing persona to
  distrust the text as injected. Real inconsistency, not a live recurrence of the bug — a
  `setSystemPromptAppend()` override for `ApiBrain` (accumulating into its own `systemPrompt` field) is
  a reasonable follow-up, not an urgent fix.

**Verification:** 56/56 targeted Python tests pass (`test_policy.py`, `test_tools_plan.py`,
`test_ask_bus.py` — new, `test_phone_policy_gate.py`). Full `cindro-sidebar`/`jarvisd` rebuild clean,
including the `agentQuestion` Qt signal signature change (3 args → 4); offscreen `--selftest` renders
OK. Live-verified against the actual running daemon, not just unit tests.

## New subsystems (2026-10-04) — Windows computer-use upgrade (human-style input, platform tools, UIA, Office)

- **Engine tool bodies that call Linux modules were silently broken on Windows.** `tools_desktop`
  calls `clipboard.*`, `windows.*`, `apps.*` and `workspaces.*` by module attribute, but
  `server_windows.py` used to patch only `input`/`screen`/`session`. Every `clipboard_*`,
  `window_*`, `app_*` and `workspace_*` call therefore ran `wl-copy`/KWin/swaymsg and failed.
  `windows/engine/win_platform.py` now provides Win32 versions, and `apply_patches()` rebinds them
  from `wp.PATCHES`. If the engine gains a new Linux-only helper module that a tool calls, add a
  Windows implementation and a `PATCHES` entry, or the tool is dead on Windows.
- **`desktop_reset` + working `list_windows` = data loss.** The engine's `desktop_reset` closes
  everything `windows.list_windows("sway")` returns. On the Windows host, the `win_platform`
  version therefore returns `[]` for `"sway"`/`"agent"` unless `JARVIS_AGENT_INSANDBOX`.
  `tools_windows` also overrides `desktop_reset` to refuse on the host. Don't "fix" either back.
- **Windows-only tools are registered, not patched.** `server_windows.main()` calls
  `tools_windows.register(computer_use_mcp.server.mcp)` before `_srv.main()`. That works because
  FastMCP reads `_tool_manager` per `tools/list` and `policy.install`'s wrapper looks tools up by
  name at call time. Overriding an engine tool means popping it from `mcp._tool_manager._tools`
  and re-registering it, which is done for `desktop_calibrate` and `desktop_reset`. Read-only
  tools join plan mode by rebinding `policy._PLAN_SAFE_TOOLS` (a module global the gate reads per
  call). The Windows tool list is now a SUPERSET of Linux's; the shared schemas are unchanged.
- **Held input must never leak.** `mouse_down`/`key_down` record presses in
  `backend_windows._HELD`. A daemon `threading.Timer` watchdog releases anything older than
  `CINDRO_INPUT_HOLD_MAX_S` (15s), and `input_release_all` frees it on demand.
  `drag_smooth`/`click_ex` release in `finally`. A stuck shift or left button turns every later
  user click into a shift-click or a drag, so keep the `finally`s.
- **Spreadsheet I/O goes through the clipboard on purpose.** Excel for the web (the user's main
  target, in Chrome) has no COM. TSV paste and copy is the one channel Excel web, Google Sheets and
  desktop Excel all honour. `sheet_paste_table` waits `settle_ms` before restoring the user's
  clipboard, because the page reads it asynchronously after ctrl+v and an early restore pastes
  the OLD contents.
- **`drag()` interpolation bug (both backends).** It looped `range(1, max(2, steps)+1)` but used
  `t = i/steps`, so `steps=1` overshot the target by a full drag length. This is fixed in
  `backend_windows.drag` only. `computer-use/computer_use_mcp/input.py:237` still has it; it's
  harmless at the default `steps=14`.
- **Packaging.** `uiautomation` (comtypes) is in `requirements-windows.txt`. `build.ps1` adds
  `--hidden-import win32clipboard/pythoncom/win32com/win32com.client`, `--collect-all
  uiautomation` and `--collect-submodules comtypes`, plus a fail-fast import probe. New engine
  modules stay flat in `windows/engine/`: the bundle-cache hash only lists that directory
  non-recursively.
- **Prompt.** The co-work guide gets a Windows-only `WINDOWS TOOLS` clause via
  `JARVIS_WINDOWS_TOOLS_CLAUSE`. It uses the same macro hoist as `JARVIS_LIVE_CPU_CMD_EXAMPLE`
  and expands to `""` on Linux.

**Verification:** 77/77 `windows/engine/tests` pass on Linux, 30 of them new
(`test_tools_windows.py`). The clause macro was compile-checked on both branches. The live checks
on a real Windows VM (`winlab`) are listed in the PR and still pending.

## Conventions

- C++: match surrounding Qt style; logic in `core` with a `core/tests` ctest; daemon/desktop stay thin.
- QML: reuse `Theme.*` and existing components (`ArcReactor`, `WidgetRenderer`, `HudFrame`,
  `FloatingWidgetLayer`). Keep pages stateless where possible; the `Bridge` is the single client.
- Android: MVVM, `StateFlow<UiState>`, Room/DataStore (not raw SharedPreferences for new code),
  one `@Composable` screen per file. After any Android change, build the APK and push it to the phone.
- Bump `versionCode`/`versionName` on every shippable Android change.
