#include "jarvis/AuditLog.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QSqlError>
#include <QSqlQuery>
#include <QVariant>

namespace jarvis {

QJsonObject AuditRow::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("ts"), ts);
    o.insert(QStringLiteral("tool"), tool);
    o.insert(QStringLiteral("ok"), ok);
    o.insert(QStringLiteral("risk"), risk);
    o.insert(QStringLiteral("summary"), summary);
    if (!sessionId.isEmpty())
        o.insert(QStringLiteral("session_id"), sessionId);
    o.insert(QStringLiteral("remote"), remote);
    return o;
}

AuditLog::~AuditLog()
{
    close();
}

QString AuditLog::defaultDbPath()
{
    return QDir::homePath() + QStringLiteral("/.local/share/jarvis/jarvis.db");
}

bool AuditLog::open(const QString &dbPath, const QString &connectionName)
{
    const QString path = dbPath.isEmpty() ? defaultDbPath() : dbPath;

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

bool AuditLog::isOpen() const
{
    return m_db.isValid() && m_db.isOpen();
}

void AuditLog::close()
{
    if (m_db.isOpen())
        m_db.close();
    m_db = QSqlDatabase();
    if (!m_connectionName.isEmpty() && QSqlDatabase::contains(m_connectionName)) {
        QSqlDatabase::removeDatabase(m_connectionName);
        m_connectionName.clear();
    }
}

bool AuditLog::exec(const QString &sql, QString *err)
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

bool AuditLog::migrate()
{
    return exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS audit ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " ts INTEGER NOT NULL,"
        " tool TEXT NOT NULL,"
        " ok INTEGER NOT NULL,"
        " risk TEXT,"
        " summary TEXT,"
        " session_id TEXT,"
        " remote INTEGER NOT NULL DEFAULT 0)"));
}

qint64 AuditLog::record(const QString &tool, bool ok, const QString &risk,
                        const QString &summary, const QString &sessionId, bool remote)
{
    if (!isOpen())
        return -1;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO audit (ts,tool,ok,risk,summary,session_id,remote)"
        " VALUES (?,?,?,?,?,?,?)"));
    q.addBindValue(now);
    q.addBindValue(tool);
    q.addBindValue(ok ? 1 : 0);
    q.addBindValue(risk.isEmpty() ? QStringLiteral("low") : risk);
    q.addBindValue(summary);
    q.addBindValue(sessionId);
    q.addBindValue(remote ? 1 : 0);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return -1;
    }
    return q.lastInsertId().toLongLong();
}

QVector<AuditRow> AuditLog::list(int limit)
{
    QVector<AuditRow> out;
    if (limit <= 0)
        limit = 100;
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,ts,tool,ok,risk,summary,session_id,remote FROM audit"
        " ORDER BY id DESC LIMIT ?"));
    q.addBindValue(limit);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        AuditRow r;
        r.id = q.value(0).toLongLong();
        r.ts = q.value(1).toLongLong();
        r.tool = q.value(2).toString();
        r.ok = q.value(3).toInt() != 0;
        r.risk = q.value(4).toString();
        r.summary = q.value(5).toString();
        r.sessionId = q.value(6).toString();
        r.remote = q.value(7).toInt() != 0;
        out.push_back(r);
    }
    return out;
}

} // namespace jarvis
