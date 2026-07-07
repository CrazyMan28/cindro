// ctest: MemoryStore add + FTS5 search + remove roundtrip against a temp DB.

#include "jarvis/MemoryStore.h"

#include <QCoreApplication>
#include <QDir>
#include <QJsonArray>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>

#include <cstdio>
#include <optional>

using jarvis::EntityRow;
using jarvis::MemoryRow;
using jarvis::MemoryStore;

namespace {
int g_failures = 0;
void check(bool cond, const char *msg)
{
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", msg); ++g_failures; }
    else { std::fprintf(stderr, "ok: %s\n", msg); }
}
bool anyTextContains(const QVector<MemoryRow> &rows, const QString &needle)
{
    for (const auto &r : rows)
        if (r.text.contains(needle))
            return true;
    return false;
}
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    QTemporaryDir tmp;
    check(tmp.isValid(), "temp dir created");
    const QString dbPath = tmp.path() + QStringLiteral("/mem_test.db");

    MemoryStore store;
    check(store.open(dbPath, QStringLiteral("mem-test-conn")), "store open + migrate");

    // --- add ---------------------------------------------------------------
    const QString id1 = store.add(QStringLiteral("The user prefers dark mode and the accent color cyan"),
                                  {QStringLiteral("prefs"), QStringLiteral("ui")});
    const QString id2 = store.add(QStringLiteral("Jarvis runs on a Fedora KDE Wayland session"),
                                  {QStringLiteral("env")});
    const QString id3 = store.add(QStringLiteral("Deploy K2-Tek via develop -> qa -> main branches"),
                                  {QStringLiteral("workflow"), QStringLiteral("k2")});
    check(!id1.isEmpty() && !id2.isEmpty() && !id3.isEmpty(), "three memories added with ids");

    check(store.list().size() == 3, "list returns all 3 memories");

    // empty text rejected
    check(store.add(QStringLiteral("   ")).isEmpty(), "empty memory text rejected");

    // --- FTS search --------------------------------------------------------
    {
        const auto hits = store.search(QStringLiteral("dark mode color"), 10);
        check(!hits.isEmpty(), "search 'dark mode color' returns hits");
        check(anyTextContains(hits, QStringLiteral("dark mode")), "FTS matched the dark-mode memory");
        check(hits.first().score > 0.0, "search hit has a positive score");
    }
    {
        const auto hits = store.search(QStringLiteral("Fedora Wayland"), 10);
        check(anyTextContains(hits, QStringLiteral("Fedora")), "FTS matched the env memory");
    }
    {
        // prefix matching: "deploy" should hit the workflow memory.
        const auto hits = store.search(QStringLiteral("deploy"), 10);
        check(anyTextContains(hits, QStringLiteral("Deploy")), "prefix search matched workflow memory");
    }
    {
        // tag-driven search.
        const auto hits = store.search(QStringLiteral("workflow"), 10);
        check(anyTextContains(hits, QStringLiteral("K2-Tek")), "tag 'workflow' matched its memory");
    }

    // --- prefetch ----------------------------------------------------------
    {
        const auto pf = store.prefetch(QStringLiteral("what color does the user like"), 3);
        check(!pf.isEmpty(), "prefetch returns context");
        const QString block = MemoryStore::renderPromptBlock(pf);
        check(block.contains(QStringLiteral("Relevant memory")), "renderPromptBlock has a header");
        check(block.contains(QStringLiteral("dark mode")), "prompt block injects the matched memory");
    }
    {
        // empty query => recent memories.
        const auto pf = store.prefetch(QString(), 2);
        check(pf.size() == 2, "empty-query prefetch returns k recent memories");
    }

