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

#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
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

    // The ClaudeBrain ctor pre-trusts the workspace by writing CLAUDE_CONFIG_DIR/
    // .claude.json — point that at a throwaway dir so the test never touches the
    // real ~/.claude.json.
    const QString tmpCfg = QDir::tempPath() + QStringLiteral("/jarvis_claude_buildargs_test");
    QDir(tmpCfg).removeRecursively();

    // Case 1: cwd + model set (the dangerous case — --add-dir present).
    {
        ClaudeBrain::Options opts;
        opts.configDir = tmpCfg;
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

        // The ctor must pre-trust the workspace so headless `claude -p` honors
        // permissions.allow (else "Ignoring N permissions.allow entries ... not
        // trusted"). Verify CLAUDE_CONFIG_DIR/.claude.json has the project trusted.
        QFile cf(tmpCfg + QStringLiteral("/.claude.json"));
        check(cf.open(QIODevice::ReadOnly),
              "ctor wrote CLAUDE_CONFIG_DIR/.claude.json");
        const QJsonObject root = QJsonDocument::fromJson(cf.readAll()).object();
        cf.close();
        const QJsonObject proj = root.value(QStringLiteral("projects")).toObject()
                                     .value(QStringLiteral("/home/user/project")).toObject();
        check(proj.value(QStringLiteral("hasTrustDialogAccepted")).toBool(),
              "workspace cwd marked hasTrustDialogAccepted:true");
    }

    // Case 2: no cwd, no model.
    {
        ClaudeBrain::Options opts;
        opts.configDir = tmpCfg;
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
        opts.configDir = tmpCfg;
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
        opts.configDir = tmpCfg;
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

    // Case 5: PLAN MODE — bypassPermissions (so MCP tools, gated separately by
    // computer_use_mcp/policy.py, still run headless) + --disallowedTools to
    // remove Claude's NATIVE mutating tools (invisible to that MCP-side gate).
    // Deliberately NOT --permission-mode plan: live-tested against a real MCP
    // server and confirmed to blanket-deny EVERY MCP tool call with no allowlist
    // override, which would also break present_plan/agent_start/todo_write.
    {
        ClaudeBrain::Options opts;
        opts.configDir = tmpCfg;
        opts.cwd = QStringLiteral("/tmp/plan");
        opts.permissionMode = QStringLiteral("bypassPermissions");
        opts.disallowedTools = {QStringLiteral("Write"), QStringLiteral("Edit"),
                                 QStringLiteral("NotebookEdit"), QStringLiteral("Bash"),
                                 QStringLiteral("Task")};
        ClaudeBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);
        check(args.contains(QStringLiteral("--permission-mode")) &&
                  args.contains(QStringLiteral("bypassPermissions")),
              "plan mode: --permission-mode bypassPermissions present");
        check(!args.contains(QStringLiteral("plan")),
              "plan mode: --permission-mode is NOT the literal CLI 'plan' value");
        check(args.contains(QStringLiteral("--disallowedTools")),
              "plan mode: --disallowedTools flag present");
        const int idx = args.indexOf(QStringLiteral("--disallowedTools"));
        check(idx >= 0 && idx + 1 < args.size() &&
                  args[idx + 1] == QStringLiteral("Write,Edit,NotebookEdit,Bash,Task"),
              "plan mode: --disallowedTools value is the joined native-tool list");
    }

    // Case 6: the APPENDED SYSTEM PROMPT must go to a FILE, never inline in argv.
    //
    // REGRESSION: ControlServer::sendToSession appends the co-work guide + the
    // identity/permission/mode policy preamble via setSystemPromptAppend() — together
    // ~17 KB. buildArgs used to pass that whole blob as one `--append-system-prompt
    // <17 KB>` command-line argument. On Windows a `claude` on PATH is usually a .cmd
    // shim, which CliResolve launches through `cmd.exe /c <shim> <args...>`, and cmd.exe
    // caps the WHOLE command line at 8191 characters. So every turn died before the
    // model was ever reached, with exactly:
    //     The command line is too long.
    //     claude exited with code 1
    // `--append-system-prompt-file <path>` (claude CLI >= 1.0.55 for --system-prompt-file,
    // documented for the append form since 2.0.30 — well under this repo's 2.1.170
    // baseline) keeps argv bounded no matter how much guidance text accumulates.
    {
        ClaudeBrain::Options opts;
        opts.configDir = tmpCfg;
        opts.cwd = QStringLiteral("/home/user/project");
        ClaudeBrain brain(opts);
        // Roughly the real payload: ~17 KB of guide + policy text.
        QString sys;
        while (sys.size() < 17000)
            sys += QStringLiteral("You are Cindro. Prefer notify_user over a voice call. ");
        brain.setSystemPromptAppend(sys);
        const QStringList args = brain.buildArgs(prompt);

        check(!args.contains(QStringLiteral("--append-system-prompt")),
              "system prompt is NOT passed inline via --append-system-prompt");
        check(!args.contains(sys),
              "the system-prompt TEXT never appears in argv");
        const int fi = args.indexOf(QStringLiteral("--append-system-prompt-file"));
        check(fi >= 0 && fi + 1 < args.size(),
              "system prompt passed via --append-system-prompt-file <path>");
        if (fi >= 0 && fi + 1 < args.size()) {
            QFile spf(args[fi + 1]);
            check(spf.open(QIODevice::ReadOnly),
                  "the system-prompt file was actually written to disk");
            const QString onDisk = QString::fromUtf8(spf.readAll());
            spf.close();
            check(onDisk == sys,
                  "the system-prompt file holds the exact appended text (nothing lost)");
        }

        // THE guard for this bug: whatever else we add to argv later, the assembled
        // command line must still fit cmd.exe's 8191-character ceiling.
        int cmdLen = 0;
        for (const QString &a : args)
            cmdLen += a.size() + 3; // worst case: a space + a quote pair per argument
        std::fprintf(stderr, "assembled command line: %d chars\n", cmdLen);
        check(cmdLen < 8191,
              "assembled command line fits cmd.exe's 8191-char limit");
    }

    // Case 7: NO system prompt -> neither system-prompt flag, and no stray temp file.
    {
        ClaudeBrain::Options opts;
        opts.configDir = tmpCfg;
        ClaudeBrain brain(opts);
        const QStringList args = brain.buildArgs(prompt);
        check(!args.contains(QStringLiteral("--append-system-prompt-file")) &&
                  !args.contains(QStringLiteral("--append-system-prompt")),
              "no system-prompt flag when nothing was appended");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
