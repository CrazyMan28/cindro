#pragma once

// KanbanStore — durable multi-agent work queue (jarvis#76 item 7).
//
// A claimable backlog that SURVIVES daemon restarts, unlike the fire-and-wait
// subagent dispatch: work items are enqueued (by the user, the model via the
// queue_* MCP tools, or the phone), a dispatcher loop in the daemon claims the
// highest-priority pending item when a worker slot is free, runs it as a
// session, and heartbeats while it runs. Items whose worker died (stale
// heartbeat) are RECLAIMED back to pending so a crash never loses work.
//
// Lives in the shared jarvis.db (own connection name, WAL) beside the other
// stores. States: pending -> running -> done | error | cancelled.

#include <QJsonObject>
#include <QSqlDatabase>
#include <QString>
#include <QVector>
#include <optional>

namespace jarvis {

struct WorkItem {
    QString id;          // "work_" + hex
    QString title;
    QString prompt;      // the turn text the worker session runs
    QString status;      // pending | running | done | error | cancelled
    int priority = 0;    // higher first
    QString brain;       // optional brain/model/profile pin (else defaults)
    QString model;
    QString profile;
    QString sessionId;   // worker session once started
    QString parentItemId; // optional decomposition link
    QString result;      // worker's summary once finished
    qint64 heartbeatAt = 0; // unix ms of the last liveness proof while running
    qint64 created = 0;
    qint64 updated = 0;
    qint64 started = 0;
    qint64 ended = 0;
    QString tags;        // space-separated labels

    QJsonObject toJson() const;
};

class KanbanStore {
public:
    KanbanStore() = default;
    ~KanbanStore();

    KanbanStore(const KanbanStore &) = delete;
    KanbanStore &operator=(const KanbanStore &) = delete;

    // Default path: the shared ~/.local/share/jarvis/jarvis.db.
    bool open(const QString &dbPath = QString(),
              const QString &connectionName = QStringLiteral("jarvis-kanban"));
    bool isOpen() const;
    void close();
    QString lastError() const { return m_lastError; }

    // Enqueue a new pending item; returns its id (empty on error).
    QString enqueue(const QString &title, const QString &prompt, int priority = 0,
                    const QString &brain = QString(), const QString &model = QString(),
                    const QString &profile = QString(), const QString &tags = QString(),
                    const QString &parentItemId = QString());

    // Claim the next pending item (highest priority, then oldest): atomically
    // flips it to running with a fresh heartbeat. nullopt when the backlog is
    // empty.
    std::optional<WorkItem> claimNext(const QString &sessionId = QString());

    std::optional<WorkItem> get(const QString &id);
    // status filter empty = all; newest first.
    QVector<WorkItem> list(const QString &status = QString(), int limit = 200);

    bool updateStatus(const QString &id, const QString &status,
                      const QString &sessionId = QString(),
                      const QString &result = QString());
    bool setPriority(const QString &id, int priority);
    // Refresh the heartbeat of a running item (worker liveness).
    bool heartbeat(const QString &id);
    // Cancel a pending/running item (running workers are stopped by the daemon).
    bool cancel(const QString &id);
    bool remove(const QString &id); // done/error/cancelled housekeeping

    // Reclaim running items whose heartbeat is older than staleMs back to
    // pending (worker died / daemon restarted mid-run). Returns count.
    int reclaimStale(qint64 staleMs);

private:
    bool exec(const QString &sql);
    bool migrate();
    static QString genId();

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
};

} // namespace jarvis
