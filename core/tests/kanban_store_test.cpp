// ctest: KanbanStore durable work queue (jarvis#76 item 7) — enqueue/claim/
// heartbeat/reclaim/status round-trip against a temp DB.

#include "jarvis/KanbanStore.h"

#include <QCoreApplication>
#include <QSqlQuery>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::KanbanStore;
using jarvis::WorkItem;

namespace {
int g_failures = 0;
void check(bool cond, const char *msg)
{
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", msg); ++g_failures; }
    else { std::fprintf(stderr, "ok: %s\n", msg); }
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    QTemporaryDir tmp;
    check(tmp.isValid(), "temp dir created");
    const QString dbPath = tmp.path() + QStringLiteral("/kanban_test.db");

    KanbanStore store;
    check(store.open(dbPath, QStringLiteral("kanban-test-conn")), "store open + migrate");

    // --- enqueue -------------------------------------------------------------
    const QString low = store.enqueue(QStringLiteral("low prio"),
                                      QStringLiteral("do the low thing"), 0);
    const QString high = store.enqueue(QStringLiteral("high prio"),
                                       QStringLiteral("do the urgent thing"), 5,
                                       QStringLiteral("codex"), QStringLiteral("gpt-5.5"),
                                       QStringLiteral("coworker"),
                                       QStringLiteral("urgent ops"));
    check(!low.isEmpty() && !high.isEmpty() && low != high, "two items enqueued");
    check(store.enqueue(QStringLiteral("x"), QStringLiteral("  ")).isEmpty(),
          "empty prompt rejected");
    check(store.list().size() == 2, "list returns both");
    check(store.list(QStringLiteral("pending")).size() == 2, "both pending");

    // --- claim honors priority then FIFO --------------------------------------
    auto first = store.claimNext(QStringLiteral("sess-1"));
    check(first.has_value() && first->id == high, "highest priority claimed first");
    check(first->status == QStringLiteral("running") && first->heartbeatAt > 0 &&
              first->started > 0,
          "claim flips to running with heartbeat");
    check(first->brain == QStringLiteral("codex") &&
              first->model == QStringLiteral("gpt-5.5"),
          "brain/model pins round-trip");

    auto second = store.claimNext(QStringLiteral("sess-2"));
    check(second.has_value() && second->id == low, "next claim takes the remaining item");
    check(!store.claimNext().has_value(), "empty backlog claims nothing");

    // --- heartbeat + stale reclaim --------------------------------------------
    check(store.heartbeat(high), "heartbeat refreshes a running item");
    // Backdate sess-2's heartbeat so only IT is stale.
    {
        QSqlQuery q(QSqlDatabase::database(QStringLiteral("kanban-test-conn")));
        q.prepare(QStringLiteral("UPDATE work_queue SET heartbeat_at=1000 WHERE id=?"));
        q.addBindValue(low);
        check(q.exec(), "backdate heartbeat");
    }
    check(store.reclaimStale(60 * 1000) == 1, "stale worker reclaimed");
    {
        const auto re = store.get(low);
        check(re && re->status == QStringLiteral("pending") && re->sessionId.isEmpty(),
              "reclaimed item back to pending with no session");
        const auto still = store.get(high);
        check(still && still->status == QStringLiteral("running"),
              "fresh-heartbeat item untouched");
    }

    // --- finish + result -------------------------------------------------------
    check(store.updateStatus(high, QStringLiteral("done"), QString(),
                             QStringLiteral("shipped the urgent thing")),
          "mark done with result");
    {
        const auto d = store.get(high);
        check(d && d->status == QStringLiteral("done") && d->ended > 0 &&
                  d->result == QStringLiteral("shipped the urgent thing"),
              "done item carries result + ended");
        check(d->toJson().value(QStringLiteral("result")).toString()
                  == d->result,
              "toJson round-trips result");
    }

    // --- cancel + remove --------------------------------------------------------
    check(store.cancel(low), "cancel pending item");
    check(store.get(low)->status == QStringLiteral("cancelled"), "cancelled state");
    check(!store.cancel(high), "cannot cancel a terminal item");
    check(store.remove(low), "remove terminal item");
    check(!store.get(low).has_value(), "removed item gone");
    check(!store.remove(QStringLiteral("work_nope")), "remove unknown fails");

    // --- durability: reopen sees the same rows ----------------------------------
    store.close();
    KanbanStore re;
    check(re.open(dbPath, QStringLiteral("kanban-test-conn2")), "reopen");
    check(re.get(high).has_value(), "items survive a restart");

    if (g_failures == 0)
        std::fprintf(stderr, "kanban_store_test: all checks passed\n");
    return g_failures == 0 ? 0 : 1;
}
