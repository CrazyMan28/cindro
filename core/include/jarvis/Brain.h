#pragma once

// Abstract brain interface. A Brain drives one AI backend (codex / claude /
// api) for a single session and emits NormalizedBrainEvents (Contract B) via
// the event() signal. Concrete impls: CodexBrain (this wave), ClaudeBrain /
// ApiBrain (Wave 5).

#include "jarvis/Protocol.h"

#include <QObject>
#include <QString>

namespace jarvis {

class Brain : public QObject {
    Q_OBJECT
public:
    explicit Brain(QObject *parent = nullptr) : QObject(parent) {}
    ~Brain() override = default;

    // The session this brain is bound to.
    QString sessionId() const { return m_sessionId; }
    void setSessionId(const QString &id) { m_sessionId = id; }

    // Send a user turn (text + optional image paths/data URIs). For CodexBrain
    // the first send launches the process; behavior of subsequent sends is
    // brain-specific (codex exec is single-turn, so a new turn re-spawns).
    virtual void send(const QString &text, const QStringList &images = {}) = 0;

    // Cancel the in-flight turn (terminate the underlying process/request).
    virtual void cancel() = 0;

    // Respond to a pending approval request (allow / deny / always).
    virtual void respondApproval(const QString &approvalId, const QString &decision)
    {
        Q_UNUSED(approvalId);
        Q_UNUSED(decision);
    }

    // True while a turn is in flight.
    virtual bool isBusy() const = 0;

signals:
    // Emitted for every normalized event produced by this brain.
    void event(const QString &sessionId, const jarvis::NormalizedBrainEvent &ev);
    // Emitted once the brain has fully finished a turn and is idle again.
    void turnFinished(const QString &sessionId);

protected:
    QString m_sessionId;
};

} // namespace jarvis
