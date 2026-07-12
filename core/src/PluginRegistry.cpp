#include "jarvis/PluginRegistry.h"
#include "jarvis/PluginSigner.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QStringList>

namespace jarvis {

QString PluginManifest::effectiveTransport() const
{
    if (!mcpUrl.isEmpty())
        return QStringLiteral("http");
    if (!mcpCommand.isEmpty())
        return QStringLiteral("stdio");
    return transport;
}

QString PluginManifest::effectiveEndpoint() const
{
    if (!mcpUrl.isEmpty())
        return mcpUrl;
    if (!mcpCommand.isEmpty())
        return mcpCommand;
    return endpoint;
}

QJsonObject PluginManifest::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("author"), author);
    o.insert(QStringLiteral("version"), version);
    o.insert(QStringLiteral("kind"), kind);
    QJsonArray perms;
    for (const QString &p : permissions)
        perms.append(p);
    o.insert(QStringLiteral("permissions"), perms);
    o.insert(QStringLiteral("description"), description);
    o.insert(QStringLiteral("installed"), installed);
    o.insert(QStringLiteral("enabled"), enabled);
    // Wave 7: surface the signature verdict + the permissions granted at install
    // so the desktop Plugins page can render a "verified / unverified" badge and
    // show exactly what a plugin is allowed to touch.
    o.insert(QStringLiteral("verified"), verified);
    o.insert(QStringLiteral("signed"), !signature.isEmpty());
    if (!grantedPermissions.isEmpty()) {
        QJsonArray g;
        for (const QString &p : grantedPermissions)
            g.append(p);
        o.insert(QStringLiteral("granted_permissions"), g);
    }
    const QString tr = effectiveTransport();
    const QString ep = effectiveEndpoint();
    if (!tr.isEmpty())
        o.insert(QStringLiteral("transport"), tr);
    if (!ep.isEmpty())
        o.insert(QStringLiteral("endpoint"), ep);
    if (!mcpEnvKeys.isEmpty()) {
        QJsonArray e;
        for (const QString &k : mcpEnvKeys)
            e.append(k);
        o.insert(QStringLiteral("env_keys"), e);
    }
    if (!skillPath.isEmpty())
        o.insert(QStringLiteral("skill_path"), skillPath);
    return o;
}

QString PluginRegistry::defaultCatalogDir()
{
    // An explicit override wins; else resolve relative to the executable
    // (<root>/build/daemon -> <root>/plugins/catalog), so any clone works.
    const QString fromEnv = qEnvironmentVariable("JARVIS_PLUGIN_CATALOG");
    if (!fromEnv.isEmpty())
        return fromEnv;
    return QDir(QCoreApplication::applicationDirPath())
        .absoluteFilePath(QStringLiteral("../../plugins/catalog"));
}

QString PluginRegistry::effectiveDir(const QString &catalogDir) const
{
    return catalogDir.isEmpty() ? defaultCatalogDir() : catalogDir;
}

namespace {

QString unquote(QString v)
{
    v = v.trimmed();
    if (v.size() >= 2) {
        const QChar a = v.front();
        const QChar b = v.back();
        if ((a == QLatin1Char('"') && b == QLatin1Char('"')) ||
            (a == QLatin1Char('\'') && b == QLatin1Char('\'')))
            return v.mid(1, v.size() - 2);
    }
    return v;
}

QStringList parseStringArray(QString v)
{
    QStringList out;
    v = v.trimmed();
    if (v.startsWith(QLatin1Char('[')) && v.endsWith(QLatin1Char(']')))
        v = v.mid(1, v.size() - 2);
    for (QString part : v.split(QLatin1Char(','))) {
        part = unquote(part.trimmed());
        if (!part.isEmpty())
            out << part;
    }
    return out;
}

} // namespace

