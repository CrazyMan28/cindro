// ctest: guard the ClaudeBrain argv shape. The user PROMPT is fed to `claude -p` via
// STDIN (see ClaudeBrain::send), NOT as a command-line positional.
//
// Why via stdin: passing the prompt on the command line breaks on Windows — a global
// `claude` is a .cmd shim and cmd.exe drops/mangles a multi-word quoted prompt, so
// claude receives NO prompt and just summarizes CLAUDE.md ("I've got your memory
// loaded…"). stdin is quoting-safe on every platform. So buildArgs must NEVER contain
// the prompt. This test also keeps the --add-dir=<dir> (equals) guard: a bare
// `--add-dir <dir>` is variadic and wrong regardless. It fails if the prompt leaks back
// into argv or the equals guard is lost.

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

// True iff the full prompt string appears NOWHERE in argv (it is fed via stdin) and no
// dangling `--` option-terminator with a trailing positional was left behind.
bool promptAbsentFromArgs(const QStringList &args, const QString &prompt)
{
    if (args.contains(prompt))
        return false; // the prompt must never be a command-line positional
    const int dd = args.indexOf(QStringLiteral("--"));
    if (dd >= 0 && dd < args.size() - 1)
        return false; // nothing may trail a `--` (no dangling positional)
    return true;
}

} // namespace

int main()
{
    // A prompt salted with tokens that LOOK like flags (-p, --add-dir, --verbose): if it
    // ever leaked into argv it could be mis-parsed. Via stdin it never can.
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
        // --add-dir MUST be the equals form (never a bare `--add-dir <dir>`).
        check(args.contains(QStringLiteral("--add-dir=/home/user/project")),
              "--add-dir uses the equals form (binds a single value)");
        check(!args.contains(QStringLiteral("--add-dir")),
              "no bare separate-token --add-dir");
        check(promptAbsentFromArgs(args, prompt),
              "prompt is NOT a command-line positional (fed via stdin)");
    }

    // Case 2: no cwd, no model.
    {
        ClaudeBrain::Options opts;
        ClaudeBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);
        check(promptAbsentFromArgs(args, prompt),
              "no-cwd/model: prompt still absent from argv");
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

    // Case 3: a prompt that itself starts with a dash. Via stdin it can NEVER reach argv
    // and so can never be mistaken for a flag — the strongest form of the old guarantee.
    {
        ClaudeBrain::Options opts;
        opts.cwd = QStringLiteral("/tmp/x");
        ClaudeBrain brain(opts);
        const QString dashy = QStringLiteral("--help me write code");
        const QStringList args = brain.buildArgs(dashy);
        check(promptAbsentFromArgs(args, dashy),
              "dash-leading prompt never reaches argv (fed via stdin)");
    }

    // Case 4: MULTIMODAL — image attachments grant Read access via --add-dir=<dir> (the
    // dir of each attached image); the prompt still never appears in argv.
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
        check(promptAbsentFromArgs(args, prompt),
              "prompt still absent from argv with image dirs added");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
