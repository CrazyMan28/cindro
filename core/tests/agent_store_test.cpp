// ctest: AgentStore frontmatter parse + create (self-authoring) + list/get/read
// + remove roundtrip against a temp agents root.

#include "jarvis/AgentStore.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::AgentFrontmatter;
using jarvis::AgentStore;

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

    // --- pure parse() ------------------------------------------------------
    {
        const QString md =
            "---\n"
            "name: Research Bot\n"
            "description: Researches topics deeply\n"
            "when_to_use: When the user asks to research a topic\n"
            "brain: claude\n"
            "model: claude-opus-4-8\n"
            "profile: coworker\n"
            "tools: [browser, screenshot]\n"
            "color: #B28BFF\n"
            "---\n"
            "\n"
            "You are a meticulous research agent.\n";
        AgentFrontmatter fm;
        QString body;
        check(AgentStore::parse(md, &fm, &body), "parse returns true");
        check(fm.name == QStringLiteral("Research Bot"), "frontmatter name parsed");
        check(fm.description == QStringLiteral("Researches topics deeply"), "description parsed");
        check(fm.whenToUse.contains(QStringLiteral("research a topic")), "when_to_use parsed");
        check(fm.brain == QStringLiteral("claude"), "brain parsed (lowered)");
        check(fm.model == QStringLiteral("claude-opus-4-8"), "model parsed");
        check(fm.profile == QStringLiteral("coworker"), "profile parsed");
        check(fm.tools.size() == 2 && fm.tools.contains(QStringLiteral("browser")),
              "tools parsed as list");
        check(fm.color == QStringLiteral("#B28BFF"), "color parsed");
        check(body.contains(QStringLiteral("meticulous research agent")), "body is system prompt");

        const QJsonObject j = fm.toJson();
        check(j.value(QStringLiteral("when_to_use")).toString().contains(QStringLiteral("research")),
              "toJson carries when_to_use");
    }

    // --- create() + list() + get() (self-authoring) ------------------------
    QTemporaryDir tmp;
    check(tmp.isValid(), "temp agents root created");

    AgentStore store;
    store.setRoot(tmp.path());

    const QString path = store.create(
        QStringLiteral("Code Reviewer"),
        QStringLiteral("Reviews diffs for bugs"),
        QStringLiteral("When the user finishes a change and wants a review"),
        QStringLiteral("You are a strict code reviewer. Find real bugs only.\n"),
        QStringLiteral("codex"),
        QStringLiteral("gpt-5.5"),
        QStringLiteral("coder"),
        {QStringLiteral("read"), QStringLiteral("shell")},
        QStringLiteral("#39E6A0"));
    check(!path.isEmpty(), "create() wrote an AGENT.md (self-authoring)");
    check(QFile::exists(path), "AGENT.md exists on disk");
    check(path.contains(QStringLiteral("/code-reviewer/AGENT.md")),
          "agent written under <root>/<name-slug>/AGENT.md");

    {
        const auto agents = store.list();
        check(agents.size() == 1, "list() indexes the created agent");
        check(agents.first().fm.name == QStringLiteral("Code Reviewer"), "indexed name matches");
        check(agents.first().fm.brain == QStringLiteral("codex"), "indexed brain matches");
        check(agents.first().systemPrompt.contains(QStringLiteral("strict code reviewer")),
              "system prompt is the body");
        const QJsonObject lj = agents.first().toListJson();
        check(lj.value(QStringLiteral("when_to_use")).toString().contains(QStringLiteral("wants a review")),
              "list json carries when_to_use");
        check(lj.value(QStringLiteral("path")).toString() == path, "list json carries path");
    }

    // get() by name and by slug.
    check(store.get(QStringLiteral("Code Reviewer")).has_value(), "get by frontmatter name");
    check(store.get(QStringLiteral("code-reviewer")).has_value(), "get by dir slug");

    // read() returns frontmatter + body + path.
    {
        AgentFrontmatter fm;
        QString body, p;
        check(store.read(QStringLiteral("Code Reviewer"), &fm, &body, &p), "read() succeeds");
        check(fm.model == QStringLiteral("gpt-5.5"), "read frontmatter model");
        check(body.contains(QStringLiteral("Find real bugs only")), "read body is system prompt");
    }

    // create() overwrites in place (edit).
    {
        const QString p2 = store.create(
            QStringLiteral("Code Reviewer"),
            QStringLiteral("Reviews diffs for bugs AND security"),
            QStringLiteral("When the user finishes a change"),
            QStringLiteral("You are a strict security-aware reviewer.\n"),
            QStringLiteral("claude"), QString(), QStringLiteral("coworker"), {}, QString());
        check(p2 == path, "create() overwrites the same AGENT.md path");
        check(store.list().size() == 1, "overwrite did not create a duplicate");
        auto r = store.get(QStringLiteral("Code Reviewer"));
        check(r && r->fm.description.contains(QStringLiteral("security")), "overwrite updated description");
    }

    // serializeClaude shape.
    {
        AgentFrontmatter fm;
        fm.name = QStringLiteral("My Agent");
        fm.description = QStringLiteral("does things");
        fm.whenToUse = QStringLiteral("when needed");
        fm.tools = {QStringLiteral("read")};
        const QString c = AgentStore::serializeClaude(fm, QStringLiteral("prompt body\n"));
        check(c.contains(QStringLiteral("name: my-agent")), "claude format uses the slug name");
        check(c.contains(QStringLiteral("when needed")), "claude description folds in when_to_use");
        check(c.contains(QStringLiteral("prompt body")), "claude format keeps the body");
    }

    // --- remove() ----------------------------------------------------------
    check(store.remove(QStringLiteral("Code Reviewer")), "remove() succeeds");
    check(!store.get(QStringLiteral("Code Reviewer")).has_value(), "removed agent gone");
    check(store.list().isEmpty(), "list empty after remove");

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
