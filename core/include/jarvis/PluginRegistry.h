#pragma once

// PluginRegistry — Contract A v2 plugins.* domain logic on top of SessionStore.
//
// The mutable install/enable state (table plugins) lives in SessionStore. This
// class owns the catalog side that isn't pure storage:
//   - reading manifests from
//     /home/user/projects/computer_use/plugins/catalog/*.toml,
//   - seeding sample manifests if the directory is empty,
//   - merging the disk catalog with the per-plugin DB state for plugins.catalog.

#include "jarvis/SessionStore.h"

#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>
#include <optional>

namespace jarvis {

struct PluginManifest {
    QString id;
    QString name;
    QString author;
    QString version;
    QString kind;          // "mcp" | "skill" | "both"
    QStringList permissions;
    QString description;
    QString transport;     // "http" | "stdio" | "" (mcp/both only)
    QString endpoint;      // url or command line (mcp/both only)

    // Wave 7 signed-manifest fields (jarvis-plugin.toml).
    //   [mcp]   transport/command|url/env_keys  — how to launch / reach the MCP.
    //   [skill] path                            — relative path to SKILL.md.
    //   signature                               — "ed25519:<keyId>:<b64 sig>".
    QString mcpCommand;    // [mcp] command  (stdio launcher argv string)
    QString mcpUrl;        // [mcp] url      (http endpoint)
    QStringList mcpEnvKeys;// [mcp] env_keys (env var names the launcher may see)
    QString skillPath;     // [skill] path   (relative path to SKILL.md)
    QString signature;     // "ed25519:<keyId>:<base64 sig>"

    // installed/enabled reflect DB state when a row exists, else the manifest's
    // own installed=/enabled= defaults (a built-in plugin can ship pre-enabled).
    bool installed = false;
    bool enabled = false;

    // Set by PluginRegistry::catalog()/get() from a signature check: true iff
    // the package is signed by a trusted publisher key. `grantedPermissions` is
    // the permission set recorded at install time (empty until installed).
    bool verified = false;
    QStringList grantedPermissions;

    // Effective transport/endpoint for MCP wiring, preferring [mcp] over the
    // legacy flat transport/endpoint keys.
    QString effectiveTransport() const;
    QString effectiveEndpoint() const;

    QJsonObject toJson() const;
};

class PluginRegistry {
public:
    explicit PluginRegistry(SessionStore &store) : m_store(store) {}

    static QString defaultCatalogDir();

    // Seed sample manifests if the catalog has no *.toml files. Returns false
    // only on an I/O error creating/writing the seed files.
    bool ensureSeeded(const QString &catalogDir = QString());

    // Disk catalog merged with DB install/enable state.
    QVector<PluginManifest> catalog(const QString &catalogDir = QString());
    std::optional<PluginManifest> get(const QString &id,
                                      const QString &catalogDir = QString());

    // install() now records the verification verdict + granted permissions so a
    // later set_enabled can launch the plugin under exactly the granted perms.
    // `verified` and `grantedPermissions` come from a prior verify() check.
    bool install(const QString &id, bool verified = false,
                 const QStringList &grantedPermissions = QStringList());
    bool setEnabled(const QString &id, bool enabled);
    bool remove(const QString &id);

    // Verify the signature of the catalog manifest `id` against the trusted-keys
    // file (~/.config/jarvis/plugin_keys.json). The catalog stores a flat
    // manifest (no payload alongside it), so verification is over the manifest's
    // canonical string with an empty payload hash unless a package dir is given.
    // Returns the verdict (verified flag + declared permissions). `catalogDir`
    // and `trustedKeysPath` override locations for tests.
    struct VerifyVerdict {
        bool verified = false;
        QStringList permissions;
        QString keyId;
        QString error;
    };
    VerifyVerdict verify(const QString &id,
                         const QString &catalogDir = QString(),
                         const QString &trustedKeysPath = QString());

    QString lastError() const { return m_lastError; }

    // Parse one manifest TOML. nullopt if it has no id.
    static std::optional<PluginManifest> parseManifest(const QString &tomlText);
    // Write the bundled samples into catalogDir. Returns false on I/O error.
    static bool seedSamples(const QString &catalogDir, QString *err = nullptr);

private:
    QString effectiveDir(const QString &catalogDir) const;

    SessionStore &m_store;
    QString m_lastError;
};

} // namespace jarvis
