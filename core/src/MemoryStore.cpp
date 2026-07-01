#include "jarvis/MemoryStore.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSet>
#include <QSqlError>
#include <QSqlQuery>
#include <QVariant>

namespace jarvis {

namespace {

QString genRandomId(const QString &prefix)
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(12, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return prefix + QString::fromLatin1(bytes.toHex());
}

QString genMemoryId() { return genRandomId(QStringLiteral("mem_")); }
QString genEntityId() { return genRandomId(QStringLiteral("ent_")); }
QString genLinkId() { return genRandomId(QStringLiteral("lnk_")); }

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

QJsonObject EntityRow::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("kind"), QStringLiteral("entity"));
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("type"), type);
    o.insert(QStringLiteral("scope"), scope);
    if (!projectRef.isEmpty())
        o.insert(QStringLiteral("projectRef"), projectRef);
    o.insert(QStringLiteral("created"), created);
    o.insert(QStringLiteral("updated"), updated);
    return o;
}

QJsonObject MemoryLink::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("from"), fromId);
    o.insert(QStringLiteral("fromType"), fromType);
    o.insert(QStringLiteral("to"), toId);
    o.insert(QStringLiteral("toType"), toType);
    o.insert(QStringLiteral("relation"), relation);
    o.insert(QStringLiteral("created"), created);
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
    if (!migrate())
        return false;
    // One-time-per-memory backfill: memories written before the knowledge
    // graph existed (or by an older binary) never went through add()'s
    // auto-extraction. Best-effort — a store that opens but can't backfill
    // still functions as a plain memory store.
    backfillEntityExtraction();
    return true;
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

    // Knowledge graph (jarvis#70 phase 1): entities auto-extracted from memory
    // text/tags, and directed links between graph nodes (memory or entity
    // ids, distinguished by id prefix). Additive — the tables above are
    // untouched, so existing callers (Android, desktop) see no change.
    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS entities ("
            " id TEXT PRIMARY KEY,"
            " name TEXT NOT NULL,"
            " type TEXT NOT NULL DEFAULT 'misc',"
            " scope TEXT NOT NULL DEFAULT 'global',"
            " project_ref TEXT,"
            " created INTEGER,"
            " updated INTEGER)")))
        return false;
    if (!exec(QStringLiteral(
            "CREATE UNIQUE INDEX IF NOT EXISTS entities_name_type_idx"
            " ON entities(name COLLATE NOCASE, type)")))
        return false;
    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS memory_links ("
            " id TEXT PRIMARY KEY,"
            " from_id TEXT NOT NULL,"
            " from_type TEXT NOT NULL,"
            " to_id TEXT NOT NULL,"
            " to_type TEXT NOT NULL,"
            " relation TEXT NOT NULL DEFAULT 'relates_to',"
            " created INTEGER)")))
        return false;
    if (!exec(QStringLiteral(
            "CREATE UNIQUE INDEX IF NOT EXISTS memory_links_edge_idx"
            " ON memory_links(from_id, to_id, relation)")))
        return false;
    if (!exec(QStringLiteral(
            "CREATE INDEX IF NOT EXISTS memory_links_to_idx ON memory_links(to_id)")))
        return false;

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
    autoExtractEntities(memId, text, tags);
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

// --- Knowledge graph (entities + links) -------------------------------

