// core/tests/tui_layout_store_test.cpp
// ctest: TuiLayoutStore CRUD + reserved-id guard + persistence across
// instances.

#include "jarvis/TuiLayoutStore.h"

#include <QJsonArray>
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

    // addPage + list round-trip.
    {
        jarvis::TuiLayoutStore store(tmp.path());
        QString err;
        jarvis::TuiPageSpec spec;
        spec.id = QStringLiteral("errorlog");
        spec.title = QStringLiteral("Error Log");
        spec.kind = QStringLiteral("log");
        spec.config = QJsonObject{{"path", QStringLiteral("/var/log/jarvis.log")}};
        check(store.addPage(spec, &err), "addPage succeeds for a fresh id");
        const auto pages = store.list();
        check(pages.size() == 1, "list() returns the added page");
        check(pages[0].title == QStringLiteral("Error Log"), "title round-trips");
    }

    // Reserved id is rejected.
    {
        jarvis::TuiLayoutStore store(tmp.path() + QStringLiteral("/other"));
        QString err;
        jarvis::TuiPageSpec spec;
        spec.id = QStringLiteral("chat");
        spec.title = QStringLiteral("Nope");
        spec.kind = QStringLiteral("log");
        check(!store.addPage(spec, &err), "addPage rejects a reserved id");
        check(!err.isEmpty(), "addPage sets an error message");
        check(jarvis::TuiLayoutStore::isReservedId(QStringLiteral("chat")),
              "isReservedId recognizes a builtin");
        check(!jarvis::TuiLayoutStore::isReservedId(QStringLiteral("errorlog")),
              "isReservedId does not flag a custom id");
    }

    // Invalid kind is rejected.
    {
        jarvis::TuiLayoutStore store(tmp.path() + QStringLiteral("/kindcheck"));
        QString err;
        jarvis::TuiPageSpec spec;
        spec.id = QStringLiteral("weird");
        spec.title = QStringLiteral("Weird");
        spec.kind = QStringLiteral("video");   // not in log|table|markdown|widget|list
        check(!store.addPage(spec, &err), "addPage rejects an invalid kind");
    }

    // editPage + removePage + persistence across instances (new object, same dir).
    {
        const QString dir = tmp.path() + QStringLiteral("/persist");
        QString err;
        {
            jarvis::TuiLayoutStore store(dir);
            jarvis::TuiPageSpec spec;
            spec.id = QStringLiteral("todo");
            spec.title = QStringLiteral("Todo");
            spec.kind = QStringLiteral("list");
            spec.config = QJsonObject{{"rows", QJsonArray{}}};
            store.addPage(spec, &err);
        }
        {
            jarvis::TuiLayoutStore store(dir);   // fresh instance, same dir
            check(store.list().size() == 1, "a fresh instance loads the persisted page");
            check(store.editPage(QStringLiteral("todo"),
                                  QJsonObject{{"rows", QJsonArray{"buy milk"}}}, &err),
                  "editPage succeeds for an existing id");
            check(!store.editPage(QStringLiteral("missing"), QJsonObject{}, &err),
                  "editPage fails for a missing id");
            check(store.removePage(QStringLiteral("todo"), &err),
                  "removePage succeeds for an existing id");
            check(store.list().isEmpty(), "removePage actually removes it");
        }
    }

    // reorder.
    {
        const QString dir = tmp.path() + QStringLiteral("/reorder");
        jarvis::TuiLayoutStore store(dir);
        QString err;
        jarvis::TuiPageSpec a; a.id = QStringLiteral("a"); a.title = QStringLiteral("A");
        a.kind = QStringLiteral("log");
        jarvis::TuiPageSpec b; b.id = QStringLiteral("b"); b.title = QStringLiteral("B");
        b.kind = QStringLiteral("log");
        store.addPage(a, &err);
        store.addPage(b, &err);
        check(store.reorder({QStringLiteral("b"), QStringLiteral("a")}, &err),
              "reorder succeeds with a valid full id list");
        const auto pages = store.list();
        check(pages.size() == 2 && pages[0].id == QStringLiteral("b")
              && pages[0].order == 0 && pages[1].order == 1,
              "reorder writes the new order field");
    }

    // Order never collides after a remove-then-add (code-review fix).
    // add a,b,c (orders 0,1,2); remove b (leaves a=0,c=2, size=2); add d.
    // The old `order = pages.size()` gave d order=2, colliding with c; the
    // new page's order must be STRICTLY greater than every other page's.
    {
        const QString dir = tmp.path() + QStringLiteral("/collision");
        jarvis::TuiLayoutStore store(dir);
        QString err;
        for (const char *id : {"a", "b", "c"}) {
            jarvis::TuiPageSpec p;
            p.id = QString::fromLatin1(id);
            p.title = p.id.toUpper();
            p.kind = QStringLiteral("log");
            check(store.addPage(p, &err), "collision setup: addPage succeeds");
        }
        check(store.removePage(QStringLiteral("b"), &err), "remove the middle page");

        jarvis::TuiPageSpec d;
        d.id = QStringLiteral("d");
        d.title = QStringLiteral("D");
        d.kind = QStringLiteral("log");
        check(store.addPage(d, &err), "add a page after a remove");

        const auto pages = store.list();
        check(pages.size() == 3, "three pages remain (a, c, d)");
        int dOrder = -1;
        for (const auto &p : pages)
            if (p.id == QStringLiteral("d"))
                dOrder = p.order;
        check(dOrder >= 0, "the new page 'd' is present");
        bool strictlyGreater = true;
        for (const auto &p : pages)
            if (p.id != QStringLiteral("d") && p.order >= dOrder)
                strictlyGreater = false;
        check(strictlyGreater,
              "new page's order is strictly greater than every other page's");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "ALL TuiLayoutStore TESTS PASSED\n");
    return g_failures == 0 ? 0 : 1;
}
