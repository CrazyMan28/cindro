#pragma once

// PluginRegistry — Contract A v2 plugins.* domain logic on top of SessionStore.
//
// The mutable install/enable state (table plugins) lives in SessionStore. This
// class owns the catalog side that isn't pure storage:
//   - reading manifests from
//     /home/kihi2024/projects/computer_use/plugins/catalog/*.toml,
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

    // installed/enabled reflect DB state when a row exists, else the manifest's
    // own installed=/enabled= defaults (a built-in plugin can ship pre-enabled).
    bool installed = false;
    bool enabled = false;

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

    bool install(const QString &id);
    bool setEnabled(const QString &id, bool enabled);
    bool remove(const QString &id);

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