    // --- replace -----------------------------------------------------------
    check(store.replace(id2, QStringLiteral("Jarvis now runs on Sway as well as KDE"),
                        {QStringLiteral("env"), QStringLiteral("sway")}),
          "replace existing memory");
    {
        auto r = store.get(id2);
        check(r && r->text.contains(QStringLiteral("Sway")), "replaced text persisted");
        const auto hits = store.search(QStringLiteral("Sway"), 10);
        check(anyTextContains(hits, QStringLiteral("Sway")), "FTS reindexed on replace");
        const auto old = store.search(QStringLiteral("Wayland session running"), 10);
        check(!anyTextContains(old, QStringLiteral("Fedora KDE Wayland session")),
              "old FTS text gone after replace");
    }
    check(!store.replace(QStringLiteral("mem_nope"), QStringLiteral("x"), {}),
          "replace unknown id fails");

    // --- remove ------------------------------------------------------------
    check(store.remove(id1), "remove returns true for existing id");
    check(!store.get(id1).has_value(), "removed memory no longer fetchable");
    {
        const auto hits = store.search(QStringLiteral("dark mode color"), 10);
        check(!anyTextContains(hits, QStringLiteral("dark mode")),
              "removed memory dropped from FTS index");
    }
    check(store.list().size() == 2, "list reflects removal");
    check(!store.remove(QStringLiteral("mem_nope")), "remove unknown id returns false");

