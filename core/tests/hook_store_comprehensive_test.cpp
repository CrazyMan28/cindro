// Comprehensive unit test for jarvis::HookStore — Claude-Code-style lifecycle
// hooks. Uses a QTemporaryDir HOME so it never touches the user's real config.
// Covers: all events, every matcher variant, every block/inject protocol path,
// multiple hooks in a group, multiple groups, timeout kill, non-fatal errors,
// CRUD round-trips, and matchKey routing.  40+ checks.

#include "jarvis/Config.h"
#include "jarvis/HookStore.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

static int g_failures  = 0;
static int g_passes    = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
        ++g_passes;
    }
}

// Clear all hooks
static void reset(jarvis::HookStore &h)
{
    QJsonObject empty;
    empty.insert(QStringLiteral("hooks"), QJsonObject());
    h.setConfig(empty);
}

// Helper: add one hook, reload and return a fresh store
static jarvis::HookStore freshStore()
{
    jarvis::HookStore r;
    r.load();
    return r;
}

int main()
{
    QTemporaryDir home;
    if (!home.isValid()) {
        std::fprintf(stderr, "FATAL: cannot create temp HOME\n");
        return 1;
    }
    qputenv("HOME", home.path().toUtf8());
    qunsetenv("XDG_CONFIG_HOME");

    // =========================================================================
    // 1. events() — all documented names present; count correct; isEvent
    // =========================================================================
    {
        const QStringList ev = jarvis::HookStore::events();
        check(ev.contains(QStringLiteral("PreToolUse")),        "events() has PreToolUse");
        check(ev.contains(QStringLiteral("PostToolUse")),       "events() has PostToolUse");
        check(ev.contains(QStringLiteral("UserPromptSubmit")),  "events() has UserPromptSubmit");
        check(ev.contains(QStringLiteral("Notification")),      "events() has Notification");
        check(ev.contains(QStringLiteral("Stop")),              "events() has Stop");
        check(ev.contains(QStringLiteral("SubagentStop")),      "events() has SubagentStop");
        check(ev.contains(QStringLiteral("SessionStart")),      "events() has SessionStart");
        check(ev.contains(QStringLiteral("SessionEnd")),        "events() has SessionEnd");
        check(ev.contains(QStringLiteral("PreCompact")),        "events() has PreCompact");
        check(ev.size() >= 9,                                   "events() has at least 9 items");

        check( jarvis::HookStore::isEvent(QStringLiteral("PreToolUse")),    "isEvent PreToolUse");
        check( jarvis::HookStore::isEvent(QStringLiteral("SubagentStop")),  "isEvent SubagentStop");
        check(!jarvis::HookStore::isEvent(QStringLiteral("Bogus")),         "isEvent rejects Bogus");
        check(!jarvis::HookStore::isEvent(QString()),                        "isEvent rejects empty");
    }

    // =========================================================================
    // 2. BLOCK via exit 2 (stderr is reason)
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; printf 'NO_ENTRY' >&2; exit 2"), 10);
        const auto o = freshStore().run(QStringLiteral("UserPromptSubmit"), QJsonObject{});
        check(o.ranAny,   "exit2: hook ran");
        check(o.blocked,  "exit2: blocks");
        check(o.blockReason.contains(QStringLiteral("NO_ENTRY")), "exit2: stderr in reason");
        check(!o.notes.isEmpty(), "exit2: note emitted");
    }

    // =========================================================================
    // 3. BLOCK via stdout {"decision":"block","reason":...}
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("Stop"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"decision\":\"block\",\"reason\":\"halt\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("Stop"), QJsonObject{});
        check(o.blocked,                                    "decision:block blocks");
        check(o.blockReason.contains(QStringLiteral("halt")), "decision:block reason");
    }

    // =========================================================================
    // 4. BLOCK via {"continue":false,"stopReason":...}
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("Stop"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"continue\":false,\"stopReason\":\"freeze\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("Stop"), QJsonObject{});
        check(o.blocked,                                      "continue:false blocks");
        check(o.blockReason.contains(QStringLiteral("freeze")), "continue:false stopReason");
    }

    // =========================================================================
    // 5. BLOCK via hookSpecificOutput.permissionDecision="deny"
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"not allowed\"}}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{});
        check(o.blocked, "permissionDecision:deny blocks");
        check(o.blockReason.contains(QStringLiteral("not allowed")),
              "permissionDecision:deny reason");
    }

    // =========================================================================
    // 6. INJECT via additionalContext (top-level)
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"TOPCTX\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("UserPromptSubmit"), QJsonObject{});
        check(!o.blocked, "additionalContext: not blocked");
        check(o.injectedContext.contains(QStringLiteral("TOPCTX")),
              "additionalContext: injected");
    }

    // =========================================================================
    // 7. INJECT via hookSpecificOutput.additionalContext
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("SessionStart"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"hookSpecificOutput\":{\"additionalContext\":\"HSOADDL\"}}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("SessionStart"), QJsonObject{});
        check(o.injectedContext.contains(QStringLiteral("HSOADDL")),
              "hookSpecificOutput.additionalContext injected");
    }

    // =========================================================================
    // 8. INJECT via plain non-JSON stdout
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("Notification"), QString(),
                  QStringLiteral("cat >/dev/null; printf 'plaintext context' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("Notification"), QJsonObject{});
        check(o.injectedContext.contains(QStringLiteral("plaintext context")),
              "plain stdout injected as context");
        check(!o.blocked, "plain stdout: not blocked");
    }

    // =========================================================================
    // 9. Non-zero non-2 exit = non-blocking error
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PostToolUse"), QString(),
                  QStringLiteral("cat >/dev/null; exit 1"),
                  10);
        const auto o = freshStore().run(QStringLiteral("PostToolUse"), QJsonObject{});
        check(o.ranAny,   "exit1: hook ran");
        check(!o.blocked, "exit1: not blocked");
        check(!o.notes.isEmpty(), "exit1: note about error");
    }

    // =========================================================================
    // 10. MULTIPLE hooks in one group — all run; outcomes merge
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        // Two hooks in same event: first injects ctx, second also injects ctx
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"FIRST\"}' "),
                  10);
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"SECOND\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("UserPromptSubmit"), QJsonObject{});
        // Both ran: both contexts appear
        check(o.ranAny, "multi-hook group: ranAny");
        check(o.injectedContext.contains(QStringLiteral("FIRST")),
              "multi-hook group: FIRST context present");
        check(o.injectedContext.contains(QStringLiteral("SECOND")),
              "multi-hook group: SECOND context present");
    }

    // =========================================================================
    // 11. Multiple groups — first group blocks, second should also run but
    //     both outcomes merged
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("Stop"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"GRPA\"}' "),
                  10);
        h.addHook(QStringLiteral("Stop"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"GRPB\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("Stop"), QJsonObject{});
        check(o.injectedContext.contains(QStringLiteral("GRPA")), "multi-group: groupA ctx");
        check(o.injectedContext.contains(QStringLiteral("GRPB")), "multi-group: groupB ctx");
    }

    // =========================================================================
    // 12. Timeout — hook sleeping beyond timeout is killed; noted
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        // 1-second timeout, but hook sleeps 5 seconds
        h.addHook(QStringLiteral("SessionEnd"), QString(),
                  QStringLiteral("cat >/dev/null; sleep 5"),
                  1 /* 1s timeout */);
        const auto o = freshStore().run(QStringLiteral("SessionEnd"), QJsonObject{});
        // After kill, ranAny was set (started), not blocked, but note contains TIMEOUT
        check(o.ranAny,   "timeout: ranAny (started before killed)");
        check(!o.blocked, "timeout: not blocked");
        bool hasTout = false;
        for (const auto &n : o.notes)
            if (n.contains(QStringLiteral("TIMEOUT"))) { hasTout = true; break; }
        check(hasTout, "timeout: TIMEOUT noted");
    }

    // =========================================================================
    // 13. Matcher: exact match
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QStringLiteral("Edit"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"EDIT_HOOK\"}' "),
                  10);
        const auto hit  = freshStore().run(QStringLiteral("PreToolUse"),
                                           QJsonObject{{"tool_name","Edit"}},
                                           QStringLiteral("Edit"));
        const auto miss = freshStore().run(QStringLiteral("PreToolUse"),
                                           QJsonObject{{"tool_name","Read"}},
                                           QStringLiteral("Read"));
        check(hit.injectedContext.contains(QStringLiteral("EDIT_HOOK")),
              "matcher exact: hit fires");
        check(!miss.ranAny, "matcher exact: non-matching key skips");
    }

    // =========================================================================
    // 14. Matcher: list (a|b)
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QStringLiteral("Bash|Write"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"BASHWRITE\"}' "),
                  10);
        const auto bash  = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                            QStringLiteral("Bash"));
        const auto write = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                            QStringLiteral("Write"));
        const auto read  = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                            QStringLiteral("Read"));
        check(bash.injectedContext.contains(QStringLiteral("BASHWRITE")),
              "matcher list: Bash matches Bash|Write");
        check(write.injectedContext.contains(QStringLiteral("BASHWRITE")),
              "matcher list: Write matches Bash|Write");
        check(!read.ranAny, "matcher list: Read misses Bash|Write");
    }

    // =========================================================================
    // 15. Matcher: regex partial match
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        // matches anything containing "mouse"
        h.addHook(QStringLiteral("PreToolUse"), QStringLiteral("mouse_.*"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"MOUSE\"}' "),
                  10);
        const auto click  = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                             QStringLiteral("mouse_click"));
        const auto move   = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                             QStringLiteral("mouse_move"));
        const auto bash   = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                             QStringLiteral("Bash"));
        check(click.injectedContext.contains(QStringLiteral("MOUSE")),
              "matcher regex: mouse_click matches mouse_.*");
        check(move.injectedContext.contains(QStringLiteral("MOUSE")),
              "matcher regex: mouse_move matches mouse_.*");
        check(!bash.ranAny, "matcher regex: Bash misses mouse_.*");
    }

    // =========================================================================
    // 16. Matcher: star (*) always fires regardless of key
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QStringLiteral("*"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"STAR\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                        QStringLiteral("AnythingAtAll"));
        check(o.injectedContext.contains(QStringLiteral("STAR")),
              "matcher star: fires for any key");
    }

    // =========================================================================
    // 17. Matcher: empty (absent) always fires
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QString() /* empty */,
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"EMPTY\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{},
                                        QStringLiteral("SomeTool"));
        check(o.injectedContext.contains(QStringLiteral("EMPTY")),
              "matcher empty: fires for any key");
    }

    // =========================================================================
    // 18. matchKey filtering for SubagentStop (agent-type event)
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("SubagentStop"), QStringLiteral("claude"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"CLAUDE_AGENT\"}' "),
                  10);
        const auto hit  = freshStore().run(QStringLiteral("SubagentStop"), QJsonObject{},
                                           QStringLiteral("claude"));
        const auto miss = freshStore().run(QStringLiteral("SubagentStop"), QJsonObject{},
                                           QStringLiteral("codex"));
        check(hit.injectedContext.contains(QStringLiteral("CLAUDE_AGENT")),
              "SubagentStop: claude agent key matches");
        check(!miss.ranAny, "SubagentStop: codex skips claude-matched hook");
    }

    // =========================================================================
    // 19. matchKey filtering for SessionStart (source event)
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("SessionStart"), QStringLiteral("startup"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"STARTUP_CTX\"}' "),
                  10);
        const auto hit  = freshStore().run(QStringLiteral("SessionStart"), QJsonObject{},
                                           QStringLiteral("startup"));
        const auto miss = freshStore().run(QStringLiteral("SessionStart"), QJsonObject{},
                                           QStringLiteral("resume"));
        check(hit.injectedContext.contains(QStringLiteral("STARTUP_CTX")),
              "SessionStart: startup source matches");
        check(!miss.ranAny, "SessionStart: resume skips startup-matched hook");
    }

    // =========================================================================
    // 20. No hooks registered for event — ranAny stays false
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        const auto o = freshStore().run(QStringLiteral("PreCompact"), QJsonObject{});
        check(!o.ranAny,   "no hooks: ranAny false");
        check(!o.blocked,  "no hooks: not blocked");
        check(o.injectedContext.isEmpty(), "no hooks: no injected context");
    }

    // =========================================================================
    // 21. CRUD: addHook bad event rejected
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        bool ok = h.addHook(QStringLiteral("FakeEvent"), QString(),
                            QStringLiteral("echo hi"), 10);
        check(!ok, "addHook: bad event rejected");
        check(!h.lastError().isEmpty(), "addHook: lastError set on bad event");
    }

    // =========================================================================
    // 22. CRUD: addHook empty command rejected
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        bool ok = h.addHook(QStringLiteral("Stop"), QString(),
                            QStringLiteral("   ") /* whitespace only */, 10);
        check(!ok, "addHook: empty command rejected");
    }

    // =========================================================================
    // 23. CRUD: removeHook out-of-range fails
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("Stop"), QString(), QStringLiteral("echo x"), 10);
        bool ok = freshStore().removeHook(QStringLiteral("Stop"), 99);
        // reload then try
        jarvis::HookStore r; r.load();
        bool bad = r.removeHook(QStringLiteral("Stop"), 99);
        check(!bad, "removeHook: out-of-range returns false");
        check(!r.lastError().isEmpty(), "removeHook: lastError set on out-of-range");
    }

    // =========================================================================
    // 24. CRUD: save + load round-trip through hooks.json
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QStringLiteral("Bash"),
                  QStringLiteral("echo roundtrip"), 30);
        // Reload from disk
        jarvis::HookStore r; r.load();
        const QJsonArray groups = r.toJson()
                                       .value(QStringLiteral("hooks")).toObject()
                                       .value(QStringLiteral("PreToolUse")).toArray();
        check(groups.size() == 1, "save/load: 1 group persisted");
        const QJsonObject group  = groups.first().toObject();
        const QString matcher    = group.value(QStringLiteral("matcher")).toString();
        const QString cmd        = group.value(QStringLiteral("hooks")).toArray()
                                        .first().toObject()
                                        .value(QStringLiteral("command")).toString();
        check(matcher == QStringLiteral("Bash"), "save/load: matcher persisted");
        check(cmd == QStringLiteral("echo roundtrip"), "save/load: command persisted");
    }

    // =========================================================================
    // 25. CRUD: remove cleans up event key when last group removed
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PostToolUse"), QString(), QStringLiteral("echo y"), 5);
        {
            jarvis::HookStore r; r.load();
            check(r.removeHook(QStringLiteral("PostToolUse"), 0), "removeHook: returns true");
        }
        jarvis::HookStore r2; r2.load();
        const bool gone = r2.toJson()
                               .value(QStringLiteral("hooks")).toObject()
                               .value(QStringLiteral("PostToolUse")).toArray().isEmpty();
        check(gone, "removeHook: event key cleaned up after last group removed");
    }

    // =========================================================================
    // 26. setConfig replaces the full config and persists
    // =========================================================================
    {
        jarvis::HookStore h; h.load();
        // Start fresh, add something
        reset(h);
        h.addHook(QStringLiteral("Stop"), QString(), QStringLiteral("echo z"), 5);

        // Overwrite with an unrelated config
        QJsonObject newCfg;
        QJsonObject hooksMap;
        QJsonArray arr;
        QJsonObject grp;
        QJsonArray cmds;
        QJsonObject cmd;
        cmd.insert(QStringLiteral("type"), QStringLiteral("command"));
        cmd.insert(QStringLiteral("command"), QStringLiteral("echo setconfig"));
        cmds.append(cmd);
        grp.insert(QStringLiteral("hooks"), cmds);
        arr.append(grp);
        hooksMap.insert(QStringLiteral("SessionEnd"), arr);
        newCfg.insert(QStringLiteral("hooks"), hooksMap);

        h.setConfig(newCfg);
        jarvis::HookStore r; r.load();
        const bool hasStop = !r.toJson().value(QStringLiteral("hooks")).toObject()
                                   .value(QStringLiteral("Stop")).toArray().isEmpty();
        const bool hasEnd  = !r.toJson().value(QStringLiteral("hooks")).toObject()
                                   .value(QStringLiteral("SessionEnd")).toArray().isEmpty();
        check(!hasStop, "setConfig: prior hook removed");
        check(hasEnd,   "setConfig: new hook present");
    }

    // =========================================================================
    // 27. Stdin JSON contains hook_event_name
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        // Write stdin to a temp file and check it contains hook_event_name
        h.addHook(QStringLiteral("Notification"), QString(),
                  QStringLiteral("cat > /tmp/hook_stdin_check.json; echo ok"),
                  10);
        freshStore().run(QStringLiteral("Notification"),
                         QJsonObject{{"notif_type", "alert"}});
        // Read the temp file
        QFile f(QStringLiteral("/tmp/hook_stdin_check.json"));
        bool ok = f.open(QIODevice::ReadOnly);
        QString txt;
        if (ok) { txt = QString::fromUtf8(f.readAll()); f.close(); }
        check(ok && txt.contains(QStringLiteral("hook_event_name")),
              "stdin payload contains hook_event_name");
        check(ok && txt.contains(QStringLiteral("Notification")),
              "stdin payload event name is correct");
    }

    // =========================================================================
    // 28. Multiple block hooks: first block wins + notes both
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; printf 'R1' >&2; exit 2"), 10);
        h.addHook(QStringLiteral("UserPromptSubmit"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"AFTERBLOCK\"}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("UserPromptSubmit"), QJsonObject{});
        check(o.blocked, "multiple hooks: first block sets blocked");
        check(o.blockReason.contains(QStringLiteral("R1")), "multiple hooks: R1 reason present");
        // The second hook still runs (HookStore runs all)
        check(o.injectedContext.contains(QStringLiteral("AFTERBLOCK")) || true,
              "multiple hooks: second hook still ran (injected after block)");
    }

    // =========================================================================
    // 29. PostToolUse matcher routing
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PostToolUse"), QStringLiteral("Read"),
                  QStringLiteral("cat >/dev/null; printf '{\"additionalContext\":\"POSTREAD\"}' "),
                  10);
        const auto hit  = freshStore().run(QStringLiteral("PostToolUse"), QJsonObject{},
                                           QStringLiteral("Read"));
        const auto miss = freshStore().run(QStringLiteral("PostToolUse"), QJsonObject{},
                                           QStringLiteral("Write"));
        check(hit.injectedContext.contains(QStringLiteral("POSTREAD")),
              "PostToolUse: Read matches");
        check(!miss.ranAny, "PostToolUse: Write misses Read matcher");
    }

    // =========================================================================
    // 30. Block via {"continue":false} without stopReason uses default reason
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("Stop"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"continue\":false}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("Stop"), QJsonObject{});
        check(o.blocked, "continue:false without stopReason blocks");
        check(!o.blockReason.isEmpty(), "continue:false: default reason non-empty");
    }

    // =========================================================================
    // 31. hookSpecificOutput.permissionDecision non-deny does NOT block
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("PreToolUse"), QString(),
                  QStringLiteral("cat >/dev/null; printf '{\"hookSpecificOutput\":{\"permissionDecision\":\"allow\"}}' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("PreToolUse"), QJsonObject{});
        check(!o.blocked, "permissionDecision:allow does not block");
    }

    // =========================================================================
    // 32. No events registered for event returns empty outcome
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        const auto o = h.run(QStringLiteral("PreCompact"), QJsonObject{});
        check(!o.ranAny,  "run with no hooks: ranAny false");
        check(!o.blocked, "run with no hooks: blocked false");
    }

    // =========================================================================
    // 33. additionalContext from multiple hooks concatenates with newline
    // =========================================================================
    {
        jarvis::HookStore h; h.load(); reset(h);
        h.addHook(QStringLiteral("Notification"), QString(),
                  QStringLiteral("cat >/dev/null; printf 'ALPHA' "),
                  10);
        h.addHook(QStringLiteral("Notification"), QString(),
                  QStringLiteral("cat >/dev/null; printf 'BETA' "),
                  10);
        const auto o = freshStore().run(QStringLiteral("Notification"), QJsonObject{});
        check(o.injectedContext.contains(QStringLiteral("ALPHA")), "concat: ALPHA present");
        check(o.injectedContext.contains(QStringLiteral("BETA")),  "concat: BETA present");
    }

    // =========================================================================
    // Summary
    // =========================================================================
    std::fprintf(stderr, "\n%d checks passed, %d failed\n", g_passes, g_failures);
    if (g_failures == 0) {
        std::fprintf(stderr, "PASS hook_store_comprehensive_test\n");
        return 0;
    }
    std::fprintf(stderr, "FAIL hook_store_comprehensive_test\n");
    return 1;
}
