// ctest: UiManifest — the shared surface contract both frontends consume.
// Validates the embedded builtin manifest's shape (every page/command well-
// formed, ids unique, table pages renderable by a generic engine) and the
// custom-page/custom-command merge.

#include "jarvis/UiManifest.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonObject>
#include <QSet>

#include <cstdio>

using jarvis::CommandRow;
using jarvis::TuiPageSpec;
using jarvis::UiManifest;

namespace {
int g_failures = 0;
void check(bool cond, const char *msg)
{
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", msg); ++g_failures; }
    else { std::fprintf(stderr, "ok: %s\n", msg); }
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    const QJsonObject base = UiManifest::base();
    check(base.value(QStringLiteral("v")).toInt() == 1, "manifest v == 1");

    const QJsonArray pages = base.value(QStringLiteral("pages")).toArray();
    const QJsonArray commands = base.value(QStringLiteral("commands")).toArray();
    check(!pages.isEmpty(), "pages non-empty");
    check(!commands.isEmpty(), "commands non-empty");
    check(!base.value(QStringLiteral("settings_sections")).toArray().isEmpty(),
          "settings_sections non-empty");
    check(!base.value(QStringLiteral("status_segments")).toArray().isEmpty(),
          "status_segments non-empty");

    // Every page well-formed; ids unique; table pages generically renderable.
    QSet<QString> ids;
    bool pagesOk = true, tablesOk = true;
    for (const auto &v : pages) {
        const QJsonObject p = v.toObject();
        const QString id = p.value(QStringLiteral("id")).toString();
        const QString kind = p.value(QStringLiteral("kind")).toString();
        if (id.isEmpty() || p.value(QStringLiteral("title")).toString().isEmpty()
            || p.value(QStringLiteral("section")).toString().isEmpty()
            || (kind != QStringLiteral("table") && kind != QStringLiteral("bespoke")))
            pagesOk = false;
        if (ids.contains(id))
            pagesOk = false;
        ids.insert(id);
        if (kind == QStringLiteral("table")) {
            const QJsonObject list = p.value(QStringLiteral("data")).toObject()
                                         .value(QStringLiteral("list")).toObject();
            if (list.value(QStringLiteral("verb")).toString().isEmpty()
                || list.value(QStringLiteral("result_key")).toString().isEmpty()
                || p.value(QStringLiteral("columns")).toArray().isEmpty())
                tablesOk = false;
        }
    }
    check(pagesOk, "every page has unique id + title + section + known kind");
    check(tablesOk, "every table page has data.list verb/result_key + columns");

    // The full builtin surface is present (the 20-screen contract).
    for (const char *want : {"home", "chat", "voice", "computer", "browser",
                             "canvas", "widgets", "phone", "sessions", "memory",
                             "memorygraph", "skills", "agents", "queue",
                             "schedules", "activity", "mcp", "plugins", "outpost",
                             "replay", "settings"})
        check(ids.contains(QString::fromLatin1(want)), want);

    // Commands well-formed; the diff review + picker commands exist.
    QSet<QString> cmdNames;
    bool cmdsOk = true;
    for (const auto &v : commands) {
        const QJsonObject c = v.toObject();
        if (c.value(QStringLiteral("name")).toString().isEmpty()
            || c.value(QStringLiteral("kind")).toString().isEmpty())
            cmdsOk = false;
        cmdNames.insert(c.value(QStringLiteral("name")).toString());
    }
    check(cmdsOk, "every command has name + kind");
    for (const char *want : {"new", "stop", "stage", "commit", "revert",
                             "openpr", "model", "provider", "sessions", "tui"})
        check(cmdNames.contains(QString::fromLatin1(want)), want);

    // Merge: custom pages/commands appended with source:"custom".
    TuiPageSpec cp;
    cp.id = QStringLiteral("errorlog");
    cp.title = QStringLiteral("Error Log");
    cp.kind = QStringLiteral("log");
    cp.order = 0;
    CommandRow cc;
    cc.name = QStringLiteral("deploy");
    cc.description = QStringLiteral("run the deploy script");
    cc.actionKind = QStringLiteral("shell");

    const QJsonObject merged = UiManifest::merged({cp}, {cc});
    const QJsonArray mp = merged.value(QStringLiteral("pages")).toArray();
    const QJsonArray mc = merged.value(QStringLiteral("commands")).toArray();
    check(mp.size() == pages.size() + 1, "merged appends the custom page");
    check(mc.size() == commands.size() + 1, "merged appends the custom command");
    const QJsonObject lastPage = mp.last().toObject();
    check(lastPage.value(QStringLiteral("id")).toString() == QStringLiteral("errorlog")
              && lastPage.value(QStringLiteral("source")).toString() == QStringLiteral("custom")
              && lastPage.value(QStringLiteral("kind")).toString() == QStringLiteral("log"),
          "custom page carries id/kind/source");
    const QJsonObject lastCmd = mc.last().toObject();
    check(lastCmd.value(QStringLiteral("name")).toString() == QStringLiteral("deploy")
              && lastCmd.value(QStringLiteral("kind")).toString() == QStringLiteral("shell")
              && lastCmd.value(QStringLiteral("source")).toString() == QStringLiteral("custom"),
          "custom command carries name/kind/source");

    // base() must be untouched by merged() (no accidental cache mutation).
    check(UiManifest::base().value(QStringLiteral("pages")).toArray().size() == pages.size(),
          "merged() does not mutate the cached base");

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
