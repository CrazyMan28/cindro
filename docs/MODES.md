# Modes — plan / build / co-worker

A **soft behavioral profile** the user picks for the agent. Like `permission_level`,
it changes *what the model is told* (a clause appended to the co-work preamble), not
the sandbox/capability tiers. Surfaced as a HUD chip on every surface and selectable
in Settings.

| Mode | Behavior |
|---|---|
| `plan` | Research + produce a step-by-step plan via `todo_write`; make **no** changes (read-only); present the plan and wait for approval before executing. Pairs naturally with `permission_level: high`. |
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

## Wake-notify (related setting)
`SettingsStore::wakeNotify()` (`wake_notify = silent|ping|always`, default `ping`) controls
what a background-job / sleep-wake does to the user's phone: `silent` (wake the agent only),
`ping` (notify the phone for long/important jobs), `always` (notify on every wake). See
[BACKGROUND_JOBS.md](BACKGROUND_JOBS.md).

Tests: `core/tests/settings_store_test.cpp` (defaults, normalization, round-trip).
