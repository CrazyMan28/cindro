#include "jarvis/SessionStore.h"
#include "jarvis/DataPaths.h"
#include "jarvis/FtsQuery.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSqlError>
#include <QSqlQuery>
#include <QVariant>

namespace jarvis {

namespace {

// Cap the text indexed per event so a huge tool output (file dump, screenshot
// OCR) can't bloat the FTS table; the full event JSON stays in events.json.
constexpr int kFtsBodyMaxChars = 8192;

// Extract the searchable plaintext of an event. Only kinds that carry human-
// meaningful text are indexed: messages, thinking, and tool results (tool name
// + output). Everything else (tool_call args, usage, state) is noise.
QString eventFtsBody(const NormalizedBrainEvent &ev)
{
    using Kind = NormalizedBrainEvent::Kind;
    QString body;
    switch (ev.kind) {
    case Kind::Message:
    case Kind::Thinking:
        body = ev.fields.value(QStringLiteral("text")).toString();
        break;
    case Kind::ToolResult:
        body = ev.fields.value(QStringLiteral("name")).toString()
             + QLatin1Char(' ')
             + ev.fields.value(QStringLiteral("output")).toString();
        break;
    default:
        return {};
    }
    body = body.trimmed();
    if (body.size() > kFtsBodyMaxChars)
        body.truncate(kFtsBodyMaxChars);
    return body;
}

} // namespace

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
    obj.insert(QStringLiteral("goals"), goals);
    obj.insert(QStringLiteral("continuation_count"), continuationCount);
    obj.insert(QStringLiteral("target_ref"), targetRef);
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
    // BUILD_SPEC pins ~/.local/share/jarvis/jarvis.db (JARVIS_DATA_DIR overrides).
    return dataDir() + QStringLiteral("/jarvis.db");
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
    // Persistent goals / auto-continuation (jarvis#76 item 9) — additive, same
    // ignore-duplicate-column pattern as above.
    exec(QStringLiteral("ALTER TABLE sessions ADD COLUMN goals TEXT DEFAULT ''"));
    exec(QStringLiteral("ALTER TABLE sessions ADD COLUMN continuation_count INTEGER DEFAULT 0"));
    // Proxmox workload manager: a session fired by a schedule inherits that
    // schedule's targetRef (e.g. "proxmox-<hostname>") so makeBrain() can route
    // the api brain at the right remote MCP endpoint. Same ignore-duplicate-
    // column pattern as the migrations above.
    exec(QStringLiteral("ALTER TABLE sessions ADD COLUMN target_ref TEXT DEFAULT ''"));

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

    // Cross-session full-text search (jarvis#76 item 1): FTS5 mirror of the
    // searchable text of each event, kept in sync manually like memories_fts.
    // Soft-fail: if FTS5 is unavailable searchEvents() degrades to LIKE.
    if (exec(QStringLiteral(
            "CREATE VIRTUAL TABLE IF NOT EXISTS events_fts"
            " USING fts5(session_id UNINDEXED, seq UNINDEXED, body)"))) {
        backfillEventsFts();
    }

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
            ins.addBindValue(QStringLiteral("http://127.0.0.1:8794/mcp"));
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
        " (id,title,profile,brain,model,thread_id,state,parent_session_id,agent,"
        "  goals,continuation_count,target_ref,created,updated)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"));
    q.addBindValue(row.id);
    q.addBindValue(row.title);
    q.addBindValue(row.profile);
    q.addBindValue(row.brain);
    q.addBindValue(row.model);
    q.addBindValue(row.threadId);
    q.addBindValue(row.state);
    q.addBindValue(row.parentSessionId);
    q.addBindValue(row.agent);
    q.addBindValue(row.goals);
    q.addBindValue(row.continuationCount);
    q.addBindValue(row.targetRef);
    q.addBindValue(row.created != 0 ? row.created : now);
    q.addBindValue(row.updated != 0 ? row.updated : now);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

