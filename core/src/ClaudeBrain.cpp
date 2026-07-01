#include "jarvis/ClaudeBrain.h"

#include "jarvis/CliResolve.h"
#include "jarvis/ClaudeParser.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcessEnvironment>
#include <QStandardPaths>
#include <QUuid>

namespace jarvis {

ClaudeBrain::ClaudeBrain(Options opts, QObject *parent)
    : Brain(parent), m_opts(std::move(opts))
{
    // Default to the Pro account dir (~/.claude) when the daemon supplies none,
    // so a claude brain turn NEVER falls back to whatever CLAUDE_CONFIG_DIR the
    // ambient environment might carry (e.g. the Max account ~/.claude-secondary).
    if (m_opts.configDir.isEmpty())
        m_opts.configDir = QDir::homePath() + QStringLiteral("/.claude");
    // A stable session id for the whole conversation (set turn 1, resumed after).
    m_claudeSessionId = QUuid::createUuid().toString(QUuid::WithoutBraces);
}

ClaudeBrain::~ClaudeBrain()
{
    if (m_proc) {
        m_proc->disconnect(this);
        if (m_proc->state() != QProcess::NotRunning) {
            m_proc->kill();
            m_proc->waitForFinished(2000);
        }
    }
    if (!m_mcpConfigPath.isEmpty())
        QFile::remove(m_mcpConfigPath);
}

bool ClaudeBrain::isBusy() const
{
    return m_busy;
}

QStringList ClaudeBrain::buildArgs(const QString &prompt, const QStringList &images) const
{
    QStringList args;
    args << QStringLiteral("-p")
         << QStringLiteral("--output-format") << QStringLiteral("stream-json")
         // --verbose is REQUIRED for stream-json to emit per-event lines.
         << QStringLiteral("--verbose");
    if (!m_opts.model.isEmpty())
        args << QStringLiteral("--model") << m_opts.model;
    // NOTE: `--add-dir` is VARIADIC in the claude CLI (it accepts one or more
    // directories), so the separate-token form `--add-dir <dir> "<prompt>"`
    // greedily swallows the trailing positional prompt as a second "directory"
    // and claude then aborts with "Input must be provided ... when using
    // --print". Use the `--add-dir=<dir>` equals form so the flag binds to a
    // single value and never consumes the prompt.
    if (!m_opts.cwd.isEmpty())
        args << (QStringLiteral("--add-dir=") + m_opts.cwd);
    // Grant Read access to the attachment dir(s) so the model can open the images.
    QStringList imgDirs;
    for (const QString &img : images) {
        const QString d = QFileInfo(img).absolutePath();
        if (!d.isEmpty() && !imgDirs.contains(d)) {
            imgDirs << d;
            args << (QStringLiteral("--add-dir=") + d);
        }
    }
    // Conversation continuity: turn 1 fixes the session id; every later turn
    // resumes it so the model keeps the full chat history.
    if (!m_started)
        args << QStringLiteral("--session-id") << m_claudeSessionId;
    else
        args << QStringLiteral("--resume") << m_claudeSessionId;
    if (!m_mcpConfigPath.isEmpty())
        args << QStringLiteral("--mcp-config") << m_mcpConfigPath;
    // ALWAYS isolate: load ONLY the Jarvis --mcp-config servers (the built-in
    // computer-use + whatever the user enabled in Jarvis Settings) and NEVER the
    // CLI's own ~/.claude.json / CLAUDE_CONFIG_DIR mcpServers (project-tracker,
    // desktop-use, vm-*, …). Without --strict-mcp-config claude MERGES both sets,
    // so a plain chat (no --mcp-config) would silently inherit all of them. With
    // no --mcp-config, --strict-mcp-config alone yields ZERO MCP servers — the
    // correct, safe default for a Jarvis session.
    args << QStringLiteral("--strict-mcp-config");
    if (!m_opts.permissionMode.isEmpty())
        args << QStringLiteral("--permission-mode") << m_opts.permissionMode;
    // `--` terminates option parsing so the prompt is unambiguously the sole
    // trailing positional, even if a future variadic flag is added above.
    args << QStringLiteral("--") << prompt;
    return args;
}

void ClaudeBrain::send(const QString &text, const QStringList &images)
{
    if (m_busy) {
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("brain is busy; cancel the current turn first")));
        return;
    }

    // `claude -p` is single-turn; (re)spawn a fresh process per turn.
    if (m_proc) {
        m_proc->disconnect(this);
        if (m_proc->state() != QProcess::NotRunning) {
            m_proc->kill();
            m_proc->waitForFinished(2000);
        }
        m_proc->deleteLater();
        m_proc = nullptr;
    }
    if (!m_mcpConfigPath.isEmpty()) {
        QFile::remove(m_mcpConfigPath);
        m_mcpConfigPath.clear();
    }

    // Write the MCP config (computer-use etc.) to a temp file claude reads.
    if (!m_opts.mcpConfigJson.isEmpty()) {
        const QString dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
        m_mcpConfigPath = dir + QStringLiteral("/jarvis-claude-mcp-") +
                          m_sessionId + QStringLiteral(".json");
        QFile f(m_mcpConfigPath);
        if (f.open(QIODevice::WriteOnly | QIODevice::Text)) {
            f.write(m_opts.mcpConfigJson.toUtf8());
            f.close();
        } else {
            m_mcpConfigPath.clear();
        }
    }

    m_stdoutBuf.clear();
    m_sawFinal = false;
    m_busy = true;

    m_proc = new QProcess(this);
    // Multimodal: `claude -p` has no base64 image flag, but its Read tool renders
    // local image files. The daemon decoded the phone's {mime,b64} attachments to
    // file paths; tell the model to view each, and grant access via --add-dir.
    QString promptText = text;
    if (!images.isEmpty()) {
        QString note = QStringLiteral("\n\n[The user attached %1 image file(s). "
            "View each with your Read tool:").arg(images.size());
        for (const QString &img : images)
            note += QStringLiteral("\n") + img;
        note += QStringLiteral("]");
        promptText += note;
    }
    QString program = m_opts.program;
    QStringList args = buildArgs(promptText, images);
    jarvis::resolveCliLaunch(program, args);
    m_proc->setProgram(program);
    m_proc->setArguments(args);
    if (!m_opts.cwd.isEmpty())
        m_proc->setWorkingDirectory(m_opts.cwd);
    // Pin CLAUDE_CONFIG_DIR so the brain runs as the SELECTED claude account
    // (Pro by default). Set it explicitly rather than inheriting, so the brain
    // never accidentally uses the Max account from the ambient environment.
    {
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        env.insert(QStringLiteral("CLAUDE_CONFIG_DIR"), m_opts.configDir);
        m_proc->setProcessEnvironment(env);
    }
    m_proc->setProcessChannelMode(QProcess::SeparateChannels);
    // Close stdin (EOF) so the one-shot `-p` turn never blocks reading input.
    m_proc->setStandardInputFile(QProcess::nullDevice());

    connect(m_proc, &QProcess::readyReadStandardOutput, this, &ClaudeBrain::onReadyReadStdout);
    connect(m_proc, &QProcess::readyReadStandardError, this, &ClaudeBrain::onReadyReadStderr);
    connect(m_proc, &QProcess::finished, this, &ClaudeBrain::onFinished);
    connect(m_proc, &QProcess::errorOccurred, this, &ClaudeBrain::onErrorOccurred);

    m_proc->start();
    if (!m_proc->waitForStarted(5000)) {
        m_busy = false;
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("failed to start claude: ") + m_proc->errorString()));
        emit turnFinished(m_sessionId);
        return;
    }
}

