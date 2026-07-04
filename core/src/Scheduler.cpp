#include "jarvis/Scheduler.h"
#include "jarvis/DataPaths.h"

#include <QDir>
#include <QFileInfo>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSqlError>
#include <QSqlQuery>
#include <QStringList>
#include <QTimer>
#include <QVariant>

namespace jarvis {

// --- CronSpec parsing -------------------------------------------------------

namespace {

// Parse one cron field into the set of permitted integer values in [lo,hi].
// "*" => empty (matches any). Supports lists (a,b), ranges (a-b), steps (*/n,
// a-b/n). Returns false on a malformed field.
bool parseCronField(const QString &field, int lo, int hi, QVector<int> *out)
{
    out->clear();
    const QString f = field.trimmed();
    if (f.isEmpty())
        return false;
    if (f == QStringLiteral("*"))
        return true; // any

    const QStringList parts = f.split(QLatin1Char(','), Qt::SkipEmptyParts);
    for (const QString &partRaw : parts) {
        QString part = partRaw;
        int step = 1;
        const int slash = part.indexOf(QLatin1Char('/'));
        if (slash >= 0) {
            bool ok = false;
            step = part.mid(slash + 1).toInt(&ok);
            if (!ok || step <= 0)
                return false;
            part = part.left(slash);
        }
        int a = lo, b = hi;
        if (part == QStringLiteral("*")) {
            // */step handled by a..b with step.
        } else if (part.contains(QLatin1Char('-'))) {
            const QStringList range = part.split(QLatin1Char('-'));
            if (range.size() != 2)
                return false;
            bool ok1 = false, ok2 = false;
            a = range[0].toInt(&ok1);
            b = range[1].toInt(&ok2);
            if (!ok1 || !ok2)
                return false;
        } else {
            bool ok = false;
            a = b = part.toInt(&ok);
            if (!ok)
                return false;
        }
        if (a < lo || b > hi || a > b)
            return false;
        for (int v = a; v <= b; v += step)
            if (!out->contains(v))
                out->push_back(v);
    }
    return true;
}

} // namespace

CronSpec CronSpec::parse(const QString &expr)
{
    CronSpec s;
    s.raw = expr.trimmed();
    const QString e = s.raw;
    if (e.isEmpty())
        return s;

    const QString lower = e.toLower();

    // "every Nm" / "every N minutes/min/m" / "Nh/hours" / "Ns/seconds".
    static const QRegularExpression everyRe(
        QStringLiteral(R"(^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$)"));
    const auto em = everyRe.match(lower);
    if (em.hasMatch()) {
        const qint64 n = em.captured(1).toLongLong();
        const QString unit = em.captured(2);
        qint64 mult = 60; // default minutes
        if (unit.startsWith(QLatin1Char('s')))
            mult = 1;
        else if (unit.startsWith(QLatin1Char('h')))
            mult = 3600;
        else
            mult = 60;
        if (n <= 0)
            return s;
        s.kind = Kind::Interval;
        s.intervalSecs = n * mult;
        return s;
    }

    // Daily at a clock time (24h). Accepts the natural forms users actually type:
    //   "at HH:MM", "HH:MM", "daily HH:MM", "every day HH:MM", "each day at HH:MM"…
    static const QRegularExpression atRe(
        QStringLiteral(R"(^(?:(?:every\s*day|each\s*day|daily)\s+)?(?:at\s+)?(\d{1,2}):(\d{2})$)"));
    const auto am = atRe.match(lower);
    if (am.hasMatch()) {
        const int h = am.captured(1).toInt();
        const int mn = am.captured(2).toInt();
        if (h < 0 || h > 23 || mn < 0 || mn > 59)
            return s;
        s.kind = Kind::DailyAt;
        s.atHour = h;
        s.atMinute = mn;
        return s;
    }

    // 5-field cron "min hour dom mon dow".
    const QStringList fields = e.split(QRegularExpression(QStringLiteral("\\s+")),
                                       Qt::SkipEmptyParts);
    if (fields.size() == 5) {
        bool ok = true;
        ok &= parseCronField(fields[0], 0, 59, &s.minutes);
        ok &= parseCronField(fields[1], 0, 23, &s.hours);
        ok &= parseCronField(fields[2], 1, 31, &s.doms);
        ok &= parseCronField(fields[3], 1, 12, &s.months);
        ok &= parseCronField(fields[4], 0, 7, &s.dows); // 0 and 7 both = Sunday
        if (ok) {
            s.kind = Kind::Cron;
            return s;
        }
    }

    return s; // Invalid
}

QDateTime CronSpec::nextAfter(const QDateTime &from) const
{
    switch (kind) {
    case Kind::Interval:
        return from.addSecs(intervalSecs);

    case Kind::DailyAt: {
        QDateTime cand(from.date(), QTime(atHour, atMinute), from.timeZone());
        if (cand <= from)
            cand = cand.addDays(1);
        return cand;
    }

    case Kind::Cron: {
        // Step minute-by-minute from the next whole minute until all fields
        // match. Bounded to ~366 days so a never-matching spec still terminates.
        auto matches = [](const QVector<int> &set, int v) {
            return set.isEmpty() || set.contains(v);
        };
        QDateTime cand = from.addSecs(60 - from.time().second());
        cand = QDateTime(cand.date(), QTime(cand.time().hour(), cand.time().minute()),
                         from.timeZone());
        const qint64 limit = 366LL * 24 * 60;
        for (qint64 i = 0; i < limit; ++i, cand = cand.addSecs(60)) {
            const QDate d = cand.date();
            const QTime t = cand.time();
            // Qt dayOfWeek: 1=Mon..7=Sun. Cron uses 0..6 with Sun=0, and also
            // accepts 7 for Sunday. Map Qt Sunday(7) -> cron 0.
            const int cronDow = (d.dayOfWeek() == 7) ? 0 : d.dayOfWeek();
            const bool dowOk = dows.isEmpty() || dows.contains(cronDow) ||
                               (cronDow == 0 && dows.contains(7));
            if (matches(minutes, t.minute()) && matches(hours, t.hour()) &&
                matches(doms, d.day()) && matches(months, d.month()) && dowOk)
                return cand;
        }
        return QDateTime();
    }

    case Kind::Invalid:
    default:
        return QDateTime();
    }
}

// --- ScheduleRow ------------------------------------------------------------

QJsonObject ScheduleRow::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("cron"), cron);
    o.insert(QStringLiteral("prompt"), prompt);
    if (!brain.isEmpty())
        o.insert(QStringLiteral("brain"), brain);
    if (!model.isEmpty())
        o.insert(QStringLiteral("model"), model);
    if (!profile.isEmpty())
        o.insert(QStringLiteral("profile"), profile);
    o.insert(QStringLiteral("enabled"), enabled);
    o.insert(QStringLiteral("next_run"), nextRun);
    o.insert(QStringLiteral("last_run"), lastRun);
    o.insert(QStringLiteral("created"), created);
    return o;
}

