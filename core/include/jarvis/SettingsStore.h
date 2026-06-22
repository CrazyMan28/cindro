#pragma once

// SettingsStore — Contract A v2 non-secret prefs + write-only secrets.
//
//   - Non-secret prefs (default_brain, default_model, theme) persist to
//     ~/.config/jarvis/config.toml (the same flat-key file Config reads). theme
//     is round-tripped as a single `theme_json = '<compact json>'` literal.
//   - API key VALUES and per-MCP bearer tokens persist to
//     ~/.config/jarvis/secrets.json (mode 0600). Values are WRITE-ONLY: callers
//     of settings.get only ever see has-key booleans (apiKeysSet()).
//
// This is the canonical home for settings.get / settings.set state; it sits on
// top of Config (load) and a tiny secrets.json reader/writer.

#include <QJsonObject>
#include <QString>
#include <QStringList>

namespace jarvis {

class SettingsStore {
public:
    SettingsStore() = default;

    // ~/.config/jarvis/secrets.json (0600).
    static QString secretsFilePath();
    // The provider keys tracked in api_keys_set.
    static QStringList providerKeys();

    // (Re)load prefs from config.toml and secrets from secrets.json. Missing
    // files yield defaults; never throws.
    void load();

    // --- non-secret prefs --------------------------------------------------
    QString defaultBrain() const { return m_defaultBrain; }
    QString defaultModel() const { return m_defaultModel; }
    QJsonObject theme() const { return m_theme; }
    void setDefaultBrain(const QString &b) { m_defaultBrain = b; }
    void setDefaultModel(const QString &m) { m_defaultModel = m; }
    void setTheme(const QJsonObject &t) { m_theme = t; }

    // --- secrets (write-only) ---------------------------------------------
    bool hasApiKey(const QString &provider) const;
    void setApiKey(const QString &provider, const QString &value); // empty => clear
    QString apiKey(const QString &provider) const;                 // daemon-internal only

    // The {codex,claude,openai,anthropic,ollama} -> bool map for settings.get.
    QJsonObject apiKeysSet() const;

    // Persist prefs (config.toml) and secrets (secrets.json, chmod 0600).
    bool saveConfig();
    bool saveSecrets();

    QString lastError() const { return m_lastError; }

private:
    QString m_defaultBrain = QStringLiteral("codex");
    QString m_defaultModel = QStringLiteral("gpt-5.5");
    QJsonObject m_theme;
    QJsonObject m_apiKeys; // provider -> value
    QString m_lastError;
};

} // namespace jarvis
