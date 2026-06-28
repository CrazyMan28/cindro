#pragma once

// HookStore — Claude-Code-style lifecycle hooks for Jarvis.
//
// User-configured shell commands that fire at session / turn / tool lifecycle
// events. Config lives at ~/.config/jarvis/hooks.json with the SAME schema as
// Claude Code's settings.json `hooks` block, so existing CC hook scripts are
// reusable:
//
//   { "hooks": {
//       "PreToolUse": [
//         { "matcher": "Bash|mouse_.*",
//           "hooks": [ { "type":"command", "command":"/path/hook.sh", "timeout":30 } ] }
//       ],
//       "UserPromptSubmit": [ { "hooks": [ {"type":"command","command":"..."} ] } ]
//   } }
//
// Each hook command receives a JSON object on STDIN (event-specific fields:
// session_id, hook_event_name, tool_name, tool_input, prompt, message, ...) and
// communicates back via:
//   - exit 0  : success. stdout may be JSON — {"continue":false} or
//               {"decision":"block","reason":...} blocks; {"additionalContext":...}
//               or {"hookSpecificOutput":{"additionalContext":...}} injects context;
//               {"hookSpecificOutput":{"permissionDecision":"deny",...}} blocks.
//               Non-JSON stdout is injected as additionalContext.
//   - exit 2  : BLOCK; stderr is the reason fed back to the model.
//   - other   : non-blocking error (stderr collected, not fatal).
//
// `matcher` (PreToolUse/PostToolUse only) is a regex tested against the tool
// name; empty/absent matches all. Jarvis enforces blocking where its
// architecture allows (UserPromptSubmit can block/inject; SessionStart injects);
// tool hooks are observational callbacks — the brain's CLI executes MCP tools
// directly, so a PreToolUse hook runs as a side effect and cannot abort an
// in-flight MCP call (documented honestly in docs/HOOKS.md).

#include <QJsonObject>
#include <QString>
#include <QStringList>

namespace jarvis {

struct HookOutcome {
    bool ranAny = false;     // at least one hook matched + ran
    bool blocked = false;    // a hook requested a block
    QString blockReason;     // why (fed back to the model)
    QString injectedContext; // additionalContext to prepend to the turn (concatenated)
    QStringList notes;       // per-hook results (for hooks.test / logs)
};

class HookStore {
public:
    HookStore() = default;

    // ~/.config/jarvis/hooks.json
    static QString configPath();
    // Supported event names (Claude-Code compatible).
    static QStringList events();
    static bool isEvent(const QString &name);

    // (Re)load hooks.json. Missing file => no hooks. Never throws.
    void load();

    // Fire every hook registered for `event` whose matcher matches `matchKey`
    // (matchKey = tool name for Pre/PostToolUse; ignored otherwise), piping
    // `input` (augmented with hook_event_name) to each on stdin.
    HookOutcome run(const QString &event, const QJsonObject &input,
                    const QString &matchKey = QString()) const;

    // hooks.list — the full config as JSON ({ "hooks": {...} }).
    QJsonObject toJson() const { return m_config; }

    // CRUD (persists to hooks.json). add/remove return false on bad input.
    bool addHook(const QString &event, const QString &matcher,
                 const QString &command, int timeoutSec = 60);
    bool removeHook(const QString &event, int index);
    bool setConfig(const QJsonObject &config);

    bool save() const;
    QString lastError() const { return m_lastError; }

private:
    QJsonObject m_config; // { "hooks": { Event: [ {matcher, hooks:[...]} ] } }
    mutable QString m_lastError;

    void runOne(const QString &command, int timeoutSec, const QByteArray &stdinJson,
                HookOutcome &out, const QString &label) const;
};

} // namespace jarvis