// --- Scheduler --------------------------------------------------------------

Scheduler::Scheduler(QObject *parent) : QObject(parent) {}

Scheduler::~Scheduler()
{
    stop();
    close();
}

QString Scheduler::genId()
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(8, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("sched_") + QString::fromLatin1(bytes.toHex());
}

bool Scheduler::open(const QString &dbPath, const QString &connectionName)
{
    const QString path =
        dbPath.isEmpty() ? dataDir() + QStringLiteral("/jarvis.db") : dbPath;

    const QFileInfo fi(path);
    QDir dir = fi.absoluteDir();
    if (!dir.exists() && !dir.mkpath(QStringLiteral("."))) {
        m_lastError = QStringLiteral("failed to create db directory: ") + dir.absolutePath();
        return false;
    }

    m_connectionName = connectionName;
    if (QSqlDatabase::contains(m_connectionName))
        QSqlDatabase::removeDatabase(m_connectionName);

    m_db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), m_connectionName);
    m_db.setDatabaseName(path);
    if (!m_db.open()) {
        m_lastError = m_db.lastError().text();
        return false;
    }
    exec(QStringLiteral("PRAGMA journal_mode=WAL"));
    if (!migrate())
        return false;

    // Compute an initial next_run for any enabled row that lacks one (e.g. after
    // a restart where the row was created but never ticked).
    const QDateTime now = QDateTime::currentDateTime();
    for (const ScheduleRow &r : list()) {
        if (r.enabled && r.nextRun <= 0) {
            const CronSpec spec = CronSpec::parse(r.cron);
            const QDateTime next = spec.nextAfter(now);
            if (next.isValid())
                persistRunTimes(r.id, r.lastRun, next.toMSecsSinceEpoch());
        }
    }
    return true;
}