QString MemoryStore::upsertEntity(const QString &name, const QString &type,
                                  const QString &scope, const QString &projectRef)
{
    const QString n = name.trimmed();
    if (n.isEmpty())
        return QString();
    const QString ty = type.isEmpty() ? QStringLiteral("misc") : type;
    const QString sc = scope.isEmpty() ? QStringLiteral("global") : scope;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();

    // Look up an existing entity by case-insensitive name+type first, since
    // the upsert must only ever ADVANCE scope global->project, never demote
    // an already project-scoped entity back to global.
    QSqlQuery sel(m_db);
    sel.prepare(QStringLiteral(
        "SELECT id, scope FROM entities WHERE name = ? COLLATE NOCASE AND type = ?"));
    sel.addBindValue(n);
    sel.addBindValue(ty);
    if (sel.exec() && sel.next()) {
        const QString id = sel.value(0).toString();
        const QString existingScope = sel.value(1).toString();
        QSqlQuery upd(m_db);
        if (sc == QStringLiteral("project") && !projectRef.isEmpty()) {
            upd.prepare(QStringLiteral(
                "UPDATE entities SET scope=?, project_ref=?, updated=? WHERE id=?"));
            upd.addBindValue(sc);
            upd.addBindValue(projectRef);
        } else {
            upd.prepare(QStringLiteral(
                "UPDATE entities SET scope=?, updated=? WHERE id=?"));
            upd.addBindValue(existingScope);
        }
        upd.addBindValue(now);
        upd.addBindValue(id);
        upd.exec();
        return id;
    }

    const QString id = genEntityId();
    QSqlQuery ins(m_db);
    ins.prepare(QStringLiteral(
        "INSERT INTO entities (id,name,type,scope,project_ref,created,updated)"
        " VALUES (?,?,?,?,?,?,?)"));
    ins.addBindValue(id);
    ins.addBindValue(n);
    ins.addBindValue(ty);
    ins.addBindValue(sc);
    ins.addBindValue(sc == QStringLiteral("project") ? projectRef : QString());
    ins.addBindValue(now);
    ins.addBindValue(now);
    if (!ins.exec()) {
        m_lastError = ins.lastError().text();
        return QString();
    }
    return id;
}

std::optional<EntityRow> MemoryStore::getEntity(const QString &id)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "SELECT id,name,type,scope,project_ref,created,updated FROM entities WHERE id=?"));
    q.addBindValue(id);
    if (!q.exec() || !q.next())
        return std::nullopt;
    EntityRow r;
    r.id = q.value(0).toString();
    r.name = q.value(1).toString();
    r.type = q.value(2).toString();
    r.scope = q.value(3).toString();
    r.projectRef = q.value(4).toString();
    r.created = q.value(5).toLongLong();
    r.updated = q.value(6).toLongLong();
    return r;
}

QVector<EntityRow> MemoryStore::listEntities(int limit)
{
    QVector<EntityRow> out;
    QString sql = QStringLiteral(
        "SELECT id,name,type,scope,project_ref,created,updated FROM entities"
        " ORDER BY updated DESC");
    if (limit > 0)
        sql += QStringLiteral(" LIMIT ") + QString::number(limit);
    QSqlQuery q(m_db);
    if (!q.exec(sql)) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        EntityRow r;
        r.id = q.value(0).toString();
        r.name = q.value(1).toString();
        r.type = q.value(2).toString();
        r.scope = q.value(3).toString();
        r.projectRef = q.value(4).toString();
        r.created = q.value(5).toLongLong();
        r.updated = q.value(6).toLongLong();
        out.push_back(r);
    }
    return out;
}

bool MemoryStore::link(const QString &fromId, const QString &fromType, const QString &toId,
                       const QString &toType, const QString &relation)
{
    if (fromId.isEmpty() || toId.isEmpty())
        return false;
    const QString rel = relation.isEmpty() ? QStringLiteral("relates_to") : relation;
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO memory_links (id,from_id,from_type,to_id,to_type,relation,created)"
        " VALUES (?,?,?,?,?,?,?)"
        " ON CONFLICT(from_id,to_id,relation) DO NOTHING"));
    q.addBindValue(genLinkId());
    q.addBindValue(fromId);
    q.addBindValue(fromType);
    q.addBindValue(toId);
    q.addBindValue(toType);
    q.addBindValue(rel);
    q.addBindValue(QDateTime::currentMSecsSinceEpoch());
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return true;
}

bool MemoryStore::unlink(const QString &fromId, const QString &toId)
{
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM memory_links WHERE from_id=? AND to_id=?"));
    q.addBindValue(fromId);
    q.addBindValue(toId);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return false;
    }
    return q.numRowsAffected() > 0;
}

