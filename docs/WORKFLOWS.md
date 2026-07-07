# Workflows & Agent-Scoped Memory

Two thin extensions to Jarvis's existing memory + scheduler.

## Agent-scoped memory

`remember`/`recall` gained an optional `agent` argument (an agent name or a
paired-machine id, e.g. `ci-runner-104`). Agent memory is isolated by
default — think of it as its own file per agent, not a tag on the global
pool — with one deliberate exception for conversations that are clearly
*about* that agent:

- `remember(text, tags=[], agent="ci-runner-104")` stores the fact scoped to
  that agent (SQLite `scope="agent"`, `entity_ref="ci-runner-104"`).
- `recall(query, agent="ci-runner-104")` returns ONLY that agent's memories.
- `recall(agent="ci-runner-104")` (empty query) returns that agent's recent
  state — the basis of the condition-polling pattern below.
- **Omitting `agent` excludes agent-scoped facts entirely.** `recall(query)`
  and `search(query)` with no `agent`/`entityRef` never return agent-scoped
  rows — an unrelated chat has no way to see them. This applies to both the
  explicit `recall`/`search` tools and the automatic per-turn memory context
  (`prefetch()`, what the daemon silently prepends to every ordinary chat
  turn).
- **Exception — mention-based auto-recall.** If the current turn's text
  mentions a known agent by name (whole-word match against any `entity_ref`
  that has at least one stored agent-scoped memory), `prefetch()`
  automatically pulls that agent's own memories into context too, on top of
  the normal global ones — so a chat that says "check on `ci-runner-104`"
  sees its scoped history without an explicit `recall(agent=...)` call. This
  only affects the automatic background-context path; it's bounded to a
  small number of extra rows and only kicks in for names that already have
  stored agent memory.

## Workflows

A **Workflow** is a nameable, managed job = trigger + prompt + (optional
brain+model) + a free-text `target` + an inbox `report_thread`. Workflows are
persisted in the same `schedules` table the scheduler already uses.

### Tools

- `workflow_create(name, trigger, prompt, brain="", model="", target="", report_thread="")`
  - `trigger`: a 5-field cron (`"0 2 * * *"`), an interval (`"every 30m"`), a
    clock time (`"at 09:00"`), or the literal `"webhook"`.
  - `target`: free-text agent/machine reference the prompt refers to (e.g.
    `recall(agent=<target>)`, or run `outpost_exec` on it).
  - `report_thread`: the in-app inbox thread the fired session posts its report
    to (default `"Workflows"`, auto-created on first `notify_user`). In-app inbox
    only — no push/SMS.
  - Returns `{id}`, or `{id, webhook_url, token}` for `trigger="webhook"`.
- `workflow_list()` → `{workflows:[{id,name,trigger,target,report_thread,brain,model,next_run,last_run,enabled}]}`.
- `workflow_delete(id)` → `{ok, deleted}`.

### Reporting to the inbox

When a Workflow fires, the daemon appends an instruction to the fired session's
prompt: *post a concise summary to the inbox via `notify_user(title="<report_thread>")`.*
The phone/inbox server creates the named thread on first use.

### Condition-polling ("check X, only report if it changed")

No new schema — it's a prompt pattern. Author a tight-cadence Workflow whose
prompt tells the fired session to `recall(agent=<target>)` for the last-known
state, compare, escalate only on a change, then `remember(..., agent=<target>)`
the new state.

### Worked example

```
workflow_create(
  name="nightly-runner-check", trigger="0 2 * * *", target="ci-runner-104",
  brain="api", model="mistral-large-latest",
  prompt="Run outpost_exec on ci-runner-104 checking the GitHub Actions runner "
         "service status; recall(agent='ci-runner-104') for last-known state; only "
         "escalate if it changed from healthy; otherwise just log OK.",
  report_thread="Workflows")
```

> **Prerequisite for `outpost_exec` in a Workflow's prompt:** the fired
> session only sees the `outpost_exec` tool if outpost-mcp is registered as
> an available MCP server for that session (`outpost-mcp/client-setup.sh`).
> This is a separate, one-time setup step from creating the Workflow itself
> — if it's skipped, the prompt above will fail because `outpost_exec`
> doesn't exist for that session to call. See
> [docs/OUTPOST.md](OUTPOST.md) for the full bring-up + registration steps.

### Webhook trigger

`workflow_create(name, trigger="webhook", prompt=...)` mints a per-workflow
bearer token and returns `{id, webhook_url, token}`. POST to that URL with the
token to fire the workflow immediately through the same path the cron scheduler
uses:

```
curl -X POST "$WEBHOOK_URL" -H "Authorization: Bearer $TOKEN"
```

The endpoint (`POST /workflows/webhook/<id>` on the computer-use MCP server,
default `:8794`) is exempt from the global bearer and authenticates ONLY with
the per-workflow token (hmac-safe compare). Set `advertise_host` in
`~/.computer-use/config.yaml` (or `JARVIS_WEBHOOK_BASE`) to a tailnet-reachable
name so `webhook_url` is callable from off-box.
