// ctest: OsvAdvisory endpoint parsing + offline fail-open (jarvis#76 item 12).
// No live OSV calls — the network path is exercised against a dead local port.

#include "jarvis/OsvAdvisory.h"

#include <QCoreApplication>

#include <cstdio>

using jarvis::OsvAdvisory;

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

    // --- parseStdioEndpoint ---------------------------------------------------
    {
        auto p = OsvAdvisory::parseStdioEndpoint(
            QStringLiteral("npx @scope/pkg@1.2.3 --port 3000"));
        check(p.has_value(), "npx scoped+pinned parses");
        check(p && p->ecosystem == QStringLiteral("npm"), "npx -> npm ecosystem");
        check(p && p->name == QStringLiteral("@scope/pkg"), "scope survives version split");
        check(p && p->version == QStringLiteral("1.2.3"), "version extracted");
    }
    {
        auto p = OsvAdvisory::parseStdioEndpoint(QStringLiteral("npx -y some-server"));
        check(p && p->name == QStringLiteral("some-server") && p->version.isEmpty(),
              "npx -y flag skipped, unpinned");
    }
    {
        auto p = OsvAdvisory::parseStdioEndpoint(
            QStringLiteral("npx --package @scope/cli-pkg run-thing"));
        check(p && p->name == QStringLiteral("@scope/cli-pkg"),
              "npx --package value wins");
    }
    {
        auto p = OsvAdvisory::parseStdioEndpoint(QStringLiteral("uvx mcp-tool"));
        check(p && p->ecosystem == QStringLiteral("PyPI") &&
                  p->name == QStringLiteral("mcp-tool"),
              "uvx -> PyPI");
    }
    {
        auto p = OsvAdvisory::parseStdioEndpoint(
            QStringLiteral("uvx --from real-pkg tool-name"));
        check(p && p->name == QStringLiteral("real-pkg"), "uvx --from value wins");
    }
    {
        auto p = OsvAdvisory::parseStdioEndpoint(
            QStringLiteral("uvx -p 3.12 mcp-tool"));
        check(p && p->name == QStringLiteral("mcp-tool"),
              "uvx -p takes a PYTHON version — package is the next token");
    }
    {
        auto p = OsvAdvisory::parseStdioEndpoint(
            QStringLiteral("npx -p @scope/cli-pkg run-thing"));
        check(p && p->name == QStringLiteral("@scope/cli-pkg"),
              "npx -p names the package");
    }
    {
        check(!OsvAdvisory::parseStdioEndpoint(QStringLiteral("/usr/bin/mcp-server --x"))
                   .has_value(),
              "plain binary is not a package launch");
        check(!OsvAdvisory::parseStdioEndpoint(QStringLiteral("npx")).has_value(),
              "bare npx has no package");
        check(!OsvAdvisory::parseStdioEndpoint(QStringLiteral("node server.js")).has_value(),
              "node script is not a package launch");
    }

    // --- offline fail-open ------------------------------------------------------
    {
        OsvAdvisory::Package pkg;
        pkg.ecosystem = QStringLiteral("npm");
        pkg.name = QStringLiteral("anything");
        const OsvAdvisory::Result r =
            OsvAdvisory::check(pkg, 300, QStringLiteral("http://127.0.0.1:1"));
        check(!r.ok, "dead endpoint reports ok=false");
        check(!r.hasMalware, "dead endpoint never claims malware (fail-open)");
        check(r.advisoryIds.isEmpty(), "no advisories on failure");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "osv_advisory_test: all checks passed\n");
    return g_failures == 0 ? 0 : 1;
}
