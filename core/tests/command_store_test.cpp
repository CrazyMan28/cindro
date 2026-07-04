// core/tests/command_store_test.cpp
// ctest: CommandStore create/list/get/remove roundtrip + reserved-name
// guard + Markdown+frontmatter persistence, mirroring agent_store_test.cpp.

#include "jarvis/CommandStore.h"

#include <QDir>
#include <QFileInfo>
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

    // --- path-traversal guard (code-review fix) ----------------------------
    // A caller-supplied name must never escape the store dir. A name with a
    // traversal payload is sanitized into a single safe path component and the
    // file lands INSIDE the store root; a name that sanitizes to nothing fails
    // cleanly and never writes to the store root.
    {
        QTemporaryDir sandbox;
        jarvis::CommandStore s(sandbox.path());

        check(s.create(QStringLiteral("../../../etc/evil"),
                       QStringLiteral("d"), QStringLiteral("prompt"),
                       QStringLiteral(""), QStringLiteral("b"), false),
              "create() accepts a traversal-style name (sanitized)");

        // Exactly one subdir was created, directly under the store root, and its
        // name contains no '/' or '..' — so it cannot escape the root.
        const QStringList subdirs =
            QDir(sandbox.path()).entryList(QDir::Dirs | QDir::NoDotAndDotDot);
        check(subdirs.size() == 1, "traversal name created exactly one subdir");
        check(!subdirs.value(0).contains(QLatin1Char('/'))
                  && !subdirs.value(0).contains(QStringLiteral("..")),
              "the created dir name has no '/' or '..' (cannot escape root)");

        // The COMMAND.md path canonically resolves to inside the store root —
        // it never lands at ${dir}/../.../etc/evil/COMMAND.md.
        const QString md = QFileInfo(sandbox.path() + QStringLiteral("/") +
                                     subdirs.value(0) + QStringLiteral("/COMMAND.md"))
                               .canonicalFilePath();
        const QString rootCanon = QFileInfo(sandbox.path()).canonicalFilePath();
        check(!md.isEmpty() && md.startsWith(rootCanon + QStringLiteral("/")),
              "COMMAND.md stays inside the store root (no traversal escape)");

        // A name that sanitizes to empty (all dropped chars) must fail cleanly
        // and never write COMMAND.md to the store root itself.
        check(!s.create(QStringLiteral("..."), QStringLiteral("d"),
                        QStringLiteral("prompt"), QStringLiteral(""),
                        QStringLiteral("b"), false),
              "create() fails for a name that sanitizes to empty");
        check(!QFileInfo::exists(sandbox.path() + QStringLiteral("/COMMAND.md")),
              "no COMMAND.md was written to the store root");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "ALL CommandStore TESTS PASSED\n");
    return g_failures == 0 ? 0 : 1;
}
