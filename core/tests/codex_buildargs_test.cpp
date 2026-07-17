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
        // The prompt is fed on STDIN (cmd.exe-safe on Windows), so the trailing
        // positional is codex's `-` stdin sentinel and the prompt is NEVER in argv.
        check(args.last() == QStringLiteral("-"),
              "trailing positional is `-` (prompt read from stdin)");
        check(!args.contains(prompt),
              "prompt is NOT on the command line (fed via stdin, cmd.exe-safe)");
        // never workspace-write in drive mode
        check(!hasPair(args, QStringLiteral("--sandbox"),
                       QStringLiteral("workspace-write")),
              "drive mode is NOT workspace-write");
    }

    // --- PLAN MODE + drive: sandboxMode="read-only" is OVERRIDDEN back to
    // danger-full-access by the ctor whenever driveMcp is set (see the class
    // comment above and CodexBrain's ctor) — Plan Mode for Codex sessions is
    // therefore enforced for MCP tools only (by computer_use_mcp/policy.py),
    // NOT by this sandbox flag, whenever computer-use is injected. This test
    // documents that as INTENTIONAL, guarded behavior, not a latent bug.
    {
        CodexBrain::Options opts;
        opts.profile = QStringLiteral("coworker");
        opts.driveMcp = true;
        opts.sandboxMode = QStringLiteral("read-only"); // what makeBrain() sets in PLAN mode
        opts.cwd = QStringLiteral("/home/user");
        CodexBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);

        check(hasPair(args, QStringLiteral("--sandbox"),
                      QStringLiteral("danger-full-access")),
              "plan mode + drive: sandboxMode=read-only is still overridden to "
              "danger-full-access (native codex tools are NOT hard-blocked here)");
        check(!hasPair(args, QStringLiteral("--sandbox"), QStringLiteral("read-only")),
              "plan mode + drive: read-only sandbox never actually reaches argv");
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
        // ISOLATION: even a non-drive coder turn MUST --ignore-user-config so it
        // never inherits the user's ~/.codex mcp_servers (hand-desktop/desktop-use).
        check(args.contains(QStringLiteral("--ignore-user-config")),
              "--ignore-user-config ALWAYS present (no CLI mcp_servers leak)");
    }

    // --- MULTIMODAL: each attached image becomes `--image <path>` ---
    {
        CodexBrain::Options opts;
        opts.profile = QStringLiteral("coworker");
        CodexBrain brain(opts);
        const QStringList imgs{QStringLiteral("/tmp/a.png"), QStringLiteral("/tmp/b.jpg")};
        const QStringList args = brain.buildArgs(prompt, imgs);
        check(hasPair(args, QStringLiteral("--image"), QStringLiteral("/tmp/a.png")),
              "image 1 passed as --image <path>");
        check(hasPair(args, QStringLiteral("--image"), QStringLiteral("/tmp/b.jpg")),
              "image 2 passed as --image <path>");
        check(args.last() == QStringLiteral("-"),
              "stdin sentinel `-` still trailing after images");
        check(!args.contains(prompt),
              "prompt still off the command line with images attached");
        // `-i/--image <FILE>...` is variadic, so without a `--` terminator codex
        // swallows the `-` stdin sentinel as another image path. The `-` MUST be
        // preceded by `--` whenever images are attached.
        const int dashIdx = args.lastIndexOf(QStringLiteral("-"));
        check(dashIdx > 0 && args.at(dashIdx - 1) == QStringLiteral("--"),
              "stdin `-` is separated from variadic --image by a `--` terminator");
        // no spurious --image / `--` when there are no attachments
        const QStringList none = brain.buildArgs(prompt);
        check(none.last() == QStringLiteral("-"),
              "stdin sentinel `-` trailing with no images");
        check(!none.contains(QStringLiteral("--image")),
              "no --image when no attachments");
        check(!none.contains(QStringLiteral("--")),
              "no `--` terminator when there are no images");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "codex_buildargs_test: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
