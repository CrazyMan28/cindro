// Unit test for SettingsStore — focuses on the auth-lock default (no-brick) and
// its config.toml round-trip. Uses an isolated $HOME so it never touches the
// user's real ~/.config/jarvis. Pure store-level proof (no sockets).

#include "jarvis/Config.h"
#include "jarvis/SettingsStore.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QTemporaryDir>

#include <cstdio>
#include <cstdlib>

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

// Read config.toml and return true if it contains a line `auth_lock_enabled = <want>`.
static bool configHasAuthLock(bool want)
{
    QFile f(jarvis::Config::configFilePath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return false;
    const QString text = QString::fromUtf8(f.readAll());
    f.close();
    const QString needle = QStringLiteral("auth_lock_enabled = ") +
                           (want ? QStringLiteral("true") : QStringLiteral("false"));
    for (const QString &raw : text.split(QLatin1Char('\n')))
        if (raw.trimmed() == needle)
            return true;
    return false;
}

static void writeConfig(const QString &body)
{
    QDir().mkpath(jarvis::Config::configDir());
    QFile f(jarvis::Config::configFilePath());
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        f.write(body.toUtf8());
        f.close();
    }
}

int main()
{
    // Isolate HOME so Config::configDir() (=$HOME/.config/jarvis) is a throwaway.
    QTemporaryDir home;
    if (!home.isValid()) {
        std::fprintf(stderr, "FAIL: could not create temp HOME\n");
        return 1;
    }
    qputenv("HOME", home.path().toUtf8());
    // QDir::homePath() prefers HOME on unix; also clear XDG to be safe.
    qunsetenv("XDG_CONFIG_HOME");

    // --- 1) FRESH CONFIG (no file): auth lock defaults ON (no-brick) -------
    {
        // Sanity: there is genuinely no config file yet.
        check(!QFile::exists(jarvis::Config::configFilePath()),
              "fresh: no config.toml exists yet");
        jarvis::SettingsStore s;
        s.load();
        check(s.authLockEnabled() == true,
              "fresh config => auth lock defaults ON");
    }

    // --- 2) SAVE writes auth_lock_enabled = true, and it round-trips ON ----
    {
        jarvis::SettingsStore s;
        s.load();
        check(s.saveConfig(), "saveConfig() on default state succeeds");
        check(configHasAuthLock(true),
              "saved config.toml contains auth_lock_enabled = true");

        jarvis::SettingsStore s2;
        s2.load();
        check(s2.authLockEnabled() == true,
              "reload of saved default => auth lock still ON");
    }

    // --- 3) User turns it OFF: persists and round-trips OFF ----------------
    {
        jarvis::SettingsStore s;
        s.load();
        s.setAuthLockEnabled(false);
        check(s.authLockEnabled() == false, "setAuthLockEnabled(false) sticks");
        check(s.saveConfig(), "saveConfig() after turning OFF succeeds");
        check(configHasAuthLock(false),
              "saved config.toml contains auth_lock_enabled = false");

        jarvis::SettingsStore s2;
        s2.load();
        check(s2.authLockEnabled() == false,
              "reload => auth lock honors the persisted OFF");
    }

    // --- 4) Explicit `false`/`0`/whitespace parse OFF; absent key => ON ----
    {
        writeConfig(QStringLiteral("auth_lock_enabled = false\n"));
        jarvis::SettingsStore s;
        s.load();
        check(s.authLockEnabled() == false, "explicit `false` parses OFF");

        writeConfig(QStringLiteral("auth_lock_enabled = 0\n"));
        jarvis::SettingsStore s0;
        s0.load();
        check(s0.authLockEnabled() == false, "explicit `0` parses OFF");

        writeConfig(QStringLiteral("auth_lock_enabled = true\n"));
        jarvis::SettingsStore st;
        st.load();
        check(st.authLockEnabled() == true, "explicit `true` parses ON");

        // A config with OTHER keys but no auth_lock_enabled => default ON.
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore sa;
        sa.load();
        check(sa.authLockEnabled() == true,
              "config missing auth_lock_enabled => default ON");
    }

    // --- Desktop unlock PIN: set, verify, persist, clear -------------------
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s;
        s.load();
        check(!s.hasDesktopPin(), "fresh config => no desktop PIN");
        s.setDesktopPin(QStringLiteral("1379"));
        check(s.hasDesktopPin(), "setDesktopPin => hasDesktopPin");
        check(s.verifyDesktopPin(QStringLiteral("1379")), "verify correct PIN");
        check(!s.verifyDesktopPin(QStringLiteral("0000")), "reject wrong PIN");
        check(!s.verifyDesktopPin(QString()), "reject empty PIN");
        check(s.saveConfig(), "saveConfig() with PIN succeeds");

        jarvis::SettingsStore s2;
        s2.load();
        check(s2.hasDesktopPin(), "PIN round-trips through config.toml");
        check(s2.verifyDesktopPin(QStringLiteral("1379")), "reloaded PIN verifies");
        check(!s2.verifyDesktopPin(QStringLiteral("1378")), "reloaded PIN rejects wrong");

        s2.setDesktopPin(QString());
        check(!s2.hasDesktopPin(), "setDesktopPin(\"\") clears the PIN");
    }

    // The stored PIN must NEVER be the plaintext (salted hash only).
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s;
        s.load();
        s.setDesktopPin(QStringLiteral("4242"));
        s.saveConfig();
        QFile f(jarvis::Config::configFilePath());
        f.open(QIODevice::ReadOnly | QIODevice::Text);
        const QString text = QString::fromUtf8(f.readAll());
        f.close();
        check(!text.contains(QStringLiteral("4242")),
              "config.toml does NOT contain the plaintext PIN");
        check(text.contains(QStringLiteral("desktop_pin")),
              "config.toml has a desktop_pin (hashed) line");
    }

    // --- Agent mode + wake-notify: defaults, normalize, round-trip ---------
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s;
        s.load();
        check(s.agentMode() == QStringLiteral("coworker"),
              "fresh config => agent_mode defaults coworker");
        check(s.wakeNotify() == QStringLiteral("ping"),
              "fresh config => wake_notify defaults ping");

        // Unknown values normalize back to the safe defaults.
        s.setAgentMode(QStringLiteral("bogus"));
        check(s.agentMode() == QStringLiteral("coworker"),
              "unknown agent_mode normalizes to coworker");
        s.setWakeNotify(QStringLiteral("bogus"));
        check(s.wakeNotify() == QStringLiteral("ping"),
              "unknown wake_notify normalizes to ping");

        s.setAgentMode(QStringLiteral("plan"));
        s.setWakeNotify(QStringLiteral("silent"));
        check(s.saveConfig(), "saveConfig() with mode/wake succeeds");

        jarvis::SettingsStore s2;
        s2.load();
        check(s2.agentMode() == QStringLiteral("plan"),
              "agent_mode=plan round-trips through config.toml");
        check(s2.wakeNotify() == QStringLiteral("silent"),
              "wake_notify=silent round-trips through config.toml");

        // build + always also persist
        s2.setAgentMode(QStringLiteral("build"));
        s2.setWakeNotify(QStringLiteral("always"));
        s2.saveConfig();
        jarvis::SettingsStore s3;
        s3.load();
        check(s3.agentMode() == QStringLiteral("build"), "agent_mode=build round-trips");
        check(s3.wakeNotify() == QStringLiteral("always"), "wake_notify=always round-trips");
    }

    // --- assistant_name: migrates old rebrand defaults, keeps custom names -
    {
        writeConfig(QStringLiteral("assistant_name = \"Orin\"\n"));
        jarvis::SettingsStore s;
        s.load();
        check(s.assistantName() == QStringLiteral("Cindro"),
              "stored old default 'Orin' migrates to 'Cindro'");

        writeConfig(QStringLiteral("assistant_name = \"Jarvis\"\n"));
        jarvis::SettingsStore s2;
        s2.load();
        check(s2.assistantName() == QStringLiteral("Cindro"),
              "stored old default 'Jarvis' migrates to 'Cindro'");

        writeConfig(QStringLiteral("assistant_name = \"Buddy\"\n"));
        jarvis::SettingsStore s3;
        s3.load();
        check(s3.assistantName() == QStringLiteral("Buddy"),
              "genuinely custom assistant_name is preserved");

        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s4;
        s4.load();
        check(s4.assistantName() == QStringLiteral("Cindro"),
              "config missing assistant_name => default Cindro");
    }

    // --- Video understanding (video_* map): defaults, normalize, round-trip -
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s;
        s.load();
        const QJsonObject v = s.videoSettings();
        check(v.value(QStringLiteral("video_backend")).toString() ==
                  QStringLiteral("local"),
              "fresh config => video_backend defaults local");
        check(v.value(QStringLiteral("video_whisper_model")).toString() ==
                  QStringLiteral("large-v3"),
              "fresh config => video_whisper_model defaults large-v3");
        check(v.value(QStringLiteral("video_frame_resolution")).toInt() == 512,
              "fresh config => video_frame_resolution defaults 512");
        check(v.value(QStringLiteral("video_enable_index")).toBool() == false,
              "fresh config => video_enable_index defaults off");

        // Unknown key rejected; unknown enum value normalizes to default.
        check(!s.setVideoSetting(QStringLiteral("video_bogus"), 1),
              "unknown video_* key is rejected");
        check(s.setVideoSetting(QStringLiteral("video_backend"),
                                QStringLiteral("bogus")),
              "known key with bogus value is accepted (normalized)");
        check(s.videoSettings().value(QStringLiteral("video_backend")).toString() ==
                  QStringLiteral("local"),
              "bogus video_backend normalizes to local");

        // Int clamp + string-typed numbers coerce.
        s.setVideoSetting(QStringLiteral("video_frame_resolution"),
                          QStringLiteral("99999"));
        check(s.videoSettings()
                      .value(QStringLiteral("video_frame_resolution"))
                      .toInt() == 2048,
              "video_frame_resolution clamps to 2048");

        // Changed values round-trip; untouched keys stay implicit defaults.
        s.setVideoSetting(QStringLiteral("video_backend"),
                          QStringLiteral("gemini-api"));
        s.setVideoSetting(QStringLiteral("video_whisper_model"),
                          QStringLiteral("tiny"));
        s.setVideoSetting(QStringLiteral("video_enable_index"), true);
        check(s.saveConfig(), "saveConfig() with video prefs succeeds");

        jarvis::SettingsStore s2;
        s2.load();
        const QJsonObject v2 = s2.videoSettings();
        check(v2.value(QStringLiteral("video_backend")).toString() ==
                  QStringLiteral("gemini-api"),
              "video_backend=gemini-api round-trips");
        check(v2.value(QStringLiteral("video_whisper_model")).toString() ==
                  QStringLiteral("tiny"),
              "video_whisper_model=tiny round-trips");
        check(v2.value(QStringLiteral("video_enable_index")).toBool() == true,
              "video_enable_index=true round-trips");
        check(v2.value(QStringLiteral("video_max_frames")).toInt() == 100,
              "untouched video_max_frames stays default after round-trip");

        // Setting a key back to its default removes the config.toml line.
        s2.setVideoSetting(QStringLiteral("video_backend"), QStringLiteral("local"));
        s2.saveConfig();
        QFile f(jarvis::Config::configFilePath());
        f.open(QIODevice::ReadOnly | QIODevice::Text);
        const QString text = QString::fromUtf8(f.readAll());
        f.close();
        check(!text.contains(QStringLiteral("video_backend")),
              "default-valued video_backend is not written to config.toml");
        check(text.contains(QStringLiteral("video_whisper_model = \"tiny\"")),
              "non-default video_whisper_model stays in config.toml");
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS settings_store_test\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL settings_store_test (%d failures)\n", g_failures);
    return 1;
}
