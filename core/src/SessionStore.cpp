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
    obj.insert(QStringLiteral("parent_session_id"), parentSessionId);
    obj.insert(QStringLiteral("agent"), agent);
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
    // Subagent support migration: link a child session to its parent + record
    // the custom-agent name it runs as. SQLite has no "ADD COLUMN IF NOT EXISTS";
    // a duplicate-column error on an already-migrated DB is expected and ignored.
    exec(QStringLiteral("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT DEFAULT ''"));
    exec(QStringLiteral("ALTER TABLE sessions ADD COLUMN agent TEXT DEFAULT ''"));

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
    // Google-connectors framework migration: add the brain-injectable env-var
    // map column to an mcp_servers table created before it existed. SQLite has
    // no "ADD COLUMN IF NOT EXISTS"; a duplicate-column error on an already-
    // migrated DB is expected and ignored (like the plugins ALTERs below).
    exec(QStringLiteral("ALTER TABLE mcp_servers ADD COLUMN env TEXT DEFAULT ''"));

    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS plugins ("
            " id TEXT PRIMARY KEY,"
            " installed INTEGER,"
            " enabled INTEGER,"
            " verified INTEGER DEFAULT 0,"
            " granted_perms TEXT DEFAULT '',"
            " updated INTEGER)")))
        return false;
    // Wave 7 migration: add the verification verdict + granted-permissions
    // columns to a plugins table created before they existed. SQLite has no
    // "ADD COLUMN IF NOT EXISTS"; a duplicate-column error on an already-migrated
    // DB is expected and ignored.
    exec(QStringLiteral("ALTER TABLE plugins ADD COLUMN verified INTEGER DEFAULT 0"));
    exec(QStringLiteral("ALTER TABLE plugins ADD COLUMN granted_perms TEXT DEFAULT ''"));

    // Contract C: queued tasks (task.queue / task.list).
    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS tasks ("
            " id TEXT PRIMARY KEY,"
            " device_id TEXT,"
            " text TEXT,"
            " when_at INTEGER,"
            " state TEXT,"
            " session_id TEXT,"
            " created INTEGER,"
            " updated INTEGER)")))
        return false;

    // Contract C: per-device FCM push tokens (push.register).
    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS push_tokens ("
            " device_id TEXT PRIMARY KEY,"
            " fcm_token TEXT,"
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
        " (id,title,profile,brain,model,thread_id,state,parent_session_id,agent,created,updated)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)"));
    q.addBindValue(row.id);
    q.addBindValue(row.title);
    q.addBindValue(row.profile);
    q.addBindValue(row.brain);
    q.addBindValue(row.model);
    q.addBindValue(row.threadId);
    q.addBindValue(row.state);
    q.addBindValue(row.parentSessionId);
    q.addBindValue(row.agent);
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
        "SELECT id,title,profile,brain,model,thread_id,state,parent_session_id,agent,created,updated"
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
    row.parentSessionId = q.value(7).toString();
    row.agent = q.value(8).toString();
    row.created = q.value(9).toLongLong();
    row.updated = q.value(10).toLongLong();
    return row;
}

QVector<SessionRow> SessionStore::list()
{
    QVector<SessionRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT id,title,profile,brain,model,thread_id,state,parent_session_id,agent,created,updated"
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
        row.parentSessionId = q.value(7).toString();
        row.agent = q.value(8).toString();
        row.created = q.value(9).toLongLong();
        row.updated = q.value(10).toLongLong();
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

bool SessionStore::updateTitle(const QString &id, const QString &title)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("UPDATE sessions SET title=?, updated=? WHERE id=?"));
    q.addBindValue(title);
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

bool SessionStore::deleteSession(const QString &id)
{
    // Remove the session row and its event stream. Done in a transaction so a
    // crash can't leave orphaned events behind.
    m_db.transaction();

    QSqlQuery delEvents(m_db);
    delEvents.prepare(QStringLiteral("DELETE FROM events WHERE session_id=?"));
    delEvents.addBindValue(id);
    if (!delEvents.exec()) {
        m_lastError = delEvents.lastError().text();
        m_db.rollback();
        return false;
    }

    QSqlQuery delSession(m_db);
    delSession.prepare(QStringLiteral("DELETE FROM sessions WHERE id=?"));
    delSession.addBindValue(id);
    if (!delSession.exec()) {
        m_lastError = delSession.lastError().text();
        m_db.rollback();
        return false;
    }

    if (!m_db.commit()) {
        m_lastError = m_db.lastError().text();
        m_db.rollback();
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
    // NOTE: token AND env are intentionally never serialized (env may reference
    // secrets). `connected`/`tools_count` are live probe results filled in by the
    // caller (mcp.test), defaulted here.
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
    const QString envJson = q.value(9).toString();
    if (!envJson.isEmpty()) {
        const QJsonDocument d = QJsonDocument::fromJson(envJson.toUtf8());
        if (d.isObject())
            r.env = d.object();
    }
    return r;
}

QVector<McpServerRow> SessionStore::listMcpServers()
{
    QVector<McpServerRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT id,name,transport,endpoint,token,enabled,builtin,risk,created,env"
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
        "SELECT id,name,transport,endpoint,token,enabled,builtin,risk,created,env"
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
        " (id,name,transport,endpoint,token,enabled,builtin,risk,created,env)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)"));
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
    q.addBindValue(row.env.isEmpty()
                       ? QString()
                       : QString::fromUtf8(QJsonDocument(row.env)
                                               .toJson(QJsonDocument::Compact)));
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
    r.verified = q.value(3).toInt() != 0;
    const QString perms = q.value(4).toString();
    if (!perms.isEmpty())
        r.grantedPermissions = perms.split(QLatin1Char(','), Qt::SkipEmptyParts);
    r.updated = q.value(5).toLongLong();
    return r;
}