std::optional<PluginManifest> PluginRegistry::parseManifest(const QString &tomlText)
{
    PluginManifest m;
    QString section; // "" (top-level) | "mcp" | "skill" | other
    for (QString line : tomlText.split(QLatin1Char('\n'))) {
        line = line.trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')))
            continue;
        if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']'))) {
            section = line.mid(1, line.size() - 2).trimmed();
            continue;
        }
        const int eq = line.indexOf(QLatin1Char('='));
        if (eq < 0)
            continue;
        const QString key = line.left(eq).trimmed();
        const QString rawVal = line.mid(eq + 1).trimmed();

        if (section == QStringLiteral("mcp")) {
            // [mcp] transport / command / url / env_keys
            if (key == QStringLiteral("transport"))
                m.transport = unquote(rawVal);
            else if (key == QStringLiteral("command"))
                m.mcpCommand = unquote(rawVal);
            else if (key == QStringLiteral("url"))
                m.mcpUrl = unquote(rawVal);
            else if (key == QStringLiteral("env_keys"))
                m.mcpEnvKeys = parseStringArray(rawVal);
            continue;
        }
        if (section == QStringLiteral("skill")) {
            if (key == QStringLiteral("path"))
                m.skillPath = unquote(rawVal);
            continue;
        }
        if (!section.isEmpty())
            continue; // ignore unknown sections

        if (key == QStringLiteral("id"))
            m.id = unquote(rawVal);
        else if (key == QStringLiteral("name"))
            m.name = unquote(rawVal);
        else if (key == QStringLiteral("author"))
            m.author = unquote(rawVal);
        else if (key == QStringLiteral("version"))
            m.version = unquote(rawVal);
        else if (key == QStringLiteral("kind"))
            m.kind = unquote(rawVal);
        else if (key == QStringLiteral("description"))
            m.description = unquote(rawVal);
        else if (key == QStringLiteral("transport"))
            m.transport = unquote(rawVal);
        else if (key == QStringLiteral("endpoint"))
            m.endpoint = unquote(rawVal);
        else if (key == QStringLiteral("signature"))
            m.signature = unquote(rawVal);
        else if (key == QStringLiteral("permissions"))
            m.permissions = parseStringArray(rawVal);
        else if (key == QStringLiteral("installed"))
            m.installed = (unquote(rawVal) == QStringLiteral("true"));
        else if (key == QStringLiteral("enabled"))
            m.enabled = (unquote(rawVal) == QStringLiteral("true"));
    }
    if (m.id.isEmpty())
        return std::nullopt;
    if (m.kind.isEmpty())
        m.kind = QStringLiteral("skill");
    return m;
}

bool PluginRegistry::seedSamples(const QString &catalogDir, QString *err)
{
    QDir dir(catalogDir);
    if (!dir.exists() && !dir.mkpath(QStringLiteral("."))) {
        if (err)
            *err = QStringLiteral("cannot create catalog dir: ") + catalogDir;
        return false;
    }

    struct Sample {
        const char *file;
        const char *toml;
    };
    const Sample samples[] = {
        {"github-mcp.toml",
         "# Cindro plugin manifest (sample, signed-ish)\n"
         "id = \"github-mcp\"\n"
         "name = \"GitHub MCP\"\n"
         "author = \"jarvis-labs\"\n"
         "version = \"0.2.0\"\n"
         "kind = \"mcp\"\n"
         "transport = \"http\"\n"
         "endpoint = \"https://api.githubcopilot.com/mcp/\"\n"
         "permissions = [\"network\", \"repo:read\", \"repo:write\"]\n"
         "description = \"Browse repos, issues, and PRs via the GitHub MCP server.\"\n"
         "signature = \"ed25519:PLACEHOLDER\"\n"},
        {"weather-skill.toml",
         "# Cindro plugin manifest (sample, signed-ish)\n"
         "id = \"weather-skill\"\n"
         "name = \"Weather Skill\"\n"
         "author = \"jarvis-labs\"\n"
         "version = \"1.0.0\"\n"
         "kind = \"skill\"\n"
         "permissions = [\"network\"]\n"
         "description = \"A skill that answers weather questions for a location.\"\n"
         "signature = \"ed25519:PLACEHOLDER\"\n"},
        {"shell-runner.toml",
         "# Cindro plugin manifest (sample, signed-ish)\n"
         "id = \"shell-runner\"\n"
         "name = \"Shell Runner\"\n"
         "author = \"jarvis-labs\"\n"
         "version = \"0.1.0\"\n"
         "kind = \"both\"\n"
         "transport = \"stdio\"\n"
         "endpoint = \"jarvis-shell-runner --stdio\"\n"
         "permissions = [\"exec\", \"fs:read\"]\n"
         "description = \"MCP + skill that runs allow-listed shell commands.\"\n"
         "signature = \"ed25519:PLACEHOLDER\"\n"},
    };

    for (const Sample &s : samples) {
        const QString path = dir.filePath(QString::fromLatin1(s.file));
        if (QFile::exists(path))
            continue;
        QFile f(path);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            if (err)
                *err = QStringLiteral("cannot write sample manifest: ") + path;
            return false;
        }
        f.write(QByteArray(s.toml));
        f.close();
    }
    return true;
}

bool PluginRegistry::ensureSeeded(const QString &catalogDir)
{
    const QString dirPath = effectiveDir(catalogDir);
    QDir dir(dirPath);
    const QStringList existing =
        dir.exists() ? dir.entryList({QStringLiteral("*.toml")}, QDir::Files) : QStringList();
    if (!existing.isEmpty())
        return true;
    QString err;
    if (!seedSamples(dirPath, &err)) {
        m_lastError = err;
        return false;
    }
    return true;
}