void ClaudeBrain::cancel()
{
    if (m_proc && m_proc->state() != QProcess::NotRunning) {
        m_proc->terminate();
        if (!m_proc->waitForFinished(2000))
            m_proc->kill();
    }
    if (m_busy) {
        m_busy = false;
        emit turnFinished(m_sessionId);
    }
}

void ClaudeBrain::onReadyReadStdout()
{
    if (!m_proc)
        return;
    m_stdoutBuf += m_proc->readAllStandardOutput();
    drainBuffer(/*flushIncomplete=*/false);
}

void ClaudeBrain::onReadyReadStderr()
{
    if (!m_proc)
        return;
    const QByteArray chunk = m_proc->readAllStandardError();
    for (const QByteArray &rawLine : chunk.split('\n')) {
        const QByteArray line = rawLine.trimmed();
        if (line.isEmpty())
            continue;
        // Filter benign noise: progress/telemetry lines that are not failures.
        if (line.startsWith("npm warn") || line.contains("DeprecationWarning"))
            continue;
        emitEvent(NormalizedBrainEvent::error(QString::fromUtf8(line)));
    }
}

void ClaudeBrain::handleLine(const QByteArray &line)
{
    for (const NormalizedBrainEvent &ev : parseClaudeLine(line)) {
        emitEvent(ev);
        if (ev.kind == NormalizedBrainEvent::Kind::Final)
            m_sawFinal = true;
    }
}

void ClaudeBrain::drainBuffer(bool flushIncomplete)
{
    int nl;
    while ((nl = m_stdoutBuf.indexOf('\n')) >= 0) {
        const QByteArray line = m_stdoutBuf.left(nl);
        m_stdoutBuf.remove(0, nl + 1);
        handleLine(line);
    }
    if (flushIncomplete && !m_stdoutBuf.trimmed().isEmpty()) {
        handleLine(m_stdoutBuf);
        m_stdoutBuf.clear();
    }
}

void ClaudeBrain::onFinished(int exitCode, QProcess::ExitStatus status)
{
    drainBuffer(/*flushIncomplete=*/true);

    if (status == QProcess::CrashExit) {
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("claude crashed (exit ") + QString::number(exitCode) +
            QStringLiteral(")")));
    } else if (exitCode != 0 && !m_sawFinal) {
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("claude exited with code ") + QString::number(exitCode)));
    }

    // Guarantee a terminal final even if the stream ended without a result line.
    if (!m_sawFinal)
        emitEvent(NormalizedBrainEvent::final_());

    if (!m_mcpConfigPath.isEmpty()) {
        QFile::remove(m_mcpConfigPath);
        m_mcpConfigPath.clear();
    }

    // After the first non-crash turn the session exists; resume it from now on so
    // the conversation context carries forward.
    if (status != QProcess::CrashExit)
        m_started = true;

    m_busy = false;
    emit turnFinished(m_sessionId);
}

void ClaudeBrain::onErrorOccurred(QProcess::ProcessError error)
{
    if (error == QProcess::FailedToStart) {
        m_busy = false;
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("claude failed to start: ") +
            (m_proc ? m_proc->errorString() : QStringLiteral("unknown"))));
        emit turnFinished(m_sessionId);
    }
}

void ClaudeBrain::emitEvent(const NormalizedBrainEvent &ev)
{
    emit event(m_sessionId, ev);
}

} // namespace jarvis
