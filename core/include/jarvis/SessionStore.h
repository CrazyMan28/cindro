#pragma once

// SQLite-backed persistence for sessions and their normalized event streams.
// DB lives at ~/.local/share/jarvis/jarvis.db (dirs created on open()).

#include "jarvis/Protocol.h"

#include <QDateTime>
#include <QSqlDatabase>
#include <QString>
#include <QStringList>
#include <QVector>
#include <optional>

namespace jarvis {

struct SessionRow {
    QString id;
    QString title;
    QString profile;   // "coder" | "coworker"
    QString brain;     // "codex" | "claude" | "api"
    QString model;
    QString threadId;  // brain thread id (may be empty until thread_started)
    QString state;     // "starting" | "running" | "idle" | "done" | "error" | ...
    // Subagent support: when this session was dispatched as a child of another
    // (agents.dispatch / session.create{parent_session_id}), this links it to
    // its parent so the desktop SubAgentTree can group it. Empty for top-level.
    QString parentSessionId;
    QString agent;     // custom-agent name this session runs as (empty = none)
    // Persistent goal (jarvis#76 item 9): when non-empty and auto_continue is
    // on, the daemon re-wakes the session after each turn until the goal is
    // met or the continuation cap is hit. continuationCount is reset on every
    // real user turn so the cap bounds unattended runs, not conversations.
    QString goals;
    int continuationCount = 0;
    qint64 created = 0; // unix ms
    qint64 updated = 0; // unix ms

    QJsonObject toJson() const;
};

struct StoredEvent {
    QString sessionId;
    int seq = 0;
    NormalizedBrainEvent ev;
    qint64 ts = 0; // unix ms
};

// One cross-session full-text search hit (jarvis#76 item 1): the matched event
// plus a small window of surrounding events so callers can read the exchange
// around the match without a second round-trip.
struct SessionSearchHit {
    QString sessionId;
    QString sessionTitle;
    int seq = 0;
    qint64 ts = 0;             // unix ms of the matched event
    NormalizedBrainEvent ev;   // the matched event
    double score = 0.0;        // higher = more relevant (bm25-derived)
    QVector<StoredEvent> context; // ±contextWindow events, seq ascending, incl. the hit
};

// A registered MCP server (Contract A v2 mcp.* methods). The built-in
// computer-use server is seeded on first open and cannot be removed.
struct McpServerRow {
    QString id;
    QString name;
    QString transport;   // "http" | "stdio"
    QString endpoint;    // URL (http) or command line (stdio)
    QString token;       // optional bearer (http) — never echoed back to clients
    bool enabled = true;
    bool builtin = false;
    QString risk;        // "low" | "medium" | "high"
    qint64 created = 0;
    // Brain-injectable env-var map (name -> secret-ref token like
    // "secret:connector:<id>:client_secret" OR a literal value). Used by Google
    // connectors so OAuth creds reach a stdio MCP server's environment. The
    // daemon reads this internally; toJson() OMITS it (it may reference secrets).
    QJsonObject env;

    QJsonObject toJson() const; // omits token+env; adds enabled/connected placeholders
};

// A plugin's installed/enabled state (catalog manifest lives on disk; this row
// tracks only the mutable state the user toggles). Wave 7 also records the
// signature verdict (`verified`) and the permission set GRANTED at install
// time (`grantedPermissions`, a comma-joined list on disk) so a later enable
// launches the plugin under exactly the perms the user approved.
struct PluginRow {
    QString id;
    bool installed = false;
    bool enabled = false;
    bool verified = false;
    QStringList grantedPermissions;
    qint64 updated = 0;
};

// A queued task (Contract C task.queue / task.list). `whenAt`<=0 means "run as
// soon as possible"; otherwise it is a unix-ms time to run at.
struct TaskRow {
    QString id;
    QString deviceId;   // device that queued it (empty for desktop-queued)
    QString text;       // the prompt to run
    qint64 whenAt = 0;  // unix ms (0 => asap)
    QString state;      // "queued" | "running" | "done" | "error" | "canceled"
    QString sessionId;  // session it ran in, once started (may be empty)
    qint64 created = 0; // unix ms
    qint64 updated = 0; // unix ms

