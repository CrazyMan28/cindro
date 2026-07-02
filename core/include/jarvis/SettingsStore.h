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

    // First-launch SETUP WIZARD state. setup_complete defaults FALSE so a fresh
    // install shows the wizard once; the wizard's Finish sets it true. The
    // assistant's friendly name (default "Jarvis") is chosen in the wizard and
    // shown across the UI. Both round-trip in config.toml as flat keys
    // `setup_complete = true|false` / `assistant_name = "..."`.
    bool setupComplete() const { return m_setupComplete; }
    void setSetupComplete(bool v) { m_setupComplete = v; }
    QString assistantName() const { return m_assistantName; }
    void setAssistantName(const QString &n)
    {
        m_assistantName = n.trimmed().isEmpty() ? QStringLiteral("Jarvis") : n.trimmed();
    }
    // The human's name, collected in the wizard. Unlike the assistant name there
    // is NO default — empty just means "not provided". Round-trips in config.toml
    // as `user_name = "..."` and is also mirrored into long-term memory by the
    // daemon so brains can address the user by name.
    QString userName() const { return m_userName; }
    void setUserName(const QString &n) { m_userName = n.trimmed(); }

    // AUTO-UPDATER prefs. auto_update defaults TRUE (the daemon checks `main` on
    // the interval and NOTIFIES on "behind" — it never auto-applies silently).
    // auto_update_interval_hours defaults 6 (clamped to >=1). Round-trip in
    // config.toml as `auto_update = true|false` / `auto_update_interval_hours = N`.
    bool autoUpdate() const { return m_autoUpdate; }
    void setAutoUpdate(bool v) { m_autoUpdate = v; }
    int autoUpdateIntervalHours() const { return m_autoUpdateIntervalHours; }
    void setAutoUpdateIntervalHours(int h) { m_autoUpdateIntervalHours = h >= 1 ? h : 6; }

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

    // Skill lifecycle curation (jarvis#76 item 2): agent-created, unpinned
    // skills untouched for this many days are ARCHIVED (never deleted) by the
    // hourly sweep. 0 disables the sweep. Round-trips as `skill_archive_days`.
    int skillArchiveDays() const { return m_skillArchiveDays; }
    void setSkillArchiveDays(int d) { m_skillArchiveDays = d < 0 ? 0 : d; }

    // Background post-turn self-improvement review (jarvis#76 item 8): after a
    // top-level turn finishes, a cheap auxiliary model call reviews the turn
    // and persists anything worth remembering. SOFT + async; "off" (default)
    // skips it entirely. Round-trips as `self_improve = "off"|"on"`.
    QString selfImprove() const { return m_selfImprove; }
    void setSelfImprove(const QString &v)
    {
        m_selfImprove = (v == QStringLiteral("on")) ? v : QStringLiteral("off");
    }

    // Persistent-goal auto-continuation (jarvis#76 item 9):
    //   "off"    -> never auto-continue (default)
    //   "capped" -> re-wake a session with an active goal up to 3 times per
    //               real user turn
    //   "on"     -> re-wake while a goal is set (bounded by a high safety cap)
    // Round-trips as `auto_continue`.
    QString autoContinue() const { return m_autoContinue; }
    void setAutoContinue(const QString &v)
    {
        m_autoContinue = (v == QStringLiteral("capped") || v == QStringLiteral("on"))
                             ? v
                             : QStringLiteral("off");
    }

    // ApiBrain context compression threshold (jarvis#76 item 6): when the
    // estimated prompt tokens exceed this, older history is collapsed into a
    // digest (PreCompact hook fires first). 0 = disabled. Round-trips as
    // `api_context_max_tokens`.
    int apiContextMaxTokens() const { return m_apiContextMaxTokens; }
    void setApiContextMaxTokens(int t) { m_apiContextMaxTokens = t < 0 ? 0 : t; }

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
    int m_skillArchiveDays = 30;                            // 0 = sweep disabled
    QString m_selfImprove = QStringLiteral("off");          // off|on
    QString m_autoContinue = QStringLiteral("off");         // off|capped|on
    int m_apiContextMaxTokens = 0;                          // 0 = compression off
    QString m_desktopPin;               // "<saltHex>:<hashHex>" or empty (no PIN)
    QString m_ttsVoice;                 // preferred TTS voice slug (empty = default)
    QString m_sttProvider = QStringLiteral("voxtral"); // STT provider id
    QString m_ttsProvider = QStringLiteral("voxtral"); // TTS provider id
    bool m_setupComplete = false;       // first-launch wizard done? (default: no)
    QString m_assistantName = QStringLiteral("Jarvis"); // friendly assistant name
    QString m_userName;                                 // the human's name ("" = unset)
    bool m_autoUpdate = true;           // periodic auto update-check (default ON)
    int m_autoUpdateIntervalHours = 6;  // auto-check cadence (hours, >=1)
    QJsonObject m_theme;
    QJsonObject m_apiKeys; // provider -> value
    QString m_lastError;
};

} // namespace jarvis
