#pragma once

// GitOps — the daemon-side git actions behind the diff.* verbs
// (diff.stage / diff.revert / diff.commit / diff.open_pr), shared by the
// desktop DiffReviewPanel and the TUI's /stage /commit /revert /openpr slash
// commands. Until this class existed those verbs were UI-only vapor: both
// frontends sent them and the daemon answered unknown_method.
//
// Pure QProcess wrappers (no libgit2): each call runs git (or gh for PRs) in
// the session's working directory with argument-list spawning (never a
// shell), merged output, and a hard timeout. Callers surface .output verbatim
// so the user sees git's own honest error text ("nothing to commit", ...).

#include <QString>
#include <QStringList>

namespace jarvis {

struct GitResult {
    bool ok = false;   // process ran, exited normally, exit code 0
    int exitCode = -1; // -1 => failed to launch / timed out / guarded
    QString output;    // merged stdout+stderr, trimmed
};

class GitOps {
public:
    // Run `program args...` in workdir with merged output. Kills the process
    // at timeoutMs (result.exitCode stays -1, output says what happened).
    static GitResult run(const QString &workdir, const QString &program,
                         const QStringList &args, int timeoutMs = 30000);

    static GitResult git(const QString &workdir, const QStringList &args,
                         int timeoutMs = 30000);

    // True when workdir is inside a git work tree.
    static bool isRepo(const QString &workdir);

    // Containment guard for user-supplied file paths: must be relative and
    // must not escape the workdir via "..". Absolute paths are rejected.
    static bool pathInside(const QString &relPath);

    // git add -- <path>
    static GitResult stage(const QString &workdir, const QString &path);

    // git checkout HEAD -- <path>: discard local (staged + worktree) changes.
    // Untracked files fail with git's own error — honest, never silent.
    static GitResult revertFile(const QString &workdir, const QString &path);

    // git commit -m <message> (staged changes only — staging stays an
    // explicit separate action). An empty message gets a default.
    static GitResult commit(const QString &workdir, const QString &message);

    // git push -u origin <current branch>, then `gh pr create`. On success
    // .output is the PR URL (the last http(s) line gh prints).
    static GitResult openPr(const QString &workdir, const QString &title);
};

} // namespace jarvis
