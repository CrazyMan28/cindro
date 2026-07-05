// ctest: GitOps — the diff.* verb engine. Real `git` in a temp repo: stage /
// revertFile / commit roundtrip, containment guards, honest failures
// (nothing-to-commit, revert-untracked, openPr with no remote — network-free).

#include "jarvis/GitOps.h"

#include <QCoreApplication>
#include <QFile>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::GitOps;
using jarvis::GitResult;

namespace {
int g_failures = 0;
void check(bool cond, const char *msg)
{
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", msg); ++g_failures; }
    else { std::fprintf(stderr, "ok: %s\n", msg); }
}

bool writeFile(const QString &path, const QByteArray &content)
{
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    f.write(content);
    return true;
}

QByteArray readFile(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return {};
    return f.readAll();
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // Isolate from the developer's global git config (gpg signing, hooks path,
    // etc. would otherwise leak into the temp repo's commit behavior).
    qputenv("GIT_CONFIG_GLOBAL", "/dev/null");
    qputenv("GIT_CONFIG_SYSTEM", "/dev/null");

    // Containment guard is pure logic — no repo needed.
    check(GitOps::pathInside(QStringLiteral("a.txt")), "plain filename allowed");
    check(GitOps::pathInside(QStringLiteral("sub/dir/a.txt")), "nested path allowed");
    check(!GitOps::pathInside(QStringLiteral("../escape.txt")), "../ rejected");
    check(!GitOps::pathInside(QStringLiteral("sub/../../escape")), "buried .. rejected");
    check(!GitOps::pathInside(QStringLiteral("/etc/passwd")), "absolute path rejected");
    check(!GitOps::pathInside(QString()), "empty path rejected");

    QTemporaryDir tmp;
    check(tmp.isValid(), "temp dir created");
    const QString repo = tmp.path();

    check(!GitOps::isRepo(repo), "bare temp dir is not a repo");

    check(GitOps::git(repo, {QStringLiteral("init"), QStringLiteral("-q")}).ok, "git init");
    GitOps::git(repo, {QStringLiteral("config"), QStringLiteral("user.email"),
                       QStringLiteral("t@test.local")});
    GitOps::git(repo, {QStringLiteral("config"), QStringLiteral("user.name"),
                       QStringLiteral("jarvis-test")});
    check(GitOps::isRepo(repo), "initialized dir is a repo");

    // stage + commit roundtrip.
    check(writeFile(repo + QStringLiteral("/a.txt"), "one\n"), "write a.txt");
    check(GitOps::stage(repo, QStringLiteral("a.txt")).ok, "stage a.txt");
    check(GitOps::commit(repo, QStringLiteral("init")).ok, "commit staged file");

    // commit with nothing staged fails honestly (git's own message surfaces).
    const GitResult c2 = GitOps::commit(repo, QString());
    check(!c2.ok, "empty commit fails");
    check(!c2.output.isEmpty(), "empty commit failure carries git's message");

    // revertFile restores HEAD content over staged+worktree edits.
    check(writeFile(repo + QStringLiteral("/a.txt"), "two\n"), "modify a.txt");
    check(GitOps::stage(repo, QStringLiteral("a.txt")).ok, "stage the modification");
    check(GitOps::revertFile(repo, QStringLiteral("a.txt")).ok, "revert a.txt");
    check(readFile(repo + QStringLiteral("/a.txt")) == "one\n", "revert restored content");

    // revert of an untracked file fails with git's own error.
    check(writeFile(repo + QStringLiteral("/new.txt"), "x\n"), "write untracked");
    check(!GitOps::revertFile(repo, QStringLiteral("new.txt")).ok, "revert untracked fails");

    // stage/revert refuse escaping paths without ever running git.
    check(!GitOps::stage(repo, QStringLiteral("../oops")).ok, "stage ../ rejected");
    check(!GitOps::revertFile(repo, QStringLiteral("/abs")).ok, "revert abs rejected");

    // open_pr with no origin fails at the push step (no network, no gh needed).
    check(!GitOps::openPr(repo, QStringLiteral("t")).ok, "openPr without remote fails");

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
