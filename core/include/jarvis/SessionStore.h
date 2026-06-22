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

private:
    bool exec(const QString &sql, QString *err = nullptr);
    bool migrate();

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
};

} // namespace jarvis