QVector<PluginManifest> PluginRegistry::catalog(const QString &catalogDir)
{
    ensureSeeded(catalogDir);

    QHash<QString, PluginRow> state;
    for (const PluginRow &pr : m_store.listPlugins())
        state.insert(pr.id, pr);

    // Verify against the trusted-keys file ONCE per catalog read.
    const QHash<QString, QByteArray> trusted = PluginSigner::loadTrustedKeys();

    QVector<PluginManifest> out;
    QDir dir(effectiveDir(catalogDir));
    if (!dir.exists())
        return out;
    for (const QString &file : dir.entryList({QStringLiteral("*.toml")}, QDir::Files, QDir::Name)) {
        QFile f(dir.filePath(file));
        if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
            continue;
        const QString text = QString::fromUtf8(f.readAll());
        f.close();
        auto man = parseManifest(text);
        if (!man)
            continue;
        // A published plugin's payload (skill SKILL.md / launcher) lives in a
        // sibling dir `<catalogDir>/<id>/` (see `jarvis-plugin publish`). Hash
        // it so the signature is checked over the SAME bytes the publisher
        // signed; a flat manifest with no payload dir verifies over "" (the
        // empty-payload case for manifest-only entries).
        const QString payloadHash =
            PluginSigner::hashPayloadDir(dir.filePath(man->id));
        const VerifyResult vr = PluginSigner::verify(*man, payloadHash, trusted);
        man->verified = vr.verified;
        if (state.contains(man->id)) {
            const PluginRow &pr = state.value(man->id);
            man->installed = pr.installed;
            man->enabled = pr.enabled;
            man->grantedPermissions = pr.grantedPermissions;
        }
        out.push_back(*man);
    }
    return out;
}

std::optional<PluginManifest> PluginRegistry::get(const QString &id, const QString &catalogDir)
{
    for (const PluginManifest &m : catalog(catalogDir)) {
        if (m.id == id)
            return m;
    }
    return std::nullopt;
}

bool PluginRegistry::install(const QString &id, bool verified,
                             const QStringList &grantedPermissions)
{
    auto man = get(id);
    if (!man) {
        m_lastError = QStringLiteral("unknown plugin: ") + id;
        return false;
    }
    PluginRow row;
    row.id = id;
    row.installed = true;
    row.verified = verified;
    // Record the granted permissions explicitly passed by the caller; if none
    // were passed, fall back to the manifest's declared permissions (the
    // implicit grant for a trusted/verified plugin).
    row.grantedPermissions =
        grantedPermissions.isEmpty() ? man->permissions : grantedPermissions;
    if (auto cur = m_store.getPlugin(id))
        row.enabled = cur->enabled;
    else
        row.enabled = true; // installing implies enabled by default
    row.updated = QDateTime::currentMSecsSinceEpoch();
    if (!m_store.upsertPlugin(row)) {
        m_lastError = m_store.lastError();
        return false;
    }
    return true;
}

PluginRegistry::VerifyVerdict
PluginRegistry::verify(const QString &id, const QString &catalogDir,
                       const QString &trustedKeysPath)
{
    VerifyVerdict v;
    auto man = get(id, catalogDir);
    if (!man) {
        v.error = QStringLiteral("unknown plugin: ") + id;
        return v;
    }
    const QHash<QString, QByteArray> trusted =
        PluginSigner::loadTrustedKeys(trustedKeysPath);
    // Hash the colocated payload dir (<catalogDir>/<id>/) so verification is
    // over the publisher-signed bytes (matches catalog()).
    const QString payloadDir =
        QDir(effectiveDir(catalogDir)).filePath(man->id);
    const QString payloadHash = PluginSigner::hashPayloadDir(payloadDir);
    const VerifyResult vr = PluginSigner::verify(*man, payloadHash, trusted);
    v.verified = vr.verified;
    v.permissions = man->permissions;
    v.keyId = vr.keyId;
    v.error = vr.error;
    return v;
}

bool PluginRegistry::setEnabled(const QString &id, bool enabled)
{
    if (!get(id)) {
        m_lastError = QStringLiteral("unknown plugin: ") + id;
        return false;
    }
    PluginRow row;
    row.id = id;
    row.enabled = enabled;
    row.installed = true;
    if (auto cur = m_store.getPlugin(id))
        row.installed = cur->installed || true; // enabling implies installed
    row.updated = QDateTime::currentMSecsSinceEpoch();
    if (!m_store.upsertPlugin(row)) {
        m_lastError = m_store.lastError();
        return false;
    }
    return true;
}

bool PluginRegistry::remove(const QString &id)
{
    if (!m_store.removePlugin(id)) {
        m_lastError = m_store.lastError();
        return false;
    }
    return true;
}

} // namespace jarvis
