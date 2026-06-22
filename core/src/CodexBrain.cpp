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
         // Run even when cwd is not a git repo / trusted dir (e.g. $HOME); the
         // sandbox mode is what actually constrains writes.
         << QStringLiteral("--skip-git-repo-check")
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
    // Redirect stdin from /dev/null BEFORE start so codex sees EOF immediately
    // and never blocks "Reading additional input from stdin..." (verified
    // gotcha, spikes/RESULTS.md). This is the equivalent of `</dev/null`.
    m_proc->setStandardInputFile(QProcess::nullDevice());

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
    const QByteArray chunk = m_proc->readAllStandardError();
    // codex writes diagnostics line-by-line on stderr. Surface them as error
    // events, but filter benign/noisy lines that are not real turn failures:
    //   - "Reading additional input from stdin..." (informational; emitted
    //     even though we close stdin — never a failure),
    //   - rmcp transport worker errors for the user's GLOBAL ~/.codex MCP
    //     servers being unreachable (orthogonal to this turn).
    for (const QByteArray &rawLine : chunk.split('\n')) {
        const QByteArray line = rawLine.trimmed();
        if (line.isEmpty())
            continue;
        if (line.contains("Reading additional input from stdin"))
            continue;
        if (line.contains("rmcp::transport") || line.contains("worker quit with fatal"))
            continue;
        emitEvent(NormalizedBrainEvent::error(QString::fromUtf8(line)));
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
