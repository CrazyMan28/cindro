#include "jarvis/MemoryStore.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QRandomGenerator>
#include <QSqlError>
#include <QSqlQuery>
#include <QVariant>

namespace jarvis {

namespace {

QString genMemoryId()
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(12, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("mem_") + QString::fromLatin1(bytes.toHex());
}

QString tagsToStorage(const QStringList &tags)
{
    QStringList cleaned;
    for (const QString &t : tags) {
        const QString s = t.trimmed();
        if (!s.isEmpty())
            cleaned << s;
    }
    return cleaned.join(QLatin1Char(' '));
}

QStringList tagsFromStorage(const QString &s)
{
    QStringList out;
    for (const QString &t : s.split(QLatin1Char(' '), Qt::SkipEmptyParts))
        out << t;
    return out;
}

// Build a safe FTS5 MATCH query from arbitrary user text: split into word
// tokens, drop FTS special chars, OR them together as prefix terms. Empty when
// the text has no usable tokens (caller then falls back to a recency/LIKE path).
QString toFtsQuery(const QString &raw)
{
    QStringList terms;
    QString cur;
    for (const QChar &ch : raw) {
        if (ch.isLetterOrNumber()) {
            cur.append(ch.toLower());
        } else {
            if (cur.size() >= 2)
                terms << cur + QStringLiteral("*");
            cur.clear();
        }
    }
    if (cur.size() >= 2)
        terms << cur + QStringLiteral("*");
    return terms.join(QStringLiteral(" OR "));
}

} // namespace

QJsonObject MemoryRow::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("text"), text);
    QJsonArray t;
    for (const QString &tag : tags)
        t.append(tag);
    o.insert(QStringLiteral("tags"), t);
    o.insert(QStringLiteral("created"), created);
    o.insert(QStringLiteral("updated"), updated);
    if (score != 0.0)
        o.insert(QStringLiteral("score"), score);
    return o;
}

MemoryStore::~MemoryStore()
{
    close();
}

QString MemoryStore::defaultDbPath()
{
    return QDir::homePath() + QStringLiteral("/.local/share/jarvis/jarvis.db");
}

bool MemoryStore::open(const QString &dbPath, const QString &connectionName)
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

bool MemoryStore::isOpen() const
{
    return m_db.isValid() && m_db.isOpen();
}

void MemoryStore::close()
{
    if (m_db.isOpen())
        m_db.close();
    m_db = QSqlDatabase();
    if (!m_connectionName.isEmpty() && QSqlDatabase::contains(m_connectionName)) {
        QSqlDatabase::removeDatabase(m_connectionName);
        m_connectionName.clear();
    }
}

bool MemoryStore::exec(const QString &sql, QString *err)
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

bool MemoryStore::migrate()
{
    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS memories ("
            " id TEXT PRIMARY KEY,"
            " text TEXT NOT NULL,"
            " tags TEXT,"
            " created INTEGER,"
            " updated INTEGER)")))
        return false;

    // FTS5 virtual table mirroring text+tags. We keep it in sync manually (no
    // external-content table) so the schema is robust across FTS5 builds.
    if (!exec(QStringLiteral(
            "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts"
            " USING fts5(id UNINDEXED, text, tags)"))) {
        // FTS5 missing is a hard failure for this provider — surface it.
        return false;
    }
    return true;
}

QString MemoryStore::add(const QString &text, const QStringList &tags, const QString &id)
{
    if (text.trimmed().isEmpty()) {
        m_lastError = QStringLiteral("memory text is empty");
        return QString();
    }
    const QString memId = id.isEmpty() ? genMemoryId() : id;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const QString tagStr = tagsToStorage(tags);

    // Upsert into memories.
    {
        QSqlQuery q(m_db);
        q.prepare(QStringLiteral(
            "INSERT INTO memories (id,text,tags,created,updated) VALUES (?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET text=excluded.text, tags=excluded.tags,"
            " updated=excluded.updated"));
        q.addBindValue(memId);
        q.addBindValue(text);
        q.addBindValue(tagStr);
        q.addBindValue(now);
        q.addBindValue(now);
        if (!q.exec()) {
            m_lastError = q.lastError().text();
            return QString();
        }
    }
    // Keep FTS in sync: delete any prior row then insert fresh.
    {
        QSqlQuery del(m_db);
        del.prepare(QStringLiteral("DELETE FROM memories_fts WHERE id=?"));
        del.addBindValue(memId);
        del.exec();
        QSqlQuery ins(m_db);
        ins.prepare(QStringLiteral(
            "INSERT INTO memories_fts (id,text,tags) VALUES (?,?,?)"));
        ins.addBindValue(memId);
        ins.addBindValue(text);
        ins.addBindValue(tagStr);
        if (!ins.exec()) {
            m_lastError = ins.lastError().text();
            // The base row is already written; report but do not roll back.
        }
    }
    return memId;
}

