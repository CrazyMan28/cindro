#pragma once

// MemoryStore — Jarvis-level long-term memory (HERMES_FEATURES.md §1).
//
// A builtin SQLite + FTS5 memory provider stored in jarvis.db (tables
// `memories` + `memories_fts`). jarvisd PREFETCHES relevant memories before
// every brain turn (injected into the prompt/system) and SYNCS salient facts
// after each turn; the memory tools (memory.add/replace/remove/search) are also
// exposed to the model so it can self-curate.
//
// This class owns its own QSqlDatabase connection (separate connection name) so
// it can live alongside SessionStore on the same on-disk file without clashing.

#include <QDateTime>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QString>
#include <QStringList>
#include <QVector>
#include <optional>

namespace jarvis {

// One stored memory. `tags` is a free-form list (stored as a space-joined
// string for FTS); `score` is only populated by search() (FTS5 bm25 rank).
struct MemoryRow {
    QString id;
    QString text;
    QStringList tags;
    qint64 created = 0; // unix ms
    qint64 updated = 0; // unix ms
    double score = 0.0; // search relevance (0 outside of search())

    QJsonObject toJson() const;
};

// One knowledge-graph node representing a real-world entity (person, project,
// topic, place, ...) — auto-extracted from memory text/tags, or created
// explicitly via link(). Dedup key is (lower(name), type).
struct EntityRow {
    QString id;
    QString name;
    QString type = QStringLiteral("misc");     // person|project|topic|place|misc
    QString scope = QStringLiteral("global");   // global|project
    QString projectRef;                          // set when scope=="project"
    qint64 created = 0;
    qint64 updated = 0;

    QJsonObject toJson() const;
};

// A directed edge between two graph nodes, each identified by id + kind
// ("memory" or "entity"). `relation` is free-form (mentions/tagged/part_of/
// relates_to/...).
struct MemoryLink {
    QString fromId;
    QString fromType;
    QString toId;
    QString toType;
    QString relation = QStringLiteral("relates_to");
    qint64 created = 0;

    QJsonObject toJson() const;
};

class MemoryStore {
public:
    MemoryStore() = default;
    ~MemoryStore();

    MemoryStore(const MemoryStore &) = delete;
    MemoryStore &operator=(const MemoryStore &) = delete;

    // Default DB path: ~/.local/share/jarvis/jarvis.db (shared with SessionStore).
    static QString defaultDbPath();

    // Open (and create + migrate) the memories + memories_fts tables. Uses a
    // distinct connection name so it can coexist with SessionStore on the same
    // file. Returns false on failure (see lastError()).
    bool open(const QString &dbPath = QString(),
              const QString &connectionName = QStringLiteral("jarvis-memory"));
    bool isOpen() const;
    void close();

    QString lastError() const { return m_lastError; }

    // --- CRUD --------------------------------------------------------------
    // Add a new memory; returns its generated id (empty on error). created/
    // updated stamped now. If `id` is provided it is used verbatim (upsert).
    QString add(const QString &text, const QStringList &tags = {},
                const QString &id = QString());
    // Replace the text/tags of an existing memory (updated re-stamped). False if
    // the id does not exist or on error.
    bool replace(const QString &id, const QString &text, const QStringList &tags);
    bool remove(const QString &id);
    std::optional<MemoryRow> get(const QString &id);

    // Newest-first list (limit<=0 => all).
    QVector<MemoryRow> list(int limit = 0);

    // Full-text search over text+tags (FTS5). Falls back to a LIKE scan when the
    // query has no usable FTS tokens. Returns up to `limit` rows, best match
    // first, each with a populated `score` (higher = more relevant).
    QVector<MemoryRow> search(const QString &query, int limit = 20);

    // prefetch(query,k): the top-k relevant memories for a turn. Empty query =>
    // the k most-recent memories (so a fresh turn still gets context).
    QVector<MemoryRow> prefetch(const QString &query, int k = 6);

    // Render a prefetch result as a system-prompt block to inject before a turn.
    // Empty input => empty string (nothing injected).
    static QString renderPromptBlock(const QVector<MemoryRow> &memories);

    // --- Knowledge graph (entities + links) --------------------------------
    // Personal Knowledge Graph (jarvis#70), phase 1: a lightweight graph layer
    // on top of the flat memories table — entities are auto-extracted from
    // memory text/tags and linked to the memory that mentioned them; add()
    // calls this automatically so every existing caller (daemon, tests) gets
    // graph population for free.

    // Create or update (by case-insensitive name+type) an entity node. Scope
    // defaults to "global" (recalled everywhere); pass scope="project" +
    // projectRef to scope it to one project (never downgrades an existing
    // project-scoped entity back to global). Returns its id (empty on error).
    QString upsertEntity(const QString &name, const QString &type = QStringLiteral("misc"),
                         const QString &scope = QStringLiteral("global"),
                         const QString &projectRef = QString());
    std::optional<EntityRow> getEntity(const QString &id);
    QVector<EntityRow> listEntities(int limit = 0);

    // Directed link between two graph nodes (ids are memory "mem_..." or
    // entity "ent_..." ids). Idempotent: re-linking the same (from,to,relation)
    // is a no-op, not a duplicate edge.
    bool link(const QString &fromId, const QString &fromType, const QString &toId,
             const QString &toType, const QString &relation = QStringLiteral("relates_to"));
    bool unlink(const QString &fromId, const QString &toId);

    // BFS over memory_links (edges treated as undirected for traversal) out to
    // `depth` hops from `nodeId`. Returns newly-discovered ids only (not
    // nodeId itself), nearest first.
    QVector<QString> neighborIds(const QString &nodeId, int depth = 1);

    // Subgraph as {nodes:[...], edges:[{from,to,relation}]} for the desktop
    // graph browser. Empty rootId => seeded from all entities (or recent
    // memories if there are none yet). Bounded to a few hundred nodes.
    QJsonObject graph(const QString &rootId = QString(), int depth = 2);

private:
    bool exec(const QString &sql, QString *err = nullptr);
    bool migrate();
    void autoExtractEntities(const QString &memId, const QString &text, const QStringList &tags);

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
};

} // namespace jarvis
