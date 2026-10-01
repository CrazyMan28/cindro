#pragma once

// Resolve a CLI brain program (codex/claude) to a launchable (program, args) pair.
//
// WHY: on Windows a globally-installed CLI is often an npm shim — `claude.cmd` /
// `codex.cmd` (plus a `.ps1`) — or a native `claude.exe`. QProcess::start("claude")
// with a bare name hands "claude" to CreateProcess, which only launches a real PE:
// it will NOT find a `.cmd` on PATH and CANNOT execute a batch shim directly, so the
// spawn dies with "The system cannot find the file specified" — even though
// QStandardPaths::findExecutable (which honors PATHEXT) reports the brain as present.
// That mismatch is exactly why the picker shows claude as available but the turn fails.
//
// This resolves the program via findExecutable (full path + real extension) and, for a
// `.cmd`/`.bat` shim, launches it through cmd.exe /c. A native `.exe` is launched by its
// full path directly (no shell, no quoting surprises). On non-Windows this is a no-op,
// so the Linux/macOS launch path is byte-for-byte unchanged.

#include <QProcess>
#include <QString>
#include <QStringList>
#ifdef Q_OS_WINDOWS
#include <QStandardPaths>
#endif

namespace jarvis {

inline void resolveCliLaunch(QString &program, QStringList &args)
{
#ifdef Q_OS_WINDOWS
    // Prefer a NATIVE <program>.exe over whatever shim PATH order finds first. A bare
    // "claude" resolves to the first of claude.cmd / claude / claude.exe on PATH, and a
    // user's own `claude.cmd` wrapper (VM-mode launchers, etc.) wins over the real
    // binary: Cindro would then run cmd -> pwsh -> script -> claude, the wrapper would
    // run its side effects (rewriting the user's mode.json / ~/.claude.json on every
    // turn), and Stop would have to chase a deeper process tree. Launching the exe
    // directly is faster, has no wrapper side effects, and makes cancel kill exactly
    // the agent process. Falls back to the old lookup when no native exe exists
    // (e.g. codex, an npm .cmd shim).
    QString resolved;
    if (!program.contains(QLatin1Char('.')) && !program.contains(QLatin1Char('\\')) &&
        !program.contains(QLatin1Char('/')))
        resolved = QStandardPaths::findExecutable(program + QStringLiteral(".exe"));
    if (resolved.isEmpty())
        resolved = QStandardPaths::findExecutable(program);
    if (resolved.isEmpty())
        return; // not on PATH → leave as-is; QProcess emits a clear FailedToStart error.

    const QString lower = resolved.toLower();
    if (lower.endsWith(QLatin1String(".cmd")) || lower.endsWith(QLatin1String(".bat"))) {
        // A batch shim can't be launched by CreateProcess directly; go through the
        // command processor: cmd.exe /c <full\path\shim.cmd> <original args...>.
        args.prepend(resolved);
        args.prepend(QStringLiteral("/c"));
        QString comspec = QString::fromLocal8Bit(qgetenv("ComSpec"));
        program = comspec.isEmpty() ? QStringLiteral("cmd.exe") : comspec;
    } else {
        // Native .exe/.com (e.g. Claude Code's Windows installer): launch by full path.
        program = resolved;
    }
#else
    Q_UNUSED(program);
    Q_UNUSED(args);
#endif
}

// Kill a CLI brain AND everything it spawned. On Windows the brain runs as
// `cmd.exe /c codex.cmd` -> node -> codex.exe, and QProcess::terminate()/kill() only
// reach the direct child (cmd.exe): the real agent keeps running and keeps driving
// the screen after the user hits Stop. taskkill /T walks the whole tree. Elsewhere
// this is the usual terminate-then-kill.
inline void killProcessTree(QProcess *p)
{
    if (!p || p->state() == QProcess::NotRunning)
        return;
#ifdef Q_OS_WINDOWS
    const qint64 pid = p->processId();
    if (pid > 0)
        QProcess::execute(QStringLiteral("taskkill"),
                          {QStringLiteral("/PID"), QString::number(pid),
                           QStringLiteral("/T"), QStringLiteral("/F")});
    if (p->state() != QProcess::NotRunning)
        p->kill();
    p->waitForFinished(2000);
#else
    p->terminate();
    if (!p->waitForFinished(2000))
        p->kill();
#endif
}

} // namespace jarvis
