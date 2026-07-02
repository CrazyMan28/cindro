#include "jarvis/CodexBrain.h"

#include "jarvis/CliResolve.h"
#include "jarvis/CodexParser.h"

#include <QProcessEnvironment>
#include <QStringList>
#include <QDir>
#include <QFile>
#include <QFileInfo>

#ifdef Q_OS_WIN
#include <filesystem>
#include <system_error>
#endif

namespace jarvis {

QString CodexBrain::ensureIsolatedHome() const
{
    if (m_opts.codexHome.isEmpty())
        return QString();

    const QString home = m_opts.codexHome;
    QDir().mkpath(home);

    const QString realCodex = QDir::homePath() + QStringLiteral("/.codex");

    // Mirror auth so the logged-in account still works. POSIX: a symlink, so
    // token refresh writes through to the real file. Windows: QFile::link()
    // does NOT symlink — it saves a binary IShellLink (.lnk) payload into the
    // destination file itself, and codex reading that as auth.json dies with
    // "stream did not contain valid UTF-8" (exit 1). There we hard-link (same
    // write-through when codex updates the file in place) and fall back to a
    // plain copy, re-mirroring every launch so a .lnk-corrupted file left by
    // an earlier build self-heals and the token stays fresh.
    for (const QString &f : { QStringLiteral("auth.json"), QStringLiteral("version.json") }) {
        const QString src = realCodex + QStringLiteral("/") + f;
        const QString dst = home + QStringLiteral("/") + f;
#ifdef Q_OS_WIN
        QFile::remove(dst);
        if (QFile::exists(src)) {
            std::error_code ec;
            std::filesystem::create_hard_link(
                std::filesystem::path(src.toStdWString()),
                std::filesystem::path(dst.toStdWString()), ec);
            if (ec)
                QFile::copy(src, dst);
        }
#else
        if (QFile::exists(src) && !QFileInfo::exists(dst))
            QFile::link(src, dst);
#endif
    }

    // Copy the user's config.toml but STRIP every [mcp_servers.*] table, so codex
    // sees ONLY the daemon-injected computer-use server (added via -c overrides) —
    // never hand-desktop / desktop-use / vm-* (which drive the user's REAL screen).
    // Preserve all non-MCP settings (model provider, base instructions, etc.).
    QString out;
    QFile in(realCodex + QStringLiteral("/config.toml"));
    if (in.open(QIODevice::ReadOnly | QIODevice::Text)) {
        bool inMcpTable = false;
        const QByteArray raw = in.readAll();
        in.close();
        const QList<QByteArray> lines = raw.split('\n');
        for (const QByteArray &lineRaw : lines) {
            const QString line = QString::fromUtf8(lineRaw);
            const QString trimmed = line.trimmed();
            if (trimmed.startsWith(QLatin1Char('['))) {
                // A new table header — does it belong to mcp_servers?
                inMcpTable = trimmed.startsWith(QStringLiteral("[mcp_servers"));
            }
            if (!inMcpTable)
                out += line + QLatin1Char('\n');
        }
    }
    out = QStringLiteral("# Jarvis-isolated CODEX_HOME — user [mcp_servers.*] stripped so the\n"
                         "# co-work brain can ONLY use the injected nested computer-use engine.\n")
          + out;
    QFile cfg(home + QStringLiteral("/config.toml"));
    if (cfg.open(QIODevice::WriteOnly | QIODevice::Text))
        cfg.write(out.toUtf8());

    return home;
}

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
    // Driving the computer-use MCP headless requires danger-full-access; any
    // narrower sandbox makes codex auto-cancel every MCP tool call. The caller
    // (daemon) only ever sets driveMcp for a coworker+agent session that drives
    // the agent's OWN isolated nested desktop, so this never loosens access to
    // the user's real machine.
    if (m_opts.driveMcp)
        m_opts.sandboxMode = QStringLiteral("danger-full-access");
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

QStringList CodexBrain::buildArgs(const QString &prompt, const QStringList &images) const
{
    QStringList args;
    args << QStringLiteral("exec");
    // Continue the SAME conversation across turns: after the first turn we have a
    // thread id, so resume it (codex exec resume <id>) — otherwise codex starts
    // fresh every message and "forgets" what was said.
    const bool resuming = !m_threadId.isEmpty();
    if (resuming)
        args << QStringLiteral("resume") << m_threadId;
    args << QStringLiteral("--json")
         // Run even when cwd is not a git repo / trusted dir (e.g. $HOME).
         << QStringLiteral("--skip-git-repo-check");
    // ALWAYS fully ignore the user's codex config — NOT just the global
    // ~/.codex/config.toml (also handled by the isolated CODEX_HOME) but also the
    // PROJECT-LOCAL config codex discovers from the cwd (e.g. cwd=$HOME finds
    // ~/.codex/config.toml again). Without this a Jarvis session inherits the
    // user's hand-desktop/desktop-use/vm-* mcp_servers. Injected Jarvis servers
    // arrive via `-c mcp_servers.*` overrides, which apply regardless of this flag.
    // Verified gpt-5.5 still resolves via auth.json under the isolated home.
    args << QStringLiteral("--ignore-user-config");
    if (resuming) {
        // `codex exec resume` does NOT accept --sandbox or -C (it keeps the
        // resumed session's cwd). When driving the computer-use MCP, bypass
        // approvals+sandbox — the resume-supported equivalent of
        // `--sandbox danger-full-access -c approval_policy=never` — so codex
        // doesn't auto-cancel MCP tool calls headless.
        if (m_opts.driveMcp)
            args << QStringLiteral("--dangerously-bypass-approvals-and-sandbox");
    } else {
        // First turn: the sandbox mode constrains writes; danger-full-access is
        // forced by the ctor when driving (codex auto-cancels MCP calls otherwise).
        args << QStringLiteral("--sandbox") << m_opts.sandboxMode;
        // `codex exec` has NO -a/--ask-for-approval flag, so approval_policy MUST
        // go through `-c`.
        if (m_opts.driveMcp)
            args << QStringLiteral("-c") << QStringLiteral("approval_policy=\"never\"");
        if (!m_opts.cwd.isEmpty())
            args << QStringLiteral("-C") << m_opts.cwd;
    }
    if (!m_opts.model.isEmpty())
        args << QStringLiteral("-m") << m_opts.model;
    for (const QString &override : m_opts.configOverrides)
        args << QStringLiteral("-c") << override;
    // Multimodal: attach each image file so the vision model SEES it. `codex exec`
    // takes `-i/--image <FILE>` (repeatable). Paths come from the daemon, which
    // decoded the phone's {mime,b64} attachments to files.
    for (const QString &img : images) {
        if (!img.isEmpty())
            args << QStringLiteral("--image") << img;
    }
    // `-i/--image <FILE>...` is VARIADIC, so a prompt placed after it is swallowed
    // as another image path — codex then finds no PROMPT positional and reads stdin
    // ("Reading prompt from stdin… / No prompt provided via stdin.", exit 1) the
    // moment you send a photo with text. Terminate option parsing with `--` so the
    // prompt is unambiguously the positional whenever images are attached.
    if (!images.isEmpty())
        args << QStringLiteral("--");
    // Prompt is the positional argument.
    args << prompt;
    return args;
}

void CodexBrain::send(const QString &text, const QStringList &images)
{
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
    QString program = m_opts.program;
    QStringList args = buildArgs(text, images);
    jarvis::resolveCliLaunch(program, args);
    m_proc->setProgram(program);
    m_proc->setArguments(args);
    m_proc->setProcessChannelMode(QProcess::SeparateChannels);
    // Export MCP bearer tokens that the `-c ...bearer_token_env_var=<NAME>`
    // overrides reference, plus an isolated CODEX_HOME when set (so codex can't
    // reach the user's global MCP servers / real desktop). Without the bearers,
    // codex starts the HTTP MCP server with no Authorization header and the engine
    // rejects every tool call.
    const QString isoHome = ensureIsolatedHome();
    if (!m_opts.extraEnv.isEmpty() || !isoHome.isEmpty()) {
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        for (auto it = m_opts.extraEnv.constBegin(); it != m_opts.extraEnv.constEnd(); ++it)
            env.insert(it.key(), it.value());
        if (!isoHome.isEmpty())
            env.insert(QStringLiteral("CODEX_HOME"), isoHome);
        m_proc->setProcessEnvironment(env);
    }
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
            // Remember the conversation id so the NEXT turn can `resume` it.
            if (ev->kind == NormalizedBrainEvent::Kind::ThreadStarted) {
                const QString tid = ev->threadId();
                if (!tid.isEmpty())
                    m_threadId = tid;
            }
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
