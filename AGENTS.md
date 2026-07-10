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
  runs as its own separate process** — the Jarvis copy is a snapshot only. Don't hand-edit
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
  in Jarvis as a Phone section (Calls/Inbox/Agents/HUD/Settings nav). On Android the Phone
  section hides Jarvis's main bottom nav (full-screen); backing out restores it. A new QML
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

- **`cli/` — the jarvis terminal** (own venv, like acp-bridge): `jarvis` = textual
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
  Jarvis is actually running on.

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
- **The workload-manager schedule seeder now ships in-repo**
  (`proxmox-mcp/packaging/seed_schedule.py`, idempotent) — the KNOWN GAP
  step is copy + run with the deployed venv's python on the Proxmox host,
  not hand-rolling `schedule.create` JSON.

## Branches & flow

Three long-lived branches; **`main` is protected** (PR-only, no direct pushes, no
force-push, no deletion). Promote up, never push straight to `main`:

```
work on dev  →  push  →  test  →  promote dev → qa  →  test  →  PR qa → main  →  merge
```

Do day-to-day work on **`dev`**. When it's good, fast-forward/merge into **`qa`** and
test. When qa passes, open a **PR into `main`** and merge it. Never commit directly to
`main` (the branch protection will reject it).

## GitHub / CI / releases (how Issac runs this repo)

- **CI is 100% self-hosted — ZERO GitHub-hosted minutes.** Windows builds run on
  `win-runner-1` (the winvm / Proxmox VM 106 box); Linux CI/release/auto-release run on the
  six `pve-ubuntu-runner-*` (VM 104). **Never** switch a workflow to `windows-latest` /
  `ubuntu-latest` — all four workflow files use `runs-on: [self-hosted, …]`. The Windows
  runner is **prebuilt** (git, vcpkg + libsodium/libqrencode, Inno Setup, VS Build Tools,
  PowerShell 7, Python, Qt, Ninja, CMake, Node) via `windows/scripts/setup-runner-*.ps1`, so
  the workflow does **no per-run tool downloads** (mirrors the Linux prebuilt CI image). After
  a winvm reboot the runner service may need `Start-Service "actions.runner.CrazyMan28-jarvis.win-runner-1"`
  (or `sc.exe start …`); it does not always auto-start after a hard power cycle.
- **Releases are automatic: merging to `main` = a new release.** `auto-release.yml` finds the
  highest `vX.Y.Z` tag, bumps the **patch**, and creates that tag → `windows-build` +
  `linux-release` fire on the tag and attach `Jarvis-Setup-<ver>.exe` + the AppImage to a new
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

## Conventions

- C++: match surrounding Qt style; logic in `core` with a `core/tests` ctest; daemon/desktop stay thin.
- QML: reuse `Theme.*` and existing components (`ArcReactor`, `WidgetRenderer`, `HudFrame`,
  `FloatingWidgetLayer`). Keep pages stateless where possible; the `Bridge` is the single client.
- Android: MVVM, `StateFlow<UiState>`, Room/DataStore (not raw SharedPreferences for new code),
  one `@Composable` screen per file. After any Android change, build the APK and push it to the phone.
- Bump `versionCode`/`versionName` on every shippable Android change.