    QJsonObject toJson() const;
};

// A registered FCM push token for a device (Contract C push.register). One row
// per device id; re-registering replaces the token.
struct PushTokenRow {
    QString deviceId;
    QString fcmToken;
    qint64 updated = 0; // unix ms
};

class SessionStore {
public:
    SessionStore() = default;
    ~SessionStore();

    SessionStore(const SessionStore &) = delete;
    SessionStore &operator=(const SessionStore &) = delete;

    // Default DB path: ~/.local/share/jarvis/jarvis.db
    static QString defaultDbPath();

    // Open (and create + migrate) the DB. Creates parent directories. Returns
    // false on failure (see lastError()). A unique connection name keeps two
    // SessionStore instances (e.g. tests) from clashing.
    bool open(const QString &dbPath = QString(),
              const QString &connectionName = QStringLiteral("jarvis-core"));
    bool isOpen() const;
    void close();

    QString lastError() const { return m_lastError; }

    // --- sessions ---------------------------------------------------------
    // Insert a new session row (created/updated stamped now). Returns false on error.
    bool create(const SessionRow &row);
    std::optional<SessionRow> get(const QString &id);
    QVector<SessionRow> list();
    bool updateState(const QString &id, const QString &state);
    bool updateTitle(const QString &id, const QString &title);
    bool updateThreadId(const QString &id, const QString &threadId);
    // Persistent goal + auto-continuation bookkeeping (jarvis#76 item 9).
    bool setGoals(const QString &id, const QString &goals);
    bool setContinuationCount(const QString &id, int count);
    // Delete a session row and all of its events. Returns false on error;
    // returns true even if the row didn't exist (idempotent delete).
    bool deleteSession(const QString &id);

    // --- events -----------------------------------------------------------
    // Append an event; sequence number is assigned monotonically per session.
    // Returns the assigned seq, or -1 on error.
    int appendEvent(const QString &sessionId, const NormalizedBrainEvent &ev);
    // Events for a session ordered by seq ascending. limit<=0 => all.
    QVector<StoredEvent> listEvents(const QString &sessionId, int limit = 0);
    // Cross-session full-text search over message/thinking text and tool
    // outputs (FTS5-ranked, LIKE fallback). Optional sessionId narrows to one
    // session; contextWindow (clamped 0..5) events either side ride along.
    QVector<SessionSearchHit> searchEvents(const QString &query, int limit = 20,
                                           int contextWindow = 2,
                                           const QString &sessionId = QString());

    // --- MCP servers ------------------------------------------------------
    QVector<McpServerRow> listMcpServers();
    std::optional<McpServerRow> getMcpServer(const QString &id);
    bool addMcpServer(const McpServerRow &row);
    bool removeMcpServer(const QString &id); // refuses builtin rows
    bool setMcpEnabled(const QString &id, bool enabled);

    // --- plugins ----------------------------------------------------------
    QVector<PluginRow> listPlugins();
    std::optional<PluginRow> getPlugin(const QString &id);
    bool upsertPlugin(const PluginRow &row);
    bool removePlugin(const QString &id);

    // --- tasks (Contract C queue) -----------------------------------------
    bool createTask(const TaskRow &row);
    QVector<TaskRow> listTasks(const QString &deviceId = QString());
    std::optional<TaskRow> getTask(const QString &id);
    bool updateTaskState(const QString &id, const QString &state,
                         const QString &sessionId = QString());

    // --- push tokens (Contract C push.register) ---------------------------
    bool upsertPushToken(const PushTokenRow &row);   // replaces by deviceId
    QVector<PushTokenRow> listPushTokens();
    bool removePushToken(const QString &deviceId);

private:
    bool exec(const QString &sql, QString *err = nullptr);
    bool migrate();
    // One-time index of pre-existing events into events_fts (no-op once filled).
    void backfillEventsFts();

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
};

} // namespace jarvis
