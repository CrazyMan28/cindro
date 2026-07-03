#pragma once

// OsvAdvisory — supply-chain malware check for npx/uvx MCP servers
// (jarvis#76 item 12, daemon half).
//
// When the user (or the model) adds a stdio MCP server launched via npx/uvx,
// the daemon queries the OSV API for MAL-* advisories on the resolved package
// BEFORE storing the row (the only window: the daemon never spawns the
// package itself — codex does, on the next brain launch). On a hit, mcp.add
// returns a needs_approval response (same contract as plugins.install) so the
// user can consciously override. Offline/timeout FAIL-OPEN (an npm outage
// must not block MCP config), matching the repo's auth-gate precedent.

#include <QString>
#include <QStringList>

#include <optional>

namespace jarvis {

class OsvAdvisory {
public:
    struct Package {
        QString ecosystem; // "npm" | "PyPI"
        QString name;      // e.g. "@scope/pkg" or "package"
        QString version;   // "" = unpinned (query without version)
    };

    struct Result {
        bool ok = false;         // the HTTP query completed (false = offline/timeout)
        bool hasMalware = false; // any MAL-* advisory id in the response
        QStringList advisoryIds; // e.g. ["MAL-2025-1234"]
        QString summary;         // first advisory summary (for the approval UI)
    };

    // Extract the package an `npx`/`uvx` stdio endpoint would install:
    //   "npx @scope/pkg@1.2.3 --flag"      -> {npm,  "@scope/pkg", "1.2.3"}
    //   "npx -y some-server"               -> {npm,  "some-server", ""}
    //   "uvx mcp-tool"                     -> {PyPI, "mcp-tool", ""}
    //   "uvx --from pkg tool"              -> {PyPI, "pkg", ""}
    // nullopt for anything else (plain binaries, node script paths, http…).
    static std::optional<Package> parseStdioEndpoint(const QString &endpoint);

    // POST https://api.osv.dev/v1/query (blocking, bounded by timeoutMs).
    // `apiBase` override is a test seam. Callers MUST fail-open on !ok.
    static Result check(const Package &pkg, int timeoutMs = 3000,
                        const QString &apiBase = QString());
};

} // namespace jarvis
