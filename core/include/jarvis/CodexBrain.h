#pragma once

// CodexBrain drives `codex exec --json` as a child process and normalizes its
// JSONL stdout into NormalizedBrainEvents via the pure parseCodexLine().
//
// Spawn shape (verified, see spikes/RESULTS.md & BUILD_SPEC Contract B):
//   codex exec --json --sandbox <mode> -C <cwd> -m <model> [--cd ...] "<prompt>"
// with stdin closed immediately (EOF) so codex never blocks reading stdin.

#include "jarvis/Brain.h"
#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QMap>
#include <QProcess>
#include <QString>

namespace jarvis {

class CodexBrain : public Brain {
    Q_OBJECT
public:
    struct Options {
        QString cwd;                                  // -C <cwd>
        QString model;                                // -m <model>
        QString sandboxMode = QStringLiteral("workspace-write"); // --sandbox
        QString profile = QStringLiteral("coder");    // "coder" | "coworker"
        QString program = QStringLiteral("codex");     // executable name/path
        // Extra config overrides passed as `-c key=value` (e.g. MCP injection).
        QStringList configOverrides;
        // Extra environment variables set on the codex child process. Used to
        // export MCP bearer tokens that `configOverrides` reference via
        // `bearer_token_env_var=<NAME>` (codex 0.135 rejects inline bearers for
        // streamable_http). Merged on top of the inherited environment.
        QMap<QString, QString> extraEnv;
    };

    // Map a session profile to the codex sandbox mode.
    // coder -> workspace-write, coworker -> workspace-write.
    static QString sandboxForProfile(const QString &profile);

    explicit CodexBrain(Options opts, QObject *parent = nullptr);
    ~CodexBrain() override;

    void send(const QString &text, const QStringList &images = {}) override;
    void cancel() override;
    bool isBusy() const override;

private slots:
    void onReadyReadStdout();
    void onReadyReadStderr();
    void onFinished(int exitCode, QProcess::ExitStatus status);
    void onErrorOccurred(QProcess::ProcessError error);

private:
    void emitEvent(const NormalizedBrainEvent &ev);
    void drainBuffer(bool flushIncomplete);
    QStringList buildArgs(const QString &prompt) const;

    Options m_opts;
    QProcess *m_proc = nullptr;
    QByteArray m_stdoutBuf;
    bool m_busy = false;
    bool m_sawUsage = false; // ensure we synthesize final after usage exactly once
};

} // namespace jarvis
