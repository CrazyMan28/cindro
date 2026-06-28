// Unit test for HookStore — Claude-Code-style lifecycle hooks. Runs REAL hook
// commands (inline sh) against a QTemporaryDir HOME so it never touches the
// user's ~/.config/jarvis. Proves: event list, CRUD round-trip through
// hooks.json, the exit-code/stdout block protocol, additionalContext injection,
// and matcher routing for tool events.

#include "jarvis/Config.h"
#include "jarvis/HookStore.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

static void reset(jarvis::HookStore &h)
{
    QJsonObject empty;
    empty.insert(QStringLiteral("hooks"), QJsonObject());
    h.setConfig(empty);
}

int main()
{
    QTemporaryDir home;
    if (!home.isValid()) {
        std::fprintf(stderr, "FAIL: temp HOME\n");
        return 1;
    }
    qputenv("HOME", home.path().toUtf8());
    qunsetenv("XDG_CONFIG_HOME");

    // --- event registry ----------------------------------------------------
    {
        const QStringList ev = jarvis::HookStore::events();
        check(ev.contains(QStringLiteral("PreToolUse")) &&
                  ev.contains(QStringLiteral("UserPromptSubmit")) &&
                  ev.contains(QStringLiteral("SessionStart")) &&
                  ev.contains(QStringLiteral("SubagentStop")) &&
                  ev.contains(QStringLiteral("Stop")),
              "events() includes the core CC events");
        check(jarvis::HookStore::isEvent(QStringLiteral("Notification")) &&
                  !jarvis::HookStore::isEvent(QStringLiteral("Bogus")),
              "isEvent validates names");
    }

    // --- CRUD round-trip through hooks.json --------------------------------
    {
        jarvis::HookStore h;
        h.load();
        reset(h);
        check(h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                        QStringLiteral("echo hi"), 10),
              "addHook persists");
        check(!h.addHook(QStringLiteral("BogusEvent"), QString(),
                         QStringLiteral("echo hi"), 10),
              "addHook rejects an unknown event");

        jarvis::HookStore h2;
        h2.load();
        const QJsonArray got = h2.toJson().value(QStringLiteral("hooks")).toObject()
                                   .value(QStringLiteral("UserPromptSubmit")).toArray();
        check(got.size() == 1, "hook reloaded from hooks.json");
        check(h2.removeHook(QStringLiteral("UserPromptSubmit"), 0), "removeHook");

        jarvis::HookStore h3;
        h3.load();
        check(h3.toJson().value(QStringLiteral("hooks")).toObject()
                  .value(QStringLiteral("UserPromptSubmit")).toArray().isEmpty(),
              "hook removed + key cleaned up");
    }

    // --- additionalContext injection (JSON stdout, exit 0) -----------------
    {
        jarvis::HookStore h;
        h.load();
        reset(h);
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"INJECTED\"}'"),
                  10);
        jarvis::HookStore r;
        r.load();
        const jarvis::HookOutcome o =
            r.run(QStringLiteral("UserPromptSubmit"), QJsonObject{{"user_prompt", "hi"}});
        check(o.ranAny, "hook ran");
        check(!o.blocked, "exit 0 does not block");
        check(o.injectedContext.contains(QStringLiteral("INJECTED")),
              "additionalContext injected");
    }

    // --- block via exit 2 (stderr is the reason) ---------------------------
    {
        jarvis::HookStore h;
        h.load();
        reset(h);
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; echo 'NOPE' >&2; exit 2"), 10);
        jarvis::HookStore r;
        r.load();
        const jarvis::HookOutcome o = r.run(QStringLiteral("UserPromptSubmit"), QJsonObject{});
        check(o.blocked, "exit 2 blocks the turn");
        check(o.blockReason.contains(QStringLiteral("NOPE")), "block reason from stderr");
    }

    // --- block via {"decision":"block","reason":...} -----------------------
    {
        jarvis::HookStore h;
        h.load();
        reset(h);
        h.addHook(QStringLiteral("Stop"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"decision\":\"block\",\"reason\":\"stay\"}'"),
                  10);
        jarvis::HookStore r;
        r.load();
        const jarvis::HookOutcome o = r.run(QStringLiteral("Stop"), QJsonObject{});
        check(o.blocked && o.blockReason.contains(QStringLiteral("stay")),
              "decision:block blocks with reason");
    }

    // --- matcher routing for tool events -----------------------------------
    {
        jarvis::HookStore h;
        h.load();
        reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QStringLiteral("Bash"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"BASHONLY\"}'"),
                  10);
        jarvis::HookStore r;
        r.load();
        const jarvis::HookOutcome hit =
            r.run(QStringLiteral("PreToolUse"), QJsonObject{{"tool_name", "Bash"}},
                  QStringLiteral("Bash"));
        check(hit.injectedContext.contains(QStringLiteral("BASHONLY")),
              "matcher matches the Bash tool");
        const jarvis::HookOutcome miss =
            r.run(QStringLiteral("PreToolUse"), QJsonObject{{"tool_name", "Edit"}},
                  QStringLiteral("Edit"));
        check(!miss.ranAny, "matcher skips a non-matching tool");
    }

    // --- non-JSON stdout becomes context -----------------------------------
    {
        jarvis::HookStore h;
        h.load();
        reset(h);
        h.addHook(QStringLiteral("SessionStart"), QString(),
                  QStringLiteral("cat >/dev/null; printf 'plain note'"), 10);
        jarvis::HookStore r;
        r.load();
        const jarvis::HookOutcome o =
            r.run(QStringLiteral("SessionStart"), QJsonObject{{"source", "startup"}},
                  QStringLiteral("startup"));
        check(o.injectedContext.contains(QStringLiteral("plain note")),
              "non-JSON stdout injected as context");
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS hook_store_test\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL hook_store_test (%d failures)\n", g_failures);
    return 1;
}
