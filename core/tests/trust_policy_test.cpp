// TrustPolicyStore (jarvis#71): CRUD persistence + the evaluation mirror
// (most-specific-wins, tie -> earliest, case-insensitive app matching).
// Uses a temp root so the real ~/.config/jarvis is never touched.

#include "jarvis/TrustPolicyStore.h"

#include <QByteArray>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QString>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::TrustDecision;
using jarvis::TrustPolicyStore;

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

// Shared glob conformance fixture (core/tests/fixtures/trust_policy_vectors.json),
// also consumed by computer-use's Python test against policy.py's fnmatch (the
// real enforcement's source of truth) -- see trust-policy-glob-parity. Each
// vector is a single glob probe; drive it through the PUBLIC evaluate()/
// addRule() API (globMatch() itself is private) with a single deny rule on
// whichever field (tool = case-sensitive, app = case-insensitive) the vector
// targets, so a match flips the decision away from the store's default allow.
static void runGlobFixture(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        std::fprintf(stderr, "  FAIL: cannot open glob fixture %s\n", qPrintable(path));
        ++g_failures;
        return;
    }
    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
    f.close();
    const QJsonArray vectors = doc.object().value(QStringLiteral("vectors")).toArray();
    check(!vectors.isEmpty(), "glob fixture loaded vectors");

    QTemporaryDir tmp;
    for (const QJsonValue &v : vectors) {
        const QJsonObject o = v.toObject();
        const QString pattern = o.value(QStringLiteral("pattern")).toString();
        const QString value = o.value(QStringLiteral("value")).toString();
        const bool isTool = o.value(QStringLiteral("tool")).toBool();
        const bool expected = o.value(QStringLiteral("expected")).toBool();
        const QString note = o.value(QStringLiteral("note")).toString();

        TrustPolicyStore store(tmp.path());
        const QString rid = isTool
            ? store.addRule(pattern, QStringLiteral("*"), QStringLiteral("deny"))
            : store.addRule(QStringLiteral("*"), pattern, QStringLiteral("deny"));
        const TrustDecision d = isTool ? store.evaluate(value, QString())
                                        : store.evaluate(QStringLiteral("x"), value);
        const bool matched = d.action == QStringLiteral("deny");
        const QByteArray label = (QStringLiteral("glob: ") + pattern +
                                   QStringLiteral(" vs ") + value +
                                   QStringLiteral(" (") + note + QStringLiteral(")"))
                                      .toUtf8();
        check(matched == expected, label.constData());
        store.removeRule(rid);
    }
}

int main(int argc, char **argv)
{
    // Fixture path: argv[1] overrides; else the compile-time define; else a
    // path relative to a ctest run from the repo root.
    QString fixturePath =
#ifdef JARVIS_TRUST_POLICY_VECTORS
        QStringLiteral(JARVIS_TRUST_POLICY_VECTORS);
#else
        QStringLiteral("core/tests/fixtures/trust_policy_vectors.json");
#endif
    if (argc > 1)
        fixturePath = QString::fromLocal8Bit(argv[1]);
    runGlobFixture(fixturePath);

    QTemporaryDir tmp;

    {
        TrustPolicyStore store(tmp.path());
        check(store.defaultAction() == "allow", "fresh store defaults to allow");
        check(store.evaluate("mouse_click", "").action == "allow",
              "no rules -> allow");

        const QString rid = store.addRule("file_*", "*", "deny", "no file tools");
        check(!rid.isEmpty(), "addRule returns an id");
        check(store.evaluate("file_read", "").action == "deny",
              "deny rule blocks matching tool");
        check(store.evaluate("file_read", "").ruleId == rid,
              "decision carries the rule id");
        check(store.evaluate("mouse_click", "").action == "allow",
              "unmatched tool stays allowed");

        // Most specific wins regardless of order.
        store.addRule("browser_*", "*", "deny", "", "broad");
        store.addRule("browser_click", "*", "allow", "", "narrow");
        check(store.evaluate("browser_click", "").ruleId == "narrow",
              "most specific rule wins");
        check(store.evaluate("browser_navigate", "").ruleId == "broad",
              "broad rule catches the rest");

        // Tie -> earliest rule in the list.
        store.addRule("key_press", "*", "ask", "", "first");
        store.addRule("key_press", "*", "deny", "", "second");
        check(store.evaluate("key_press", "").ruleId == "first",
              "tie goes to the earliest rule");

        // App matching is case-insensitive glob.
        store.addRule("*", "*bank*", "deny", "", "bank");
        check(store.evaluate("mouse_click", "firefox|My Bank — login").action == "deny",
              "app glob matches case-insensitively");
        check(store.evaluate("mouse_click", "firefox|news").ruleId != "bank",
              "app glob does not overmatch");

        // Update + remove.
        check(store.updateRule("broad", QJsonObject{{"action", "ask"}}),
              "updateRule succeeds");
        check(store.evaluate("browser_navigate", "").action == "ask",
              "update took effect");
        check(!store.updateRule("broad", QJsonObject{{"action", "bogus"}}),
              "bad action rejected");
        check(store.removeRule("bank"), "removeRule succeeds");
        check(store.evaluate("mouse_click", "firefox|My Bank").action == "allow",
              "removed rule no longer applies");
        check(!store.removeRule("bank"), "double remove fails");

        check(store.setDefaultAction("deny"), "setDefaultAction persists");
        check(store.evaluate("totally_unknown", "").action == "deny",
              "default deny applies to unmatched tools");
        check(!store.setDefaultAction("nope"), "bad default rejected");

        check(!store.preambleClause().isEmpty(),
              "preamble clause renders when rules exist");
    }

    {
        // Reload from disk: everything above persisted.
        TrustPolicyStore store2(tmp.path());
        check(store2.defaultAction() == "deny", "default survived reload");
        check(store2.evaluate("browser_click", "").ruleId == "narrow",
              "rules survived reload");
    }

    {
        // Corrupt file: never brick, behave as empty.
        QTemporaryDir tmp2;
        TrustPolicyStore pre(tmp2.path());
        QFile f(pre.filePath());
        f.open(QIODevice::WriteOnly);
        f.write("{not json");
        f.close();
        TrustPolicyStore store3(tmp2.path());
        check(store3.evaluate("anything", "").action == "allow",
              "corrupt file behaves as empty (allow)");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d failure(s)\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "trust_policy_test: all passed\n");
    return 0;
}