QVector<PluginRow> SessionStore::listPlugins()
{
    QVector<PluginRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT id,installed,enabled,verified,granted_perms,updated FROM plugins"))) {
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
        "SELECT id,installed,enabled,verified,granted_perms,updated"
        " FROM plugins WHERE id=?"));
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
        "INSERT OR REPLACE INTO plugins"
        " (id,installed,enabled,verified,granted_perms,updated)"
        " VALUES (?,?,?,?,?,?)"));
    q.addBindValue(row.id);
    q.addBindValue(row.installed ? 1 : 0);
    q.addBindValue(row.enabled ? 1 : 0);
    q.addBindValue(row.verified ? 1 : 0);
    q.addBindValue(row.grantedPermissions.join(QLatin1Char(',')));
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

// --- tasks ------------------------------------------------------------------

QJsonObject TaskRow::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("device_id"), deviceId);
    o.insert(QStringLiteral("text"), text);
    o.insert(QStringLiteral("when"), whenAt);
    o.insert(QStringLiteral("state"), state);
    o.insert(QStringLiteral("session_id"), sessionId);
    o.insert(QStringLiteral("created"), created);
    o.insert(QStringLiteral("updated"), updated);
    return o;
}

static TaskRow readTaskRow(QSqlQuery &q)
{
    TaskRow r;
    r.id = q.value(0).toString();
    r.deviceId = q.value(1).toString();
    r.text = q.value(2).toString();
    r.whenAt = q.value(3).toLongLong();
    r.state = q.value(4).toString();
    r.sessionId = q.value(5).toString();
    r.created = q.value(6).toLongLong();
    r.updated = q.value(7).toLongLong();
    return r;
}

bool SessionStore::createTask(const TaskRow &row)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO tasks"
        " (id,device_id,text,when_at,state,session_id,created,updated)"
        " VALUES (?,?,?,?,?,?,?,?)"));
    q.addBindValue(row.id);
    q.addBindValue(row.deviceId);
    q.addBindValue(row.text);
    q.addBindValue(row.whenAt);
    q.addBindValue(row.state.isEmpty() ? QStringLiteral("queued") : row.state);
    q.addBindValue(row.sessionId);
    q.addBindValue(row.created != 0 ? row.created : now);
    q.addBindValue(row.updated != 0 ? row.updated : now);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

QVector<TaskRow> SessionStore::listTasks(const QString &deviceId)
{
    QVector<TaskRow> out;
    QSqlQuery q(m_db);
    if (deviceId.isEmpty()) {
        q.prepare(QStringLiteral(
            "SELECT id,device_id,text,when_at,state,session_id,created,updated"
            " FROM tasks ORDER BY created DESC"));
    } else {
        q.prepare(QStringLiteral(
            "SELECT id,device_id,text,when_at,state,session_id,created,updated"
            " FROM tasks WHERE device_id=? ORDER BY created DESC"));
        q.addBindValue(deviceId);
    }
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next())
        out.push_back(readTaskRow(q));
    return out;
}

std::optional<TaskRow> SessionStore::getTask(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,device_id,text,when_at,state,session_id,created,updated"
        " FROM tasks WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;
    return readTaskRow(q);
}

bool SessionStore::updateTaskState(const QString &id, const QString &state,
                                   const QString &sessionId)
{
    QSqlQuery q(m_db);
    if (sessionId.isEmpty()) {
        q.prepare(QStringLiteral("UPDATE tasks SET state=?, updated=? WHERE id=?"));
        q.addBindValue(state);
        q.addBindValue(QDateTime::currentMSecsSinceEpoch());
        q.addBindValue(id);
    } else {
        q.prepare(QStringLiteral(
            "UPDATE tasks SET state=?, session_id=?, updated=? WHERE id=?"));
        q.addBindValue(state);
        q.addBindValue(sessionId);
        q.addBindValue(QDateTime::currentMSecsSinceEpoch());
        q.addBindValue(id);
    }
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

// --- push tokens ------------------------------------------------------------

bool SessionStore::upsertPushToken(const PushTokenRow &row)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT OR REPLACE INTO push_tokens (device_id,fcm_token,updated)"
        " VALUES (?,?,?)"));
    q.addBindValue(row.deviceId);
    q.addBindValue(row.fcmToken);
    q.addBindValue(row.updated != 0 ? row.updated
                                    : QDateTime::currentMSecsSinceEpoch());
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

QVector<PushTokenRow> SessionStore::listPushTokens()
{
    QVector<PushTokenRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT device_id,fcm_token,updated FROM push_tokens"))) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        PushTokenRow r;
        r.deviceId = q.value(0).toString();
        r.fcmToken = q.value(1).toString();
        r.updated = q.value(2).toLongLong();
        out.push_back(r);
    }
    return out;
}

bool SessionStore::removePushToken(const QString &deviceId)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM push_tokens WHERE device_id=?"));
    q.addBindValue(deviceId);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

} // namespace jarvis
