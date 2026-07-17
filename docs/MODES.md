# Modes — plan / build / co-worker

A **behavioral profile** the user picks for the agent, like `permission_level`. Unlike
`permission_level`, PLAN mode is not just a prompt suggestion — write/execute tools are
**hard-blocked at the tool layer** while planning (see "How PLAN is enforced" below).
Surfaced as a HUD chip on every surface and selectable in Settings.

| Mode | Behavior |
|---|---|
| `plan` | Research + produce a step-by-step plan via `todo_write`; write/execute tools are **hard-blocked**, not just discouraged; call `present_plan` to submit the plan and block for the user's decision (Approve & Build / Request Changes). Pairs naturally with `permission_level: high`. |
| `build` | Execute the agreed plan autonomously; minimal asking; keep the todo list current. |
| `coworker` (default) | Balanced — does the work but asks before risky/destructive actions (today's behavior; no extra clause). |

## How it works
- **Storage:** `SettingsStore::agentMode()` round-trips in `~/.config/jarvis/config.toml`
  as `agent_mode = "plan|build|coworker"` (normalized; unknown → `coworker`). Mirrors
  `permission_level` exactly (`core/src/SettingsStore.cpp`).
- **Injection:** `ControlServer::modePolicyClause()` returns the clause, appended right
  after `permissionPolicyClause()` in the per-session preamble
  (`daemon/src/ControlServer.cpp`). Skipped for subagents (isolated).
- **Contract A:** `settings.get` / `settings.set` carry `agent_mode`.
- **Desktop:** `Bridge.agentMode` is a live property (WRITE persists via `settings.set`);
  the HUD chip in `HudStatusStrip.qml` cycles coworker→plan→build (violet/cyan/amber, the
  dot pulses in BUILD); Settings → Mode has a segmented selector.

## Two ways into PLAN mode

1. **Settings-driven (global)** — the user sets `agent_mode = plan`. Exiting back to BUILD
   is **mandatory-gated**: only `present_plan`'s "Approve & Build" answer can lift it, and
   it lifts the restriction for the *approving session only* — it does not touch the
   global `agent_mode` setting, so a different, concurrently-running session that's also
   plan-restricted stays restricted until its own plan is separately approved.
2. **Self-initiated (ephemeral, per-session)** — the model calls `enter_plan_mode(reason)`
   on its own judgment at any time, in any mode (mirrors how Claude Code's own plan mode
   works — the model decides to go read-only, the user doesn't have to pre-toggle
   anything). This restricts only that one session, is never persisted, and the model can
   leave it itself with `exit_plan_mode(summary)` — no user approval required. It can still
   voluntarily call `present_plan` if the plan is worth showing the user, but doesn't have
   to. Tracked server-side in `ControlServer::m_selfPlanModeSessions` (in-memory only).

Both paths are checked by the same `plan.status{session_id}` Contract A method
(`{restricted, source: "settings"|"self"|"approved"|""}`) — see `handlePlanEnter`/
`handlePlanExit`/`handlePlanStatus`/`handlePlanApprove` in `daemon/src/ControlServer.cpp`.
A third, per-session `m_planApprovedSessions` set (granted by `plan.approve{session_id}`,
which only `present_plan`'s Approve & Build path calls) is checked FIRST and always wins,
regardless of the current global/self state — this is what makes approval session-scoped
instead of leaking across concurrently-running plan-restricted sessions. On the Python
side, `policy._plan_status()` also reports `source: "unreachable"` (daemon unreachable,
fails closed) or `"ambiguous_session"` (the shared global engine couldn't tell which of
2+ concurrent sessions is calling — also fails closed, rather than querying with an empty
session id and risking another session's status leaking into this one's cache entry).

## How PLAN is enforced

The real enforcement lives in `computer-use/computer_use_mcp/policy.py`'s
`_plan_mode_gate` — the single choke point every brain's MCP tool call already passes
through (`install()`/`gated_call_tool`, wired first, before the trust-policy/phone/
command-scan gates). It calls `plan.status` (session-scoped, ~2s TTL cache,
**fails closed** — an unreachable daemon is treated as restricted, unlike this file's
usual fail-open convention, because PLAN mode is a safety guarantee) and hard-denies
any tool not on a small read/plan-safe allowlist (`_PLAN_SAFE_TOOLS`): read-only
introspection, the checklist (`todo_*`), `ask_user`/`notify_user`, the full subagent
research surface (`agent_create`/`agent_list`/`agent_get`/`agent_start`/`agent_wait`/
`agent_status`/`agent_result`/`agent_stop`/`agent_send`), and Plan Mode's own tools
(`present_plan`/`enter_plan_mode`/`exit_plan_mode`).

This is 100% of the tool surface for **ApiBrain** (it has no native file/shell tools —
everything routes through this MCP server). For **CodexBrain** and **ClaudeBrain**,
which shell out to the real `codex`/`claude` CLIs, this only covers their MCP-sourced
tools; each CLI's own native file/shell tools need brain-specific handling too
(`ControlServer::makeBrain()`), with real caveats:

- **CodexBrain**: `driveMcp` (set whenever computer-use is injected — true for any
  session that also needs `present_plan`/`agent_start`) unconditionally forces
  `--sandbox danger-full-access` in `CodexBrain`'s ctor, overriding whatever `makeBrain()`
  sets. So PLAN mode for Codex sessions is enforced for MCP tools only — Codex's
  **native** shell/apply_patch tools are **not** hard-blocked. A known, documented gap.
- **ClaudeBrain**: `--permission-mode plan` (Claude Code's own native plan mode) was
  live-tested and **rejected** — it blanket-denies every MCP tool call with no allowlist
  override, which would also break `present_plan`/`agent_start`/`todo_write`. The
  verified mechanism instead: `--permission-mode bypassPermissions` (so MCP tools —
  gated by `policy.py` — actually run headless) + `--disallowedTools
  Write,Edit,NotebookEdit,Bash,Task` to remove Claude's native mutating tools (invisible
  to the MCP-side gate). `Task` is included so subagent dispatch is forced through
  Cindro's own gated `agent_start`, not Claude's native ungated Task tool.

**Persona note (2026-07-17 live-testing fix):** the co-work guide + policy preamble
(tool grants, permission/mode policy, identity) used to be PREPENDED into the first
user-turn's text for every brain, including ClaudeBrain — but Claude Sonnet 5 correctly
treats an unsigned instruction block riding inside user-turn text as a plausible prompt
injection, and refused to adopt the persona or trust the tools it listed even though they
were genuinely wired up. Fixed by giving `Brain` a `setSystemPromptAppend(text)` virtual
(no-op default) and routing the preamble through it for ClaudeBrain, which wires to the
real `claude` CLI's `--append-system-prompt` flag (accumulates across calls, never
replaces). CodexBrain/ApiBrain keep the legacy prepend convention. See
`ControlServer::identityClause()`/`sendToSession()` and
`ClaudeBrain::Options::systemPromptAppend`.

## Presenting a plan — `present_plan`

`present_plan(title, markdown, todos)` (`computer_use_mcp/tools_plan.py`) publishes the
plan and blocks (via the existing `ask_bus`, the same mechanism trust-policy/phone/
command-scan "ask" already use — no new UI plumbing) for the user's **Approve & Build**
or **Request Changes**. Approve calls both `plan.exit` (clears the self-initiated flag,
if set) and `plan.approve` (grants the session-scoped approved-override) — it
deliberately does **not** flip the global `agent_mode` setting, so approving one
session's plan can never silently unblock a different, concurrently-running
plan-restricted session whose own plan was never shown to the user (a real bug an
earlier version of this had — Codex review, PR #130/#132). Then busts the gate's cache
so the very next tool call in the same turn is already unblocked. Request Changes returns
the user's feedback as `note` for the model to incorporate before calling `present_plan`
again — there is **no** separate edit/update-plan tool; `present_plan` is both how a plan
is published and how revision feedback comes back, and the docstrings/`modePolicyClause`/
`planToolsClause` say so explicitly so the model doesn't go looking for one. On the UI
side, `ChatDelegate.qml`'s plan card detects `present_plan`'s fixed two-option shape and
opens "Request Changes" into a focused text field instead of submitting the bare label as
the answer (2026-07-17 live-testing fix — the bare label left the model with a
`note` containing no actual feedback to act on).

Approve/deny matching across every `ask_bus`-backed gate (this one, trust-policy,
phone, command-scan) goes through `ask_bus.is_affirmative(answer, yes_label)`, not an
exact `answer == "allow"` string match — the latter silently denied legitimate
free-text affirmatives typed into a question card's custom-answer field (2026-07-17
live-testing fix). Matching order: exact match against the button's own label first,
then a small literal whitelist, then a narrow `"yes "`/`"sure "`/etc. prefix match —
deliberately not fuzzy/substring, so a genuinely ambiguous reply still fails closed.

## Steering a dispatched subagent — `agent_send`

`agent_send(session_id, message)` sends a follow-up to a subagent already dispatched via
`agent_start`, without waiting for it to finish. It does **not** interrupt a subagent
mid-task (codex/claude subagents run one non-interruptible process invocation per turn);
the message is queued and delivered as the subagent's next turn the instant its current
one finishes. Implemented as a thin wrapper over the same `session.send` Contract A path
`agent_stop` already reuses (`session.cancel`) — `agent_start` spins up a real daemon
session, so no new C++ plumbing was needed.

## Builtin "planning" skill

Seeded at daemon startup like `internal_docs`/`phone` (`ControlServer::seedPlanningSkill()`,
versioned marker, `group: "builtin"` — never clobbers a user-owned skill of the same
name): research-first methodology, when to fan out via `agent_start`, what a good plan
contains, always finish with `present_plan`.

## Wake-notify (related setting)
`SettingsStore::wakeNotify()` (`wake_notify = silent|ping|always`, default `ping`) controls
what a background-job / sleep-wake does to the user's phone: `silent` (wake the agent only),
`ping` (notify the phone for long/important jobs), `always` (notify on every wake). See
[BACKGROUND_JOBS.md](BACKGROUND_JOBS.md).

Tests: `core/tests/settings_store_test.cpp` (defaults, normalization, round-trip);
`core/tests/claude_buildargs_test.cpp` / `core/tests/codex_buildargs_test.cpp` (PLAN
mode argv shape, incl. the CodexBrain driveMcp-override case); `computer-use/tests/
test_policy.py` (`_plan_mode_gate` cache/allowlist/fail-closed behavior) and
`computer-use/tests/test_tools_plan.py` (`present_plan`/`enter_plan_mode`/
`exit_plan_mode`).
