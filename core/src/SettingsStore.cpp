#include "jarvis/SettingsStore.h"

#include "jarvis/Config.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStringList>
#include <QTextStream>

namespace jarvis {

void SettingsStore::setDesktopPin(const QString &pin)
{
    if (pin.isEmpty()) {
        m_desktopPin.clear();
        return;
    }
    // Random 8-byte salt; store "<saltHex>:<sha256(salt+pin)Hex>".
    QByteArray salt(8, '\0');
    for (char &b : salt)
        b = static_cast<char>(QRandomGenerator::system()->bounded(256));
    const QByteArray hash =
        QCryptographicHash::hash(salt + pin.toUtf8(), QCryptographicHash::Sha256);
    m_desktopPin = QString::fromLatin1(salt.toHex()) + QLatin1Char(':')
                 + QString::fromLatin1(hash.toHex());
}

bool SettingsStore::verifyDesktopPin(const QString &pin) const
{
    if (m_desktopPin.isEmpty() || pin.isEmpty())
        return false;
    const int sep = m_desktopPin.indexOf(QLatin1Char(':'));
    if (sep <= 0)
        return false;
    const QByteArray salt = QByteArray::fromHex(m_desktopPin.left(sep).toLatin1());
    const QByteArray want = m_desktopPin.mid(sep + 1).toLatin1();
    const QByteArray got =
        QCryptographicHash::hash(salt + pin.toUtf8(), QCryptographicHash::Sha256).toHex();
    return got == want;
}

QString SettingsStore::secretsFilePath()
{
    return Config::configDir() + QStringLiteral("/secrets.json");
}

// ---- video understanding (video_* keys) ------------------------------------
// Typed defaults for every video setting. The Python engine keeps a mirrored
// fallback table (computer_use_mcp/video/config.py DEFAULTS) for when the
// daemon is unreachable — keep the two in sync when adding a knob.

static const QStringList &videoKeyOrder()
{
    static const QStringList kOrder = {
        QStringLiteral("video_backend"),
        QStringLiteral("video_whisper_engine"),
        QStringLiteral("video_whisper_model"),
        QStringLiteral("video_whisper_device"),
        QStringLiteral("video_frame_mode"),
        QStringLiteral("video_frame_format"),
        QStringLiteral("video_frame_resolution"),
        QStringLiteral("video_default_fps"),
        QStringLiteral("video_max_frames"),
        QStringLiteral("video_frame_describer_model"),
        QStringLiteral("video_frame_describer_timeout_sec"),
        QStringLiteral("video_enable_index"),
        QStringLiteral("video_session_max_age_days"),
        QStringLiteral("video_downloads_max_age_days"),
        QStringLiteral("video_audio_chunk_trigger_seconds"),
        QStringLiteral("video_audio_chunk_size_seconds"),
        QStringLiteral("video_audio_chunk_overlap_seconds"),
        QStringLiteral("video_gemini_model"),
        QStringLiteral("video_gemini_max_output_tokens"),
    };
    return kOrder;
}

static const QJsonObject &videoDefaults()
{
    static const QJsonObject kDefaults = [] {
        QJsonObject d;
        d.insert(QStringLiteral("video_backend"), QStringLiteral("local"));
        d.insert(QStringLiteral("video_whisper_engine"), QStringLiteral("faster-whisper"));
        d.insert(QStringLiteral("video_whisper_model"), QStringLiteral("large-v3"));
        d.insert(QStringLiteral("video_whisper_device"), QStringLiteral("auto"));
        d.insert(QStringLiteral("video_frame_mode"), QStringLiteral("images"));
        d.insert(QStringLiteral("video_frame_format"), QStringLiteral("jpeg"));
        d.insert(QStringLiteral("video_frame_resolution"), 512);
        d.insert(QStringLiteral("video_default_fps"), QStringLiteral("auto"));
        d.insert(QStringLiteral("video_max_frames"), 100);
        d.insert(QStringLiteral("video_frame_describer_model"), QString());
        d.insert(QStringLiteral("video_frame_describer_timeout_sec"), 180);
        d.insert(QStringLiteral("video_enable_index"), false);
        d.insert(QStringLiteral("video_session_max_age_days"), 7);
        d.insert(QStringLiteral("video_downloads_max_age_days"), 7);
        d.insert(QStringLiteral("video_audio_chunk_trigger_seconds"), 1200);
        d.insert(QStringLiteral("video_audio_chunk_size_seconds"), 600);
        d.insert(QStringLiteral("video_audio_chunk_overlap_seconds"), 0);
        d.insert(QStringLiteral("video_gemini_model"),
                 QStringLiteral("gemini-3-flash-preview"));
        d.insert(QStringLiteral("video_gemini_max_output_tokens"), 65536);
        return d;
    }();
    return kDefaults;
}

// Enum keys normalize unknown values back to the default; int keys clamp to a
// sane range; bools accept true/false/"true"/"1". Free-text keys pass through.
static QJsonValue normalizeVideoValue(const QString &key, const QJsonValue &value)
{
    const auto oneOf = [&](std::initializer_list<const char *> allowed) -> QJsonValue {
        // toVariant() first: QJsonValue::toString() yields "" for non-String
        // JSON values, which would silently reset a numeric-typed slip to the
        // default instead of even attempting a match.
        const QString v = value.toVariant().toString().trimmed().toLower();
        for (const char *a : allowed)
            if (v == QLatin1String(a))
                return v;
        return videoDefaults().value(key);
    };
    const auto clamped = [&](int lo, int hi) -> QJsonValue {
        bool ok = value.isDouble();
        const int n = ok ? int(value.toDouble()) : value.toString().toInt(&ok);
        if (!ok)
            return videoDefaults().value(key);
        return qBound(lo, n, hi);
    };

    if (key == QLatin1String("video_backend"))
        return oneOf({"local", "gemini-api", "openai-api"});
    if (key == QLatin1String("video_whisper_engine"))
        return oneOf({"faster-whisper", "whisper-cpp", "openai-whisper"});
    if (key == QLatin1String("video_whisper_model"))
        return oneOf({"auto", "tiny", "base", "small", "medium",
                      "large-v3-turbo", "large-v3"});
    if (key == QLatin1String("video_whisper_device"))
        return oneOf({"auto", "cpu", "cuda"});
    if (key == QLatin1String("video_frame_mode"))
        return oneOf({"images", "descriptions"});
    if (key == QLatin1String("video_frame_format"))
        return oneOf({"jpeg", "png", "webp"});
    if (key == QLatin1String("video_frame_resolution"))
        return clamped(128, 2048);
    if (key == QLatin1String("video_default_fps")) {
        // "auto" or a positive number kept as a string ("0.5", "2").
        const QString v = value.isDouble() ? QString::number(value.toDouble())
                                           : value.toString().trimmed().toLower();
        if (v == QLatin1String("auto"))
            return v;
        bool ok = false;
        const double fps = v.toDouble(&ok);
        return (ok && fps > 0.0) ? QJsonValue(v) : videoDefaults().value(key);
    }
    if (key == QLatin1String("video_max_frames"))
        return clamped(1, 1000);
    if (key == QLatin1String("video_frame_describer_timeout_sec"))
        return clamped(10, 3600);
    if (key == QLatin1String("video_enable_index")) {
        if (value.isBool())
            return value;
        if (value.isDouble()) // config.toml `= 1` parses as a JSON number
            return value.toDouble() != 0.0;
        const QString v = value.toString().trimmed().toLower();
        return v == QLatin1String("true") || v == QLatin1String("1");
    }
    if (key == QLatin1String("video_session_max_age_days") ||
        key == QLatin1String("video_downloads_max_age_days"))
        return clamped(1, 365);
    if (key == QLatin1String("video_audio_chunk_trigger_seconds") ||
        key == QLatin1String("video_audio_chunk_size_seconds"))
        return clamped(60, 24 * 3600);
    if (key == QLatin1String("video_audio_chunk_overlap_seconds"))
        return clamped(0, 60);
    if (key == QLatin1String("video_gemini_max_output_tokens"))
        return clamped(1024, 1000000);
    // Free text: video_frame_describer_model, video_gemini_model.
    return value.isString() ? value : QJsonValue(value.toVariant().toString());
}

QJsonObject SettingsStore::videoSettings() const
{
    QJsonObject out = videoDefaults();
    for (auto it = m_videoOverrides.begin(); it != m_videoOverrides.end(); ++it)
        out.insert(it.key(), it.value());
    return out;
}

bool SettingsStore::setVideoSetting(const QString &key, const QJsonValue &value)
{
    if (!videoDefaults().contains(key))
        return false; // unknown key: reject so typos never persist silently
    const QJsonValue norm = normalizeVideoValue(key, value);
    if (norm == videoDefaults().value(key))
        m_videoOverrides.remove(key); // back to default: keep config.toml lean
    else
        m_videoOverrides.insert(key, norm);
    return true;
}

QStringList SettingsStore::providerKeys()
{
    return {QStringLiteral("codex"), QStringLiteral("claude"),
            QStringLiteral("openai"), QStringLiteral("anthropic"),
            QStringLiteral("mistral"), QStringLiteral("ollama"),
            QStringLiteral("gemini"), QStringLiteral("xai"),
            QStringLiteral("deepseek")};
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
    m_permissionLevel = QStringLiteral("medium");
    m_agentMode = QStringLiteral("coworker");
    m_wakeNotify = QStringLiteral("ping");
    m_skillArchiveDays = 30;
    m_selfImprove = QStringLiteral("off");
    m_autoContinue = QStringLiteral("off");
    m_apiContextMaxTokens = 0;
    m_desktopPin.clear();
    m_ttsVoice.clear();
    m_sttProvider = QStringLiteral("voxtral");
    m_ttsProvider = QStringLiteral("voxtral");
    m_setupComplete = false;          // wizard not done until config says so
    m_assistantName = QStringLiteral("Jarvis");
    m_userName.clear();               // the human's name; empty until the wizard sets it
    m_autoUpdate = true;              // default ON (only an explicit false/0 disables)
    m_autoUpdateApply = false;        // auto-INSTALL stays opt-in
    m_autoUpdateIntervalHours = 6;
    m_theme = QJsonObject();
    m_videoOverrides = QJsonObject(); // video_* keys re-read below
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
                if (line.startsWith(QStringLiteral("permission_level"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setPermissionLevel(v.toLower()); // normalizes unknown -> medium
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("agent_mode"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setAgentMode(v.toLower()); // normalizes unknown -> coworker
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("wake_notify"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setWakeNotify(v.toLower()); // normalizes unknown -> ping
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("skill_archive_days"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        bool okNum = false;
                        const int d = line.mid(eq + 1).trimmed().toInt(&okNum);
                        if (okNum)
                            setSkillArchiveDays(d); // clamps to >=0
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("self_improve"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setSelfImprove(v.toLower()); // normalizes unknown -> off
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("auto_continue"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setAutoContinue(v.toLower()); // normalizes unknown -> off
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("api_context_max_tokens"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        bool okNum = false;
                        const int t = line.mid(eq + 1).trimmed().toInt(&okNum);
                        if (okNum)
                            setApiContextMaxTokens(t); // clamps to >=0
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("desktop_pin"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        m_desktopPin = v;   // already a stored "<salt>:<hash>"
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
                if (line.startsWith(QStringLiteral("video_"))) {
                    // Generic video_* round-trip: one block for all 19 keys.
                    // setVideoSetting() rejects unknown keys and normalizes
                    // values, so a hand-edited config.toml can't poison prefs.
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq > 0) {
                        const QString key = line.left(eq).trimmed();
                        QString v = line.mid(eq + 1).trimmed();
                        QJsonValue jv;
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"')))) {
                            jv = v.mid(1, v.size() - 2);
                        } else if (v.compare(QStringLiteral("true"), Qt::CaseInsensitive) == 0) {
                            jv = true;
                        } else if (v.compare(QStringLiteral("false"), Qt::CaseInsensitive) == 0) {
                            jv = false;
                        } else {
                            bool okNum = false;
                            const double num = v.toDouble(&okNum);
                            jv = okNum ? QJsonValue(num) : QJsonValue(v);
                        }
                        setVideoSetting(key, jv);
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
                if (line.startsWith(QStringLiteral("setup_complete"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        const QString v = line.mid(eq + 1).trimmed().toLower();
                        // Default OFF; only an explicit true/1 marks the wizard done.
                        m_setupComplete =
                            (v == QStringLiteral("true") || v == QStringLiteral("1"));
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("assistant_name"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setAssistantName(v); // empty -> "Jarvis"
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("user_name"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        QString v = line.mid(eq + 1).trimmed();
                        if (v.size() >= 2 &&
                            ((v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\'')) ||
                             (v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"'))))
                            v = v.mid(1, v.size() - 2);
                        setUserName(v); // empty stays empty (no default)
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("auto_update_interval_hours"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        bool okNum = false;
                        const int h = line.mid(eq + 1).trimmed().toInt(&okNum);
                        if (okNum)
                            setAutoUpdateIntervalHours(h); // clamps to >=1
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("auto_update_apply"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        const QString v = line.mid(eq + 1).trimmed().toLower();
                        // Default OFF; only an explicit true/1 enables auto-install.
                        m_autoUpdateApply =
                            (v == QStringLiteral("true") || v == QStringLiteral("1"));
                    }
                    continue;
                }
                if (line.startsWith(QStringLiteral("auto_update"))) {
                    const int eq = line.indexOf(QLatin1Char('='));
                    if (eq >= 0) {
                        const QString v = line.mid(eq + 1).trimmed().toLower();
                        // Default ON; only an explicit false/0 turns it OFF.
                        m_autoUpdate =
                            !(v == QStringLiteral("false") || v == QStringLiteral("0"));
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
    // Pool semantics (jarvis#76 item 5): "has a key" must agree with what
    // apiKey() would return — a separators-only value is NOT a usable key.
    return !apiKeyPool(provider).isEmpty();
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
    // Multi-credential pools (jarvis#76 item 5) keep the flat string contract:
    // several keys live in ONE secrets.json value separated by commas or
    // newlines. Single-key callers get the first entry.
    const QStringList pool = apiKeyPool(provider);
    return pool.isEmpty() ? QString() : pool.first();
}

QStringList SettingsStore::apiKeyPool(const QString &provider) const
{
    const QString raw = m_apiKeys.value(provider).toString();
    QStringList out;
    static const QRegularExpression sep(QStringLiteral("[,\\n]"));
    for (const QString &part : raw.split(sep, Qt::SkipEmptyParts)) {
        const QString t = part.trimmed();
        if (!t.isEmpty())
            out << t;
    }
    return out;
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
                    t.startsWith(QStringLiteral("permission_level")) ||
                    t.startsWith(QStringLiteral("agent_mode")) ||
                    t.startsWith(QStringLiteral("wake_notify")) ||
                    t.startsWith(QStringLiteral("skill_archive_days")) ||
                    t.startsWith(QStringLiteral("self_improve")) ||
                    t.startsWith(QStringLiteral("auto_continue")) ||
                    t.startsWith(QStringLiteral("api_context_max_tokens")) ||
                    t.startsWith(QStringLiteral("desktop_pin")) ||
                    t.startsWith(QStringLiteral("tts_voice")) ||
                    t.startsWith(QStringLiteral("stt_provider")) ||
                    t.startsWith(QStringLiteral("tts_provider")) ||
                    t.startsWith(QStringLiteral("setup_complete")) ||
                    t.startsWith(QStringLiteral("assistant_name")) ||
                    t.startsWith(QStringLiteral("user_name")) ||
                    t.startsWith(QStringLiteral("auto_update")) ||
                    t.startsWith(QStringLiteral("video_")) ||
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
    ts << "permission_level = \"" << m_permissionLevel << "\"\n";
    ts << "agent_mode = \"" << m_agentMode << "\"\n";
    ts << "wake_notify = \"" << m_wakeNotify << "\"\n";
    ts << "skill_archive_days = " << m_skillArchiveDays << "\n";
    ts << "self_improve = \"" << m_selfImprove << "\"\n";
    ts << "auto_continue = \"" << m_autoContinue << "\"\n";
    ts << "api_context_max_tokens = " << m_apiContextMaxTokens << "\n";
    if (!m_desktopPin.isEmpty())
        ts << "desktop_pin = \"" << m_desktopPin << "\"\n";
    if (!m_ttsVoice.isEmpty())
        ts << "tts_voice = \"" << m_ttsVoice << "\"\n";
    ts << "stt_provider = \"" << m_sttProvider << "\"\n";
    ts << "tts_provider = \"" << m_ttsProvider << "\"\n";
    ts << "setup_complete = " << (m_setupComplete ? "true" : "false") << "\n";
    ts << "assistant_name = \"" << m_assistantName << "\"\n";
    if (!m_userName.isEmpty())
        ts << "user_name = \"" << m_userName << "\"\n";
    ts << "auto_update = " << (m_autoUpdate ? "true" : "false") << "\n";
    ts << "auto_update_apply = " << (m_autoUpdateApply ? "true" : "false") << "\n";
    ts << "auto_update_interval_hours = " << m_autoUpdateIntervalHours << "\n";
    if (!m_theme.isEmpty()) {
        const QByteArray tj = QJsonDocument(m_theme).toJson(QJsonDocument::Compact);
        ts << "theme_json = '" << QString::fromUtf8(tj) << "'\n";
    }
    // Video understanding prefs: only keys the user changed (defaults stay
    // implicit, so new defaults in future builds apply without migration).
    for (const QString &key : videoKeyOrder()) {
        if (!m_videoOverrides.contains(key))
            continue;
        const QJsonValue v = m_videoOverrides.value(key);
        if (v.isBool())
            ts << key << " = " << (v.toBool() ? "true" : "false") << "\n";
        else if (v.isDouble())
            ts << key << " = " << qint64(v.toDouble()) << "\n";
        else
            ts << key << " = \"" << v.toString() << "\"\n";
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
    if (!QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner)) {
        // Best-effort hardening only: config.toml is already durably committed,
        // so a failure to tighten permissions (FAT/exFAT/network/overlay mounts,
        // transient AV lock on Windows) must NOT fail the save — gating on it
        // would spuriously abort callers' follow-up steps (voice-lib update,
        // phone propagation) even though the new settings are correctly on disk.
        qWarning() << "SettingsStore: could not chmod 0600 config.toml (non-fatal)";
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
