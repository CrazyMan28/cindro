#include "jarvis/KanbanStore.h"
#include "jarvis/DataPaths.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QRandomGenerator>
#include <QSqlError>
#include <QSqlQuery>
#include <QVariant>

namespace jarvis {

namespace {
constexpr const char *kCols =
    "id,title,prompt,status,priority,brain,model,profile,session_id,"
    "parent_item_id,result,heartbeat_at,created,updated,started,ended,tags";

WorkItem itemFromQuery(const QSqlQuery &q)
{
    WorkItem w;
    w.id = q.value(0).toString();
    w.title = q.value(1).toString();
    w.prompt = q.value(2).toString();
    w.status = q.value(3).toString();
    w.priority = q.value(4).toInt();
    w.brain = q.value(5).toString();
    w.model = q.value(6).toString();
    w.profile = q.value(7).toString();
    w.sessionId = q.value(8).toString();
    w.parentItemId = q.value(9).toString();
    w.result = q.value(10).toString();
    w.heartbeatAt = q.value(11).toLongLong();
    w.created = q.value(12).toLongLong();
    w.updated = q.value(13).toLongLong();
    w.started = q.value(14).toLongLong();
    w.ended = q.value(15).toLongLong();
    w.tags = q.value(16).toString();
    return w;
}
} // namespace

QJsonObject WorkItem::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("title"), title);
    o.insert(QStringLiteral("prompt"), prompt);
    o.insert(QStringLiteral("status"), status);
    o.insert(QStringLiteral("priority"), priority);
    if (!brain.isEmpty())
        o.insert(QStringLiteral("brain"), brain);
    if (!model.isEmpty())
        o.insert(QStringLiteral("model"), model);
    if (!profile.isEmpty())
        o.insert(QStringLiteral("profile"), profile);
    o.insert(QStringLiteral("session_id"), sessionId);
    if (!parentItemId.isEmpty())
        o.insert(QStringLiteral("parent_item_id"), parentItemId);
    if (!result.isEmpty())
        o.insert(QStringLiteral("result"), result);
    o.insert(QStringLiteral("heartbeat_at"), heartbeatAt);
    o.insert(QStringLiteral("created"), created);
    o.insert(QStringLiteral("updated"), updated);
    o.insert(QStringLiteral("started"), started);
    o.insert(QStringLiteral("ended"), ended);
    if (!tags.isEmpty())
        o.insert(QStringLiteral("tags"), tags);
    return o;
}

KanbanStore::~KanbanStore()
{
    close();
}

QString KanbanStore::genId()
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(8, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("work_") + QString::fromLatin1(bytes.toHex());
}

bool KanbanStore::open(const QString &dbPath, const QString &connectionName)
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
    return migrate();
}

bool KanbanStore::isOpen() const
{
    return m_db.isValid() && m_db.isOpen();
}

void KanbanStore::close()
{
    if (m_db.isOpen())
        m_db.close();
    m_db = QSqlDatabase();
    if (!m_connectionName.isEmpty() && QSqlDatabase::contains(m_connectionName)) {
        QSqlDatabase::removeDatabase(m_connectionName);
        m_connectionName.clear();
    }
}

bool KanbanStore::exec(const QString &sql)
{
    QSqlQuery q(m_db);
    if (!q.exec(sql)) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

bool KanbanStore::migrate()
{
    if (!exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS work_queue ("
        " id TEXT PRIMARY KEY,"
        " title TEXT NOT NULL,"
        " prompt TEXT NOT NULL,"
        " status TEXT NOT NULL DEFAULT 'pending',"
        " priority INTEGER NOT NULL DEFAULT 0,"
        " brain TEXT DEFAULT '',"
        " model TEXT DEFAULT '',"
        " profile TEXT DEFAULT '',"
        " session_id TEXT DEFAULT '',"
        " parent_item_id TEXT DEFAULT '',"
        " result TEXT DEFAULT '',"
        " heartbeat_at INTEGER NOT NULL DEFAULT 0,"
        " created INTEGER,"
        " updated INTEGER,"
        " started INTEGER NOT NULL DEFAULT 0,"
        " ended INTEGER NOT NULL DEFAULT 0,"
        " tags TEXT DEFAULT '')")))
        return false;
    // The dispatcher polls by status every 5s for the daemon's lifetime —
    // keep that scan indexed as done/cancelled rows accumulate.
    return exec(QStringLiteral(
        "CREATE INDEX IF NOT EXISTS idx_work_queue_status"
        " ON work_queue(status, priority DESC, created ASC)"));
}

QString KanbanStore::enqueue(const QString &title, const QString &prompt, int priority,
                             const QString &brain, const QString &model,
                             const QString &profile, const QString &tags,
                             const QString &parentItemId)
{
    if (prompt.trimmed().isEmpty()) {
        m_lastError = QStringLiteral("work item prompt is empty");
        return QString();
    }
    const QString id = genId();
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO work_queue (id,title,prompt,status,priority,brain,model,"
        " profile,session_id,parent_item_id,result,heartbeat_at,created,updated,"
        " started,ended,tags)"
        " VALUES (?,?,?,'pending',?,?,?,?,'',?,'',0,?,?,0,0,?)"));
    q.addBindValue(id);
    q.addBindValue(title.trimmed().isEmpty() ? prompt.left(60) : title.trimmed());
    q.addBindValue(prompt);
    q.addBindValue(priority);
    q.addBindValue(brain);
    q.addBindValue(model);
    q.addBindValue(profile);
    q.addBindValue(parentItemId);
    q.addBindValue(now);
    q.addBindValue(now);
    q.addBindValue(tags);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return QString();
    }
    return id;
}

