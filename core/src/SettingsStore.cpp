#include "jarvis/SettingsStore.h"

#include "jarvis/Config.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>
#include <QStringList>
#include <QTextStream>

namespace jarvis {

QString SettingsStore::secretsFilePath()
{
    return Config::configDir() + QStringLiteral("/secrets.json");
}

QStringList SettingsStore::providerKeys()
{
    return {QStringLiteral("codex"), QStringLiteral("claude"),
            QStringLiteral("openai"), QStringLiteral("anthropic"),
            QStringLiteral("mistral"), QStringLiteral("ollama")};
}

QString SettingsStore::claudeConfigDirFor(const QString &account)
{
    // Pro = ~/.claude (default), Max = ~/.claude-secondary. Anything other than
    // an explicit "max" resolves to Pro so the claude brain never accidentally
    // points at the Max account.
    if (account == QStringLiteral("max"))
        return QDir::homePath() + QStringLiteral("/.claude-secondary");
    return QDir::homePath() + QStringLiteral("/.claude");
}

void SettingsStore::load()
{
    const Config cfg = Config::load();
    m_defaultBrain = cfg.defaultBrain;
    m_defaultModel = cfg.defaultModel;
    setClaudeAccount(cfg.claudeAccount); // normalizes to pro|max

    // theme round-trips as `theme_json = '<compact json>'` in config.toml.
    // let_jarvis_use_computer round-trips as a bare `true`/`false` flat key
    // (default true when absent). auth_lock_enabled defaults ON (no-brick: lock
    // the desktop on launch; the daemon fail-opens when no approver is reachable)
    // so it must default true here too — the parse below only flips it OFF on an
    // explicit `false`/`0`, matching let_jarvis_use_computer. tts_voice
    // round-trips as `tts_voice = "..."` (empty when absent).
    m_letJarvisUseComputer = true;
    m_authLockEnabled = true;
    m_ttsVoice.clear();
    m_sttProvider = QStringLiteral("voxtral");
    m_ttsProvider = QStringLiteral("voxtral");
    m_theme = QJsonObject();
    {
        QFile f(Config::configFilePath());
        if (f.exists() && f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            const QString text = QString::fromUtf8(f.readAll());
            f.close();
            for (const QString &raw : text.split(QLatin1Char('\n'))) {
                const QString line = raw.trimmed();
                if (line.startsWith(QStringLiteral("let_jarvis_use_computer"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        const QString v = line.mid(eq + 1).trimmed().toLower();
                        m_letJarvisUseComputer =
                            !(v == QStringLiteral("false") || v == QStringLiteral("0"));
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("auth_lock_enabled"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        const QString v = line.mid(eq + 1).trimmed().toLower();
                        // Default ON (no-brick); only an explicit false/0 turns it
                        // OFF (mirrors let_jarvis_use_computer above).
                        m_authLockEnabled =
                            !(v == QStringLiteral("false") || v == QStringLiteral("0"));
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("tts_voice"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        m_ttsVoice = v;
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("stt_provider"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setSttProvider(v); // normalizes unknown -> voxtral
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("tts_provider"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setTtsProvider(v); // normalizes unknown -> voxtral
                    }
                    continue;
                }
                if (!line.startsWith(QStringLiteral("theme_json")))
                    continue;
                const int eq = line.indexOf(QLatin1Char('='));
                if (eq < 0)
                    continue;
                QString v = line.mid(eq + 1).trimmed();
                if (v.size() >= 2 &&
                    ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                     (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                    v = v.mid(1, v.size() - 2);
                const QJsonDocument d = QJsonDocument::fromJson(v.toUtf8());
                if (d.isObject())
                    m_theme = d.object();
                break;
            }
        }
    }

    // secrets.json: { provider: value, ... }  (flat; matches ControlServer's writer).
    m_apiKeys = QJsonObject();
    {
        QFile f(secretsFilePath());
        if (f.exists() && f.open(QIODevice::ReadOnly)) {
            const QJsonDocument d = QJsonDocument::fromJson(f.readAll());
            f.close();
            if (d.isObject())
                m_apiKeys = d.object();
        }
    }
}

bool SettingsStore::hasApiKey(const QString &provider) const
{
    return !m_apiKeys.value(provider).toString().isEmpty();
}

void SettingsStore::setApiKey(const QString &provider, const QString &value)
{
    if (value.isEmpty())
        m_apiKeys.remove(provider);
    else
        m_apiKeys.insert(provider, value);
}

QString SettingsStore::apiKey(const QString &provider) const
{
    return m_apiKeys.value(provider).toString();
}

QJsonObject SettingsStore::apiKeysSet() const
{
    QJsonObject out;
    for (const QString &p : providerKeys())
        out.insert(p, hasApiKey(p));
    return out;
}

bool SettingsStore::saveConfig()
{
    const QString path = Config::configFilePath();
    const QFileInfo fi(path);
    QDir dir = fi.absoluteDir();
    if (!dir.exists() && !dir.mkpath(QStringLiteral("."))) {
        m_lastError = QStringLiteral("failed to create config dir: ") + dir.absolutePath();
        return false;
    }

    // Preserve any unrelated keys/sections; rewrite only our managed keys.
    QStringList preserved;
    {
        QFile f(path);
        if (f.exists() && f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            const QString text = QString::fromUtf8(f.readAll());
            f.close();
            for (const QString &raw : text.split(QLatin1Char('\n'))) {
                const QString t = raw.trimmed();
                if (t.startsWith(QStringLiteral("default_brain")) ||
                    t.startsWith(QStringLiteral("default_model")) ||
                    t.startsWith(QStringLiteral("claude_account")) ||
                    t.startsWith(QStringLiteral("let_jarvis_use_computer")) ||
                    t.startsWith(QStringLiteral("auth_lock_enabled")) ||
                    t.startsWith(QStringLiteral("tts_voice")) ||
                    t.startsWith(QStringLiteral("stt_provider")) ||
                    t.startsWith(QStringLiteral("tts_provider")) ||
                    t.startsWith(QStringLiteral("theme_json")))
                    continue;
                preserved << raw;
            }
        }
    }

    QString out;
    QTextStream ts(&out);
    ts << "default_brain = \"" << m_defaultBrain << "\"\n";
    ts << "default_model = \"" << m_defaultModel << "\"\n";
    ts << "claude_account = \"" << m_claudeAccount << "\"\n";
    ts << "let_jarvis_use_computer = " << (m_letJarvisUseComputer ? "true" : "false") << "\n";
    ts << "auth_lock_enabled = " << (m_authLockEnabled ? "true" : "false") << "\n";
    if (!m_ttsVoice.isEmpty())
        ts << "tts_voice = \"" << m_ttsVoice << "\"\n";
    ts << "stt_provider = \"" << m_sttProvider << "\"\n";
    ts << "tts_provider = \"" << m_ttsProvider << "\"\n";
    if (!m_theme.isEmpty()) {
        const QByteArray tj = QJsonDocument(m_theme).toJson(QJsonDocument::Compact);
        ts << "theme_json = '" << QString::fromUtf8(tj) << "'\n";
    }
    bool seenContent = false;
    for (const QString &line : std::as_const(preserved)) {
        if (!seenContent && line.trimmed().isEmpty())
            continue;
        seenContent = true;
        ts << line << "\n";
    }
    ts.flush();

    QSaveFile sf(path);
    if (!sf.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_lastError = QStringLiteral("cannot write config.toml: ") + sf.errorString();
        return false;
    }
    sf.write(out.toUtf8());
    if (!sf.commit()) {
        m_lastError = QStringLiteral("cannot commit config.toml: ") + sf.errorString();
        return false;
    }
    return true;
}

bool SettingsStore::saveSecrets()
{
    const QString path = secretsFilePath();
    const QFileInfo fi(path);
    QDir dir = fi.absoluteDir();
    if (!dir.exists() && !dir.mkpath(QStringLiteral("."))) {
        m_lastError = QStringLiteral("failed to create config dir: ") + dir.absolutePath();
        return false;
    }

    const QByteArray json = QJsonDocument(m_apiKeys).toJson(QJsonDocument::Indented);
    QSaveFile sf(path);
    if (!sf.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_lastError = QStringLiteral("cannot write secrets.json: ") + sf.errorString();
        return false;
    }
    sf.write(json);
    if (!sf.commit()) {
        m_lastError = QStringLiteral("cannot commit secrets.json: ") + sf.errorString();
        return false;
    }
    if (!QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner)) {
        m_lastError = QStringLiteral("cannot chmod 0600 secrets.json");
        return false;
    }
    return true;
}

} // namespace jarvis