    // --- knowledge graph: entity auto-extraction on add() ------------------
    {
        const QString memA = store.add(
            QStringLiteral("Had a great sync with Chad Hanson about the roadmap"),
            {QStringLiteral("project:K2-Tek")});
        check(!memA.isEmpty(), "graph: memory A added");

        const auto entities = store.listEntities();
        auto findEntity = [&](const QString &name) -> std::optional<EntityRow> {
            for (const auto &e : entities)
                if (e.name.compare(name, Qt::CaseInsensitive) == 0)
                    return e;
            return std::nullopt;
        };
        auto person = findEntity(QStringLiteral("Chad Hanson"));
        check(person.has_value(), "graph: 'Chad Hanson' phrase auto-extracted as an entity");
        auto project = findEntity(QStringLiteral("K2-Tek"));
        check(project.has_value(), "graph: 'project:K2-Tek' tag created a project entity");
        if (project)
            check(project->scope == QStringLiteral("project") && project->projectRef == QStringLiteral("K2-Tek"),
                  "graph: project entity scoped correctly");

        // A second, unrelated mention of the same person must NOT create a
        // duplicate entity (case-insensitive name+type dedupe).
        const QString memB = store.add(
            QStringLiteral("Chad Hanson approved the deploy window"),
            {QStringLiteral("project:K2-Tek")});
        check(!memB.isEmpty(), "graph: memory B added");
        int chadCount = 0;
        for (const auto &e : store.listEntities())
            if (e.name.compare(QStringLiteral("Chad Hanson"), Qt::CaseInsensitive) == 0)
                ++chadCount;
        check(chadCount == 1, "graph: repeated entity mention dedupes, not duplicates");

        if (person) {
            const QJsonObject g = store.graph(memA, 2);
            bool sawPersonNode = false, sawMentionsEdge = false;
            for (const QJsonValue &nv : g.value(QStringLiteral("nodes")).toArray()) {
                const QJsonObject n = nv.toObject();
                if (n.value(QStringLiteral("id")).toString() == person->id) {
                    sawPersonNode = true;
                    check(n.value(QStringLiteral("kind")).toString() == QStringLiteral("entity"),
                          "graph: entity node tagged kind=entity");
                }
            }
            for (const QJsonValue &ev : g.value(QStringLiteral("edges")).toArray()) {
                const QJsonObject e = ev.toObject();
                if (e.value(QStringLiteral("from")).toString() == memA &&
                    e.value(QStringLiteral("to")).toString() == person->id)
                    sawMentionsEdge = e.value(QStringLiteral("relation")).toString() == QStringLiteral("mentions");
            }
            check(sawPersonNode, "graph(memA): subgraph includes the auto-linked person entity");
            check(sawMentionsEdge, "graph(memA): subgraph includes the 'mentions' edge");
        }

        // Both memories mentioning Chad Hanson are graph-connected (siblings
        // via the shared entity) even though B's text doesn't literally match A's.
        if (person) {
            bool bReachesA = false;
            for (const QString &nid : store.neighborIds(memB, 2))
                if (nid == memA)
                    bReachesA = true;
            check(bReachesA, "graph: memory B reaches memory A within 2 hops via the shared entity");
        }

        // --- manual link()/unlink() ----------------------------------------
        check(store.link(memA, QStringLiteral("memory"), memB, QStringLiteral("memory"),
                         QStringLiteral("relates_to")),
              "graph: manual link() between two memories");
        check(store.link(memA, QStringLiteral("memory"), memB, QStringLiteral("memory"),
                         QStringLiteral("relates_to")),
              "graph: re-linking the same edge is idempotent (no error)");
        {
            const auto direct = store.neighborIds(memA, 1);
            check(direct.contains(memB), "graph: neighborIds(memA,1) sees the manual link");
        }
        check(store.unlink(memA, memB), "graph: unlink() removes the manual edge");
        {
            const auto direct = store.neighborIds(memA, 1);
            check(!direct.contains(memB), "graph: neighborIds(memA,1) no longer sees the unlinked edge");
        }

        // --- graph-aware prefetch: pulls in a sibling via a shared entity --
        {
            // Query text matches ONLY memA ("sync ... roadmap"); memB's text
            // shares no words with it, so plain FTS/prefetch of k=1 should
            // still surface memB once graph expansion is in play.
            const auto pf = store.prefetch(QStringLiteral("roadmap sync"), 1);
            bool sawA = false, sawB = false;
            for (const auto &r : pf) {
                if (r.id == memA) sawA = true;
                if (r.id == memB) sawB = true;
            }
            check(sawA, "graph-aware prefetch: still returns the literal text match");
            check(sawB, "graph-aware prefetch: pulls in the sibling sharing the K2-Tek entity");
        }

        // --- regression: a caller-supplied (non "mem_"-prefixed) memory id --
        // The daemon writes a stable "user-name" slot via add(text,tags,id).
        // graph()/prefetch() used to key memory-vs-entity purely off the
        // "mem_" prefix, so a custom id was silently dropped from results
        // even though it was correctly discovered by graph traversal.
        {
            const QString customId = store.add(
                QStringLiteral("The user's name is Dana Scully"),
                {QStringLiteral("user"), QStringLiteral("profile")},
                QStringLiteral("user-name"));
            check(customId == QStringLiteral("user-name"),
                  "custom id: add() honors the caller-supplied id verbatim");

            const QJsonObject g = store.graph(customId, 1);
            bool sawCustomIdNode = false;
            for (const QJsonValue &nv : g.value(QStringLiteral("nodes")).toArray()) {
                const QJsonObject n = nv.toObject();
                if (n.value(QStringLiteral("id")).toString() == customId) {
                    sawCustomIdNode = true;
                    check(n.value(QStringLiteral("kind")).toString() == QStringLiteral("memory"),
                          "custom id: graph() classifies it as kind=memory despite the non-mem_ id");
                }
            }
            check(sawCustomIdNode, "custom id: graph(rootId=customId) includes the root itself");

            // Overview graph (no root) must include it too, and the
            // graph-aware prefetch expansion must be able to return it as a
            // neighbor (both used to filter it out via the "mem_" prefix).
            const QJsonObject overview = store.graph(QString(), 2);
            bool sawInOverview = false;
            for (const QJsonValue &nv : overview.value(QStringLiteral("nodes")).toArray())
                if (nv.toObject().value(QStringLiteral("id")).toString() == customId)
                    sawInOverview = true;
            check(sawInOverview, "custom id: the default overview graph includes it");
        }

        // --- regression: backfill extracts entities for pre-existing memories
        // (memories written before the graph tables existed, or by an older
        // binary — nothing ever called add() on them post-upgrade).
        {
            QTemporaryDir tmp2;
            const QString dbPath2 = tmp2.path() + QStringLiteral("/backfill_test.db");

            // Simulate a "legacy" memory: insert straight into `memories` via
            // raw SQL, bypassing add() entirely, so it has zero graph links —
            // exactly what a pre-upgrade memories table looks like.
            {
                MemoryStore legacy;
                check(legacy.open(dbPath2, QStringLiteral("mem-test-legacy-conn")),
                      "backfill: legacy store open + migrate");
                QSqlDatabase db = QSqlDatabase::database(QStringLiteral("mem-test-legacy-conn"));
                QSqlQuery ins(db);
                ins.prepare(QStringLiteral(
                    "INSERT INTO memories (id,text,tags,created,updated) VALUES (?,?,?,?,?)"));
                ins.addBindValue(QStringLiteral("legacy-1"));
                ins.addBindValue(QStringLiteral("Talked to Fox Mulder about the case"));
                ins.addBindValue(QStringLiteral("case work"));
                ins.addBindValue(qint64(1));
                ins.addBindValue(qint64(1));
                check(ins.exec(), "backfill: raw-inserted a legacy memory with no links");
                check(legacy.listEntities().isEmpty(),
                      "backfill: legacy memory has no entities yet (never went through add())");
                legacy.close();
            }

            // Reopen the SAME db file — open() re-runs migrate() + the
            // backfill, which should now extract entities for "legacy-1".
            {
                MemoryStore reopened;
                check(reopened.open(dbPath2, QStringLiteral("mem-test-reopen-conn")),
                      "backfill: reopen the same db file");
                const auto entities = reopened.listEntities();
                bool sawMulder = false, sawWorkTag = false;
                for (const auto &e : entities) {
                    if (e.name.compare(QStringLiteral("Fox Mulder"), Qt::CaseInsensitive) == 0)
                        sawMulder = true;
                    if (e.name.compare(QStringLiteral("work"), Qt::CaseInsensitive) == 0)
                        sawWorkTag = true;
                }
                check(sawMulder, "backfill: reopening extracted 'Fox Mulder' from the legacy memory's text");
                check(sawWorkTag, "backfill: reopening extracted the legacy memory's tags too");

                const auto direct = reopened.neighborIds(QStringLiteral("legacy-1"), 1);
                check(!direct.isEmpty(), "backfill: the legacy memory is now linked into the graph");

                // Re-opening again must NOT duplicate entities (idempotent).
                reopened.close();
                MemoryStore reopenedAgain;
                check(reopenedAgain.open(dbPath2, QStringLiteral("mem-test-reopen2-conn")),
                      "backfill: reopen a second time");
                int mulderCount = 0;
                for (const auto &e : reopenedAgain.listEntities())
                    if (e.name.compare(QStringLiteral("Fox Mulder"), Qt::CaseInsensitive) == 0)
                        ++mulderCount;
                check(mulderCount == 1, "backfill: re-running backfill on an already-linked memory doesn't duplicate");
            }
        }
    }

