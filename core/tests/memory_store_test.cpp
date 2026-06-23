// ctest: MemoryStore add + FTS5 search + remove roundtrip against a temp DB.

#include "jarvis/MemoryStore.h"

#include <QCoreApplication>
#include <QDir>
#include <QTemporaryDir>

#include <cstdio>

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

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