namespace {
constexpr const char *kSessionCols =
    "id,title,profile,brain,model,thread_id,state,parent_session_id,agent,"
    "goals,continuation_count,target_ref,created,updated";

SessionRow sessionRowFromQuery(const QSqlQuery &q)
{
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
    row.goals = q.value(9).toString();
    row.continuationCount = q.value(10).toInt();
    row.targetRef = q.value(11).toString();
    row.created = q.value(12).toLongLong();
    row.updated = q.value(13).toLongLong();
    return row;
}
} // namespace

std::optional<SessionRow> SessionStore::get(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("SELECT %1 FROM sessions WHERE id=?")
                  .arg(QLatin1String(kSessionCols)));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;
    return sessionRowFromQuery(q);
}

QVector<SessionRow> SessionStore::list()
{
    QVector<SessionRow> out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral("SELECT %1 FROM sessions ORDER BY created DESC")
                    .arg(QLatin1String(kSessionCols)))) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next())
        out.push_back(sessionRowFromQuery(q));
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

bool SessionStore::setGoals(const QString &id, const QString &goals)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("UPDATE sessions SET goals=?, updated=? WHERE id=?"));
    q.addBindValue(goals);
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

bool SessionStore::setContinuationCount(const QString &id, int count)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("UPDATE sessions SET continuation_count=? WHERE id=?"));
    q.addBindValue(count);
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

    // FTS mirror rows go first so the index can't outlive the base rows.
    {
        QSqlQuery delFts(m_db);
        delFts.prepare(QStringLiteral("DELETE FROM events_fts WHERE session_id=?"));
        delFts.addBindValue(id);
        delFts.exec(); // soft: absent events_fts (no FTS5) must not block delete
    }

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

    // Keep the FTS mirror in sync. Unlike memories_fts (upserts by id), seq
    // was freshly allocated above so no prior FTS row can exist — a plain
    // INSERT is enough, and this is the hot per-brain-event path.
    const QString body = eventFtsBody(ev);
    if (!body.isEmpty()) {
        QSqlQuery ins(m_db);
        ins.prepare(QStringLiteral(
            "INSERT INTO events_fts (session_id,seq,body) VALUES (?,?,?)"));
        ins.addBindValue(sessionId);
        ins.addBindValue(seq);
        ins.addBindValue(body);
        ins.exec(); // soft: base row already written; search just won't see it
    }
    return seq;
}

void SessionStore::backfillEventsFts()
{
    // Only when the mirror is empty but events exist (fresh index on an old DB).
    {
        QSqlQuery cnt(m_db);
        if (!cnt.exec(QStringLiteral("SELECT COUNT(*) FROM events_fts")) || !cnt.next()
            || cnt.value(0).toLongLong() > 0)
            return;
    }
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral("SELECT session_id,seq,json FROM events")))
        return;
    m_db.transaction();
    QSqlQuery ins(m_db);
    ins.prepare(QStringLiteral(
        "INSERT INTO events_fts (session_id,seq,body) VALUES (?,?,?)"));
    while (q.next()) {
        const auto obj = QJsonDocument::fromJson(q.value(2).toString().toUtf8()).object();
        const auto ev = NormalizedBrainEvent::fromJson(obj);
        if (!ev)
            continue;
        const QString body = eventFtsBody(*ev);
        if (body.isEmpty())
            continue;
        ins.addBindValue(q.value(0).toString());
        ins.addBindValue(q.value(1).toInt());
        ins.addBindValue(body);
        ins.exec();
    }
    m_db.commit();
}

