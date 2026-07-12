# Hermes-derived features to build into Cindro (spec for the memory/skills + co-worker waves)

Source studied: `~/.hermes/hermes-agent/` (Python agent) + `~/projects/mcp/hermes-phone-mcp-bridge/`
(Android body) + `~/projects/mcp/agent_tts-stt/`. Adopt the FEATURES below (not Hermes' look).
These sit at the **Cindro level** (jarvisd), applied for ALL brains — and especially the ApiBrain path
(CodexBrain/ClaudeBrain already have their own memory/skills; Cindro memory is injected on top).

## 1. Memory (adopt — task #17)
MemoryProvider pattern (from `agent/memory_manager.py` + `memory_provider.py`):
- Lifecycle hooks called by the agent loop: `initialize(session)`, `prefetch(query,session)` BEFORE each
  turn (returns relevant memory to inject into the prompt), `sync_turn(user,assistant,session)` AFTER
  each turn (async write), `get_tool_schemas()` (expose memory tools to the model), `system_prompt_block()`.
- Writes via `on_memory_write(action, target, content, metadata)` — action ∈ add|replace|remove,
  target ∈ memory|user, metadata = provenance (session_id, tool_name, origin).
- Storage: SQLite + FTS5 full-text search. One active external provider at a time (avoid schema bloat).
- Cindro impl: builtin SQLite provider at `~/.local/share/jarvis/jarvis.db` (tables `memories`,
  `memories_fts`). jarvisd calls prefetch before spawning/sending to the brain and injects results;
  sync_turn after. Expose memory tools (`memory.add/replace/remove/search`) so the model self-curates.

## 2. Self-authored Skills (adopt — task #17; this is the user's "create its own skills")
From `agent/skill_commands.py` + `skill_utils.py` + `~/.hermes/skills/`:
- A skill = a **Markdown file with YAML frontmatter** in `~/.local/share/jarvis/skills/<group>/<name>/SKILL.md`
  (+ optional `scripts/`, `templates/`). Frontmatter: `name, description, tags, metadata{...}`.
- Invoked by `/skill-name args`: loader does template-var `{{VAR}}` substitution, injects the skill dir
  path + resolved config, and inserts the skill content as a user message before the next model call.
- Skills expose NO tools themselves; the agent uses its file/shell/computer-use tools to run bundled scripts.
- SELF-AUTHORING: give the agent a `skill.create(name, description, body, scripts?)` tool that writes a
  new `SKILL.md` to the skills dir; Cindro indexes it and it becomes invokable. Cindro can thus learn a
  repeatable task once and save it as a skill. (Codex/Claude CLIs also read a skills dir — Cindro can
  drop the SKILL.md where the active CLI brain picks it up too.)

## 3. Agent loop (adopt for ApiBrain — task #4)
Per turn: prefetch memory -> build prompt (system + memory + tools) -> model call (stream) -> dispatch
tool calls in a loop (call->result->resend) -> sync memory -> queue next prefetch -> log turn metadata
(tokens, cost, duration). CodexBrain/ClaudeBrain get this from the CLI; ApiBrain implements it.

## 4. Sessions: resume / branch / reset (adopt — extends SessionStore)
Sessions table already exists; add `parent_session_id`, `cost`, `title`. Commands: `/resume <id>`,
`/branch` (fork), `/new` `/reset`. Context-compression auto-chains old->new (defer compression to v2).

## 5. Audit log + risk gate (adopt — task #10, security)
From the phone bridge `AuditLog`: every tool call logged {timestamp, tool, success, summary, remote,
risk: low|medium|high}. high-risk (system control, computer-use take-over, ssh) requires explicit user
approval (the approval cards already in the desktop UI). Keep last ~100 entries; surface in a desktop page.

### Implementation (Wave 8, core + daemon)
- `core/src/AuditLog.*` — SQLite `audit` table in jarvis.db (distinct connection):
  `{id,ts,tool,ok,risk,summary,session_id,remote}`. `audit.list{limit?}` returns the newest ~100.
  jarvisd records: every `session.send` (low), every brain `tool_call` (risk from the injection scan),
  every `approval`, all `schedule.*` and `ssh.*` actions, and the injection-gate decision.
- `core/src/InjectionGuard.*` — pure heuristic scanner (BUILD_SPEC prompt-injection gating). Cues:
  "ignore/disregard previous instructions", credential/cookie exfiltration verbs, destructive shell
  (`rm -rf ~`, fork bomb, disk-wipe), large embedded base64 blobs, and (for tool calls) an unexpected
  external POST to a non-loopback/non-tailnet host. Scored to low|medium|high; medium+ trips the gate.
- **Where it gates:** `ControlServer::gateForInjection()` runs over the user turn before it reaches the
  brain. For an **ApiBrain** session a risky turn is BLOCKED: jarvisd emits an `approval`
  NormalizedBrainEvent (`inject-<session>`), holds the turn, and only resends it after
  `approval.respond("inject-<session>","allow")` (Anthropic-style confirmation). For **CLI brains
  (codex / claude)** the gate CANNOT intercept mid-loop — they run their own in-process tool loop — so
  jarvisd only AUDITS + notifies the flagged turn and relies on the CLIs' own approval/sandbox modes
  (`--sandbox` for codex, claude's permission prompts). Every brain `tool_call` is still rescanned and
  audited as it streams back.
- `core/src/NotifyService.*` — `notify-send` (libnotify/mako) on attention events: approval needed,
  schedule done, task done. Fire-and-forget; silently no-ops if notify-send is absent.

## 5b. Scheduler + SSH allow-list (Wave 8, BUILD_SPEC Contract-A additions)
- `core/src/Scheduler.*` — SQLite `schedules` table + a ~15s `QTimer` tick. `CronSpec` parses
  `every Nm/Nh/Ns`, `at HH:MM`, and 5-field cron (`* , - /` ranges/steps, dow 0/7=Sun). Due enabled
  jobs fire via a `FireFn` the daemon wires to `createSession + sendToSession`; `last_run`/`next_run`
  persist (cadence advances from the scheduled time, not wall-clock, so it doesn't drift). Methods:
  `schedule.create{name,when|cron,prompt,brain?,model?,profile?,enabled?}`, `schedule.list`,
  `schedule.set_enabled`, `schedule.remove`. A fired job calls `notify-send` + audits.
- `core/src/SshAllowList.*` — `~/.config/jarvis/ssh_allow.json` (0600). `ssh.allow_list/allow_add/
  allow_remove`, and `ssh.exec{host,cmd}` which runs `ssh -o BatchMode=yes -o StrictHostKeyChecking=
  accept-new <host> <cmd>` via QProcess **only if the host is allow-listed** — a non-listed host
  returns `host_not_allowed` and ssh is NEVER spawned. Audited (high risk).
- **Contract C mirror:** `schedule.*`, `ssh.allow_list/add/remove`, `ssh.exec`, and `audit.list` are all
  exposed over the device WS via `ControlServer::dispatchOpsMethod(remote=true)`. `ssh.exec` and
  `schedule.create` are **biometric** tier; the audit log records `remote=true` for device-initiated ops.

## 6. Voice STT/TTS + "Hey Cindro" wake (adopt — Android, task #7/#10)
Android `SpeechRecognizer` (push-to-talk + foreground wake phrase) + `TextToSpeech`. Async input,
sync TTS output. Wake phrase only while a foreground service + notification is visible (no silent bg listen).

## 7. Streaming, tokens, error handling (adopt)
Stream chunks to the UI; rough token estimate per request; track cumulative tokens/cost per session;
classify errors (network=retry w/ jittered backoff, auth=fatal, rate-limit=backoff, context-full=
compress/rewind); model fallback chain (primary -> backup).

## Skip / defer
Context compression (v2), RL batch runner, gateway multi-platform (start CLI + our desktop + phone),
multi-provider external memory (builtin SQLite first), Hermes' MCP phone-bridge (we have our own
computer-use + phone stack).

## Where Hermes code lives (reference)
- `~/.hermes/hermes-agent/agent/{memory_manager,memory_provider,skill_commands,skill_utils,conversation_loop}.py`
- `~/.hermes/hermes-agent/{run_agent,cli}.py`, `~/.hermes/skills/`, `~/.hermes/hermes-agent/cron/`
- `~/projects/mcp/hermes-phone-mcp-bridge/` (Android body, AuditLog, McpServer.kt, voice/VoiceManager.kt)