    // --- agent-scoped memory (per-agent-scoped recall) ---------------------
    {
        QTemporaryDir tmpA;
        const QString dbPathA = tmpA.path() + QStringLiteral("/agent_scope.db");
        MemoryStore s;
        check(s.open(dbPathA, QStringLiteral("mem-agent-conn")), "agent-scope: store open");

        // Two agent-scoped memories + one global memory.
        const QString a1 = s.add(QStringLiteral("runner service is healthy"),
                                 {QStringLiteral("status")}, QString(),
                                 QStringLiteral("agent"), QStringLiteral("ci-runner-104"));
        const QString a2 = s.add(QStringLiteral("disk at 40 percent"),
                                 {QStringLiteral("status")}, QString(),
                                 QStringLiteral("agent"), QStringLiteral("ci-runner-106"));
        const QString g1 = s.add(QStringLiteral("the runner keychain lives in vault"),
                                 {QStringLiteral("status")});
        check(!a1.isEmpty() && !a2.isEmpty() && !g1.isEmpty(), "agent-scope: three memories added");

        // recall filtered by agent returns ONLY that agent's rows.
        {
            const auto hits = s.search(QStringLiteral("runner"), 20, QStringLiteral("ci-runner-104"));
            bool sawA1 = false, sawG1 = false, sawA2 = false;
            for (const auto &r : hits) {
                if (r.id == a1) sawA1 = true;
                if (r.id == g1) sawG1 = true;
                if (r.id == a2) sawA2 = true;
            }
            check(sawA1, "agent-scope: search(agent=104) returns the 104 memory");
            check(!sawG1, "agent-scope: search(agent=104) excludes the global memory");
            check(!sawA2, "agent-scope: search(agent=104) excludes the other agent's memory");
        }

        // Empty-query + agent returns that agent's rows (condition-polling pattern).
        {
            const auto hits = s.search(QString(), 20, QStringLiteral("ci-runner-104"));
            bool sawA1 = false, sawA2 = false;
            for (const auto &r : hits) {
                if (r.id == a1) sawA1 = true;
                if (r.id == a2) sawA2 = true;
            }
            check(sawA1, "agent-scope: empty-query search(agent=104) returns 104 rows");
            check(!sawA2, "agent-scope: empty-query search(agent=104) excludes other agents");
        }

        // Reversed regression (2026-07-06 per-agent-memory redesign): this
        // used to assert that an unfiltered search() spans global+agent rows
        // together (deliberate original design). New explicit user direction
        // supersedes that: agents get dedicated PER-AGENT memory, not global
        // memory, so an unscoped search() must now EXCLUDE agent-scoped rows
        // — only an explicitly agent-scoped call (entityRef set, exercised
        // above) still returns them.
        {
            const auto hits = s.search(QStringLiteral("runner"), 20);
            bool sawA1 = false, sawG1 = false;
            for (const auto &r : hits) {
                if (r.id == a1) sawA1 = true;
                if (r.id == g1) sawG1 = true;
            }
            check(!sawA1, "agent-scope: unscoped search excludes the agent-scoped memory");
            check(sawG1, "agent-scope: unscoped search still includes the global memory");
        }

        // The row carries its scope + entityRef; toJson surfaces them.
        {
            auto r = s.get(a1);
            check(r && r->scope == QStringLiteral("agent"), "agent-scope: stored scope is 'agent'");
            check(r && r->entityRef == QStringLiteral("ci-runner-104"), "agent-scope: entityRef stored");
            const QJsonObject j = r->toJson();
            check(j.value(QStringLiteral("scope")).toString() == QStringLiteral("agent"),
                  "agent-scope: toJson emits scope for an agent row");
            check(j.value(QStringLiteral("entityRef")).toString() == QStringLiteral("ci-runner-104"),
                  "agent-scope: toJson emits entityRef for an agent row");
        }

        // Regression: a global row's JSON does NOT gain scope/entityRef keys.
        {
            auto r = s.get(g1);
            const QJsonObject j = r->toJson();
            check(!j.contains(QStringLiteral("scope")), "agent-scope: global row toJson omits scope");
            check(!j.contains(QStringLiteral("entityRef")), "agent-scope: global row toJson omits entityRef");
        }

        // prefetch() is the AUTOMATIC per-turn context injection (jarvisd
        // prepends it to every ordinary chat turn); ordinary turns aren't
        // scoped to any particular agent/machine, so an agent-scoped fact
        // must never ride along unprompted. Both a1 and g1 share the word
        // "runner", so an unfiltered query would match both.
        {
            const auto pf = s.prefetch(QStringLiteral("runner"), 20);
            bool sawA1 = false, sawG1 = false;
            for (const auto &r : pf) {
                if (r.id == a1) sawA1 = true;
                if (r.id == g1) sawG1 = true;
            }
            check(!sawA1, "agent-scope: prefetch() excludes the agent-scoped memory");
            check(sawG1, "agent-scope: prefetch() still includes the global memory");

            // Reversed regression (2026-07-06 per-agent-memory redesign):
            // this used to assert unfiltered search() was UNAFFECTED by the
            // prefetch() fix (i.e. still spanned global+agent rows). Per the
            // redesign, Change 1 closes that leak everywhere the entityRef
            // arg is omitted, not just in prefetch() — so an unscoped
            // search() must now ALSO exclude the agent-scoped row.
            const auto hits = s.search(QStringLiteral("runner"), 20);
            bool searchSawA1 = false, searchSawG1 = false;
            for (const auto &r : hits) {
                if (r.id == a1) searchSawA1 = true;
                if (r.id == g1) searchSawG1 = true;
            }
            check(!searchSawA1 && searchSawG1,
                  "agent-scope: unfiltered search() also excludes agent-scoped rows now");
        }
    }

