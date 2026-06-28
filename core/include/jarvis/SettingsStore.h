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

    // Preferred TTS voice slug for voice.tts (Mistral Voxtral). Empty means "let
    // the daemon/VoiceService pick its default" (en_paul_neutral). Round-tripped
    // in config.toml as a flat key `tts_voice = "..."`.
    QString ttsVoice() const { return m_ttsVoice; }
    void setTtsVoice(const QString &v) { m_ttsVoice = v; }

    // Pluggable STT/TTS provider ids (default "voxtral" = Mistral cloud). The
    // local providers are "whisper" (STT) and "piper" (TTS); the daemon degrades
    // to voxtral at call time if the local binary/model is absent. Round-tripped
    // in config.toml as flat keys `stt_provider`/`tts_provider`. Unknown values
    // normalize to "voxtral" so a bad pref can never select a missing provider.
    QString sttProvider() const { return m_sttProvider; }
    void setSttProvider(const QString &p)
    {
        m_sttProvider = (p == QStringLiteral("whisper")) ? QStringLiteral("whisper")
                                                         : QStringLiteral("voxtral");
    }
    QString ttsProvider() const { return m_ttsProvider; }
    void setTtsProvider(const QString &p)
    {
        m_ttsProvider = (p == QStringLiteral("piper")) ? QStringLiteral("piper")
                                                       : QStringLiteral("voxtral");
    }

    // "Let Jarvis use a computer/browser" (default ON). When set, EVERY session
    // (not just coworker+agent) gets the computer-use MCP injected against a
    // lazily-provisioned nested agent desktop, so a plain chat can drive the
    // computer/Chrome on demand with no manual "Computer" tab / co-work step.
    bool letJarvisUseComputer() const { return m_letJarvisUseComputer; }
    void setLetJarvisUseComputer(bool v) { m_letJarvisUseComputer = v; }

    // "Require phone+fingerprint to open Jarvis" (2FA + fingerprint cross-device
    // unlock; default ON — no-brick). When set, the desktop shows a LockGate
    // overlay on launch that runs auth.request (FCM push to the paired phone +
    // biometric). ANTI-BRICK: when there is no reachable approver (no paired
    // device, OR a paired device but no way to push to it), the daemon fail-opens
    // so the user is never permanently locked out (see ControlServer::
    // handleAuthRequest). Round-tripped in config.toml as a flat key
    // `auth_lock_enabled = true|false`.
    bool authLockEnabled() const { return m_authLockEnabled; }
    void setAuthLockEnabled(bool v) { m_authLockEnabled = v; }

    // How cautious the agent is before taking risky actions ("permission
    // level"). This drives a SOFT policy injected into the co-work preamble —
    // the model is told to call ask_user first before actions at/above the
    // configured risk tier. It does NOT change the sandbox / capability tiers
    // (those stay enforced by the daemon); it only tunes how often the model
    // pauses to ask. Tools are auto-ranked high/medium/low by name pattern.
    //   "high"   -> ask before HIGH and MEDIUM risk actions (most cautious)
    //   "medium" -> ask before HIGH risk actions only (balanced, default)
    //   "low"    -> act freely; only confirm the most destructive HIGH actions
    // Anything unrecognized normalizes to "medium". Round-trips in config.toml
    // as a flat key `permission_level = "..."`.
    QString permissionLevel() const { return m_permissionLevel; }
    void setPermissionLevel(const QString &p)
    {
        m_permissionLevel = (p == QStringLiteral("high") || p == QStringLiteral("low"))
                                ? p
                                : QStringLiteral("medium");
    }

    // Agent MODE — a SOFT behavioral profile injected into the co-work preamble
    // (like permission_level; it does NOT change the sandbox). Selectable in
    // Settings and surfaced as a HUD chip on every surface.
    //   "plan"     -> research + produce a step-by-step plan; make NO changes;
    //                 present the plan and wait for approval.
    //   "build"    -> execute the plan autonomously; minimal asking; keep the
    //                 todo list current.
    //   "coworker" -> balanced default (today's behavior).
    // Anything unrecognized normalizes to "coworker". Round-trips in config.toml
    // as a flat key `agent_mode = "..."`.
    QString agentMode() const { return m_agentMode; }
    void setAgentMode(const QString &m)
    {
        m_agentMode = (m == QStringLiteral("plan") || m == QStringLiteral("build"))
                          ? m
                          : QStringLiteral("coworker");
    }

    // What happens when a background job finishes (or a sleep/monitor wake fires):
    //   "silent" -> wake the agent only; never ping the user's phone.
    //   "ping"   -> wake the agent AND notify the phone for long/important jobs
    //               (escalates to a real call only if the job is marked critical).
    //   "always" -> notify the phone on every wake, even routine ones.
    // Anything unrecognized normalizes to "ping". Round-trips as `wake_notify`.
    QString wakeNotify() const { return m_wakeNotify; }
    void setWakeNotify(const QString &w)
    {
        m_wakeNotify = (w == QStringLiteral("silent") || w == QStringLiteral("always"))
                           ? w
                           : QStringLiteral("ping");
    }

    // Desktop unlock PIN (fallback when the phone can't approve). Stored as a
    // SALTED SHA-256 ("<saltHex>:<hashHex>") in config.toml — never the PIN
    // itself. Empty = no PIN set. setDesktopPin("") clears it.
    bool hasDesktopPin() const { return !m_desktopPin.isEmpty(); }
    void setDesktopPin(const QString &pin); // hashes; empty clears
    bool verifyDesktopPin(const QString &pin) const;

    // Which claude OAuth account the claude brain spawns against.
    //   "pro" -> ~/.claude          (you@example.com, the default)
    //   "max" -> ~/.claude-secondary (you-max@example.com, uses Max quota)
    // Anything unrecognized (or unset) is treated as "pro" so the brain never
    // accidentally inherits the Max account.
    QString claudeAccount() const { return m_claudeAccount; }
    void setClaudeAccount(const QString &a)
    {
        m_claudeAccount = (a == QStringLiteral("max")) ? QStringLiteral("max")
                                                       : QStringLiteral("pro");
    }
    // Absolute CLAUDE_CONFIG_DIR for the configured account. Always returns the
    // Pro dir unless the account is explicitly "max".
    static QString claudeConfigDirFor(const QString &account);
    QString claudeConfigDir() const { return claudeConfigDirFor(m_claudeAccount); }

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
    QString m_claudeAccount = QStringLiteral("pro"); // default: Pro (~/.claude)
    bool m_letJarvisUseComputer = true; // default ON (auto computer-use in chat)
    bool m_authLockEnabled = true;      // default ON (require phone+fingerprint)
    QString m_permissionLevel = QStringLiteral("medium"); // ask-before-risky policy
    QString m_agentMode = QStringLiteral("coworker");      // plan|build|coworker (soft)
    QString m_wakeNotify = QStringLiteral("ping");         // silent|ping|always
    QString m_desktopPin;               // "<saltHex>:<hashHex>" or empty (no PIN)
    QString m_ttsVoice;                 // preferred TTS voice slug (empty = default)
    QString m_sttProvider = QStringLiteral("voxtral"); // STT provider id
    QString m_ttsProvider = QStringLiteral("voxtral"); // TTS provider id
    QJsonObject m_theme;
    QJsonObject m_apiKeys; // provider -> value
    QString m_lastError;
};

} // namespace jarvis
