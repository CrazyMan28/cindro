// ctest: guard the CodexBrain DRIVE-mode argv contract.
//
// EMPIRICALLY VERIFIED (codex 0.135.0): `codex exec --json` under any sandbox
// other than `danger-full-access` AUTO-CANCELS every MCP tool call headless
// ("user cancelled MCP tool call") because there is no human to approve the
// per-call escalation. So to let a brain DRIVE the computer-use MCP (which only
// ever happens for a coworker+agent session against the agent's OWN isolated
// nested desktop) CodexBrain must force `--sandbox danger-full-access` and
// `-c approval_policy="never"`. This test fails if either guard is lost, and
// also asserts the NON-drive (default coder) path stays on workspace-write.

#include "jarvis/CodexBrain.h"

#include <QString>
#include <QStringList>

#include <cstdio>

using jarvis::CodexBrain;

namespace {

int g_failures = 0;

void check(bool cond, const char *msg)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        ++g_failures;
    } else {
        std::fprintf(stderr, "ok: %s\n", msg);
    }
}

// True iff `args` contains the consecutive pair {flag, value}.
bool hasPair(const QStringList &args, const QString &flag, const QString &value)
{
    for (int i = 0; i + 1 < args.size(); ++i)
        if (args.at(i) == flag && args.at(i + 1) == value)
            return true;
    return false;
}

} // namespace

int main()
{
    const QString prompt = QStringLiteral("open foot and type echo CODEX_DRIVES");

    // --- DRIVE mode: must force danger-full-access + approval_policy=never ---
    {
        CodexBrain::Options opts;
        opts.profile = QStringLiteral("coworker");
        opts.driveMcp = true;
        opts.cwd = QStringLiteral("/home/user");
        CodexBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);

        check(hasPair(args, QStringLiteral("--sandbox"),
                      QStringLiteral("danger-full-access")),
              "drive mode forces --sandbox danger-full-access");
        check(hasPair(args, QStringLiteral("-c"),
                      QStringLiteral("approval_policy=\"never\"")),
              "drive mode sets -c approval_policy=\"never\"");
        check(args.last() == prompt, "prompt is the trailing positional");
        // never workspace-write in drive mode
        check(!hasPair(args, QStringLiteral("--sandbox"),
                       QStringLiteral("workspace-write")),
              "drive mode is NOT workspace-write");
    }

    // --- NON-drive (default coder): stays workspace-write, no approval flag ---
    {
        CodexBrain::Options opts;
        opts.profile = QStringLiteral("coder");
        // driveMcp defaults false
        CodexBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);

        check(hasPair(args, QStringLiteral("--sandbox"),
                      QStringLiteral("workspace-write")),
              "non-drive coder stays --sandbox workspace-write");
        check(!hasPair(args, QStringLiteral("-c"),
                       QStringLiteral("approval_policy=\"never\"")),
              "non-drive coder does NOT force approval_policy=never");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "codex_buildargs_test: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