    // --- per-agent memory redesign (2026-07-06): mention-based auto-recall
    // in prefetch() ------------------------------------------------------
    // New explicit user direction: a brand-new/unrelated chat must have NO
    // idea about agent-specific facts (closing the leak from Change 1 above,
    // reasserted here against this test's own fixture), but a chat that's
    // clearly working on a specific agent/VM should automatically recall
    // that agent's memories without the user/model naming them explicitly
    // every time (prefetch()'s new mention-based auto-recall, Change 2).
    {
        QTemporaryDir tmpMention;
        const QString dbPathMention = tmpMention.path() + QStringLiteral("/agent_mention.db");
        MemoryStore s;
        check(s.open(dbPathMention, QStringLiteral("mem-agent-mention-conn")),
              "agent-mention: store open");

        const QString globalId = s.add(QStringLiteral("the shared database lives in vault"));
        const QString pveId = s.add(QStringLiteral("cpu load has been steady on pve"),
                                    {QStringLiteral("status")}, QString(),
                                    QStringLiteral("agent"), QStringLiteral("pve"));
        check(!globalId.isEmpty() && !pveId.isEmpty(), "agent-mention: two memories added");

        // A query that does NOT mention "pve" gets no agent-scoped rows at
        // all (closing the leak, matching the existing prefetch() exclusion
        // reasserted here for this fixture).
        {
            const auto pf = s.prefetch(QStringLiteral("what's new today"), 20);
            bool sawPve = false;
            for (const auto &r : pf)
                if (r.id == pveId) sawPve = true;
            check(!sawPve, "agent-mention: prefetch() with no agent mention excludes the pve row");
        }

        // A query that DOES mention "pve" (as a whole word) auto-recalls that
        // agent's scoped memories too, in addition to the normal global hits.
        {
            const auto pf = s.prefetch(QStringLiteral("let's check on pve"), 20);
            bool sawPve = false;
            for (const auto &r : pf)
                if (r.id == pveId) sawPve = true;
            check(sawPve, "agent-mention: prefetch() mentioning 'pve' auto-recalls its scoped memory");
        }

        // Change 1's leak-closing behavior, from this same fixture: an
        // unscoped search() must not include the pve-scoped row...
        {
            const auto hits = s.search(QStringLiteral("cpu load"), 20);
            bool sawPve = false;
            for (const auto &r : hits)
                if (r.id == pveId) sawPve = true;
            check(!sawPve, "agent-mention: unscoped search() excludes the pve-scoped row");
        }

        // ...while an explicitly agent-scoped search() still returns it.
        {
            const auto hits = s.search(QStringLiteral("cpu load"), 20, QStringLiteral("pve"));
            bool sawPve = false;
            for (const auto &r : hits)
                if (r.id == pveId) sawPve = true;
            check(sawPve, "agent-mention: search(entityRef='pve') still returns the pve-scoped row");
        }
    }

