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

## Conventions

- C++: match surrounding Qt style; logic in `core` with a `core/tests` ctest; daemon/desktop stay thin.
- QML: reuse `Theme.*` and existing components (`ArcReactor`, `WidgetRenderer`, `HudFrame`,
  `FloatingWidgetLayer`). Keep pages stateless where possible; the `Bridge` is the single client.
- Android: MVVM, `StateFlow<UiState>`, Room/DataStore (not raw SharedPreferences for new code),
  one `@Composable` screen per file. After any Android change, build the APK and push it to the phone.
- Bump `versionCode`/`versionName` on every shippable Android change.
