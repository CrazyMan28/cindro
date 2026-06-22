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

    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS mcp_servers ("
            " id TEXT PRIMARY KEY,"
            " name TEXT,"
            " transport TEXT,"
            " endpoint TEXT,"
            " token TEXT,"
            " enabled INTEGER,"
            " builtin INTEGER,"
            " risk TEXT,"
            " created INTEGER)")))
        return false;

    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS plugins ("
            " id TEXT PRIMARY KEY,"
            " installed INTEGER,"
            " enabled INTEGER,"
            " updated INTEGER)")))
        return false;

    // Seed the built-in computer-use MCP server exactly once (idempotent).
    {
        QSqlQuery q(m_db);
        q.prepare(QStringLiteral("SELECT COUNT(*) FROM mcp_servers WHERE id=?"));
        q.addBindValue(QStringLiteral("computer-use"));
        bool present = false;
        if (q.exec() && q.next())
            present = q.value(0).toInt() > 0;
        if (!present) {
            QSqlQuery ins(m_db);
            ins.prepare(QStringLiteral(
                "INSERT INTO mcp_servers"
                " (id,name,transport,endpoint,token,enabled,builtin,risk,created)"
                " VALUES (?,?,?,?,?,?,?,?,?)"));
            ins.addBindValue(QStringLiteral("computer-use"));
            ins.addBindValue(QStringLiteral("Computer Use"));
            ins.addBindValue(QStringLiteral("http"));
            ins.addBindValue(QStringLiteral("http://100.114.201.41:8794/mcp"));
            ins.addBindValue(QString());
            ins.addBindValue(1);
            ins.addBindValue(1);
            ins.addBindValue(QStringLiteral("high"));
            ins.addBindValue(QDateTime::currentMSecsSinceEpoch());
            ins.exec();
        }
    }

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

// --- MCP servers -----------------------------------------------------------

QJsonObject McpServerRow::toJson() const
{
    // NOTE: token is intentionally never serialized. `connected`/`tools_count`
    // are live probe results filled in by the caller (mcp.test), defaulted here.
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("transport"), transport);
    o.insert(QStringLiteral("endpoint"), endpoint);
    o.insert(QStringLiteral("enabled"), enabled);
    o.insert(QStringLiteral("builtin"), builtin);
    o.insert(QStringLiteral("connected"), false);
    o.insert(QStringLiteral("tools_count"), 0);
    o.insert(QStringLiteral("has_token"), !token.isEmpty());
    o.insert(QStringLiteral("risk"), risk);
    return o;
}

static McpServerRow readMcpRow(QSqlQuery &q)
{
    McpServerRow r;
    r.id = q.value(0).toString();
    r.name = q.value(1).toString();
    r.transport = q.value(2).toString();
    r.endpoint = q.value(3).toString();
    r.token = q.value(4).toString();
    r.enabled = q.value(5).toInt() != 0;
    r.builtin = q.value(6).toInt() != 0;
    r.risk = q.value(7).toString();
    r.created = q.value(8).toLongLong();
    return r;
}

QVector<McpServerRow> SessionStore::listMcpServers()
{
    QVector<McpServerRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT id,name,transport,endpoint,token,enabled,builtin,risk,created"
            " FROM mcp_servers ORDER BY builtin DESC, created ASC"))) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next())
        out.push_back(readMcpRow(q));
    return out;
}

std::optional<McpServerRow> SessionStore::getMcpServer(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,name,transport,endpoint,token,enabled,builtin,risk,created"
        " FROM mcp_servers WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;
    return readMcpRow(q);
}

bool SessionStore::addMcpServer(const McpServerRow &row)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT OR REPLACE INTO mcp_servers"
        " (id,name,transport,endpoint,token,enabled,builtin,risk,created)"
        " VALUES (?,?,?,?,?,?,?,?,?)"));
    q.addBindValue(row.id);
    q.addBindValue(row.name);
    q.addBindValue(row.transport);
    q.addBindValue(row.endpoint);
    q.addBindValue(row.token);
    q.addBindValue(row.enabled ? 1 : 0);
    q.addBindValue(row.builtin ? 1 : 0);
    q.addBindValue(row.risk);
    q.addBindValue(row.created != 0 ? row.created
                                    : QDateTime::currentMSecsSinceEpoch());
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

bool SessionStore::removeMcpServer(const QString &id)
{
    // Built-in servers (computer-use) are protected from removal.
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM mcp_servers WHERE id=? AND builtin=0"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool SessionStore::setMcpEnabled(const QString &id, bool enabled)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("UPDATE mcp_servers SET enabled=? WHERE id=?"));
    q.addBindValue(enabled ? 1 : 0);
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

// --- plugins ---------------------------------------------------------------

static PluginRow readPluginRow(QSqlQuery &q)
{
    PluginRow r;
    r.id = q.value(0).toString();
    r.installed = q.value(1).toInt() != 0;
    r.enabled = q.value(2).toInt() != 0;
    r.updated = q.value(3).toLongLong();
    return r;
}

QVector<PluginRow> SessionStore::listPlugins()
{
    QVector<PluginRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT id,installed,enabled,updated FROM plugins"))) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next())
        out.push_back(readPluginRow(q));
    return out;
}

std::optional<PluginRow> SessionStore::getPlugin(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,installed,enabled,updated FROM plugins WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;
    return readPluginRow(q);
}

bool SessionStore::upsertPlugin(const PluginRow &row)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT OR REPLACE INTO plugins (id,installed,enabled,updated)"
        " VALUES (?,?,?,?)"));
    q.addBindValue(row.id);
    q.addBindValue(row.installed ? 1 : 0);
    q.addBindValue(row.enabled ? 1 : 0);
    q.addBindValue(row.updated != 0 ? row.updated
                                    : QDateTime::currentMSecsSinceEpoch());
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

bool SessionStore::removePlugin(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM plugins WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

} // namespace jarvis
