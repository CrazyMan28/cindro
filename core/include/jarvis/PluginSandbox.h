#pragma once

// PluginSandbox — launch a kind=mcp/both stdio plugin under a constrained
// sandbox, derived from the plugin's DECLARED permissions, and tear it down by
// PID (never pkill-by-name).
//
// Preferred backend: `systemd-run --user --scope` with:
//   - ProtectHome=read-only            (home is hidden unless a fs perm opens it)
//   - ReadWritePaths=<p> per filesystem:<p> permission
//   - PrivateNetwork=yes               UNLESS a network:<host> permission exists
//   - a scrubbed environment, re-exporting only the declared env_keys
// Fallback (when systemd-run is unavailable): a plain QProcess with the env
// scrubbed to the declared env_keys (best-effort; weaker isolation).
//
// HTTP-MCP plugins are NOT launched here — they are just URLs the daemon adds to
// the brains' MCP config with a bearer (handled in ControlServer).

#include "jarvis/PluginRegistry.h"

#include <QObject>
#include <QProcess>
#include <QString>
#include <QStringList>
#include <map>
#include <memory>

namespace jarvis {

// The argv + environment + working dir a sandboxed launch resolves to. Exposed
// so it can be unit-tested without actually spawning anything.
struct SandboxPlan {
    QString program;          // "systemd-run" or the plugin's own program
    QStringList arguments;    // full argv after `program`
    QStringList allowedEnv;   // env_keys re-exported into the unit
    bool usesSystemdRun = false;
    bool networkAllowed = false;
    QStringList readWritePaths;
};

// A running sandboxed plugin process. Owns the QProcess; teardown() kills it by
// PID (terminate, then kill after a grace period) — scoped to THIS process only.
struct RunningPlugin {
    QString id;
    qint64 pid = 0;
    bool usesSystemdRun = false;
    QString scopeName;        // "jarvis-plugin-<id>.scope" when systemd-run
    std::unique_ptr<QProcess> process;
};

class PluginSandbox : public QObject {
    Q_OBJECT
public:
    explicit PluginSandbox(QObject *parent = nullptr);
    ~PluginSandbox() override;

    // True iff `systemd-run --user` is usable (binary on PATH + a user manager).
    static bool systemdRunAvailable();

    // Resolve (without spawning) the sandbox plan for a plugin manifest given a
    // base environment. `permissions` is the GRANTED set (filesystem:<p> /
    // network:<host> / computer-use). Pure function — used by tests.
    static SandboxPlan plan(const PluginManifest &m,
                            const QStringList &permissions,
                            const QProcessEnvironment &baseEnv,
                            bool forceSystemdRun, bool forceFallback);

    // Launch the plugin's stdio MCP server under the sandbox. Returns false (and
    // sets lastError) if the manifest isn't a stdio mcp/both plugin or spawn
    // failed. Idempotent: a second start for the same id is a no-op success.
    bool start(const PluginManifest &m, const QStringList &grantedPermissions);

    // Tear down the plugin's process BY PID (scoped). No-op if not running.
    bool stop(const QString &id);

    bool isRunning(const QString &id) const;
    qint64 pidOf(const QString &id) const;

    QString lastError() const { return m_lastError; }

private:
    // std::map (not QHash) because the values are move-only unique_ptrs —
    // QHash's copy-on-write detach would require a copyable value type.
    std::map<QString, std::unique_ptr<RunningPlugin>> m_running;
    QString m_lastError;
};

} // namespace jarvis
