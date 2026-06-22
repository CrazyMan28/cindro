#pragma once

// SQLite-backed persistence for sessions and their normalized event streams.
// DB lives at ~/.local/share/jarvis/jarvis.db (dirs created on open()).

#include "jarvis/Protocol.h"

#include <QDateTime>
#include <QSqlDatabase>
#include <QString>
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

    QJsonObject toJson() const; // omits token; adds enabled/connected placeholders
};

// A plugin's installed/enabled state (catalog manifest lives on disk; this row
// tracks only the mutable state the user toggles).
struct PluginRow {
    QString id;
    bool installed = false;
    bool enabled = false;
    qint64 updated = 0;
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
    bool updateThreadId(const QString &id, const QString &threadId);

    // --- events -----------------------------------------------------------
    // Append an event; sequence number is assigned monotonically per session.
    // Returns the assigned seq, or -1 on error.
    int appendEvent(const QString &sessionId, const NormalizedBrainEvent &ev);
    // Events for a session ordered by seq ascending. limit<=0 => all.
    QVector<StoredEvent> listEvents(const QString &sessionId, int limit = 0);

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

private:
    bool exec(const QString &sql, QString *err = nullptr);
    bool migrate();

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
};

} // namespace jarvis
