#include "jarvis/CodexBrain.h"

#include "jarvis/CodexParser.h"

#include <QStringList>

namespace jarvis {

QString CodexBrain::sandboxForProfile(const QString &profile)
{
    // Both profiles use workspace-write per BUILD_SPEC; coworker additionally
    // loads the computer-use MCP (config injected by the daemon), but the
    // sandbox mode itself is the same.
    Q_UNUSED(profile);
    return QStringLiteral("workspace-write");
}

CodexBrain::CodexBrain(Options opts, QObject *parent)
    : Brain(parent), m_opts(std::move(opts))
{
    if (m_opts.sandboxMode.isEmpty())
        m_opts.sandboxMode = sandboxForProfile(m_opts.profile);
}

CodexBrain::~CodexBrain()
{
    if (m_proc) {
        m_proc->disconnect(this);
        if (m_proc->state() != QProcess::NotRunning) {
            m_proc->kill();
            m_proc->waitForFinished(2000);
        }
    }
}

bool CodexBrain::isBusy() const
{
    return m_busy;
}

QStringList CodexBrain::buildArgs(const QString &prompt) const
{
    QStringList args;
    args << QStringLiteral("exec")
         << QStringLiteral("--json")
         << QStringLiteral("--sandbox") << m_opts.sandboxMode;
    if (!m_opts.cwd.isEmpty())
        args << QStringLiteral("-C") << m_opts.cwd;
    if (!m_opts.model.isEmpty())
        args << QStringLiteral("-m") << m_opts.model;
    for (const QString &override : m_opts.configOverrides)
        args << QStringLiteral("-c") << override;
    // Prompt is the positional argument.
    args << prompt;
    return args;
}

void CodexBrain::send(const QString &text, const QStringList &images)
{
    Q_UNUSED(images); // image attachment wiring lands with the multimodal wave

    if (m_busy) {
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("brain is busy; cancel the current turn first")));
        return;
    }

    // `codex exec` is single-turn; (re)spawn a fresh process per turn.
    if (m_proc) {
        m_proc->disconnect(this);
        if (m_proc->state() != QProcess::NotRunning) {
            m_proc->kill();
            m_proc->waitForFinished(2000);
        }
        m_proc->deleteLater();
        m_proc = nullptr;
    }

    m_stdoutBuf.clear();
    m_sawUsage = false;
    m_busy = true;

    m_proc = new QProcess(this);
    m_proc->setProgram(m_opts.program);
    m_proc->setArguments(buildArgs(text));
    m_proc->setProcessChannelMode(QProcess::SeparateChannels);

    connect(m_proc, &QProcess::readyReadStandardOutput, this, &CodexBrain::onReadyReadStdout);
    connect(m_proc, &QProcess::readyReadStandardError, this, &CodexBrain::onReadyReadStderr);
    connect(m_proc, &QProcess::finished, this, &CodexBrain::onFinished);
    connect(m_proc, &QProcess::errorOccurred, this, &CodexBrain::onErrorOccurred);

    m_proc->start();
    if (!m_proc->waitForStarted(5000)) {
        m_busy = false;
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("failed to start codex: ") + m_proc->errorString()));
        emit turnFinished(m_sessionId);
        return;
    }

    // Close stdin immediately so codex sees EOF and does not block reading
    // additional input from stdin (verified gotcha, spikes/RESULTS.md).
    m_proc->closeWriteChannel();
}

void CodexBrain::cancel()
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

void CodexBrain::onReadyReadStdout()
{
    if (!m_proc)
        return;
    m_stdoutBuf += m_proc->readAllStandardOutput();
    drainBuffer(/*flushIncomplete=*/false);
}

void CodexBrain::onReadyReadStderr()
{
    if (!m_proc)
        return;
    const QByteArray err = m_proc->readAllStandardError().trimmed();
    if (!err.isEmpty()) {
        // Surface codex stderr as a low-priority normalized error/thinking
        // line; keep it as error so the UI can show diagnostics.
        emitEvent(NormalizedBrainEvent::error(QString::fromUtf8(err)));
    }
}

void CodexBrain::drainBuffer(bool flushIncomplete)
{
    int nl;
    while ((nl = m_stdoutBuf.indexOf('\n')) >= 0) {
        const QByteArray line = m_stdoutBuf.left(nl);
        m_stdoutBuf.remove(0, nl + 1);
        if (auto ev = parseCodexLine(line)) {
            emitEvent(*ev);
            if (ev->kind == NormalizedBrainEvent::Kind::Usage && !m_sawUsage) {
                m_sawUsage = true;
                emitEvent(NormalizedBrainEvent::final_());
            }
        }
    }
    if (flushIncomplete && !m_stdoutBuf.trimmed().isEmpty()) {
        if (auto ev = parseCodexLine(m_stdoutBuf)) {
            emitEvent(*ev);
            if (ev->kind == NormalizedBrainEvent::Kind::Usage && !m_sawUsage) {
                m_sawUsage = true;
                emitEvent(NormalizedBrainEvent::final_());
            }
        }
        m_stdoutBuf.clear();
    }
}

void CodexBrain::onFinished(int exitCode, QProcess::ExitStatus status)
{
    // Flush any trailing partial line.
    drainBuffer(/*flushIncomplete=*/true);

    if (status == QProcess::CrashExit) {
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("codex crashed (exit ") + QString::number(exitCode) +
            QStringLiteral(")")));
    } else if (exitCode != 0 && !m_sawUsage) {
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("codex exited with code ") + QString::number(exitCode)));
    }

    // Guarantee a terminal `final` if codex ended without a usage/final.
    if (!m_sawUsage)
        emitEvent(NormalizedBrainEvent::final_());

    m_busy = false;
    emit turnFinished(m_sessionId);
}

void CodexBrain::onErrorOccurred(QProcess::ProcessError error)
{
    if (error == QProcess::FailedToStart) {
        m_busy = false;
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("codex failed to start: ") +
            (m_proc ? m_proc->errorString() : QStringLiteral("unknown"))));
        emit turnFinished(m_sessionId);
    }
}

void CodexBrain::emitEvent(const NormalizedBrainEvent &ev)
{
    emit event(m_sessionId, ev);
}

} // namespace jarvis
