#pragma once

// Scheduler — cron/at scheduled Jarvis jobs (BUILD_SPEC CONTRACT-A additions +
// ROLE: "Scheduler (core/src/Scheduler.* + SQLite schedules table)").
//
//   schedule.create{name,when|cron,prompt,brain?,model?,profile?,enabled?} -> {id}
//   schedule.list   -> {schedules:[{id,name,cron,next_run,last_run,enabled}]}
//   schedule.set_enabled{id,enabled}
//   schedule.remove{id}
//   schedule.update{id,name?,cron?,prompt?,brain?,model?,profile?,target?,report_thread?}
//                   -> {ok} (a PARTIAL update: omitted fields are left unchanged;
//                   webhook_token is never editable here)
//
// Supported `when`/`cron` syntaxes (CronSpec):
//   - "every Nm" / "every N minutes" / "every Nh" / "every Ns"  (interval)
//   - "at HH:MM"                                                (daily clock time)
//   - a 5-field cron "min hour dom mon dow"                     (with * , - / ranges)
//
// A QTimer ticks ~every 15s; on each tick the scheduler fires every enabled job
// whose next_run is due, by invoking a fire callback the daemon wires to
// ControlServer (session.create + session.send), then recomputes next_run and
// persists last_run/next_run. Jobs persist in the `schedules` SQLite table in
// jarvis.db so they survive a daemon restart.

#include <QDateTime>
#include <QJsonObject>
#include <QObject>
#include <QSqlDatabase>
#include <QString>
#include <QVector>
#include <functional>
#include <optional>

QT_BEGIN_NAMESPACE
class QTimer;
QT_END_NAMESPACE

namespace jarvis {

// A parsed schedule expression. `valid` is false when the text could not be
// parsed; `kind` selects how nextAfter() advances.
struct CronSpec {
    enum class Kind { Invalid, Interval, DailyAt, Cron, Webhook };

    Kind kind = Kind::Invalid;
    QString raw;            // the original expression (stored verbatim)

    // Interval.
    qint64 intervalSecs = 0;

    // DailyAt.
    int atHour = 0;
    int atMinute = 0;

    // 5-field cron: each field is the set of permitted values (empty => any/*).
    // Indexed: minute, hour, day-of-month, month, day-of-week (0/7=Sun).
    QVector<int> minutes, hours, doms, months, dows;

    bool valid() const { return kind != Kind::Invalid; }

    // Parse "every Nm" / "at HH:MM" / a 5-field cron string.
    static CronSpec parse(const QString &expr);

    // The next fire time strictly AFTER `from`. Returns an invalid QDateTime if
    // the spec is invalid. For Interval, this is from+interval. For DailyAt /
    // Cron it is the next matching wall-clock minute (local time).
    QDateTime nextAfter(const QDateTime &from) const;
};

// One persisted schedule row.
struct ScheduleRow {
    QString id;
    QString name;
    QString cron;       // the raw when/cron expression
    QString prompt;     // the text sent to the spawned session
    QString brain;      // optional brain override ("" => daemon default)
    QString model;      // optional model override
    QString profile;    // "coder" | "coworker" ("" => coder)
    bool enabled = true;
    qint64 nextRun = 0; // unix ms (0 => not scheduled / compute on load)
    qint64 lastRun = 0; // unix ms (0 => never run)
    qint64 created = 0;

    QString targetRef;    // agent name / paired-machine id (free-text ref, no FK)
    QString reportThread; // inbox thread for the fired session's report ("" => none)
    QString webhookToken; // per-workflow bearer for trigger=="webhook" (never serialized)

    QJsonObject toJson() const;
};

class Scheduler : public QObject {
    Q_OBJECT
public:
    // The daemon supplies this: given (prompt, brain, model, profile) it should
    // create a session + send the prompt, returning the new session id (or empty
    // on failure). Scheduler stays decoupled from ControlServer this way.
    using FireFn = std::function<QString(const ScheduleRow &)>;