bool Scheduler::isOpen() const
{
    return m_db.isValid() && m_db.isOpen();
}

void Scheduler::close()
{
    if (m_db.isOpen())
        m_db.close();
    m_db = QSqlDatabase();
    if (!m_connectionName.isEmpty() && QSqlDatabase::contains(m_connectionName)) {
        QSqlDatabase::removeDatabase(m_connectionName);
        m_connectionName.clear();
    }
}

bool Scheduler::exec(const QString &sql, QString *err)
{
    QSqlQuery q(m_db);
    if (!q.exec(sql)) {
        const QString e = q.lastError().text();
        m_lastError = e;
        if (err)
            *err = e;
        return false;
    }
    return true;
}

bool Scheduler::migrate()
{
    return exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS schedules ("
        " id TEXT PRIMARY KEY,"
        " name TEXT,"
        " cron TEXT NOT NULL,"
        " prompt TEXT NOT NULL,"
        " brain TEXT,"
        " model TEXT,"
        " profile TEXT,"
        " enabled INTEGER NOT NULL DEFAULT 1,"
        " next_run INTEGER NOT NULL DEFAULT 0,"
        " last_run INTEGER NOT NULL DEFAULT 0,"
        " created INTEGER)"));
}

void Scheduler::start(int tickMs)
{
    if (!m_timer) {
        m_timer = new QTimer(this);
        connect(m_timer, &QTimer::timeout, this, &Scheduler::onTick);
    }
    m_timer->start(tickMs);
}

void Scheduler::stop()
{
    if (m_timer)
        m_timer->stop();
}

void Scheduler::onTick()
{
    tick(QDateTime::currentDateTime());
}

QString Scheduler::create(const QString &name, const QString &cronExpr, const QString &prompt,
                          const QString &brain, const QString &model,
                          const QString &profile, bool enabled)
{
    const CronSpec spec = CronSpec::parse(cronExpr);
    if (!spec.valid()) {
        m_lastError = QStringLiteral("unrecognized schedule expression: ") + cronExpr;
        return QString();
    }
    if (prompt.trimmed().isEmpty()) {
        m_lastError = QStringLiteral("prompt is required");
        return QString();
    }

    ScheduleRow r;
    r.id = genId();
    r.name = name.isEmpty() ? cronExpr : name;
    r.cron = spec.raw;
    r.prompt = prompt;
    r.brain = brain;
    r.model = model;
    r.profile = profile;
    r.enabled = enabled;
    r.created = QDateTime::currentMSecsSinceEpoch();
    r.lastRun = 0;
    const QDateTime next = spec.nextAfter(QDateTime::currentDateTime());
    r.nextRun = (enabled && next.isValid()) ? next.toMSecsSinceEpoch() : 0;

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO schedules"
        " (id,name,cron,prompt,brain,model,profile,enabled,next_run,last_run,created)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)"));
    q.addBindValue(r.id);
    q.addBindValue(r.name);
    q.addBindValue(r.cron);
    q.addBindValue(r.prompt);
    q.addBindValue(r.brain);
    q.addBindValue(r.model);
    q.addBindValue(r.profile);
    q.addBindValue(r.enabled ? 1 : 0);
    q.addBindValue(r.nextRun);
    q.addBindValue(r.lastRun);
    q.addBindValue(r.created);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return QString();
    }
    return r.id;
}

