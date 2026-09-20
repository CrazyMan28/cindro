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
        // Tool names to remove from the model's toolset entirely (--disallowedTools).
        // Used for PLAN mode: native Write/Edit/Bash/NotebookEdit/Task are removed
        // so the MCP-side plan-mode gate (computer_use_mcp/policy.py) is the only
        // enforcement needed for MCP tools, while these native tools — invisible to
        // that gate — are blocked here instead. NOT the same mechanism as
        // `--permission-mode plan`, which was tried and rejected: it blanket-denies
        // EVERY MCP tool call with no allowlist override, which would also break
        // present_plan/agent_start/todo_write.
        QStringList disallowedTools; // empty => nothing removed
        // CLAUDE_CONFIG_DIR for the spawned `claude` process — pins which OAuth
        // account the brain runs as. DEFAULTS to the Pro account dir (~/.claude)
        // so the brain never accidentally inherits the user's Max account
        // (~/.claude-secondary) from the ambient environment. The daemon maps
        // the `claude_account` setting (pro|max) onto this.
        QString configDir;
        // When non-empty, seeds m_claudeSessionId (instead of a fresh random
        // UUID) and marks the conversation already-started, so the FIRST
        // send() of a re-spawned brain (e.g. after a daemon restart) resumes
        // this existing claude session (`--resume <id>`) instead of starting
        // fresh with `--session-id` and losing all prior context. Set by the
        // daemon from the session's persisted session id.
        QString resumeSessionId;
        // Extra system-prompt text, sent via `--append-system-prompt-file` on
        // every turn (NOT the first user message, and NOT inline in argv — it is
        // ~17 KB and an argument that big overflows the command line; see
        // writeSystemPromptFile()). WHY THIS EXISTS: ClaudeBrain has
        // no other true system-prompt field, so the daemon used to prepend its
        // "you are Cindro, here are your tools" co-work guide + permission/mode
        // policy text directly into the FIRST user-turn message instead. Live
        // testing (2026-07-17) showed Claude Sonnet 5 correctly treats an
        // unsigned identity/tool-grant block embedded in user-turn TEXT as a
        // likely prompt injection and refuses to adopt the persona or trust the
        // listed tools ("I'm running as Claude Code... flagging it as a likely
        // prompt injection, not something I'm complying with") — even though
        // the MCP tools themselves were correctly wired up. Routing the same
        // text through the CLI's real system-prompt channel instead makes
        // Claude treat it as genuine. Set via setSystemPromptAppend(); callers
        // should NOT write this field directly after construction.
        QString systemPromptAppend;
    };

    explicit ClaudeBrain(Options opts, QObject *parent = nullptr);
    ~ClaudeBrain() override;

    void send(const QString &text, const QStringList &images = {}) override;
    void cancel() override;
    bool isBusy() const override;
    // Accumulates into Options::systemPromptAppend (never replaces) so a later
    // call — e.g. the co-work guide firing on a LATER turn than the policy
    // preamble did — can never silently drop text an earlier call already set.
    void setSystemPromptAppend(const QString &text) override;

    // Build the `claude` argv for a one-shot `-p` turn. Public so a ctest can
    // assert the prompt is an isolated trailing positional after `--` (guards the
    // prior --add-dir regression where the variadic flag swallowed the prompt).
    // NOT const: it also (re)writes this turn's system-prompt temp file, so argv
    // carries only a path — see writeSystemPromptFile().
    QStringList buildArgs(const QString &prompt, const QStringList &images = {});

private slots:
    void onReadyReadStdout();
    void onReadyReadStderr();
    void onFinished(int exitCode, QProcess::ExitStatus status);
    void onErrorOccurred(QProcess::ProcessError error);

private:
    void emitEvent(const NormalizedBrainEvent &ev);
    void drainBuffer(bool flushIncomplete);
    void handleLine(const QByteArray &line);
    // Mark the workspace (cwd) trusted in CLAUDE_CONFIG_DIR/.claude.json so headless
    // `claude -p` honors the project's permissions.allow instead of "Ignoring N
    // permissions.allow entries ... this workspace has not been trusted". No CLI flag
    // skips the trust gate, so the config must be pre-populated. Idempotent; merges.
    void ensureWorkspaceTrusted();
    // Spill Options::systemPromptAppend to a 0600 temp file and return its path (empty
    // on failure -> caller falls back to the inline flag). WHY A FILE: that text is the
    // daemon's co-work guide + policy preamble, ~17 KB and growing, and an argument that
    // big overflows the command line. On Windows a `claude` on PATH is usually a .cmd
    // shim, which CliResolve launches via `cmd.exe /c` — and cmd.exe hard-caps the whole
    // command line at 8191 chars, so the turn died with "The command line is too long."
    // + "claude exited with code 1" before ever reaching the model. Replaces the
    // previous turn's file, so only one exists per brain at a time.
    QString writeSystemPromptFile();
    // Remove the current system-prompt temp file, if any.
    void clearSystemPromptFile();

    Options m_opts;
    QProcess *m_proc = nullptr;
    QByteArray m_stdoutBuf;
    bool m_busy = false;
    bool m_sawFinal = false; // saw the terminal result -> final
    QString m_mcpConfigPath;  // temp file holding mcpConfigJson (cleaned per turn)
    QString m_sysPromptPath;  // temp file holding systemPromptAppend (cleaned per turn)
    // Conversation continuity: a fixed session UUID set on the first turn via
    // --session-id, then --resume'd on every later turn so the model KEEPS the
    // whole conversation instead of starting cold each message.
    QString m_claudeSessionId;
    bool m_started = false;
};

} // namespace jarvis
