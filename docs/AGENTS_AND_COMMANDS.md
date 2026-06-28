# Jarvis — "/" Command Palette + Custom Agents (Subagents)

How the slash-command palette and the custom-agent (subagent) system work across
the desktop, the phone, and the Chrome extension. Pair with
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`../AGENTS.md`](../AGENTS.md).

## The "/" command palette

Type `/` as the first character of the chat composer and an animated, scrollable,
filterable menu rises above the input listing three groups:

- **Commands** — built-ins: `/new`, `/clear`, `/voice`, `/agents`, `/skills`,
  `/dispatch <agent> <task>`, `/agent <name>`, `/model <m>`, `/brain <b>`,
  `/resume <id>`, `/help`.
- **Agents** — your custom agents (each shown with its *when to use*).
- **Skills** — self-authored skills (`/<name>`).

Up/Down move the selection, Enter/Tab pick, Esc closes; typing after `/` filters
live. Picking a command runs it; picking an agent inserts `/dispatch <name> ` so
you can type the task; picking a skill inserts `/<name> ` for its args.

Surfaces:
- **Desktop** — `desktop/qml/SlashPalette.qml`, hooked in `JarvisPanel.qml`
  (`updateSlash`/`handleSlashSubmit`/`runSlashCommand`), styled after
  `CommandPalette.qml`. (The Ctrl+K page/session quick-switcher is separate and
  unchanged.)
- **Phone** — `android/.../ui/chat/SlashPalette.kt`, shown above the composer;
  `ChatViewModel.handleSlash` runs commands; `loadSlashCatalog` fetches the lists.
- **Chrome extension** — the side panel composer (`extension/sidepanel.js`):
  `/` opens the dropdown; `handleSlash` runs commands; a quick-flow chip row
  (Agents / Skills / Running / Commands) gives one-tap access.

## Custom agents (subagents)

A custom agent is a reusable specialist you define once and dispatch tasks to. It
runs as a **child session** (its own brain turn) and reports back; the desktop
SubAgentTree groups children under their parent.

### Definition — `AGENT.md`
Stored at `~/.local/share/jarvis/agents/<slug>/AGENT.md` (mirrors the skills
layout). YAML frontmatter + a body that is the agent's **system prompt**:

```markdown
---
name: Research Bot
description: Researches a topic deeply across sources
when_to_use: When the user asks to research / investigate something multi-source
brain: claude            # optional: codex | claude | api (else default)
model: claude-opus-4-8   # optional (else brain default)
profile: coworker        # optional: coder | coworker (default coworker)
tools: [browser, screenshot]   # optional, informational
color: "#B28BFF"         # optional UI accent
---
You are a meticulous research agent. Always cite sources…
```

Created agents are mirrored to `~/.claude/agents/<slug>.md` (Claude-Code subagent
format) so the claude CLI brain can use them too. Backed by
`core/AgentStore.{h,cpp}` (unit-tested: `core/tests/agent_store_test.cpp`).

### Contract A (daemon)
- `agents.list` / `agents.get` / `agents.create` / `agents.remove` — definition CRUD.
- `agents.dispatch {agent, task, parent_session_id?}` → `{session_id}` — spawns a
  child session that runs as the agent and sends it `task`.
- `agents.running` — agent (child) sessions + whether each is live.
- Sessions gained `parent_session_id` + `agent` columns (`SessionStore` migration);
  `session.create` accepts `parent_session_id` + `agent` (resolves the def,
  injects its system prompt on turn 1).
- Mirrored on the **device WS** for the phone (reads = read tier;
  create/remove/dispatch = biometric tier).

### Model-driven MCP tools
The model drives its own agents through MCP (engine `tools_jarvis_ops.py`,
re-exported by `jarvis-mcp`), so it decides *when* to delegate:
`agent_create`, `agent_list` (each with its `when_to_use`), `agent_get`,
`agent_remove`, `agent_start(name, task)` → child session id, `agent_status`,
`agent_stop(session_id)`. The co-work preamble tells the model to consult each
agent's `when_to_use` and prefer dispatching the right agent over doing every
sub-task inline.

### UIs
- Desktop **Agents** page (`desktop/qml/AgentsPage.qml`, NavRail → MIND): list,
  create/edit (name / what it does / when to call / brain / model / profile /
  system prompt), dispatch (task prompt), remove.
- Phone **Agents** screen (`android/.../ui/agents/`, under "More").
- Extension: `/agents`, `/dispatch`, `/running` in the side panel.

## Related behavior shipped alongside

- **Right-side panel (desktop)** — the model's **PLAN** card now sits on top of the
  live agent-desktop view in one panel; it opens only when a TODO is created or an
  agent desktop is actually in use (not on the first message).
- **Plan strikethrough** — done TODO items render with a line through them (the
  `strike` text prop, both widget renderers).
- **TTS** — one strict FIFO queue (single player; requests serialized) so replies
  never talk over each other across messages, on desktop and phone.
- **Skills** — the model must use the `create_skill` MCP tool (not its CLI's own
  skill files); the Skills list also surfaces skills found in the CLI dirs so any
  created skill shows up.
- **Chrome extension** — renders the generative widget DSL + the PLAN checklist via
  a control-WS `widget.subscribe` broadcast (the desktop still tails the file).