QVector<SessionSearchHit> SessionStore::searchEvents(const QString &query, int limit,
                                                     int contextWindow,
                                                     const QString &sessionId)
{
    QVector<SessionSearchHit> out;
    limit = qBound(1, limit <= 0 ? 20 : limit, 50);
    contextWindow = qBound(0, contextWindow, 5);

    struct RawHit { QString sid; int seq; qint64 ts; QString json; double score; };
    QVector<RawHit> raw;

    const QString fts = toFtsQuery(query);
    if (!fts.isEmpty()) {
        QSqlQuery q(m_db);
        QString sql = QStringLiteral(
            "SELECT e.session_id, e.seq, e.ts, e.json, bm25(events_fts) AS rank"
            " FROM events_fts f JOIN events e"
            "   ON e.session_id=f.session_id AND e.seq=f.seq"
            " WHERE events_fts MATCH ?");
        if (!sessionId.isEmpty())
            sql += QStringLiteral(" AND f.session_id = ?");
        sql += QStringLiteral(" ORDER BY rank ASC LIMIT ?");
        q.prepare(sql);
        q.addBindValue(fts);
        if (!sessionId.isEmpty())
            q.addBindValue(sessionId);
        q.addBindValue(limit);
        if (q.exec()) {
            while (q.next()) {
                // SQLite bm25() is a COST: more negative = better match. Expose
                // "higher = more relevant" by negating (abs() would have ranked
                // the WEAKEST hits highest). Non-negative ranks (degenerate)
                // squash toward zero, below any real match.
                const double rank = q.value(4).toDouble();
                const double score = rank < 0 ? -rank : 1.0 / (1.0 + rank);
                raw.push_back({q.value(0).toString(), q.value(1).toInt(),
                               q.value(2).toLongLong(), q.value(3).toString(),
                               score});
            }
        } else {
            m_lastError = q.lastError().text();
        }
    }

    if (raw.isEmpty()) {
        // Fallback: LIKE scan over raw event JSON (covers FTS-tokenless queries
        // and builds without FTS5). Recency-ordered, unranked.
        QSqlQuery q(m_db);
        QString sql = QStringLiteral(
            "SELECT session_id, seq, ts, json FROM events WHERE json LIKE ?");
        if (!sessionId.isEmpty())
            sql += QStringLiteral(" AND session_id = ?");
        sql += QStringLiteral(" ORDER BY ts DESC LIMIT ?");
        q.prepare(sql);
        q.addBindValue(QStringLiteral("%") + query.trimmed() + QStringLiteral("%"));
        if (!sessionId.isEmpty())
            q.addBindValue(sessionId);
        q.addBindValue(limit);
        if (!q.exec()) {
            m_lastError = q.lastError().text();
            return out;
        }
        while (q.next())
            raw.push_back({q.value(0).toString(), q.value(1).toInt(),
                           q.value(2).toLongLong(), q.value(3).toString(), 0.5});
    }

    // Session titles for hit labelling (one query per distinct session).
    QHash<QString, QString> titles;
    for (const RawHit &h : raw) {
        const auto obj = QJsonDocument::fromJson(h.json.toUtf8()).object();
        const auto ev = NormalizedBrainEvent::fromJson(obj);
        if (!ev)
            continue;
        SessionSearchHit hit;
        hit.sessionId = h.sid;
        hit.seq = h.seq;
        hit.ts = h.ts;
        hit.ev = *ev;
        hit.score = h.score;
        if (!titles.contains(h.sid)) {
            const auto row = get(h.sid);
            titles.insert(h.sid, row ? row->title : QString());
        }
        hit.sessionTitle = titles.value(h.sid);
        if (contextWindow > 0) {
            QSqlQuery c(m_db);
            c.prepare(QStringLiteral(
                "SELECT session_id,seq,json,ts FROM events"
                " WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq ASC"));
            c.addBindValue(h.sid);
            c.addBindValue(h.seq - contextWindow);
            c.addBindValue(h.seq + contextWindow);
            if (c.exec()) {
                while (c.next()) {
                    const auto cobj =
                        QJsonDocument::fromJson(c.value(2).toString().toUtf8()).object();
                    const auto cev = NormalizedBrainEvent::fromJson(cobj);
                    if (!cev)
                        continue;
                    StoredEvent se;
                    se.sessionId = c.value(0).toString();
                    se.seq = c.value(1).toInt();
                    se.ev = *cev;
                    se.ts = c.value(3).toLongLong();
                    hit.context.push_back(se);
                }
            }
        }
        out.push_back(hit);
    }
    return out;
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
