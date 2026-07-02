// TrustPolicyStore (jarvis#71): CRUD persistence + the evaluation mirror
// (most-specific-wins, tie -> earliest, case-insensitive app matching).
// Uses a temp root so the real ~/.config/jarvis is never touched.

#include "jarvis/TrustPolicyStore.h"

#include <QFile>
#include <QJsonObject>
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

int main()
{
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
