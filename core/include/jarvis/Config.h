#pragma once

// Jarvis configuration. Reads ~/.config/jarvis/config.toml when present, else
// falls back to the BUILD_SPEC defaults. A tiny hand-rolled key=value TOML
// reader is sufficient for the flat keys we need (BUILD_SPEC sanctioned).

#include <QString>

namespace jarvis {

struct Config {
    QString defaultBrain = QStringLiteral("codex"); // default_brain
    QString defaultModel = QStringLiteral("gpt-5.5"); // default_model
    int controlPort = 8795;                          // ports.control
    int devicePort = 8796;                           // ports.device
    QString defaultCwd;                              // cwd default; empty => $HOME

    // Effective working directory: configured cwd, else $HOME.
    QString effectiveCwd() const;

    // ~/.config/jarvis (the config directory).
    static QString configDir();
    // ~/.config/jarvis/config.toml
    static QString configFilePath();
    // ~/.config/jarvis/control_token
    static QString controlTokenPath();

    // Load from configFilePath() if present, else defaults. Never throws.
    static Config load();
    // Load from an explicit path (used by tests). Missing file => defaults.
    static Config loadFromFile(const QString &path);
    // Parse from in-memory TOML text (used by tests). Unknown keys ignored.
    static Config parseToml(const QString &text);
};

} // namespace jarvis