std::optional<WorkItem> KanbanStore::claimNext(const QString &sessionId)
{
    // Highest priority first, FIFO within a priority band.
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
                  "SELECT %1 FROM work_queue WHERE status='pending'"
                  " ORDER BY priority DESC, created ASC LIMIT 1")
                  .arg(QLatin1String(kCols)));
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;
    WorkItem w = itemFromQuery(q);

    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    QSqlQuery up(m_db);
    // Guard on status='pending' so two dispatchers can't double-claim.
    up.prepare(QStringLiteral(
        "UPDATE work_queue SET status='running', session_id=?, heartbeat_at=?,"
        " started=?, updated=? WHERE id=? AND status='pending'"));
    up.addBindValue(sessionId);
    up.addBindValue(now);
    up.addBindValue(now);
    up.addBindValue(now);
    up.addBindValue(w.id);
    if (!up.exec() || up.numRowsAffected() == 0) {
        m_lastError = up.lastError().text();
        return std::nullopt;
    }
    w.status = QStringLiteral("running");
    w.sessionId = sessionId;
    w.heartbeatAt = now;
    w.started = now;
    w.updated = now;
    return w;
}

std::optional<WorkItem> KanbanStore::get(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("SELECT %1 FROM work_queue WHERE id=?")
                  .arg(QLatin1String(kCols)));
    q.addBindValue(id);
    if (!q.exec() || !q.next())
        return std::nullopt;
    return itemFromQuery(q);
}

QVector<WorkItem> KanbanStore::list(const QString &status, int limit)
{
    QVector<WorkItem> out;
    QSqlQuery q(m_db);
    if (status.isEmpty()) {
        q.prepare(QStringLiteral(
                      "SELECT %1 FROM work_queue ORDER BY created DESC LIMIT ?")
                      .arg(QLatin1String(kCols)));
        q.addBindValue(limit);
    } else {
        q.prepare(QStringLiteral(
                      "SELECT %1 FROM work_queue WHERE status=?"
                      " ORDER BY priority DESC, created ASC LIMIT ?")
                      .arg(QLatin1String(kCols)));
        q.addBindValue(status);
        q.addBindValue(limit);
    }
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next())
        out.push_back(itemFromQuery(q));
    return out;
}

bool KanbanStore::updateStatus(const QString &id, const QString &status,
                               const QString &sessionId, const QString &result)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const bool terminal = status == QStringLiteral("done") ||
                          status == QStringLiteral("error") ||
                          status == QStringLiteral("cancelled");
    // Named binds: the optional SET clauses and their values can never fall
    // out of positional sync (a silent wrong-column write with '?' binds).
    QSqlQuery q(m_db);
    QString sql = QStringLiteral("UPDATE work_queue SET status=:status, updated=:updated");
    if (!sessionId.isEmpty())
        sql += QStringLiteral(", session_id=:sid");
    if (!result.isEmpty())
        sql += QStringLiteral(", result=:result");
    if (terminal)
        sql += QStringLiteral(", ended=:ended");
    sql += QStringLiteral(" WHERE id=:id");
    q.prepare(sql);
    q.bindValue(QStringLiteral(":status"), status);
    q.bindValue(QStringLiteral(":updated"), now);
    if (!sessionId.isEmpty())
        q.bindValue(QStringLiteral(":sid"), sessionId);
    if (!result.isEmpty())
        q.bindValue(QStringLiteral(":result"), result);
    if (terminal)
        q.bindValue(QStringLiteral(":ended"), now);
    q.bindValue(QStringLiteral(":id"), id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool KanbanStore::setPriority(const QString &id, int priority)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "UPDATE work_queue SET priority=?, updated=? WHERE id=?"));
    q.addBindValue(priority);
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool KanbanStore::heartbeat(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "UPDATE work_queue SET heartbeat_at=? WHERE id=? AND status='running'"));
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool KanbanStore::cancel(const QString &id)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "UPDATE work_queue SET status='cancelled', updated=?, ended=?"
        " WHERE id=? AND status IN ('pending','running')"));
    q.addBindValue(now);
    q.addBindValue(now);
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool KanbanStore::remove(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "DELETE FROM work_queue WHERE id=? AND status IN ('done','error','cancelled')"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

int KanbanStore::reclaimStale(qint64 staleMs)
{
    const qint64 cutoff = QDateTime::currentMSecsSinceEpoch() - staleMs;
    QSqlQuery q(m_db);
    // Reclaimed items rejoin their priority band with the session link cleared
    // — the next claim runs a fresh worker session. `updated` stamps the
    // reclaim for observability.
    q.prepare(QStringLiteral(
        "UPDATE work_queue SET status='pending', session_id='', heartbeat_at=0,"
        " updated=? WHERE status='running' AND heartbeat_at < ?"));
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    q.addBindValue(cutoff);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return 0;
    }
    return q.numRowsAffected();
}

bool KanbanStore::releaseClaim(const QString &id)
{
    // Unlike updateStatus() (which deliberately leaves session_id untouched
    // when the caller passes an empty sessionId, so error paths/transitions
    // don't clobber it), releasing a claim back to pending must CLEAR
    // session_id — otherwise a reclaimed item keeps pointing at a session
    // that's about to be torn down. Mirrors reclaimStale()'s single-item form.
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "UPDATE work_queue SET status='pending', session_id='', heartbeat_at=0,"
        " updated=? WHERE id=?"));
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

} // namespace jarvis
