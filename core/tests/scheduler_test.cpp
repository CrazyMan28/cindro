// ctest: Scheduler cron/at/interval next-run calc + a create+tick fire roundtrip.

#include "jarvis/Scheduler.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::CronSpec;
using jarvis::ScheduleRow;
using jarvis::Scheduler;

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

    // --- CronSpec::parse + nextAfter --------------------------------------

    // "every 5m" -> interval of 300s.
    {
        const CronSpec s = CronSpec::parse(QStringLiteral("every 5m"));
        check(s.valid() && s.kind == CronSpec::Kind::Interval, "'every 5m' parses as interval");
        check(s.intervalSecs == 300, "'every 5m' = 300s");
        const QDateTime base(QDate(2026, 6, 22), QTime(10, 0, 0));
        const QDateTime next = s.nextAfter(base);
        check(next == base.addSecs(300), "interval nextAfter = base+300s");
    }
    {
        const CronSpec s = CronSpec::parse(QStringLiteral("every 2 hours"));
        check(s.valid() && s.intervalSecs == 7200, "'every 2 hours' = 7200s");
    }
    {
        const CronSpec s = CronSpec::parse(QStringLiteral("every 30 seconds"));
        check(s.valid() && s.intervalSecs == 30, "'every 30 seconds' = 30s");
    }

    // "at HH:MM" -> next daily clock time.
    {
        const CronSpec s = CronSpec::parse(QStringLiteral("at 09:30"));
        check(s.valid() && s.kind == CronSpec::Kind::DailyAt, "'at 09:30' parses as daily");
        // From 08:00 same day -> 09:30 same day.
        const QDateTime from1(QDate(2026, 6, 22), QTime(8, 0, 0));
        const QDateTime n1 = s.nextAfter(from1);
        check(n1.date() == from1.date() && n1.time() == QTime(9, 30),
              "'at 09:30' from 08:00 -> 09:30 same day");
        // From 10:00 same day -> 09:30 NEXT day.
        const QDateTime from2(QDate(2026, 6, 22), QTime(10, 0, 0));
        const QDateTime n2 = s.nextAfter(from2);
        check(n2.date() == from2.date().addDays(1) && n2.time() == QTime(9, 30),
              "'at 09:30' from 10:00 -> 09:30 next day");
    }

    // 5-field cron: "0 9 * * 1" = 09:00 every Monday.
    {
        const CronSpec s = CronSpec::parse(QStringLiteral("0 9 * * 1"));
        check(s.valid() && s.kind == CronSpec::Kind::Cron, "'0 9 * * 1' parses as cron");
        // 2026-06-22 is a Monday. From Sun 2026-06-21 12:00 -> Mon 06-22 09:00.
        const QDateTime from(QDate(2026, 6, 21), QTime(12, 0, 0));
        const QDateTime n = s.nextAfter(from);
        check(n.date() == QDate(2026, 6, 22) && n.time() == QTime(9, 0),
              "'0 9 * * 1' next Monday 09:00");
        check(n.date().dayOfWeek() == 1, "matched day is a Monday");
    }

    // 5-field cron with a step: "*/15 * * * *" = every 15 minutes.
    {
        const CronSpec s = CronSpec::parse(QStringLiteral("*/15 * * * *"));
        check(s.valid(), "'*/15 * * * *' parses");
        const QDateTime from(QDate(2026, 6, 22), QTime(10, 7, 0));
        const QDateTime n = s.nextAfter(from);
        check(n.time() == QTime(10, 15), "'*/15' from 10:07 -> 10:15");
    }

    // 5-field cron list+range: "30 8-9 * * *".
    {
        const CronSpec s = CronSpec::parse(QStringLiteral("30 8-9 * * *"));
        check(s.valid(), "'30 8-9 * * *' parses");
        const QDateTime from(QDate(2026, 6, 22), QTime(8, 45, 0));
        const QDateTime n = s.nextAfter(from);
        check(n.time() == QTime(9, 30), "'30 8-9' from 08:45 -> 09:30");
    }

    // Garbage / out-of-range is invalid.
    check(!CronSpec::parse(QStringLiteral("not a schedule")).valid(),
          "garbage expression is invalid");
    check(!CronSpec::parse(QStringLiteral("at 25:00")).valid(), "'at 25:00' rejected");
    check(!CronSpec::parse(QStringLiteral("99 * * * *")).valid(),
          "out-of-range cron minute rejected");

    // --- create + tick fire roundtrip (temp DB) ---------------------------
    {
        QTemporaryDir tmp;
        check(tmp.isValid(), "temp dir created");
        const QString dbPath = tmp.path() + QStringLiteral("/sched_test.db");

        Scheduler sched;
        check(sched.open(dbPath, QStringLiteral("sched-test-conn")), "scheduler open + migrate");

        int fireCount = 0;
        ScheduleRow firedRow;
        sched.setFireCallback([&](const ScheduleRow &r) -> QString {
            ++fireCount;
            firedRow = r;
            return QStringLiteral("sess_fake");
        });

        // A job due right now: "every 1m" with next_run forced into the past via
        // a create then an immediate tick at now+2min.
        const QString id = sched.create(QStringLiteral("ping"), QStringLiteral("every 1m"),
                                        QStringLiteral("say hi"), QStringLiteral("codex"));
        check(!id.isEmpty(), "create returns an id");
        check(sched.list().size() == 1, "list has the new schedule");

        auto row = sched.get(id);
        check(row && row->nextRun > 0, "new enabled job has a next_run");
        check(row && row->cron == QStringLiteral("every 1m"), "cron stored verbatim");

        // Tick well after next_run => the job fires.
        const QDateTime later =
            QDateTime::fromMSecsSinceEpoch(row->nextRun).addSecs(5);
        const int fired = sched.tick(later);
        check(fired == 1, "tick fires the due job");
        check(fireCount == 1, "fire callback was invoked once");
        check(firedRow.prompt == QStringLiteral("say hi"), "fired row carries the prompt");

        // last_run set, next_run advanced past 'later'.
        auto row2 = sched.get(id);
        check(row2 && row2->lastRun > 0, "last_run recorded");
        check(row2 && row2->nextRun > later.toMSecsSinceEpoch(), "next_run advanced");

        // Disabling clears next_run and stops firing.
        check(sched.setEnabled(id, false), "set_enabled(false) ok");
        auto row3 = sched.get(id);
        check(row3 && !row3->enabled && row3->nextRun == 0, "disabled job unscheduled");
        const int fired2 = sched.tick(later.addSecs(600));
        check(fired2 == 0, "disabled job does not fire");

        // Remove.
        check(sched.remove(id), "remove existing schedule");
        check(sched.list().isEmpty(), "list empty after remove");
        check(!sched.remove(QStringLiteral("sched_nope")), "remove unknown id false");

        // Bad expression rejected by create.
        check(sched.create(QStringLiteral("bad"), QStringLiteral("whenever"),
                           QStringLiteral("x")).isEmpty(),
              "create rejects an unparseable expression");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