bool MemoryStore::replace(const QString &id, const QString &text, const QStringList &tags)
{
    if (!get(id)) {
        m_lastError = QStringLiteral("no such memory: ") + id;
        return false;
    }
    return !add(text, tags, id).isEmpty();
}

bool MemoryStore::remove(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM memories WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    const bool removed = q.numRowsAffected() > 0;
    QSqlQuery fts(m_db);
    fts.prepare(QStringLiteral("DELETE FROM memories_fts WHERE id=?"));
    fts.addBindValue(id);
    fts.exec();
    return removed;
}

std::optional<MemoryRow> MemoryStore::get(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,text,tags,created,updated FROM memories WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return std::nullopt;
    }
    if (!q.next())
        return std::nullopt;
    MemoryRow r;
    r.id = q.value(0).toString();
    r.text = q.value(1).toString();
    r.tags = tagsFromStorage(q.value(2).toString());
    r.created = q.value(3).toLongLong();
    r.updated = q.value(4).toLongLong();
    return r;
}

QVector<MemoryRow> MemoryStore::list(int limit)
{
    QVector<MemoryRow> out;
    QSqlQuery q(m_db);
    QString sql = QStringLiteral(
        "SELECT id,text,tags,created,updated FROM memories ORDER BY updated DESC");
    if (limit > 0)
        sql += QStringLiteral(" LIMIT ") + QString::number(limit);
    if (!q.exec(sql)) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        MemoryRow r;
        r.id = q.value(0).toString();
        r.text = q.value(1).toString();
        r.tags = tagsFromStorage(q.value(2).toString());
        r.created = q.value(3).toLongLong();
        r.updated = q.value(4).toLongLong();
        out.push_back(r);
    }
    return out;
}

QVector<MemoryRow> MemoryStore::search(const QString &query, int limit)
{
    QVector<MemoryRow> out;
    if (limit <= 0)
        limit = 20;

    const QString fts = toFtsQuery(query);
    if (!fts.isEmpty()) {
        // FTS5 ranked match: bm25() returns a LOWER-is-better cost; we expose a
        // positive score where higher = more relevant.
        QSqlQuery q(m_db);
        q.prepare(QStringLiteral(
            "SELECT m.id,m.text,m.tags,m.created,m.updated,"
            "       bm25(memories_fts) AS rank"
            " FROM memories_fts f JOIN memories m ON m.id=f.id"
            " WHERE memories_fts MATCH ?"
            " ORDER BY rank ASC LIMIT ?"));
        q.addBindValue(fts);
        q.addBindValue(limit);
        if (q.exec()) {
            while (q.next()) {
                MemoryRow r;
                r.id = q.value(0).toString();
                r.text = q.value(1).toString();
                r.tags = tagsFromStorage(q.value(2).toString());
                r.created = q.value(3).toLongLong();
                r.updated = q.value(4).toLongLong();
                const double rank = q.value(5).toDouble();
                r.score = 1.0 / (1.0 + (rank < 0 ? -rank : rank));
                out.push_back(r);
            }
            if (!out.isEmpty())
                return out;
        } else {
            m_lastError = q.lastError().text();
        }
    }

    // Fallback: LIKE scan over text+tags (covers FTS-tokenless queries and any
    // FTS error). Recency-ordered.
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,text,tags,created,updated FROM memories"
        " WHERE text LIKE ? OR tags LIKE ? ORDER BY updated DESC LIMIT ?"));
    const QString like = QStringLiteral("%") + query.trimmed() + QStringLiteral("%");
    q.addBindValue(like);
    q.addBindValue(like);
    q.addBindValue(limit);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        MemoryRow r;
        r.id = q.value(0).toString();
        r.text = q.value(1).toString();
        r.tags = tagsFromStorage(q.value(2).toString());
        r.created = q.value(3).toLongLong();
        r.updated = q.value(4).toLongLong();
        r.score = 0.5; // unranked match
        out.push_back(r);
    }
    return out;
}

QVector<MemoryRow> MemoryStore::prefetch(const QString &query, int k)
{
    if (k <= 0)
        k = 6;
    if (query.trimmed().isEmpty())
        return list(k);
    QVector<MemoryRow> hits = search(query, k);
    if (hits.isEmpty())
        hits = list(k); // no relevant match — still give recent context
    return hits;
}

QString MemoryStore::renderPromptBlock(const QVector<MemoryRow> &memories)
{
    if (memories.isEmpty())
        return QString();
    QString block = QStringLiteral(
        "## Relevant memory (Jarvis long-term memory)\n"
        "These are facts you have previously saved. Use them if relevant; do not "
        "repeat them verbatim unless asked.\n");
    for (const MemoryRow &m : memories) {
        block += QStringLiteral("- ") + m.text;
        if (!m.tags.isEmpty())
            block += QStringLiteral("  [") + m.tags.join(QLatin1Char(',')) + QStringLiteral("]");
        block += QLatin1Char('\n');
    }
    return block;
}

} // namespace jarvis
