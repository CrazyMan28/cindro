#include "jarvis/GitOps.h"

#include <QDir>
#include <QProcess>

namespace jarvis {

GitResult GitOps::run(const QString &workdir, const QString &program,
                      const QStringList &args, int timeoutMs)
{
    GitResult r;
    QProcess p;
    p.setWorkingDirectory(workdir);
    p.setProcessChannelMode(QProcess::MergedChannels);
    p.start(program, args);
    if (!p.waitForStarted(5000)) {
        r.output = program + QStringLiteral(" failed to start (not installed?)");
        return r;
    }
    if (!p.waitForFinished(timeoutMs)) {
        p.kill();
        p.waitForFinished(2000);
        r.output = program + QStringLiteral(" timed out after %1ms").arg(timeoutMs);
        return r;
    }
    r.output = QString::fromUtf8(p.readAll()).trimmed();
    r.exitCode = p.exitCode();
    r.ok = p.exitStatus() == QProcess::NormalExit && p.exitCode() == 0;
    return r;
}

GitResult GitOps::git(const QString &workdir, const QStringList &args, int timeoutMs)
{
    return run(workdir, QStringLiteral("git"), args, timeoutMs);
}

bool GitOps::isRepo(const QString &workdir)
{
    const GitResult r = git(workdir, {QStringLiteral("rev-parse"),
                                      QStringLiteral("--is-inside-work-tree")});
    return r.ok && r.output == QStringLiteral("true");
}

bool GitOps::pathInside(const QString &relPath)
{
    if (relPath.trimmed().isEmpty() || QDir::isAbsolutePath(relPath))
        return false;
    const QString clean = QDir::cleanPath(relPath);
    return clean != QStringLiteral("..") && !clean.startsWith(QStringLiteral("../"));
}

GitResult GitOps::stage(const QString &workdir, const QString &path)
{
    if (!pathInside(path))
        return {false, -1, QStringLiteral("path escapes the session workdir: ") + path};
    return git(workdir, {QStringLiteral("add"), QStringLiteral("--"), path});
}

GitResult GitOps::revertFile(const QString &workdir, const QString &path)
{
    if (!pathInside(path))
        return {false, -1, QStringLiteral("path escapes the session workdir: ") + path};
    return git(workdir, {QStringLiteral("checkout"), QStringLiteral("HEAD"),
                         QStringLiteral("--"), path});
}

GitResult GitOps::commit(const QString &workdir, const QString &message)
{
    const QString msg = message.trimmed().isEmpty()
        ? QStringLiteral("orin: apply reviewed changes")
        : message.trimmed();
    return git(workdir, {QStringLiteral("commit"), QStringLiteral("-m"), msg});
}

GitResult GitOps::openPr(const QString &workdir, const QString &title)
{
    const GitResult branch = git(workdir, {QStringLiteral("rev-parse"),
                                           QStringLiteral("--abbrev-ref"),
                                           QStringLiteral("HEAD")});
    if (!branch.ok)
        return branch;
    if (branch.output == QStringLiteral("HEAD"))
        return {false, -1,
                QStringLiteral("detached HEAD — check out a branch first")};

    const GitResult push = git(workdir, {QStringLiteral("push"), QStringLiteral("-u"),
                                         QStringLiteral("origin"), branch.output},
                               60000);
    if (!push.ok)
        return push;

    QStringList args{QStringLiteral("pr"), QStringLiteral("create")};
    if (title.trimmed().isEmpty())
        args << QStringLiteral("--fill");
    else
        args << QStringLiteral("--title") << title.trimmed()
             << QStringLiteral("--body") << QString();
    GitResult pr = run(workdir, QStringLiteral("gh"), args, 60000);
    if (pr.ok) {
        // gh prints the PR URL last — surface just the URL.
        const QStringList lines = pr.output.split(QLatin1Char('\n'), Qt::SkipEmptyParts);
        for (auto it = lines.rbegin(); it != lines.rend(); ++it) {
            if (it->startsWith(QStringLiteral("http"))) {
                pr.output = it->trimmed();
                break;
            }
        }
    }
    return pr;
}

} // namespace jarvis
