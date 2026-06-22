#pragma once

// McpRegistry — Contract A v2 mcp.* domain logic on top of SessionStore.
//
// The raw rows (table mcp_servers, incl. the always-present built-in
// "computer-use" entry) live in SessionStore. This class adds the behavior
// that isn't pure storage:
//   - test(): a REAL MCP handshake (initialize + tools/list) over http(s)
//     (Streamable HTTP / JSON-RPC POST) or stdio (spawned QProcess), with a
//     timeout, returning the advertised tool count.
//   - codexOverrides(): the `-c mcp_servers.<name>.url=...`/`.bearer_token=...`
//     (http) or `.command=...` (stdio) overrides for every ENABLED server, so a
//     spawned codex brain can call them. The built-in computer-use server's
//     bearer is read from ~/.computer-use/config.yaml.

#include "jarvis/SessionStore.h"

#include <QString>
#include <QStringList>

namespace jarvis {

struct McpTestResult {
    bool ok = false;
    int toolsCount = 0;
    QString error;
};

class McpRegistry {
public:
    explicit McpRegistry(SessionStore &store) : m_store(store) {}

    static QString builtinId() { return QStringLiteral("computer-use"); }
    static QString builtinEndpoint() { return QStringLiteral("http://127.0.0.1:8794/mcp"); }
    // ~/.computer-use/config.yaml -> bearer_token (best-effort; empty if absent).
    static QString computerUseBearer();

    // --- CRUD (delegates to SessionStore) ---------------------------------
    QVector<McpServerRow> list() { return m_store.listMcpServers(); }
    std::optional<McpServerRow> get(const QString &id) { return m_store.getMcpServer(id); }
    // Add a user server; returns its generated id (empty on error).
    QString add(const QString &name, const QString &transport,
                const QString &endpoint, const QString &token, bool enabled,
                const QString &risk = QStringLiteral("medium"));
    bool remove(const QString &id) { return m_store.removeMcpServer(id); }
    bool setEnabled(const QString &id, bool enabled) { return m_store.setMcpEnabled(id, enabled); }

    // --- live test ---------------------------------------------------------
    // Real MCP initialize + tools/list with a timeout. For http, `server.token`
    // (or computerUseBearer() for the built-in) is sent as Bearer.
    static McpTestResult test(const McpServerRow &server, int timeoutMs = 5000);

    // --- codex injection ---------------------------------------------------
    // `-c mcp_servers.<key>...` overrides for every enabled server (always
    // including the built-in computer-use with its config.yaml bearer).
    QStringList codexOverrides();

    // Sanitize a server name into a codex-config-safe key (alnum + underscore).
    static QString codexKey(const McpServerRow &row);

private:
    SessionStore &m_store;
};

} // namespace jarvis