    explicit Scheduler(QObject *parent = nullptr);
    ~Scheduler() override;

    // Open + migrate the `schedules` table (distinct connection name). Computes
    // an initial next_run for any enabled row missing one. Returns false on
    // failure (see lastError()).
    bool open(const QString &dbPath = QString(),
              const QString &connectionName = QStringLiteral("jarvis-sched"));
    bool isOpen() const;
    void close();
    QString lastError() const { return m_lastError; }

    // Wire the fire callback and start the ~15s tick timer.
    void setFireCallback(FireFn fn) { m_fire = std::move(fn); }
    void start(int tickMs = 15000);
    void stop();

    // --- schedule.* operations ---------------------------------------------
    // Create a schedule from a parsed `when`/`cron` expression. Returns the new
    // id (empty + lastError set on a bad expression or store error).
    QString create(const QString &name, const QString &cronExpr, const QString &prompt,
                   const QString &brain = QString(), const QString &model = QString(),
                   const QString &profile = QString(), bool enabled = true,
                   const QString &targetRef = QString(),
                   const QString &reportThread = QString(),
                   const QString &webhookToken = QString());
    QVector<ScheduleRow> list();
    std::optional<ScheduleRow> get(const QString &id);
    bool setEnabled(const QString &id, bool enabled);
    bool remove(const QString &id);

    // Partial update: only fields whose optional is engaged (has_value())
    // are changed; everything else is left as-is. A changed `cron`
    // re-parses and recomputes next_run the same way create() does
    // (respecting the row's current enabled state); an unset cron leaves
    // next_run untouched. webhookToken can never be SET/minted through this
    // call (there is no such parameter — only create() mints one, and
    // converting a token-less row's trigger to "webhook" is rejected
    // outright); but if the row's CURRENT trigger is "webhook" and the new
    // `cronExpr` converts it away from "webhook", the stored token IS
    // cleared as a side effect, so a stale webhook URL/token can never keep
    // firing a row that is no longer webhook-triggered. Returns false for an
    // unknown id or an unparseable new cron expression (see lastError()).
    bool update(const QString &id,
                const std::optional<QString> &name = std::nullopt,
                const std::optional<QString> &cronExpr = std::nullopt,
                const std::optional<QString> &prompt = std::nullopt,
                const std::optional<QString> &brain = std::nullopt,
                const std::optional<QString> &model = std::nullopt,
                const std::optional<QString> &profile = std::nullopt,
                const std::optional<QString> &targetRef = std::nullopt,
                const std::optional<QString> &reportThread = std::nullopt);

    // Run one scheduling pass now (also called by the tick). Fires every enabled
    // job whose next_run <= now, updates last_run/next_run. Returns the number of
    // jobs fired. Exposed for tests.
    int tick(const QDateTime &now = QDateTime::currentDateTime());

    // schedule.run_now: fire one job immediately regardless of enabled/next_run
    // state (an explicit user action). Stamps last_run but leaves next_run
    // untouched so a manual run never shifts the configured cadence. Returns
    // std::nullopt for an unknown id, else the fire callback's session id
    // (empty when the daemon failed to spawn the session).
    std::optional<QString> runNow(const QString &id,
                                  const QDateTime &now = QDateTime::currentDateTime());

signals:
    // Emitted after a job fires (so the daemon can notify-send "schedule done").
    // `sessionId` is whatever the fire callback returned (may be empty).
    void jobFired(const jarvis::ScheduleRow &row, const QString &sessionId);

private slots:
    void onTick();

private:
    bool exec(const QString &sql, QString *err = nullptr);
    bool migrate();
    bool hasColumn(const QString &table, const QString &column);
    bool persistRunTimes(const QString &id, qint64 lastRun, qint64 nextRun);
    static QString genId();

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
    QTimer *m_timer = nullptr;
    FireFn m_fire;
};

} // namespace jarvis