QVector<QString> MemoryStore::neighborIds(const QString &nodeId, int depth)
{
    QVector<QString> result;
    if (nodeId.isEmpty() || depth <= 0)
        return result;

    QSet<QString> visited{nodeId};
    QVector<QString> frontier{nodeId};
    for (int d = 0; d < depth && !frontier.isEmpty(); ++d) {
        QVector<QString> next;
        for (const QString &cur : frontier) {
            QSqlQuery q(m_db);
            q.prepare(QStringLiteral(
                "SELECT to_id FROM memory_links WHERE from_id=?"
                " UNION SELECT from_id FROM memory_links WHERE to_id=?"));
            q.addBindValue(cur);
            q.addBindValue(cur);
            if (!q.exec())
                continue;
            while (q.next()) {
                const QString nid = q.value(0).toString();
                if (!visited.contains(nid)) {
                    visited.insert(nid);
                    result.push_back(nid);
                    next.push_back(nid);
                }
            }
        }
        frontier = next;
    }
    return result;
}

QJsonObject MemoryStore::graph(const QString &rootId, int depth)
{
    constexpr int kMaxNodes = 300;

    // Empty rootId == the overview: seed with EVERY entity and memory (not
    // just BFS-reachable ones) so isolated nodes and their edges still show
    // up. depth only matters for the rooted-subgraph case below.
    QVector<QString> seeds;
    if (rootId.isEmpty()) {
        for (const EntityRow &e : listEntities(kMaxNodes))
            seeds << e.id;
        for (const MemoryRow &m : list(kMaxNodes))
            seeds << m.id;
    } else {
        seeds << rootId;
    }

    QSet<QString> visited;
    for (const QString &s : seeds)
        visited.insert(s);
    QVector<QString> frontier = seeds;
    for (int d = 0; d < depth && !frontier.isEmpty() && visited.size() < kMaxNodes; ++d) {
        QVector<QString> next;
        for (const QString &cur : frontier) {
            if (visited.size() >= kMaxNodes)
                break;
            for (const QString &nid : neighborIds(cur, 1)) {
                if (visited.size() >= kMaxNodes)
                    break;
                if (!visited.contains(nid)) {
                    visited.insert(nid);
                    next.push_back(nid);
                }
            }
        }
        frontier = next;
    }

    // Entities are ALWAYS "ent_"-prefixed (only genEntityId() mints them), but
    // a memory id is caller-controlled (add(text,tags,id) — e.g. the daemon's
    // self-curated "user-name" slot) and need not start with "mem_". So
    // entity-prefix is authoritative; anything else is a memory-id candidate.
    QJsonArray nodesArr;
    for (const QString &id : visited) {
        if (id.startsWith(QStringLiteral("ent_"))) {
            if (auto r = getEntity(id))
                nodesArr.append(r->toJson());
        } else if (auto r = get(id)) {
            QJsonObject o = r->toJson();
            o.insert(QStringLiteral("kind"), QStringLiteral("memory"));
            nodesArr.append(o);
        }
    }

    QJsonArray edgesArr;
    {
        QSqlQuery q(m_db);
        if (q.exec(QStringLiteral("SELECT from_id,to_id,relation FROM memory_links"))) {
            while (q.next()) {
                const QString f = q.value(0).toString();
                const QString t = q.value(1).toString();
                if (visited.contains(f) && visited.contains(t)) {
                    QJsonObject e;
                    e.insert(QStringLiteral("from"), f);
                    e.insert(QStringLiteral("to"), t);
                    e.insert(QStringLiteral("relation"), q.value(2).toString());
                    edgesArr.append(e);
                }
            }
        }
    }

    QJsonObject out;
    out.insert(QStringLiteral("nodes"), nodesArr);
    out.insert(QStringLiteral("edges"), edgesArr);
    return out;
}