    // --- regression: migrate() against a genuinely pre-existing, already-
    // populated OLD-schema database (the real upgrade scenario: an existing
    // user's jarvis.db, created by code that predates the scope/entity_ref
    // columns, now opened by this build). Unlike the backfill test above
    // (whose "legacy" row is inserted AFTER a MemoryStore has already run
    // migrate() once), this builds the raw db file itself via bare Qt SQL
    // first — with the true OLD 5-column schema and data already in it —
    // before MemoryStore ever touches it, so migrate()'s hasColumn()-guarded
    // ALTER TABLE runs against a real, populated old-schema table.
    {
        QTemporaryDir tmp3;
        const QString dbPath3 = tmp3.path() + QStringLiteral("/legacy_schema.db");

        // Build the OLD 5-column schema directly (no MemoryStore involved)
        // and insert a row into it, mirroring a pre-upgrade jarvis.db.
        {
            QSqlDatabase raw = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"),
                                                         QStringLiteral("mem-legacy-raw-conn"));
            raw.setDatabaseName(dbPath3);
            check(raw.open(), "legacy-migration: raw sqlite file opened");
            {
                QSqlQuery ddl(raw);
                check(ddl.exec(QStringLiteral(
                          "CREATE TABLE memories ("
                          " id TEXT PRIMARY KEY,"
                          " text TEXT NOT NULL,"
                          " tags TEXT,"
                          " created INTEGER,"
                          " updated INTEGER)")),
                      "legacy-migration: created OLD 5-column memories table (no scope/entity_ref)");
            }
            {
                QSqlQuery ins(raw);
                ins.prepare(QStringLiteral(
                    "INSERT INTO memories (id,text,tags,created,updated) VALUES (?,?,?,?,?)"));
                ins.addBindValue(QStringLiteral("legacy-pre-existing-1"));
                ins.addBindValue(QStringLiteral("The vault PIN rotates every 90 days"));
                ins.addBindValue(QStringLiteral("security vault"));
                ins.addBindValue(qint64(1700000000000));
                ins.addBindValue(qint64(1700000000000));
                check(ins.exec(), "legacy-migration: raw-inserted a row into the old-schema table");
            }
            raw.close();
        }
        QSqlDatabase::removeDatabase(QStringLiteral("mem-legacy-raw-conn"));

