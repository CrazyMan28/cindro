// ctest: guard the ClaudeBrain argv shape — specifically that the user PROMPT is
// an isolated trailing positional placed AFTER a `--` option terminator.
//
// This guards a real regression: `--add-dir` is VARIADIC in the claude CLI, so
// the separate-token form `--add-dir <dir> "<prompt>"` greedily swallowed the
// trailing prompt as a second directory and claude aborted with "Input must be
// provided ... when using --print". The fix uses `--add-dir=<dir>` (equals form)
// AND terminates options with `--` so the prompt can never be consumed by any
// (current or future) variadic flag. This test fails if either guard is lost.

#include "jarvis/ClaudeBrain.h"

#include <QString>
#include <QStringList>

#include <cstdio>

using jarvis::ClaudeBrain;

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

// True iff `--` appears exactly once, the prompt is the SOLE token after it, and
// nothing between the program flags and `--` is the prompt.
bool promptIsIsolatedTrailingPositional(const QStringList &args, const QString &prompt)
{
    const int dd = args.indexOf(QStringLiteral("--"));
    if (dd < 0)
        return false;
    if (args.indexOf(QStringLiteral("--"), dd + 1) != -1)
        return false; // `--` must be unique
    // Exactly one token after `--`, and it is the prompt.
    if (dd != args.size() - 2)
        return false;
    return args.last() == prompt;
}

} // namespace

int main()
{
    const QString prompt =
        QStringLiteral("list the files -p --add-dir /etc and explain --verbose");

    // Case 1: cwd + model set (the dangerous case — --add-dir present).
    {
        ClaudeBrain::Options opts;
        opts.cwd = QStringLiteral("/home/user/project");
        opts.model = QStringLiteral("claude-opus-4-8");
        ClaudeBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);

        std::fprintf(stderr, "args:");
        for (const QString &a : args)
            std::fprintf(stderr, " [%s]", qPrintable(a));
        std::fprintf(stderr, "\n");

        check(args.contains(QStringLiteral("-p")), "has -p (print mode)");
        check(args.contains(QStringLiteral("--output-format")) &&
                  args.contains(QStringLiteral("stream-json")),
              "has --output-format stream-json");
        check(args.contains(QStringLiteral("--verbose")), "has --verbose flag");
        // --add-dir MUST be the equals form (never a bare `--add-dir <dir>` that
        // could swallow the prompt).
        check(args.contains(QStringLiteral("--add-dir=/home/user/project")),
              "--add-dir uses the equals form (binds a single value)");
        check(!args.contains(QStringLiteral("--add-dir")),
              "no bare separate-token --add-dir");
        check(promptIsIsolatedTrailingPositional(args, prompt),
              "prompt is the sole trailing positional after a unique --");
    }

    // Case 2: no cwd, no model — `--` + prompt must STILL be the trailing pair.
    {
        ClaudeBrain::Options opts;
        ClaudeBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);
        check(promptIsIsolatedTrailingPositional(args, prompt),
              "no-cwd/model: prompt still isolated after --");
        check(!args.contains(QStringLiteral("--model")),
              "no --model when model is empty");
        // ISOLATION: even with NO --mcp-config, a Jarvis claude turn MUST pass
        // --strict-mcp-config so it never inherits the user's ~/.claude.json
        // mcpServers (the leak this guards). Zero config + strict = zero servers.
        check(args.contains(QStringLiteral("--strict-mcp-config")),
              "--strict-mcp-config ALWAYS present (no CLI mcpServers leak)");
        check(!args.contains(QStringLiteral("--mcp-config")),
              "no --mcp-config when none was built (strict alone = zero servers)");
    }

    // Case 3: a prompt that itself starts with a dash must not be parsed as a flag.
    {
        ClaudeBrain::Options opts;
        opts.cwd = QStringLiteral("/tmp/x");
        ClaudeBrain brain(opts);
        const QString dashy = QStringLiteral("--help me write code");
        const QStringList args = brain.buildArgs(dashy);
        check(promptIsIsolatedTrailingPositional(args, dashy),
              "dash-leading prompt is isolated after -- (not mistaken for a flag)");
    }

    // Case 4: MULTIMODAL — image attachments grant Read access via --add-dir=<dir>
    // (the dir of each attached image), still keeping the prompt isolated after --.
    {
        ClaudeBrain::Options opts;
        opts.cwd = QStringLiteral("/home/user/project");
        ClaudeBrain brain(opts);
        const QStringList imgs{QStringLiteral("/tmp/jarvis/a.png"),
                               QStringLiteral("/tmp/jarvis/b.jpg")};
        const QStringList args = brain.buildArgs(prompt, imgs);
        check(args.contains(QStringLiteral("--add-dir=/tmp/jarvis")),
              "image attachment dir granted via --add-dir=<dir>");
        // both images share one dir -> only one extra --add-dir for it
        check(args.count(QStringLiteral("--add-dir=/tmp/jarvis")) == 1,
              "duplicate image dirs are de-duplicated");
        check(promptIsIsolatedTrailingPositional(args, prompt),
              "prompt still isolated after -- with image dirs added");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
