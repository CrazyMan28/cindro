#pragma once

// McpRegistry — Contract A v2 mcp.* domain logic on top of SessionStore.
//
// The raw rows (table mcp_servers, incl. the always-present built-in
// "computer-use" entry) live in SessionStore. This class adds the behavior
// that isn't pure storage:
//   - test(): a REAL MCP handshake (initialize + tools/list) over http(s)
//     (Streamable HTTP / JSON-RPC POST) or stdio (spawned QProcess), with a
//     timeout, returning the advertised tool count.
//   - codexOverrides(): the `-c mcp_servers.<name>.url=...` +
//     `.bearer_token_env_var=...` (http) or `.command=...` (stdio) overrides for
//     every ENABLED server, so a spawned codex brain can call them — plus the
//     (envName -> token) pairs the brain must export (codex 0.135 rejects an
//     inline `bearer_token=` for streamable_http). The built-in computer-use
//     server's bearer is read from ~/.computer-use/config.yaml.

#include "jarvis/SessionStore.h"

#include <QJsonObject>
#include <QMap>
#include <QString>
#include <QStringList>
#include <functional>

namespace jarvis {

struct McpTestResult {
    bool ok = false;
    int toolsCount = 0;
    QString error;
};

// One executed MCP tools/call (command.invoke's mcp_tool custom commands).
struct McpCallResult {
    bool ok = false;
    QString content;  // concatenated text content items from the result
    QString error;    // JSON-RPC error message / isError content / transport error
};

// The codex `-c mcp_servers.<key>...` overrides PLUS the bearer-token env vars
// they reference. codex 0.135 rejects an inline `bearer_token=` for a streamable
// HTTP MCP server ("bearer_token is not supported for streamable_http") and
// instead wants `bearer_token_env_var=<NAME>` with <NAME> set in the codex
// process environment. So the override builder must hand back BOTH the `-c`
// args AND the (envName -> token) pairs, and the spawning brain must export the
// latter into the codex child's environment.
struct CodexMcpOverrides {
    QStringList args;            // values for `-c <arg>`
    QMap<QString, QString> env;  // envName -> bearer token
};

class McpRegistry {
public:
    explicit McpRegistry(SessionStore &store) : m_store(store) {}

    static QString builtinId() { return QStringLiteral("computer-use"); }
    static QString builtinEndpoint() { return QStringLiteral("http://127.0.0.1:8794/mcp"); }
    // ~/.computer-use/config.yaml -> bearer_token (best-effort; empty if absent).
    static QString computerUseBearer();

    // Proxmox workload manager: the local proxmox-mcp tool server a jarvisd
    // instance talks to when it fires a schedule whose targetRef starts with
    // "proxmox-". Only ever meaningful on a jarvisd deployed BY the Outpost
    // install flow onto the Proxmox host itself — proxmox-mcp and the jarvisd
    // that drives it are always co-located, so this is a fixed localhost port,
    // exactly like builtinEndpoint() is for the desktop computer-use engine.
    static QString proxmoxAgentEndpoint() { return QStringLiteral("http://127.0.0.1:8799/mcp"); }
    // /etc/jarvis-proxmox-agent/mcp_token -> bearer (written by the installer;
    // best-effort, empty if absent).
    static QString proxmoxAgentBearer();

    // --- CRUD (delegates to SessionStore) ---------------------------------
    QVector<McpServerRow> list() { return m_store.listMcpServers(); }
    std::optional<McpServerRow> get(const QString &id) { return m_store.getMcpServer(id); }
    // Add a user server; returns its generated id (empty on error). `env` is the
    // optional brain-injectable env-var map (name -> secret-ref or literal) used
    // by Google connectors; empty for ordinary servers.
    QString add(const QString &name, const QString &transport,
                const QString &endpoint, const QString &token, bool enabled,
                const QString &risk = QStringLiteral("medium"),
                const QJsonObject &env = {}, bool builtin = false,
                const QString &fixedId = QString());
    // Refuses to remove a built-in server (computer-use / phone) — they're seeded
    // by the daemon and must always be present. Returns false for a builtin id.
    bool remove(const QString &id);
    bool setEnabled(const QString &id, bool enabled) { return m_store.setMcpEnabled(id, enabled); }

    // --- live test ---------------------------------------------------------
    // Real MCP initialize + tools/list with a timeout. For http, `server.token`
    // (or computerUseBearer() for the built-in) is sent as Bearer.
    static McpTestResult test(const McpServerRow &server, int timeoutMs = 5000);

    // --- live tool call ----------------------------------------------------
    // Real MCP initialize + tools/call (same transports/bearer rules as
    // test()). Powers command.invoke's mcp_tool custom commands — previously
    // those only echoed the tool name back and nothing ever executed.
    static McpCallResult callTool(const McpServerRow &server, const QString &tool,
                                  const QJsonObject &arguments, int timeoutMs = 30000);

    // Resolves a row.env value (a "secret:<key>" reference or a literal) to the
    // concrete value to inject. The daemon supplies one backed by SettingsStore;
    // the default (identity) leaves the token as-is.
    using EnvResolver = std::function<QString(const QString &)>;

    // --- codex injection ---------------------------------------------------
    // `-c mcp_servers.<key>...` overrides for every enabled server (always
    // including the built-in computer-use with its config.yaml bearer). HTTP
    // bearers are emitted as `bearer_token_env_var=<NAME>` with the value
    // returned in CodexMcpOverrides::env (see struct doc). For an enabled stdio
    // server with a non-empty `env` map, each entry is emitted as
    // `mcp_servers.<key>.env.<NAME>=<resolved value>` (Google connectors).
    CodexMcpOverrides codexOverrides(const EnvResolver &resolveEnv = {});

    // Sanitize a server name into a codex-config-safe key (alnum + underscore).
    static QString codexKey(const McpServerRow &row);

    // The codex env-var NAME under which a given server key's bearer is exported
    // (e.g. JARVIS_CU_BEARER_<KEY>). Uppercased, alnum+underscore.
    static QString bearerEnvName(const QString &codexKey);

private:
    SessionStore &m_store;
};

} // namespace jarvis
