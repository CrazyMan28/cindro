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
    QString scope = QStringLiteral("global"); // global|project|agent
    QString entityRef;                        // set when scope=="project"/"agent" (project name / agent id)

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
                const QString &id = QString(),
                const QString &scope = QStringLiteral("global"),
                const QString &entityRef = QString());
    // Replace the text/tags of an existing memory (updated re-stamped). False if
    // the id does not exist or on error.
    bool replace(const QString &id, const QString &text, const QStringList &tags);
    bool remove(const QString &id);
    std::optional<MemoryRow> get(const QString &id);

    // Newest-first list (limit<=0 => all).
    QVector<MemoryRow> list(int limit = 0);

    // Full-text search over text+tags (FTS5). Falls back to a LIKE scan when the
    // query has no usable FTS tokens. Returns up to `limit` rows, best match
    // first, each with a populated `score` (higher = more relevant). When
    // `entityRef` is empty (an unscoped call) this EXCLUDES scope=="agent"
    // rows — per-agent memories are only visible to a caller that names that
    // agent (pass its id as `entityRef`); an explicitly-scoped call is
    // completely unaffected and returns only that agent's rows, as before.
    // list() is unaffected by any of this and always returns every row.
    //
    // `includeAgentScoped` is a narrow opt-in for HUMAN-facing memory-browser
    // UIs only (web/desktop/TUI/phone "search my memory" boxes): when true AND
    // the call is unscoped (entityRef empty), the scope=="agent" exclusion
    // above is skipped, so a person deliberately searching their own memory
    // sees everything they've stored — matching what empty-query browsing via
    // list() already shows. Defaults to false so every existing/automatic
    // caller (recall(), prefetchMemoryBlock()) is completely unaffected; this
    // parameter must never be set to true from an automatic LLM-context path.
    QVector<MemoryRow> search(const QString &query, int limit = 20,
                              const QString &entityRef = QString(),
                              bool includeAgentScoped = false);

    // prefetch(query,k): context for a turn, used as the AUTOMATIC per-turn
    // context injection (see ControlServer::prefetchMemoryBlock /
    // memorySystemBlock — invoked on every ordinary chat turn, which usually
    // has no notion of "which agent/machine" it belongs to). Empty query =>
    // the k most-recent memories (so a fresh turn still gets context). The
    // baseline result set ALWAYS excludes scope=="agent" rows (including ones
    // pulled in via graph expansion), so an unrelated turn gets zero
    // agent-scoped noise. HOWEVER, if `query` names one or more known agents
    // (an entity_ref appearing as its own token, hyphen-boundary aware, so
    // e.g. "pve" does not also match "pve-backup" — see agentRefsMentionedIn()
    // in the .cpp) those agents' own scoped memories are merged back in too,
    // bounded to a small additive cap (kMaxAgentInject in the .cpp) that is
    // shared and distributed FAIRLY (round-robin) across every mentioned
    // agent, not first-come-first-served — so a conversation that's clearly
    // about a machine recalls its facts automatically, without an explicit
    // recall(agent=...)/search(entityRef=...) every time, and naming two
    // agents in the same turn doesn't starve one of them of its share.
    // Graph expansion (kMaxExpand in the .cpp) additionally folds in a
    // bounded number of memories that share an entity with a top hit.
    // CONTRACT / documented maximum: the returned vector is at most
    // k (base) + kMaxAgentInject (agent-mention injection) + kMaxExpand
    // (graph expansion) rows total — an explicit, enforced ceiling (truncated
    // at the end of prefetch() if the additive stages ever combine to more),
    // NOT a bare `k`. list() is unaffected and always returns every row
    // (raw/debug listing).
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
    bool hasColumn(const QString &table, const QString &column);
    void autoExtractEntities(const QString &memId, const QString &text, const QStringList &tags);
    void backfillEntityExtraction();
    // Known agent entity_refs (i.e. every distinct entity_ref with at least
    // one scope=="agent" memory row) that appear as their own token,
    // case-insensitively and hyphen-boundary aware (so "pve" does not match
    // inside "pve-backup"), in `query` — used by prefetch()'s mention-based
    // auto-recall (see prefetch() doc comment above). Returned sorted
    // (alphabetically) for deterministic, fair round-robin injection when
    // multiple agents are mentioned in the same call. Short-circuits to an
    // empty list, with NO query and NO regex work, when
    // m_hasAgentScopedRows is false (the common case: no agent-scoped memory
    // has ever been stored), so a chat turn never pays for a full table scan
    // it can't possibly need.
    QStringList agentRefsMentionedIn(const QString &query);

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
    // Cheap short-circuit for agentRefsMentionedIn(): true once ANY
    // scope=="agent" memory has ever been written via add() (monotonic —
    // never flipped back to false on removal, which only costs an
    // occasional redundant-but-harmless query, never a correctness bug).
    // Initialized once at open() time via a single SELECT EXISTS(...) check.
    bool m_hasAgentScopedRows = false;
};

} // namespace jarvis
