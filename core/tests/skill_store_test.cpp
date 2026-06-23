// ctest: SkillStore frontmatter parse + create (self-authoring) + invoke
// (template render) roundtrip against a temp skills root.

#include "jarvis/SkillStore.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::SkillFrontmatter;
using jarvis::SkillScript;
using jarvis::SkillStore;

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
            "name: greet-user\n"
            "description: Greets the user by name\n"
            "group: demo\n"
            "tags: [greeting, demo]\n"
            "self_authored: true\n"
            "---\n"
            "\n"
            "Say hello to {{NAME}} from {{SKILL_DIR}}.\n";
        SkillFrontmatter fm;
        QString body;
        check(SkillStore::parse(md, &fm, &body), "parse returns true");
        check(fm.name == QStringLiteral("greet-user"), "frontmatter name parsed");
        check(fm.description == QStringLiteral("Greets the user by name"), "description parsed");
        check(fm.group == QStringLiteral("demo"), "group parsed");
        check(fm.tags.size() == 2 && fm.tags.contains(QStringLiteral("greeting")),
              "tags parsed as list");
        check(fm.selfAuthored, "self_authored parsed true");
        check(body.contains(QStringLiteral("{{NAME}}")), "body retained template vars");

        // template render.
        QJsonObject vars;
        vars.insert(QStringLiteral("NAME"), QStringLiteral("Issac"));
        vars.insert(QStringLiteral("SKILL_DIR"), QStringLiteral("/tmp/skill"));
        const QString out = SkillStore::renderTemplate(body, vars);
        check(out.contains(QStringLiteral("hello to Issac")), "template var NAME substituted");
        check(out.contains(QStringLiteral("/tmp/skill")), "template var SKILL_DIR substituted");
        check(!out.contains(QStringLiteral("{{NAME}}")), "no unresolved NAME token");
    }

    // --- create() + list() + get() (self-authoring) ------------------------
    QTemporaryDir tmp;
    check(tmp.isValid(), "temp skills root created");

    SkillStore store;
    store.setRoot(tmp.path());

    const QString path = store.create(
        QStringLiteral("Backup Postgres"),
        QStringLiteral("Dump the prod DB to a timestamped file"),
        QStringLiteral("Run `bash {{SKILL_DIR}}/scripts/backup.sh {{ARGS}}` to dump the DB.\n"),
        QStringLiteral("ops"),
        {QStringLiteral("db"), QStringLiteral("backup")},
        {SkillScript{QStringLiteral("backup.sh"), QStringLiteral("#!/usr/bin/env bash\npg_dump \"$1\"\n")}});
    check(!path.isEmpty(), "create() wrote a SKILL.md (self-authoring)");
    check(QFile::exists(path), "SKILL.md exists on disk");
    check(path.contains(QStringLiteral("/ops/backup-postgres/SKILL.md")),
          "skill written under <root>/<group-slug>/<name-slug>/SKILL.md");
    check(QFile::exists(QFileInfo(path).absoluteDir().absolutePath() +
                        QStringLiteral("/scripts/backup.sh")),
          "bundled script written");

    {
        const auto skills = store.list();
        check(skills.size() == 1, "list() indexes the created skill");
        check(skills.first().fm.name == QStringLiteral("Backup Postgres"), "indexed name matches");
        check(skills.first().fm.selfAuthored, "created skill marked self_authored");
        const QJsonObject lj = skills.first().toListJson();
        check(lj.value(QStringLiteral("group")).toString() == QStringLiteral("ops"),
              "list json carries group");
    }

    // get() by frontmatter name and by slug.
    check(store.get(QStringLiteral("Backup Postgres")).has_value(), "get by frontmatter name");
    check(store.get(QStringLiteral("backup-postgres")).has_value(), "get by dir slug");

    // read() returns frontmatter + body + path.
    {
        SkillFrontmatter fm;
        QString body, p;
        check(store.read(QStringLiteral("Backup Postgres"), &fm, &body, &p), "read() succeeds");
        check(fm.description.contains(QStringLiteral("Dump the prod DB")), "read frontmatter");
        check(body.contains(QStringLiteral("{{SKILL_DIR}}")), "read body has template");
    }

    // --- invoke() (template render with builtins) --------------------------
    {
        QString err;
        const QString msg = store.invoke(QStringLiteral("Backup Postgres"),
                                         QStringLiteral("postgres://prod"),
                                         QJsonObject(), &err);
        check(!msg.isEmpty() && err.isEmpty(), "invoke renders a message");
        check(msg.contains(QStringLiteral("# Skill: Backup Postgres")), "invoke has skill header");
        check(msg.contains(QStringLiteral("postgres://prod")), "invoke substituted ARGS");
        check(msg.contains(QStringLiteral("/ops/backup-postgres")), "invoke substituted SKILL_DIR");
        check(!msg.contains(QStringLiteral("{{SKILL_DIR}}")), "no unresolved SKILL_DIR token");
        check(!msg.contains(QStringLiteral("{{ARGS}}")), "no unresolved ARGS token");
    }
    {
        QString err;
        const QString msg = store.invoke(QStringLiteral("does-not-exist"), QString(),
                                         QJsonObject(), &err);
        check(msg.isEmpty() && !err.isEmpty(), "invoke unknown skill errors");
    }

    // --- remove() ----------------------------------------------------------
    check(store.remove(QStringLiteral("Backup Postgres")), "remove() succeeds");
    check(!store.get(QStringLiteral("Backup Postgres")).has_value(), "removed skill gone");
    check(store.list().isEmpty(), "list empty after remove");

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
