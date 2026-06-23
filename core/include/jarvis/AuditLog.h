#pragma once

// AuditLog — HERMES_FEATURES.md §5 (audit log + risk gate).
//
// Every tool/action Jarvis takes is logged to a SQLite `audit` table in
// jarvis.db: {ts, tool, ok, risk, summary, (optional) remote, session_id}. The
// desktop/phone surface the last ~N entries via the `audit.list` method. The
// risk tier (low|medium|high) is the same vocabulary the prompt-injection gate
// (InjectionGuard) and the device capability tiers use; high-risk actions
// (system control, take-over, ssh) ride the existing approval cards.
//
// Owns its own QSqlDatabase connection (distinct connection name) so it can
// coexist with SessionStore + MemoryStore on the same on-disk jarvis.db.

#include <QJsonObject>
#include <QSqlDatabase>
#include <QString>
#include <QVector>

namespace jarvis {

// One audit entry. `ok` records whether the action succeeded; `risk` is the
// assessed tier; `summary` is a short human-readable description.
struct AuditRow {
    qint64 id = 0;       // autoincrement rowid
    qint64 ts = 0;       // unix ms
    QString tool;        // tool / action name (e.g. "ssh.exec", "computer_use.click")
    bool ok = true;      // did the action succeed
    QString risk;        // "low" | "medium" | "high"
    QString summary;     // short description
    QString sessionId;   // originating session (may be empty)
    bool remote = false; // initiated from a paired device (phone) vs the desktop

    QJsonObject toJson() const;
};

class AuditLog {
public:
    AuditLog() = default;
    ~AuditLog();

    AuditLog(const AuditLog &) = delete;
    AuditLog &operator=(const AuditLog &) = delete;

    // Default DB path: ~/.local/share/jarvis/jarvis.db (shared file).
    static QString defaultDbPath();

    // Open + migrate the `audit` table. Distinct connection name so it coexists
    // with the other stores. Returns false on failure (see lastError()).
    bool open(const QString &dbPath = QString(),
              const QString &connectionName = QStringLiteral("jarvis-audit"));
    bool isOpen() const;
    void close();

    QString lastError() const { return m_lastError; }

    // Append an entry; returns its rowid (or -1 on error). `ts` is stamped now.
    qint64 record(const QString &tool, bool ok, const QString &risk,
                  const QString &summary, const QString &sessionId = QString(),
                  bool remote = false);

    // Newest-first list of the most recent `limit` entries (default ~100, the
    // HERMES_FEATURES retention target). limit<=0 => the default cap.
    QVector<AuditRow> list(int limit = 100);

private:
    bool exec(const QString &sql, QString *err = nullptr);
    bool migrate();

    QSqlDatabase m_db;
    QString m_connectionName;
    QString m_lastError;
};

} // namespace jarvis
