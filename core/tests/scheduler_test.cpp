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

    // Natural daily forms users actually type must ALSO parse as DailyAt.
    for (const char *expr : {"every day 09:00", "daily 9:00", "daily at 09:00",
                             "every day at 9:00", "9:00"}) {
        const CronSpec s = CronSpec::parse(QString::fromLatin1(expr));
        check(s.valid() && s.kind == CronSpec::Kind::DailyAt && s.atHour == 9
                  && s.atMinute == 0,
              expr);
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

        // schedule.run_now: manual fire works even while disabled, stamps
        // last_run, and leaves next_run untouched (a manual run must not
        // shift the configured cadence — tick() owns next_run advancement).
        const qint64 lastBefore = row3 ? row3->lastRun : 0;
        const auto manualSid = sched.runNow(id, later.addSecs(1200));
        check(manualSid.has_value(), "runNow finds the schedule");
        check(manualSid && *manualSid == QStringLiteral("sess_fake"),
              "runNow returns the fire callback's session id");
        check(fireCount == 2, "runNow invoked the fire callback (even disabled)");
        auto row4 = sched.get(id);
        check(row4 && row4->lastRun > lastBefore, "runNow stamps last_run");
        check(row4 && row3 && row4->nextRun == row3->nextRun,
              "runNow leaves next_run untouched");
        check(!sched.runNow(QStringLiteral("sched_nope")).has_value(),
              "runNow unknown id returns nullopt");

        // Remove.
        check(sched.remove(id), "remove existing schedule");
        check(sched.list().isEmpty(), "list empty after remove");
        check(!sched.remove(QStringLiteral("sched_nope")), "remove unknown id false");

        // Bad expression rejected by create.
        check(sched.create(QStringLiteral("bad"), QStringLiteral("whenever"),
                           QStringLiteral("x")).isEmpty(),
              "create rejects an unparseable expression");
    }

    // --- webhook trigger + workflow columns -------------------------------
    {
        const CronSpec w = CronSpec::parse(QStringLiteral("webhook"));
        check(w.valid() && w.kind == CronSpec::Kind::Webhook, "'webhook' parses as Webhook kind");
        check(!w.nextAfter(QDateTime::currentDateTime()).isValid(),
              "webhook nextAfter is invalid (never timer-scheduled)");
    }
    {
        QTemporaryDir tmp;
        const QString dbPath = tmp.path() + QStringLiteral("/wf_test.db");
        Scheduler sched;
        check(sched.open(dbPath, QStringLiteral("wf-test-conn")), "workflow: scheduler open");

        int fireCount = 0;
        sched.setFireCallback([&](const ScheduleRow &) -> QString {
            ++fireCount;
            return QStringLiteral("sess_wf");
        });

        // A cron workflow carrying target + report thread.
        const QString cid = sched.create(
            QStringLiteral("nightly-runner-check"), QStringLiteral("0 2 * * *"),
            QStringLiteral("check runner"), QStringLiteral("api"),
            QStringLiteral("mistral-large-latest"), QString(), true,
            QStringLiteral("ci-runner-104"), QStringLiteral("Workflows"), QString());
        check(!cid.isEmpty(), "workflow: cron workflow created");
        auto crow = sched.get(cid);
        check(crow && crow->targetRef == QStringLiteral("ci-runner-104"), "workflow: target persisted");
        check(crow && crow->reportThread == QStringLiteral("Workflows"), "workflow: report thread persisted");
        check(crow && crow->nextRun > 0, "workflow: cron workflow has a next_run");
        {
            const QJsonObject j = crow->toJson();
            check(j.value(QStringLiteral("target")).toString() == QStringLiteral("ci-runner-104"),
                  "workflow: toJson emits target");
            check(j.value(QStringLiteral("report_thread")).toString() == QStringLiteral("Workflows"),
                  "workflow: toJson emits report_thread");
            check(!j.contains(QStringLiteral("webhook_token")) && !j.contains(QStringLiteral("token")),
                  "workflow: toJson NEVER emits the webhook token");
        }

        // A webhook workflow: valid, stored, but never fires on a tick.
        const QString wid = sched.create(
            QStringLiteral("deploy-hook"), QStringLiteral("webhook"),
            QStringLiteral("handle deploy"), QString(), QString(), QString(), true,
            QString(), QStringLiteral("Workflows"), QStringLiteral("secret-token-xyz"));
        check(!wid.isEmpty(), "workflow: webhook workflow created (webhook is a valid trigger)");
        auto wrow = sched.get(wid);
        check(wrow && wrow->nextRun == 0, "workflow: webhook workflow is never timer-scheduled");
        check(wrow && wrow->webhookToken == QStringLiteral("secret-token-xyz"),
              "workflow: webhook token stored");

        // A near-term (+2min) tick fires neither: nothing is due yet at all
        // (the 02:00 cron isn't due for hours; the webhook is never
        // timer-scheduled). This does NOT by itself prove the webhook is
        // discriminated against on a timer tick -- see the past-cron-fire-time
        // tick below for that.
        const QDateTime soon = QDateTime::currentDateTime().addSecs(120);
        sched.tick(soon);
        check(fireCount == 0, "workflow: near-term tick fires nothing (nothing is due yet)");

        // Now tick genuinely PAST the cron workflow's actual computed next_run
        // (read back from the row, not a hardcoded wall-clock time) and confirm
        // the cron fires exactly once while the webhook workflow is completely
        // untouched. This is what actually proves "webhook never fires on a
        // timer tick" as opposed to "nothing happened to be due yet".
        const QDateTime pastCronFire = QDateTime::fromMSecsSinceEpoch(crow->nextRun).addSecs(60);
        const int firedPastCron = sched.tick(pastCronFire);
        check(firedPastCron == 1 && fireCount == 1,
              "workflow: a tick past the cron's next_run fires only the cron (fireCount==1)");
        auto crowAfterFire = sched.get(cid);
        check(crowAfterFire && crowAfterFire->lastRun > 0,
              "workflow: cron row's last_run is stamped after firing");
        auto wrowAfterFire = sched.get(wid);
        check(wrowAfterFire && wrowAfterFire->lastRun == 0 && wrowAfterFire->nextRun == 0,
              "workflow: webhook row is untouched (last_run/next_run still 0) by a tick past the cron's fire time");

        // runNow fires the webhook workflow through the normal fire path.
        const auto sid = sched.runNow(wid);
        check(sid.has_value() && fireCount == 2, "workflow: runNow fires the webhook workflow");
    }

    // --- schedule.update: partial-update semantics -------------------------
    {
        QTemporaryDir tmp;
        const QString dbPath = tmp.path() + QStringLiteral("/update_test.db");
        Scheduler sched;
        check(sched.open(dbPath, QStringLiteral("update-test-conn")),
              "update: scheduler open");

        const QString id = sched.create(
            QStringLiteral("orig-name"), QStringLiteral("every 5m"),
            QStringLiteral("orig prompt"), QStringLiteral("codex"),
            QStringLiteral("orig-model"), QStringLiteral("coder"), true,
            QStringLiteral("orig-target"), QStringLiteral("orig-thread"));
        check(!id.isEmpty(), "update: schedule created");

        // Update ONLY the prompt: cron/model/name/etc must be unchanged.
        check(sched.update(id, std::nullopt, std::nullopt,
                          QString(QStringLiteral("new prompt"))),
              "update: prompt-only update succeeds");
        {
            auto row = sched.get(id);
            check(row && row->prompt == QStringLiteral("new prompt"),
                  "update: prompt changed");
            check(row && row->cron == QStringLiteral("every 5m"),
                  "update: prompt-only update leaves cron unchanged");
            check(row && row->model == QStringLiteral("orig-model"),
                  "update: prompt-only update leaves model unchanged");
            check(row && row->name == QStringLiteral("orig-name"),
                  "update: prompt-only update leaves name unchanged");
            check(row && row->targetRef == QStringLiteral("orig-target"),
                  "update: prompt-only update leaves target unchanged");
        }

        // Update ONLY the model: prompt/cron must stay exactly as set above.
        check(sched.update(id, std::nullopt, std::nullopt, std::nullopt,
                          std::nullopt, QString(QStringLiteral("new-model"))),
              "update: model-only update succeeds");
        {
            auto row = sched.get(id);
            check(row && row->model == QStringLiteral("new-model"),
                  "update: model changed");
            check(row && row->prompt == QStringLiteral("new prompt"),
                  "update: model-only update leaves prompt (from prior update) unchanged");
            check(row && row->cron == QStringLiteral("every 5m"),
                  "update: model-only update leaves cron unchanged");
        }

        // Update the cron: next_run must be recomputed from the new expression.
        {
            auto before = sched.get(id);
            check(sched.update(id, std::nullopt,
                              QString(QStringLiteral("every 1m"))),
                  "update: cron update succeeds");
            auto after = sched.get(id);
            check(after && after->cron == QStringLiteral("every 1m"),
                  "update: cron changed");
            check(after && before && after->nextRun != before->nextRun,
                  "update: changing cron recomputes next_run");
        }

        // webhook_token is never touched by update (no parameter accepts it).
        check(sched.get(id) && sched.get(id)->webhookToken.isEmpty(),
              "update: webhook_token stays empty/untouched (no such param exists)");

        // Unknown id fails.
        check(!sched.update(QStringLiteral("sched_nope"), std::nullopt, std::nullopt,
                           QString(QStringLiteral("x"))),
              "update: unknown id returns false");

        // An unparseable new cron is rejected and leaves the row untouched.
        {
            auto before = sched.get(id);
            check(!sched.update(id, std::nullopt, QString(QStringLiteral("whenever"))),
                  "update: unparseable cron rejected");
            auto after = sched.get(id);
            check(after && before && after->cron == before->cron,
                  "update: rejected cron leaves the row's cron unchanged");
        }

        // A blank name falls back to the row's (current) cron, mirroring
        // create()'s "name.isEmpty() ? cronExpr : name" convention — a
        // schedule row's name must never end up blank.
        {
            check(sched.update(id, QString()), "update: blank-name update succeeds");
            auto row = sched.get(id);
            check(row && !row->name.isEmpty() && row->name == row->cron,
                  "update: blank name falls back to the row's cron, never stored blank");
        }

        // Changing cron AND blanking name in the SAME call: the fallback must
        // use the NEW cron, not the stale pre-update one.
        {
            check(sched.update(id, QString(), QString(QStringLiteral("every 7m"))),
                  "update: simultaneous cron-change + blank-name update succeeds");
            auto row = sched.get(id);
            check(row && row->cron == QStringLiteral("every 7m"),
                  "update: cron changed in the combined call");
            check(row && row->name == QStringLiteral("every 7m"),
                  "update: blank-name fallback reflects the NEW cron, not the stale one");
        }
    }

    // --- schedule.update: cannot convert a token-less row to webhook --------
    {
        QTemporaryDir tmp;
        const QString dbPath = tmp.path() + QStringLiteral("/update_webhook_test.db");
        Scheduler sched;
        check(sched.open(dbPath, QStringLiteral("update-webhook-test-conn")),
              "update-webhook: scheduler open");

        // A plain cron schedule with NO webhook token.
        const QString id = sched.create(QStringLiteral("plain"), QStringLiteral("every 5m"),
                                        QStringLiteral("do thing"));
        check(!id.isEmpty(), "update-webhook: plain schedule created");

        // Attempting to flip its trigger to "webhook" via update must be
        // rejected — there is no way to mint a token through update() (it
        // takes no webhookToken parameter at all), so silently allowing this
        // would produce a permanently unfireable webhook workflow.
        check(!sched.update(id, std::nullopt, QString(QStringLiteral("webhook"))),
              "update-webhook: converting a token-less row to webhook is rejected");
        auto row = sched.get(id);
        check(row && row->cron == QStringLiteral("every 5m"),
              "update-webhook: rejected conversion leaves the row's cron unchanged");

        // A row created WITH a webhook token can still have its cron updated
        // to something else (moving away from webhook is fine — the token
        // just goes dormant, no security or correctness issue).
        const QString wid = sched.create(QStringLiteral("hook"), QStringLiteral("webhook"),
                                         QStringLiteral("handle it"), QString(), QString(),
                                         QString(), true, QString(), QString(),
                                         QStringLiteral("tok-abc"));
        check(!wid.isEmpty(), "update-webhook: webhook schedule created");
        check(sched.update(wid, std::nullopt, QString(QStringLiteral("every 10m"))),
              "update-webhook: moving an existing webhook row AWAY from webhook is allowed");
        auto wrow = sched.get(wid);
        check(wrow && wrow->cron == QStringLiteral("every 10m"),
              "update-webhook: cron changed away from webhook");
        check(wrow && wrow->webhookToken == QStringLiteral("tok-abc"),
              "update-webhook: the now-dormant token is left untouched (still stored, just unused)");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