static ScheduleRow rowFromQuery(QSqlQuery &q)
{
    ScheduleRow r;
    r.id = q.value(0).toString();
    r.name = q.value(1).toString();
    r.cron = q.value(2).toString();
    r.prompt = q.value(3).toString();
    r.brain = q.value(4).toString();
    r.model = q.value(5).toString();
    r.profile = q.value(6).toString();
    r.enabled = q.value(7).toInt() != 0;
    r.nextRun = q.value(8).toLongLong();
    r.lastRun = q.value(9).toLongLong();
    r.created = q.value(10).toLongLong();
    return r;
}

QVector<ScheduleRow> Scheduler::list()
{
    QVector<ScheduleRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT id,name,cron,prompt,brain,model,profile,enabled,next_run,last_run,created"
            " FROM schedules ORDER BY created ASC"))) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next())
        out.push_back(rowFromQuery(q));
    return out;
}

std::optional<ScheduleRow> Scheduler::get(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,name,cron,prompt,brain,model,profile,enabled,next_run,last_run,created"
        " FROM schedules WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;
    return rowFromQuery(q);
}

bool Scheduler::setEnabled(const QString &id, bool enabled)
{
    auto row = get(id);
    if (!row)
        return false;

    qint64 nextRun = row->nextRun;
    if (enabled) {
        // Re-enabling: (re)compute next_run from now.
        const CronSpec spec = CronSpec::parse(row->cron);
        const QDateTime next = spec.nextAfter(QDateTime::currentDateTime());
        nextRun = next.isValid() ? next.toMSecsSinceEpoch() : 0;
    } else {
        nextRun = 0; // disabled jobs are not scheduled
    }

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "UPDATE schedules SET enabled=?, next_run=? WHERE id=?"));
    q.addBindValue(enabled ? 1 : 0);
    q.addBindValue(nextRun);
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool Scheduler::remove(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM schedules WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool Scheduler::persistRunTimes(const QString &id, qint64 lastRun, qint64 nextRun)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "UPDATE schedules SET last_run=?, next_run=? WHERE id=?"));
    q.addBindValue(lastRun);
    q.addBindValue(nextRun);
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

int Scheduler::tick(const QDateTime &now)
{
    const qint64 nowMs = now.toMSecsSinceEpoch();
    int fired = 0;

    for (const ScheduleRow &r : list()) {
        if (!r.enabled || r.nextRun <= 0 || r.nextRun > nowMs)
            continue;

        // Fire the job (daemon creates a session + sends the prompt).
        QString sessionId;
        if (m_fire)
            sessionId = m_fire(r);

        // Advance next_run from the SCHEDULED time (not 'now') so cadence doesn't
        // drift; if we're behind, skip ahead past 'now'.
        const CronSpec spec = CronSpec::parse(r.cron);
        QDateTime base = QDateTime::fromMSecsSinceEpoch(r.nextRun);
        QDateTime next = spec.nextAfter(base);
        int guard = 0;
        while (next.isValid() && next <= now && guard++ < 100000)
            next = spec.nextAfter(next);

        persistRunTimes(r.id, nowMs, next.isValid() ? next.toMSecsSinceEpoch() : 0);
        emit jobFired(r, sessionId);
        ++fired;
    }
    return fired;
}

std::optional<QString> Scheduler::runNow(const QString &id, const QDateTime &now)
{
    const std::optional<ScheduleRow> row = get(id);
    if (!row)
        return std::nullopt;

    // Explicit user action: fire regardless of enabled/next_run state.
    QString sessionId;
    if (m_fire)
        sessionId = m_fire(*row);

    // Stamp last_run but leave next_run exactly as stored — tick() owns
    // next_run advancement, and a manual run must not shift the cadence.
    persistRunTimes(id, now.toMSecsSinceEpoch(), row->nextRun);
    emit jobFired(*row, sessionId);
    return sessionId;
}

} // namespace jarvis
