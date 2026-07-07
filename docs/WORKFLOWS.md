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
- `workflow_update(id, name="", trigger="", prompt="", brain="", model="", target="", report_thread="")`
  - Edits an existing Workflow (from `workflow_list`) **in place**. Every
    argument besides `id` is optional and defaults to `""`, meaning **"don't
    change this field"** — only pass the fields you actually want to change.
    There is no way to explicitly clear a field back to empty through this
    tool (an empty string is indistinguishable from "not provided"); the web
    dashboard's Edit panel talks to `schedule.update` directly instead, which
    is where real clearing (e.g. wiping `report_thread`) lives.
  - `trigger` follows the same syntax as `workflow_create`'s `trigger`.
  - The webhook token (if any) is never editable here — it stays fixed once
    minted at creation. Converting an existing non-webhook row's trigger to
    `"webhook"` is rejected (only `workflow_create` can mint a token).
  - Returns `{ok}`.
- `workflow_delete(id)` → `{ok, deleted}`.

### Reporting to the inbox

When a Workflow fires, the daemon appends an instruction to the fired session's
prompt: *post a concise summary to the inbox via `notify_user(title="<report_thread>")`.*
The phone/inbox server creates the named thread on first use.

### Condition-polling ("check X, only report if it changed")

No new schema — it's a prompt pattern. Author a tight-cadence Workflow whose
prompt tells the fired session to `recall(agent=<target>)` for the last-known
state, compare, escalate only on a change, then `remember(..., agent=<target>)`
the new state. The web dashboard's **"⚡ Monitor a condition"** button (see
below) fills in this exact pattern as a ready-to-edit template so you don't
have to author it from scratch.

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

### "Monitor a condition" preset

The web dashboard's Workflows page has a one-click preset button that seeds
the create form with the exact condition-polling template above, as literal
placeholder text meant to be edited in place:

```
Run <CHECK COMMAND> on <TARGET>. Recall the last known state (agent=<TARGET>)
and compare — if it changed from healthy/OK, attempt an obvious fix (e.g.
restart the affected service) and/or escalate to my inbox with details;
otherwise just remember the current state and stay quiet.
```

It also sets the trigger to an interval of `every 10m`, the name to
"Condition monitor", and the report thread to the default `"Workflows"` —
you then fill in `<CHECK COMMAND>` and `<TARGET>` (both placeholders) and the
Target field before creating.

A concrete fill-in for the CI-runner health check from the worked example
above, but authored via the preset (tight-cadence polling instead of a
once-nightly cron) rather than by hand:

```
workflow_create(
  name="Condition monitor", trigger="every 10m", target="ci-runner-104",
  prompt="Run systemctl status actions.runner.* on ci-runner-104. Recall the "
         "last known state (agent=ci-runner-104) and compare — if it changed "
         "from healthy/OK, attempt an obvious fix (e.g. restart the affected "
         "service) and/or escalate to my inbox with details; otherwise just "
         "remember the current state and stay quiet.",
  report_thread="Workflows")
```

Equivalently, via `workflow_update` once created, only the `prompt` and
`target` need to change from the raw preset — everything else (trigger,
report thread) can be left at the preset's defaults.

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

### Managing workflows in the web dashboard

Everything above is also available without touching the MCP tools directly:
the web dashboard (`web/src/pages/workflows.tsx`) has a **WORKFLOWS** page in
the MIND nav section (right after Schedules), listing, creating, running,
editing, and deleting Workflows through the same `schedule.*` RPCs the tools
wrap.

**List view.** The page fetches the same `schedule.list` data the plain
Schedules page uses, but shows only the rows that are Workflow-shaped: a
schedule counts as a Workflow if it carries a non-empty `target`, a non-empty
`report_thread`, or a `"webhook"` trigger. A vanilla cron/interval schedule
with none of those three extensions never appears here — it's Schedules-only.
Each row shows the name, trigger (raw cron/interval/daily-at text, or
"Webhook"), target/report-thread/brain+model chips, an enabled toggle, and
next/last-run timestamps (relative, with the absolute time on hover).

**Row actions:**
- **Run** — fires the workflow immediately via `schedule.run_now`, same path
  a cron tick or webhook POST uses.
- **Enable/disable toggle** — flips `enabled` via `schedule.set_enabled`
  without deleting the row.
- **Edit** — expands an inline panel (name, trigger, prompt, brain, model,
  target, report thread) pre-filled with the row's current values, and saves
  via `schedule.update`. The brain `<select>` has an explicit "(daemon
  default)" empty option so a row with no brain set displays its real value
  instead of silently defaulting to whatever option renders first. Unlike
  `workflow_update`'s MCP-level "empty means unchanged" convention, the web
  UI's Edit panel talks to `schedule.update` directly and sends field values
  as-is — an explicitly blanked Report Thread is saved as blank (turning off
  the completion report), the one place in the UI that can deliberately clear
  a field that was previously set.
- **Delete** — `schedule.remove` behind a confirm dialog.

**Webhook token reveal.** Webhook-triggered rows get a "Reveal webhook URL +
token" button instead of a next-run time. Nothing is fetched or rendered
until clicked; clicking calls `schedule.webhook_token` and shows the
`/workflows/webhook/<id>` path and the raw bearer token with per-field Copy
buttons, plus a "Hide" button that clears both back out of component state
(and the DOM). Creating a new webhook workflow shows the freshly minted
token once in a dismissible banner — it isn't actually one-time server-side,
so it can always be re-revealed later from the row.

**Create form fields:** name, a trigger-type selector (Cron / Interval /
Daily at / Webhook) with a type-specific value input, a prompt textarea,
brain (populated from `settings.get`'s `available_brains`, falling back to
`codex`/`claude`/`api`), an optional model override, a free-text Target
(what the prompt acts on — an agent name for `recall()`, or a paired Outpost
machine name), and a Report Thread (defaults to `"Workflows"` if left blank).
Choosing Webhook mints a bearer token client-side at create time and hands
it straight to `schedule.create`'s `token` param.

**"⚡ Monitor a condition" quick-create button** — pre-fills the composer
with the condition-polling preset described above (interval `every 10m`,
name "Condition monitor", report thread "Workflows", and the
`<CHECK COMMAND>`/`<TARGET>` placeholder prompt) so a health-check Workflow
can be authored by editing two placeholders and the Target field rather than
writing the prompt from scratch.

**Known overlap with the Schedules page:** a workflow-shaped row (one with a
target, report thread, or webhook trigger) is still also visible on the
plain Schedules page, since both pages read the same underlying
`schedule.list` data — Schedules just doesn't filter it. This is accepted,
not a bug: Schedules remains the complete, unfiltered view of every
scheduled job, and Workflows is a curated subset with richer editing for the
jobs that use the target/report-thread/webhook extensions. Don't be
surprised to see the same row in both places.
