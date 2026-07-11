// ctest: pure parse/merge logic for the dynamic model-discovery feature
// (jarvis::parseCodexModelCatalog / parseClaudeModelCatalog / mergeModelCatalogs).
//
// Both source formats were confirmed against the REAL codex/claude endpoints
// live (2026-07-11), not assumed from docs — codex's `debug models --bundled`
// is an unofficial subcommand and Anthropic's /v1/models is public but still
// gets the same defensive treatment. These tests pin: the real shapes parse
// correctly, a "hide"-visibility codex model is filtered out, and any
// unexpected top-level shape (wrong type, missing key, garbage) fails open
// (ok=false, empty models) rather than throwing or half-parsing.

#include "jarvis/ModelCatalog.h"

#include <QJsonArray>
#include <QJsonValue>
#include <QString>
#include <QStringList>

#include <cstdio>

using jarvis::mergeModelCatalogs;
using jarvis::parseClaudeModelCatalog;
using jarvis::parseCodexModelCatalog;

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

QStringList toStringList(const QJsonArray &a)
{
    QStringList out;
    for (const QJsonValue &v : a)
        out << v.toString();
    return out;
}

} // namespace

int main()
{
    // --- codex: real shape (live-verified against codex 0.144.1) ---
    {
        const QByteArray body = R"({"models":[
            {"slug":"gpt-5.6-sol","visibility":"list"},
            {"slug":"codex-auto-review","visibility":"hide"},
            {"slug":"gpt-5.5","visibility":"list"}
        ]})";
        const auto r = parseCodexModelCatalog(body);
        check(r.ok, "codex: real shape parses ok");
        check(toStringList(r.models) == QStringList({"gpt-5.6-sol", "gpt-5.5"}),
              "codex: hide-visibility model filtered, others kept in order");
    }

    // --- codex: shape mismatches fail open ---
    {
        check(!parseCodexModelCatalog("[]").ok,
              "codex: bare top-level array (the WRONG assumed shape) fails open");
        check(!parseCodexModelCatalog("{}").ok,
              "codex: object missing \"models\" key fails open");
        check(!parseCodexModelCatalog("not json at all").ok,
              "codex: garbage input fails open, no crash");
        check(!parseCodexModelCatalog("").ok,
              "codex: empty stdout fails open");
    }

    // --- codex: shape valid but genuinely zero models is still ok=true ---
    {
        const auto r = parseCodexModelCatalog(R"({"models":[]})");
        check(r.ok && r.models.isEmpty(),
              "codex: valid empty catalog is ok=true (longer TTL, not a retry-soon failure)");
    }

    // --- codex: entries missing a slug are skipped, not crashing ---
    {
        const auto r = parseCodexModelCatalog(R"({"models":[{"visibility":"list"}]})");
        check(r.ok && r.models.isEmpty(), "codex: entry with no slug is silently skipped");
    }

    // --- claude: real shape (live-verified against /v1/models, 2026-07-11) ---
    {
        const QByteArray body = R"({"data":[
            {"type":"model","id":"claude-sonnet-5","display_name":"Claude Sonnet 5"},
            {"type":"model","id":"claude-fable-5","display_name":"Claude Fable 5"}
        ],"has_more":false})";
        const auto r = parseClaudeModelCatalog(body);
        check(r.ok, "claude: real shape parses ok");
        check(toStringList(r.models) == QStringList({"claude-sonnet-5", "claude-fable-5"}),
              "claude: ids extracted in order");
    }

    // --- claude: shape mismatches fail open ---
    {
        check(!parseClaudeModelCatalog("[]").ok,
              "claude: bare top-level array fails open");
        check(!parseClaudeModelCatalog(R"({"error":{"type":"not_found_error"}})").ok,
              "claude: an API error body (no \"data\" key) fails open");
        check(!parseClaudeModelCatalog("garbage").ok,
              "claude: garbage input fails open, no crash");
    }

    // --- merge: live entries appended, baseline order/priority preserved ---
    {
        QJsonArray baseline{QStringLiteral("claude-opus-4-8"), QStringLiteral("claude-sonnet-4-6")};
        QJsonArray live{QStringLiteral("claude-sonnet-4-6"), QStringLiteral("claude-fable-5")};
        const QJsonArray merged = mergeModelCatalogs(baseline, live);
        check(toStringList(merged) ==
                  QStringList({"claude-opus-4-8", "claude-sonnet-4-6", "claude-fable-5"}),
              "merge: baseline first, live dedup'd, new live entries appended");
        check(merged.first().toString() == QStringLiteral("claude-opus-4-8"),
              "merge: baseline's first entry stays first (firstModelForBrain's default is stable)");
    }

    // --- merge: dedup is case/whitespace-insensitive ---
    {
        QJsonArray baseline{QStringLiteral("gpt-5.5")};
        QJsonArray live{QStringLiteral(" GPT-5.5 "), QStringLiteral("gpt-5.6-sol")};
        const QJsonArray merged = mergeModelCatalogs(baseline, live);
        check(toStringList(merged) == QStringList({"gpt-5.5", "gpt-5.6-sol"}),
              "merge: case/whitespace-insensitive dedup against baseline");
    }

    // --- merge: empty live list is a no-op ---
    {
        QJsonArray baseline{QStringLiteral("gpt-5.5"), QStringLiteral("o4-mini")};
        const QJsonArray merged = mergeModelCatalogs(baseline, {});
        check(merged == baseline, "merge: empty live catalog leaves baseline untouched");
    }

    if (g_failures) {
        std::fprintf(stderr, "\n%d check(s) FAILED\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "\nall checks passed\n");
    return 0;
}
