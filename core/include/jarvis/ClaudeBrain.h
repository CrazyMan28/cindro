#pragma once

// ClaudeBrain drives the Claude Code CLI (`claude -p --output-format
// stream-json`) as a child process and normalizes its JSONL stdout into
// NormalizedBrainEvents via the pure parseClaudeLine() (Contract B).
//
// Spawn shape (verified against claude 2.1.170, see spikes/RESULTS.md &
// spikes/claude_stream_json_sample.jsonl):
//   claude -p --output-format stream-json --verbose [--model <m>]
//          [--add-dir <cwd>] "<prompt>"
// with stdin redirected from /dev/null so a one-shot `-p` turn never blocks.
// `claude exec` is single-turn like codex, so a new turn re-spawns the process.

#include "jarvis/Brain.h"
#include "jarvis/Protocol.h"

#include <QByteArray>
#include <QProcess>
#include <QString>
#include <QStringList>

namespace jarvis {

class ClaudeBrain : public Brain {
    Q_OBJECT
public:
    struct Options {
        QString cwd;     // --add-dir <cwd> (and process working dir)
        QString model;   // --model <model>
        QString profile = QStringLiteral("coder"); // "coder" | "coworker"
        QString program = QStringLiteral("claude"); // executable name/path
        // Extra MCP servers to expose to claude as a JSON config (--mcp-config).
        // Empty => no extra servers.
        QString mcpConfigJson;
        // Permission mode: coder/coworker run with default gated permissions; the
        // daemon never passes bypassPermissions.
        QString permissionMode; // "" => CLI default
        // CLAUDE_CONFIG_DIR for the spawned `claude` process — pins which OAuth
        // account the brain runs as. DEFAULTS to the Pro account dir (~/.claude)
        // so the brain never accidentally inherits the user's Max account
        // (~/.claude-secondary) from the ambient environment. The daemon maps
        // the `claude_account` setting (pro|max) onto this.
        QString configDir;
    };

    explicit ClaudeBrain(Options opts, QObject *parent = nullptr);
    ~ClaudeBrain() override;

    void send(const QString &text, const QStringList &images = {}) override;
    void cancel() override;
    bool isBusy() const override;

    // Build the `claude` argv for a one-shot `-p` turn. Public so a ctest can
    // assert the prompt is an isolated trailing positional after `--` (guards the
    // prior --add-dir regression where the variadic flag swallowed the prompt).
    QStringList buildArgs(const QString &prompt, const QStringList &images = {}) const;

private slots:
    void onReadyReadStdout();
    void onReadyReadStderr();
    void onFinished(int exitCode, QProcess::ExitStatus status);
    void onErrorOccurred(QProcess::ProcessError error);

private:
    void emitEvent(const NormalizedBrainEvent &ev);
    void drainBuffer(bool flushIncomplete);
    void handleLine(const QByteArray &line);

    Options m_opts;
    QProcess *m_proc = nullptr;
    QByteArray m_stdoutBuf;
    bool m_busy = false;
    bool m_sawFinal = false; // saw the terminal result -> final
    QString m_mcpConfigPath;  // temp file holding mcpConfigJson (cleaned per turn)
    // Conversation continuity: a fixed session UUID set on the first turn via
    // --session-id, then --resume'd on every later turn so the model KEEPS the
    // whole conversation instead of starting cold each message.
    QString m_claudeSessionId;
    bool m_started = false;
};

} // namespace jarvis