// Heuristic extraction (no NLP model): #tags become entity mentions (a
// "project:<name>" tag creates/attaches a scope=project entity instead), and
// runs of 2+ consecutive Capitalized Words in the text become "mentions"
// entities. Deliberately conservative — single capitalized words are too
// noisy (every sentence start) to be worth the false positives.
void MemoryStore::autoExtractEntities(const QString &memId, const QString &text,
                                      const QStringList &tags)
{
    for (const QString &tag : tags) {
        const QString t = tag.trimmed();
        if (t.isEmpty())
            continue;
        if (t.startsWith(QStringLiteral("project:"), Qt::CaseInsensitive)) {
            const QString projectName = t.mid(8).trimmed();
            if (projectName.isEmpty())
                continue;
            const QString entId = upsertEntity(projectName, QStringLiteral("project"),
                                               QStringLiteral("project"), projectName);
            if (!entId.isEmpty())
                link(memId, QStringLiteral("memory"), entId, QStringLiteral("entity"),
                    QStringLiteral("part_of"));
        } else {
            const QString entId = upsertEntity(t, QStringLiteral("topic"));
            if (!entId.isEmpty())
                link(memId, QStringLiteral("memory"), entId, QStringLiteral("entity"),
                    QStringLiteral("tagged"));
        }
    }

    static const QRegularExpression phraseRe(
        QStringLiteral("\\b[A-Z][a-zA-Z0-9]*(?:\\s+[A-Z][a-zA-Z0-9]*)+\\b"));
    QSet<QString> seen;
    int count = 0;
    auto it = phraseRe.globalMatch(text);
    while (it.hasNext() && count < 5) {
        const QString phrase = it.next().captured(0).trimmed();
        const QString key = phrase.toLower();
        if (phrase.isEmpty() || seen.contains(key))
            continue;
        seen.insert(key);
        const QString entId = upsertEntity(phrase, QStringLiteral("misc"));
        if (!entId.isEmpty()) {
            link(memId, QStringLiteral("memory"), entId, QStringLiteral("entity"),
                QStringLiteral("mentions"));
            ++count;
        }
    }
}

void MemoryStore::backfillEntityExtraction()
{
    struct Row { QString id; QString text; QString tags; };
    QVector<Row> rows;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral(
            "SELECT m.id, m.text, m.tags FROM memories m"
            " WHERE NOT EXISTS (SELECT 1 FROM memory_links l WHERE l.from_id = m.id)")))
        return;
    while (q.next())
        rows.push_back({q.value(0).toString(), q.value(1).toString(), q.value(2).toString()});

    for (const Row &r : rows)
        autoExtractEntities(r.id, r.text, tagsFromStorage(r.tags));
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
    QVector<MemoryRow> hits = query.trimmed().isEmpty() ? list(k) : search(query, k);
    if (hits.isEmpty())
        hits = list(k); // no relevant match — still give recent context

    // Graph-aware expansion: a memory sharing an entity (tag/topic/project)
    // with a top hit is relevant context even if its own text doesn't match
    // the query. Walk 2 hops (memory -> entity -> sibling memory) from each
    // of the top hits and fold in a bounded number of newly-discovered
    // memories so recall isn't limited to literal text matches.
    QSet<QString> have;
    for (const MemoryRow &r : hits)
        have.insert(r.id);
    constexpr int kMaxExpand = 3;
    int added = 0;
    for (int i = 0; i < hits.size() && added < kMaxExpand; ++i) {
        for (const QString &nid : neighborIds(hits[i].id, 2)) {
            if (added >= kMaxExpand)
                break;
            // Entities are always "ent_"-prefixed; a memory id is not (e.g.
            // the daemon's caller-supplied "user-name" slot) — skip entities
            // by prefix, then try a memory lookup for everything else.
            if (have.contains(nid) || nid.startsWith(QStringLiteral("ent_")))
                continue;
            if (auto r = get(nid)) {
                have.insert(nid);
                hits.push_back(*r);
                ++added;
            }
        }
    }
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
