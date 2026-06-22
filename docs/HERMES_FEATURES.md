# Hermes-derived features to build into Jarvis (spec for the memory/skills + co-worker waves)

Source studied: `~/.hermes/hermes-agent/` (Python agent) + `~/projects/mcp/hermes-phone-mcp-bridge/`
(Android body) + `~/projects/mcp/agent_tts-stt/`. Adopt the FEATURES below (not Hermes' look).
These sit at the **Jarvis level** (jarvisd), applied for ALL brains — and especially the ApiBrain path
(CodexBrain/ClaudeBrain already have their own memory/skills; Jarvis memory is injected on top).

## 1. Memory (adopt — task #17)
MemoryProvider pattern (from `agent/memory_manager.py` + `memory_provider.py`):
- Lifecycle hooks called by the agent loop: `initialize(session)`, `prefetch(query,session)` BEFORE each
  turn (returns relevant memory to inject into the prompt), `sync_turn(user,assistant,session)` AFTER
  each turn (async write), `get_tool_schemas()` (expose memory tools to the model), `system_prompt_block()`.
- Writes via `on_memory_write(action, target, content, metadata)` — action ∈ add|replace|remove,
  target ∈ memory|user, metadata = provenance (session_id, tool_name, origin).
- Storage: SQLite + FTS5 full-text search. One active external provider at a time (avoid schema bloat).
- Jarvis impl: builtin SQLite provider at `~/.local/share/jarvis/jarvis.db` (tables `memories`,
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
  new `SKILL.md` to the skills dir; Jarvis indexes it and it becomes invokable. Jarvis can thus learn a
  repeatable task once and save it as a skill. (Codex/Claude CLIs also read a skills dir — Jarvis can
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

## 6. Voice STT/TTS + "Hey Jarvis" wake (adopt — Android, task #7/#10)
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
