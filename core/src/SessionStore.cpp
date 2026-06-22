#include "jarvis/SessionStore.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSqlError>
#include <QSqlQuery>
#include <QVariant>

namespace jarvis {

QJsonObject SessionRow::toJson() const
{
    QJsonObject obj;
    obj.insert(QStringLiteral("id"), id);
    obj.insert(QStringLiteral("title"), title);
    obj.insert(QStringLiteral("profile"), profile);
    obj.insert(QStringLiteral("brain"), brain);
    obj.insert(QStringLiteral("model"), model);
    obj.insert(QStringLiteral("thread_id"), threadId);
    obj.insert(QStringLiteral("state"), state);
    obj.insert(QStringLiteral("created"), created);
    obj.insert(QStringLiteral("updated"), updated);
    return obj;
}

SessionStore::~SessionStore()
{
    close();
}

QString SessionStore::defaultDbPath()
{
    // BUILD_SPEC pins ~/.local/share/jarvis/jarvis.db.
    return QDir::homePath() + QStringLiteral("/.local/share/jarvis/jarvis.db");
}

bool SessionStore::open(const QString &dbPath, const QString &connectionName)
{
    const QString path = dbPath.isEmpty() ? defaultDbPath() : dbPath;

    // Ensure the parent directory exists.
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

    // Pragmas for durability + concurrent readers.
    exec(QStringLiteral("PRAGMA journal_mode=WAL"));
    exec(QStringLiteral("PRAGMA foreign_keys=ON"));

    return migrate();
}

bool SessionStore::isOpen() const
{
    return m_db.isValid() && m_db.isOpen();
}

void SessionStore::close()
{
    if (m_db.isOpen())
        m_db.close();
    m_db = QSqlDatabase();
    if (!m_connectionName.isEmpty() && QSqlDatabase::contains(m_connectionName)) {
        QSqlDatabase::removeDatabase(m_connectionName);
        m_connectionName.clear();
    }
}

bool SessionStore::exec(const QString &sql, QString *err)
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

bool SessionStore::migrate()
{
    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS sessions ("
            " id TEXT PRIMARY KEY,"
            " title TEXT,"
            " profile TEXT,"
            " brain TEXT,"
            " model TEXT,"
            " thread_id TEXT,"
            " state TEXT,"
            " created INTEGER,"
            " updated INTEGER)")))
        return false;

    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS events ("
            " session_id TEXT,"
            " seq INTEGER,"
            " json TEXT,"
            " ts INTEGER,"
            " PRIMARY KEY(session_id, seq))")))
        return false;

    exec(QStringLiteral(
        "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)"));
    return true;
}

bool SessionStore::create(const SessionRow &row)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO sessions"
        " (id,title,profile,brain,model,thread_id,state,created,updated)"
        " VALUES (?,?,?,?,?,?,?,?,?)"));
    q.addBindValue(row.id);
    q.addBindValue(row.title);
    q.addBindValue(row.profile);
    q.addBindValue(row.brain);
    q.addBindValue(row.model);
    q.addBindValue(row.threadId);
    q.addBindValue(row.state);
    q.addBindValue(row.created != 0 ? row.created : now);
    q.addBindValue(row.updated != 0 ? row.updated : now);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

std::optional<SessionRow> SessionStore::get(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,title,profile,brain,model,thread_id,state,created,updated"
        " FROM sessions WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;

    SessionRow row;
    row.id = q.value(0).toString();
    row.title = q.value(1).toString();
    row.profile = q.value(2).toString();
    row.brain = q.value(3).toString();
    row.model = q.value(4).toString();
    row.threadId = q.value(5).toString();
    row.state = q.value(6).toString();
    row.created = q.value(7).toLongLong();
    row.updated = q.value(8).toLongLong();
    return row;
}

QVector<SessionRow> SessionStore::list()
{
    QVector<SessionRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT id,title,profile,brain,model,thread_id,state,created,updated"
            " FROM sessions ORDER BY created DESC"))) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        SessionRow row;
        row.id = q.value(0).toString();
        row.title = q.value(1).toString();
        row.profile = q.value(2).toString();
        row.brain = q.value(3).toString();
        row.model = q.value(4).toString();
        row.threadId = q.value(5).toString();
        row.state = q.value(6).toString();
        row.created = q.value(7).toLongLong();
        row.updated = q.value(8).toLongLong();
        out.push_back(row);
    }
    return out;
}

bool SessionStore::updateState(const QString &id, const QString &state)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("UPDATE sessions SET state=?, updated=? WHERE id=?"));
    q.addBindValue(state);
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

bool SessionStore::updateThreadId(const QString &id, const QString &threadId)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("UPDATE sessions SET thread_id=?, updated=? WHERE id=?"));
    q.addBindValue(threadId);
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

int SessionStore::appendEvent(const QString &sessionId, const NormalizedBrainEvent &ev)
{
    // Compute next seq for this session.
    int seq = 0;
    {
        QSqlQuery q(m_db);
        q.prepare(QStringLiteral(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM events WHERE session_id=?"));
        q.addBindValue(sessionId);
        if (!q.exec()) {
            m_lastError = q.lastError().text();
            return -1;
        }
        if (q.next())
            seq = q.value(0).toInt();
    }

    const QByteArray json =
        QJsonDocument(ev.toJson()).toJson(QJsonDocument::Compact);

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO events (session_id,seq,json,ts) VALUES (?,?,?,?)"));
    q.addBindValue(sessionId);
    q.addBindValue(seq);
    q.addBindValue(QString::fromUtf8(json));
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return -1;
    }
    return seq;
}

QVector<StoredEvent> SessionStore::listEvents(const QString &sessionId, int limit)
{
    QVector<StoredEvent> out;
    QSqlQuery q(m_db);
    if (limit > 0) {
        // Take the most recent `limit` events, returned in ascending order.
        q.prepare(QStringLiteral(
            "SELECT session_id,seq,json,ts FROM events WHERE session_id=?"
            " ORDER BY seq DESC LIMIT ?"));
        q.addBindValue(sessionId);
        q.addBindValue(limit);
    } else {
        q.prepare(QStringLiteral(
            "SELECT session_id,seq,json,ts FROM events WHERE session_id=?"
            " ORDER BY seq ASC"));
        q.addBindValue(sessionId);
    }
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        StoredEvent se;
        se.sessionId = q.value(0).toString();
        se.seq = q.value(1).toInt();
        const QByteArray json = q.value(2).toString().toUtf8();
        const QJsonObject obj = QJsonDocument::fromJson(json).object();
        if (auto ev = NormalizedBrainEvent::fromJson(obj))
            se.ev = *ev;
        se.ts = q.value(3).toLongLong();
        out.push_back(se);
    }
    if (limit > 0) {
        // We selected DESC for the limit; restore ascending order.
        std::reverse(out.begin(), out.end());
    }
    return out;
}

} // namespace jarvis
