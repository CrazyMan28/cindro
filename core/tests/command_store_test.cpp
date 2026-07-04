// core/tests/command_store_test.cpp
// ctest: CommandStore create/list/get/remove roundtrip + reserved-name
// guard + Markdown+frontmatter persistence, mirroring agent_store_test.cpp.

#include "jarvis/CommandStore.h"

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

int main()
{
    QTemporaryDir tmp;
    jarvis::CommandStore store(tmp.path());

    check(store.list().isEmpty(), "a fresh store has no commands");

    bool created = store.create(QStringLiteral("deploy"),
                                QStringLiteral("Deploy the current branch"),
                                QStringLiteral("shell"),
                                QStringLiteral("scripts/deploy.sh"),
                                QStringLiteral("Runs the deploy script."),
                                /*selfAuthored=*/true);
    check(created, "create() succeeds for a fresh name");

    const auto rows = store.list();
    check(rows.size() == 1, "list() sees the new command");
    check(rows[0].name == QStringLiteral("deploy"), "name round-trips");
    check(rows[0].actionKind == QStringLiteral("shell"), "action_kind round-trips");
    check(rows[0].selfAuthored, "self_authored round-trips true");

    const auto got = store.get(QStringLiteral("deploy"));
    check(got.has_value(), "get() finds the command");
    check(got->actionTarget == QStringLiteral("scripts/deploy.sh"), "action_target round-trips");

    check(!store.create(QStringLiteral("goal"), QStringLiteral("x"),
                        QStringLiteral("prompt"), QStringLiteral(""),
                        QStringLiteral("x"), false),
          "create() rejects a name that collides with a built-in");

    check(!store.create(QStringLiteral("deploy"), QStringLiteral("dup"),
                        QStringLiteral("prompt"), QStringLiteral(""),
                        QStringLiteral("x"), false),
          "create() rejects a name that already exists");

    // Persistence across instances.
    {
        jarvis::CommandStore store2(tmp.path());
        check(store2.list().size() == 1, "a fresh instance loads the persisted command");
    }

    check(store.remove(QStringLiteral("deploy")), "remove() succeeds for an existing command");
    check(store.list().isEmpty(), "remove() actually removes it");
    check(!store.remove(QStringLiteral("missing")), "remove() fails for a missing command");

    if (g_failures == 0)
        std::fprintf(stderr, "ALL CommandStore TESTS PASSED\n");
    return g_failures == 0 ? 0 : 1;
}
