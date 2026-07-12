# Hooks — Claude-Code-style lifecycle hooks

User-configured shell commands that fire at Orin lifecycle events. The config
schema matches Claude Code's `settings.json` `hooks` block, so existing CC hook
scripts are reusable.

## Config — `~/.config/jarvis/hooks.json`
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|mouse_.*",
        "hooks": [ { "type": "command", "command": "/path/hook.sh", "timeout": 30 } ] }
    ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "..." } ] } ]
  }
}
```
`matcher` (a regex; `*`/empty = always) routes by **tool name** (PreToolUse/PostToolUse),
**source** (SessionStart/End), **notification type**, or **agent type** (SubagentStop).

## Events
`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`,
`SessionStart`, `SessionEnd`, `PreCompact`.

## The protocol (per hook command)
The command receives a JSON event on **stdin** (`session_id`, `hook_event_name`,
`tool_name`, `tool_input`, `user_prompt`, `source`, …) and communicates back via:
- **exit 0** — success. stdout may be JSON: `{"continue":false}` or
  `{"decision":"block","reason":...}` block; `{"additionalContext":"..."}` (or
  `hookSpecificOutput.additionalContext`, or plain non-JSON stdout) injects context;
  `hookSpecificOutput.permissionDecision:"deny"` blocks.
- **exit 2** — hard block; stderr is the reason fed back to the model.
- **other** — non-blocking error (stderr collected, not fatal).

## Where Orin fires them (and what's enforceable)
`HookStore::run()` is a **no-op fast path** when an event has no hooks, so fire points
cost ~nothing by default (`core/src/HookStore.cpp`; `daemon/src/ControlServer.cpp`):
- **UserPromptSubmit** — can **block** the turn or **inject** context. (Fully enforced.)
- **SessionStart** — injects `additionalContext` into the session's first turn.
- **Stop, SubagentStop, PreToolUse, PostToolUse, Notification** — **observational** callbacks.
  The brain's CLI executes MCP tools itself, so a PreToolUse hook runs as a side effect
  and **cannot abort** an in-flight tool call (honest limitation vs. Claude Code, where the
  harness owns execution).

## Manage them
- MCP tools (the model): `hooks_list`, `hooks_add(event, command, matcher?, timeout?)`,
  `hooks_remove(event, index)`, `hooks_test(event, match_key?, input?)`.
- Contract A: `hooks.list` / `hooks.add` / `hooks.remove` / `hooks.test` (control + device).

Tests: `core/tests/hook_store_test.cpp` (matcher routing, exit-2 block, `decision:block`,
`additionalContext` inject, non-JSON context, CRUD round-trip — real hook scripts).