        // Now open that SAME file through MemoryStore — this is what triggers
        // migrate()'s ALTER TABLE ADD COLUMN against a genuinely pre-existing,
        // already-populated old-schema table.
        MemoryStore migrated;
        check(migrated.open(dbPath3, QStringLiteral("mem-legacy-migrated-conn")),
              "legacy-migration: MemoryStore.open() migrates the pre-existing populated db");

        auto legacyRow = migrated.get(QStringLiteral("legacy-pre-existing-1"));
        check(legacyRow.has_value(), "legacy-migration: pre-existing row still retrievable after migrate");
        if (legacyRow) {
            check(legacyRow->text == QStringLiteral("The vault PIN rotates every 90 days"),
                  "legacy-migration: pre-existing row's text is untouched");
            check(legacyRow->tags == (QStringList{QStringLiteral("security"), QStringLiteral("vault")}),
                  "legacy-migration: pre-existing row's tags are untouched");
            check(legacyRow->created == 1700000000000LL,
                  "legacy-migration: pre-existing row's created is untouched");
            check(legacyRow->updated == 1700000000000LL,
                  "legacy-migration: pre-existing row's updated is untouched");
            check(legacyRow->scope == QStringLiteral("global"),
                  "legacy-migration: pre-existing row defaults scope='global'");
            check(legacyRow->entityRef.isEmpty(),
                  "legacy-migration: pre-existing row defaults entity_ref to empty");
        }

        // Search must still find the pre-existing row post-migration.
        {
            const auto hits = migrated.search(QStringLiteral("vault PIN"), 10);
            check(anyTextContains(hits, QStringLiteral("vault PIN")),
                  "legacy-migration: search finds the pre-existing row after migration");
        }

        // A brand-new row added post-migration must coexist correctly with
        // the migrated legacy row (both old and new rows work after the
        // ALTER TABLE has run against real data).
        const QString freshId = migrated.add(
            QStringLiteral("Freshly added memory after migrating the legacy db"),
            {QStringLiteral("fresh")});
        check(!freshId.isEmpty(), "legacy-migration: add() works on the freshly-migrated db");
        auto freshRow = migrated.get(freshId);
        check(freshRow.has_value() && freshRow->scope == QStringLiteral("global"),
              "legacy-migration: freshly-added row defaults scope='global' too");
        check(migrated.list().size() == 2,
              "legacy-migration: both the legacy row and the fresh row coexist post-migration");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
