// ctest: SessionStore events_fts search + goals/continuation columns + delete
// cleanup roundtrip against a temp DB (jarvis#76 items 1 + 9).

#include "jarvis/SessionStore.h"

#include <QCoreApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::NormalizedBrainEvent;
using jarvis::SessionRow;
using jarvis::SessionSearchHit;
using jarvis::SessionStore;

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
    const QString dbPath = tmp.path() + QStringLiteral("/sess_test.db");

    SessionStore store;
    check(store.open(dbPath, QStringLiteral("sess-test-conn")), "store open + migrate");

    // --- two sessions with searchable event streams -------------------------
    SessionRow a;
    a.id = QStringLiteral("sess-alpha");
    a.title = QStringLiteral("Postgres backup planning");
    a.profile = QStringLiteral("coworker");
    check(store.create(a), "session alpha created");

    SessionRow b;
    b.id = QStringLiteral("sess-beta");
    b.title = QStringLiteral("Weather widget");
    check(store.create(b), "session beta created");

    check(store.appendEvent(a.id, NormalizedBrainEvent::message(
              QStringLiteral("user"),
              QStringLiteral("please schedule the postgres backup for tuesday night"))) == 0,
          "alpha user turn appended at seq 0");
    check(store.appendEvent(a.id, NormalizedBrainEvent::toolCall(
              QStringLiteral("c1"), QStringLiteral("bg_start"),
              QJsonObject{{QStringLiteral("command"), QStringLiteral("pg_dump")}})) == 1,
          "alpha tool call appended at seq 1");
    check(store.appendEvent(a.id, NormalizedBrainEvent::toolResult(
              QStringLiteral("c1"), true,
              QStringLiteral("pg_dump finished: wrote 42MB to /backups/db.sql"),
              QStringLiteral("bg_start"))) == 2,
          "alpha tool result appended at seq 2");
    check(store.appendEvent(a.id, NormalizedBrainEvent::message(
              QStringLiteral("assistant"),
              QStringLiteral("Backup scheduled for Tuesday 02:00."))) == 3,
          "alpha assistant turn appended at seq 3");

    check(store.appendEvent(b.id, NormalizedBrainEvent::message(
              QStringLiteral("user"),
              QStringLiteral("draw a weather widget for tokyo"))) == 0,
          "beta user turn appended");

    // --- cross-session FTS search -------------------------------------------
    {
        const auto hits = store.searchEvents(QStringLiteral("postgres backup"));
        check(!hits.isEmpty(), "search finds the postgres turn");
        check(!hits.isEmpty() && hits.first().sessionId == a.id,
              "top hit is in session alpha");
        check(!hits.isEmpty() && hits.first().score > 0.0, "hit carries a score");
        check(!hits.isEmpty() && hits.first().sessionTitle == a.title,
              "hit carries the session title");
    }

    // Tool OUTPUT text is searchable too.
    {
        const auto hits = store.searchEvents(QStringLiteral("pg_dump 42MB"));
        check(!hits.isEmpty(), "search finds text inside a tool result");
    }

    // Session filter narrows results.
    {
        const auto all = store.searchEvents(QStringLiteral("widget tokyo"));
        check(!all.isEmpty() && all.first().sessionId == b.id,
              "unfiltered search reaches session beta");
        const auto onlyA = store.searchEvents(QStringLiteral("widget tokyo"), 20, 2, a.id);
        check(onlyA.isEmpty(), "session filter excludes other sessions");
    }

    // Context window: hit at seq 2 (tool result) brings seq 0..3 with ±2.
    {
        const auto hits = store.searchEvents(QStringLiteral("42MB"), 5, 2);
        check(!hits.isEmpty(), "context test hit found");
        if (!hits.isEmpty()) {
            const SessionSearchHit &h = hits.first();
            check(h.seq == 2, "hit is the tool-result event");
            check(h.context.size() == 4, "context spans the neighbouring events");
            check(!h.context.isEmpty() && h.context.first().seq == 0,
                  "context starts at seq 0");
            bool ascending = true;
            for (int i = 1; i < h.context.size(); ++i)
                ascending = ascending && h.context[i].seq > h.context[i - 1].seq;
            check(ascending, "context is seq-ascending");
        }
    }

    {
        const auto hits = store.searchEvents(QStringLiteral("42MB"), 5, 0);
        check(!hits.isEmpty() && hits.first().context.isEmpty(),
              "contextWindow=0 returns no context");
    }

    // --- goals / continuation columns (jarvis#76 item 9) ---------------------
    check(store.setGoals(a.id, QStringLiteral("finish the backup automation")),
          "setGoals succeeds");
    check(store.setContinuationCount(a.id, 2), "setContinuationCount succeeds");
    {
        const auto row = store.get(a.id);
        check(row && row->goals == QStringLiteral("finish the backup automation"),
              "goals round-trips");
        check(row && row->continuationCount == 2, "continuation count round-trips");
        check(row && row->toJson().value(QStringLiteral("goals")).toString()
                  == row->goals,
              "goals serialized in toJson");
    }
    check(!store.setGoals(QStringLiteral("nope"), QStringLiteral("x")),
          "setGoals on unknown session reports failure");

    // --- historyPage: windowed, compacted session open ------------------------
    {
        SessionRow h;
        h.id = QStringLiteral("sess-history");
        check(store.create(h), "history session created");
        // 30 turns: user msg, turn_started, 50 streamed thinking chunks, usage,
        // tool call/result (huge output), assistant msg, final.
        const QString bigOut(50000, QLatin1Char('x'));
        for (int t = 0; t < 30; ++t) {
            store.appendEvent(h.id, NormalizedBrainEvent::message(
                QStringLiteral("user"), QStringLiteral("question %1").arg(t)));
            store.appendEvent(h.id, NormalizedBrainEvent::turnStarted());
            for (int c = 0; c < 50; ++c)
                store.appendEvent(h.id, NormalizedBrainEvent::thinking(QStringLiteral("t%1.").arg(c)));
            store.appendEvent(h.id, NormalizedBrainEvent::usage(QJsonObject{{QStringLiteral("input_tokens"), 5}}));
            store.appendEvent(h.id, NormalizedBrainEvent::toolCall(
                QStringLiteral("call%1").arg(t), QStringLiteral("shell"), QJsonObject{}));
            store.appendEvent(h.id, NormalizedBrainEvent::toolResult(
                QStringLiteral("call%1").arg(t), true, bigOut));
            store.appendEvent(h.id, NormalizedBrainEvent::message(
                QStringLiteral("assistant"), QStringLiteral("answer %1").arg(t)));
            store.appendEvent(h.id, NormalizedBrainEvent::final_());
        }
        // Each turn compacts to 7 items: user, turn_started, thinking, call, result, answer, final.
        const auto p1 = store.historyPage(h.id, -1, 14, 1000);
        check(p1.events.size() == 14, "page 1 holds exactly maxItems items");
        check(p1.hasMore, "page 1 reports more history");
        check(!p1.events.isEmpty()
                  && p1.events.last().ev.kind == NormalizedBrainEvent::Kind::Final,
              "page 1 ends at the newest event");
        int thinkingRows = 0;
        bool sawUsage = false, capped = false, fullThought = false;
        for (const auto &se : p1.events) {
            if (se.ev.kind == NormalizedBrainEvent::Kind::Thinking) {
                ++thinkingRows;
                const QString txt = se.ev.fields.value(QStringLiteral("text")).toString();
                fullThought = txt.startsWith(QStringLiteral("t0.")) && txt.endsWith(QStringLiteral("t49."));
            }
            if (se.ev.kind == NormalizedBrainEvent::Kind::Usage)
                sawUsage = true;
            if (se.ev.kind == NormalizedBrainEvent::Kind::ToolResult)
                capped = se.ev.fields.value(QStringLiteral("output")).toString().size() == 1000
                         && se.ev.fields.value(QStringLiteral("truncated")).toBool()
                         && se.ev.fields.value(QStringLiteral("full_chars")).toInt() == 50000;
        }
        check(thinkingRows == 2, "50 thinking chunks per turn coalesce into one row");
        check(fullThought, "coalesced thinking keeps every chunk in order");
        check(!sawUsage, "usage events are dropped from the page");
        check(capped, "oversized tool output is capped + tagged truncated");

        // Walk every page back to the start; total must be 30 turns * 7 items.
        int total = p1.events.size();
        int cursor = p1.oldestSeq;
        bool more = p1.hasMore;
        int pages = 1;
        int prevFirstSeq = p1.events.first().seq;
        bool ordered = true;
        while (more && pages < 100) {
            const auto p = store.historyPage(h.id, cursor, 14, 1000);
            if (!p.events.isEmpty()) {
                ordered = ordered && p.events.last().seq < prevFirstSeq;
                prevFirstSeq = p.events.first().seq;
            }
            total += p.events.size();
            cursor = p.oldestSeq;
            more = p.hasMore;
            ++pages;
        }
        check(total == 30 * 7, "paging back visits every renderable item exactly once");
        check(ordered, "older pages strictly precede newer ones");
        check(cursor == 0, "last page reaches seq 0");

        const auto all = store.historyPage(h.id, -1, 100000, 0);
        check(!all.hasMore && all.events.size() == 30 * 7, "one big page = whole history, no more");
        bool uncapped = false;
        for (const auto &se : all.events)
            if (se.ev.kind == NormalizedBrainEvent::Kind::ToolResult)
                uncapped = se.ev.fields.value(QStringLiteral("output")).toString().size() == 50000;
        check(uncapped, "maxFieldChars=0 leaves outputs intact");
        check(store.historyPage(QStringLiteral("nope"), -1, 10).events.isEmpty(),
              "unknown session pages empty");
    }

    // --- delete clears the FTS mirror ----------------------------------------
    check(store.deleteSession(a.id), "delete session alpha");
    {
        const auto hits = store.searchEvents(QStringLiteral("postgres backup"));
        bool foundAlpha = false;
        for (const auto &h : hits)
            foundAlpha = foundAlpha || h.sessionId == a.id;
        check(!foundAlpha, "deleted session no longer searchable");
    }

    // --- backfill: a store reopened over an events table with no FTS rows ----
    {
        // Simulate a pre-FTS database: wipe events_fts, then reopen.
        {
            QSqlDatabase db = QSqlDatabase::database(QStringLiteral("sess-test-conn"));
            QSqlQuery q(db);
            q.exec(QStringLiteral("DELETE FROM events_fts"));
        }
        store.close();
        SessionStore re;
        check(re.open(dbPath, QStringLiteral("sess-test-conn2")), "store reopened");
        const auto hits = re.searchEvents(QStringLiteral("weather widget tokyo"));
        check(!hits.isEmpty() && hits.first().sessionId == b.id,
              "backfill re-indexed pre-existing events");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "session_store_test: all checks passed\n");
    return g_failures == 0 ? 0 : 1;
}
