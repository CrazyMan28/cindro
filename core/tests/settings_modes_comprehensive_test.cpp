// Comprehensive unit test for jarvis::SettingsStore — round-trips through a
// QTemporaryDir HOME so no real config is touched. Covers:
//   - agent_mode (plan/build/coworker + invalid->coworker)
//   - wake_notify (silent/ping/always + invalid->ping)
//   - permission_level (high/medium/low + invalid->medium)
//   - Defaults when keys absent
//   - All three persist via saveConfig + reload
//   - UNRELATED config.toml keys are PRESERVED across save
//   - Desktop PIN hashing not plaintext; verify/clear round-trip
//   - API key set/clear + apiKeysSet()
// 30+ checks.

#include "jarvis/Config.h"
#include "jarvis/DataPaths.h"
#include "jarvis/SessionStore.h"
#include "jarvis/SettingsStore.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

static int g_failures = 0;
static int g_passes   = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
        ++g_passes;
    }
}

// Write raw text to config.toml (creates dir if needed).
static void writeConfig(const QString &body)
{
    QDir().mkpath(jarvis::Config::configDir());
    QFile f(jarvis::Config::configFilePath());
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        f.write(body.toUtf8());
        f.close();
    }
}

// Read config.toml raw text.
static QString readConfig()
{
    QFile f(jarvis::Config::configFilePath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) return {};
    const QString t = QString::fromUtf8(f.readAll());
    f.close();
    return t;
}

// Check a line `key = value` exists in config.toml text.
static bool configHasLine(const QString &key, const QString &value)
{
    const QString text = readConfig();
    for (const QString &raw : text.split(QLatin1Char('\n'))) {
        const QString t = raw.trimmed();
        if (t == key + QStringLiteral(" = \"") + value + QLatin1Char('"'))
            return true;
        // unquoted booleans
        if (t == key + QStringLiteral(" = ") + value)
            return true;
    }
    return false;
}

int main()
{
    QTemporaryDir home;
    if (!home.isValid()) {
        std::fprintf(stderr, "FATAL: cannot create temp HOME\n");
        return 1;
    }
    qputenv("HOME", home.path().toUtf8());
    qunsetenv("XDG_CONFIG_HOME");

    // =========================================================================
    // 1. Defaults when keys absent (fresh config)
    // =========================================================================
    {
        check(!QFile::exists(jarvis::Config::configFilePath()),
              "fresh: no config.toml yet");
        jarvis::SettingsStore s;
        s.load();
        check(s.agentMode()       == QStringLiteral("coworker"),
              "fresh default: agent_mode is coworker");
        check(s.wakeNotify()      == QStringLiteral("ping"),
              "fresh default: wake_notify is ping");
        check(s.permissionLevel() == QStringLiteral("medium"),
              "fresh default: permission_level is medium");
        check(s.authLockEnabled() == true,
              "fresh default: auth_lock_enabled is ON");
        check(!s.hasDesktopPin(),
              "fresh default: no desktop PIN");
    }

    // =========================================================================
    // 2. agent_mode: plan persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setAgentMode(QStringLiteral("plan"));
        check(s.agentMode() == QStringLiteral("plan"), "setAgentMode(plan) in-memory");
        check(s.saveConfig(), "saveConfig agent_mode=plan succeeds");

        jarvis::SettingsStore s2; s2.load();
        check(s2.agentMode() == QStringLiteral("plan"),
              "agent_mode=plan round-trips through config.toml");
        check(configHasLine(QStringLiteral("agent_mode"), QStringLiteral("plan")),
              "agent_mode=plan present in config.toml");
    }

    // =========================================================================
    // 3. agent_mode: build persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setAgentMode(QStringLiteral("build"));
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.agentMode() == QStringLiteral("build"),
              "agent_mode=build round-trips through config.toml");
    }

    // =========================================================================
    // 4. agent_mode: coworker persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setAgentMode(QStringLiteral("coworker"));
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.agentMode() == QStringLiteral("coworker"),
              "agent_mode=coworker round-trips through config.toml");
    }

    // =========================================================================
    // 5. agent_mode: invalid normalizes to coworker
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setAgentMode(QStringLiteral("turbo"));
        check(s.agentMode() == QStringLiteral("coworker"),
              "setAgentMode(invalid) normalizes to coworker");
        s.setAgentMode(QString());
        check(s.agentMode() == QStringLiteral("coworker"),
              "setAgentMode(empty) normalizes to coworker");
    }

    // =========================================================================
    // 6. agent_mode: written into config.toml as agent_mode = "..." is parsed
    // =========================================================================
    {
        writeConfig(QStringLiteral("agent_mode = \"plan\"\n"));
        jarvis::SettingsStore s; s.load();
        check(s.agentMode() == QStringLiteral("plan"),
              "agent_mode = \"plan\" loaded from config.toml");
        writeConfig(QStringLiteral("agent_mode = \"build\"\n"));
        jarvis::SettingsStore s2; s2.load();
        check(s2.agentMode() == QStringLiteral("build"),
              "agent_mode = \"build\" loaded from config.toml");
        writeConfig(QStringLiteral("agent_mode = \"bogus\"\n"));
        jarvis::SettingsStore s3; s3.load();
        check(s3.agentMode() == QStringLiteral("coworker"),
              "agent_mode = \"bogus\" normalizes to coworker on load");
    }

    // =========================================================================
    // 7. wake_notify: silent persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setWakeNotify(QStringLiteral("silent"));
        check(s.wakeNotify() == QStringLiteral("silent"), "setWakeNotify(silent) in-memory");
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.wakeNotify() == QStringLiteral("silent"),
              "wake_notify=silent round-trips through config.toml");
    }

    // =========================================================================
    // 8. wake_notify: always persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setWakeNotify(QStringLiteral("always"));
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.wakeNotify() == QStringLiteral("always"),
              "wake_notify=always round-trips through config.toml");
    }

    // =========================================================================
    // 9. wake_notify: ping persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setWakeNotify(QStringLiteral("ping"));
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.wakeNotify() == QStringLiteral("ping"),
              "wake_notify=ping round-trips through config.toml");
    }

    // =========================================================================
    // 10. wake_notify: invalid normalizes to ping
    // =========================================================================
    {
        jarvis::SettingsStore s; s.load();
        s.setWakeNotify(QStringLiteral("scream"));
        check(s.wakeNotify() == QStringLiteral("ping"),
              "setWakeNotify(invalid) normalizes to ping");
        writeConfig(QStringLiteral("wake_notify = \"bogus\"\n"));
        jarvis::SettingsStore s2; s2.load();
        check(s2.wakeNotify() == QStringLiteral("ping"),
              "wake_notify=bogus on disk normalizes to ping");
    }

    // =========================================================================
    // 11. permission_level: high persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setPermissionLevel(QStringLiteral("high"));
        check(s.permissionLevel() == QStringLiteral("high"),
              "setPermissionLevel(high) in-memory");
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.permissionLevel() == QStringLiteral("high"),
              "permission_level=high round-trips through config.toml");
    }

    // =========================================================================
    // 12. permission_level: low persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setPermissionLevel(QStringLiteral("low"));
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.permissionLevel() == QStringLiteral("low"),
              "permission_level=low round-trips through config.toml");
    }

    // =========================================================================
    // 13. permission_level: medium persists + round-trips
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setPermissionLevel(QStringLiteral("medium"));
        s.saveConfig();
        jarvis::SettingsStore s2; s2.load();
        check(s2.permissionLevel() == QStringLiteral("medium"),
              "permission_level=medium round-trips through config.toml");
    }

    // =========================================================================
    // 14. permission_level: invalid normalizes to medium
    // =========================================================================
    {
        jarvis::SettingsStore s; s.load();
        s.setPermissionLevel(QStringLiteral("extreme"));
        check(s.permissionLevel() == QStringLiteral("medium"),
              "setPermissionLevel(invalid) normalizes to medium");
        writeConfig(QStringLiteral("permission_level = \"extreme\"\n"));
        jarvis::SettingsStore s2; s2.load();
        check(s2.permissionLevel() == QStringLiteral("medium"),
              "permission_level=extreme on disk normalizes to medium");
    }

    // =========================================================================
    // 15. UNRELATED keys in config.toml are PRESERVED across saveConfig
    // =========================================================================
    {
        // Write a config with a custom/extra key that SettingsStore doesn't own
        writeConfig(QStringLiteral("# my custom comment\nsome_custom_key = \"preserved_value\"\n"
                                   "another_key = 42\n"));
        jarvis::SettingsStore s; s.load();
        s.setAgentMode(QStringLiteral("plan"));
        s.setWakeNotify(QStringLiteral("silent"));
        s.saveConfig();
        const QString saved = readConfig();
        check(saved.contains(QStringLiteral("some_custom_key")),
              "UNRELATED key some_custom_key preserved after saveConfig");
        check(saved.contains(QStringLiteral("preserved_value")),
              "UNRELATED value preserved_value preserved after saveConfig");
        check(saved.contains(QStringLiteral("another_key")),
              "UNRELATED key another_key preserved after saveConfig");
    }

    // =========================================================================
    // 16. Desktop PIN: set, verify correct, reject wrong, clear
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        check(!s.hasDesktopPin(), "initially no desktop PIN");
        s.setDesktopPin(QStringLiteral("1379"));
        check(s.hasDesktopPin(), "setDesktopPin sets flag");
        check(s.verifyDesktopPin(QStringLiteral("1379")),
              "verifyDesktopPin: correct PIN accepted");
        check(!s.verifyDesktopPin(QStringLiteral("0000")),
              "verifyDesktopPin: wrong PIN rejected");
        check(!s.verifyDesktopPin(QString()),
              "verifyDesktopPin: empty PIN rejected");

        s.setDesktopPin(QString()); // clear
        check(!s.hasDesktopPin(), "setDesktopPin(\"\") clears PIN");
        check(!s.verifyDesktopPin(QStringLiteral("1379")),
              "verify after clear returns false");
    }

    // =========================================================================
    // 17. Desktop PIN persists through saveConfig + reload
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setDesktopPin(QStringLiteral("4242"));
        check(s.saveConfig(), "saveConfig with PIN succeeds");

        jarvis::SettingsStore s2; s2.load();
        check(s2.hasDesktopPin(), "PIN round-trips: hasDesktopPin after reload");
        check(s2.verifyDesktopPin(QStringLiteral("4242")),
              "PIN round-trips: reloaded PIN verifies");
        check(!s2.verifyDesktopPin(QStringLiteral("4243")),
              "PIN round-trips: off-by-one rejected");
    }

    // =========================================================================
    // 18. Desktop PIN is NOT stored as plaintext
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setDesktopPin(QStringLiteral("9876"));
        s.saveConfig();
        const QString txt = readConfig();
        check(!txt.contains(QStringLiteral("9876")),
              "PIN not stored as plaintext in config.toml");
        check(txt.contains(QStringLiteral("desktop_pin")),
              "config.toml contains desktop_pin (hashed) key");
        // Hash should be in saltHex:hashHex format — look for ':'
        bool hasColon = false;
        for (const QString &line : txt.split(QLatin1Char('\n'))) {
            if (line.trimmed().startsWith(QStringLiteral("desktop_pin"))) {
                hasColon = line.contains(QLatin1Char(':'));
                break;
            }
        }
        check(hasColon, "desktop_pin line contains ':' (salt:hash format)");
    }

    // =========================================================================
    // 19. API key: set, hasApiKey, apiKeysSet, clear
    // =========================================================================
    {
        jarvis::SettingsStore s; s.load();
        // Initially no keys
        const QJsonObject before = s.apiKeysSet();
        check(!before.value(QStringLiteral("anthropic")).toBool(),
              "apiKeysSet: anthropic absent initially");
        check(!before.value(QStringLiteral("openai")).toBool(),
              "apiKeysSet: openai absent initially");

        s.setApiKey(QStringLiteral("anthropic"), QStringLiteral("sk-ant-test-key"));
        check(s.hasApiKey(QStringLiteral("anthropic")),
              "hasApiKey: set key present");
        check(!s.hasApiKey(QStringLiteral("openai")),
              "hasApiKey: unset key absent");

        const QJsonObject after = s.apiKeysSet();
        check(after.value(QStringLiteral("anthropic")).toBool(),
              "apiKeysSet: anthropic true after set");
        check(!after.value(QStringLiteral("openai")).toBool(),
              "apiKeysSet: openai still false");

        // All provider keys are present in apiKeysSet
        const QStringList providers = jarvis::SettingsStore::providerKeys();
        bool allPresent = true;
        for (const auto &p : providers)
            if (!after.contains(p)) { allPresent = false; break; }
        check(allPresent, "apiKeysSet: all provider keys present in result");
        check(providers.contains(QStringLiteral("gemini")) &&
                  providers.contains(QStringLiteral("xai")) &&
                  providers.contains(QStringLiteral("deepseek")),
              "providerKeys: gemini/xai/deepseek registered (jarvis#76 item 11)");

        // Multi-credential pool (jarvis#76 item 5): comma/newline separated
        // values split into an ordered pool; apiKey() returns the first.
        s.setApiKey(QStringLiteral("gemini"),
                    QStringLiteral("key-one, key-two\nkey-three"));
        const QStringList pool = s.apiKeyPool(QStringLiteral("gemini"));
        check(pool.size() == 3, "apiKeyPool: three keys parsed");
        check(pool.first() == QStringLiteral("key-one") &&
                  pool.last() == QStringLiteral("key-three"),
              "apiKeyPool: order preserved, whitespace trimmed");
        check(s.apiKey(QStringLiteral("gemini")) == QStringLiteral("key-one"),
              "apiKey: single-key callers get the first pool entry");
        check(s.apiKeyPool(QStringLiteral("openai")).isEmpty(),
              "apiKeyPool: unset provider is empty");
        s.setApiKey(QStringLiteral("gemini"), QString());

        // Clear
        s.setApiKey(QStringLiteral("anthropic"), QString());
        check(!s.hasApiKey(QStringLiteral("anthropic")),
              "hasApiKey: cleared key absent");
        check(!s.apiKeysSet().value(QStringLiteral("anthropic")).toBool(),
              "apiKeysSet: cleared key shows false");
    }

    // =========================================================================
    // 20. API keys persist through saveSecrets + reload
    // =========================================================================
    {
        jarvis::SettingsStore s; s.load();
        s.setApiKey(QStringLiteral("codex"), QStringLiteral("sk-codex-test"));
        check(s.saveSecrets(), "saveSecrets succeeds");

        jarvis::SettingsStore s2; s2.load();
        check(s2.hasApiKey(QStringLiteral("codex")),
              "API key round-trips through secrets.json");
        check(s2.apiKeysSet().value(QStringLiteral("codex")).toBool(),
              "apiKeysSet: codex true after reload");

        // secrets.json must not be readable by group/world (mode 0600)
        QFile sf(jarvis::SettingsStore::secretsFilePath());
        const QFileDevice::Permissions perms = sf.permissions();
        const bool noGroupRead  = !(perms & QFileDevice::ReadGroup);
        const bool noOtherRead  = !(perms & QFileDevice::ReadOther);
        check(noGroupRead && noOtherRead, "secrets.json has 0600 permissions");
    }

    // =========================================================================
    // 21. All three mode settings coexist in one saveConfig/reload cycle
    // =========================================================================
    {
        writeConfig(QStringLiteral("default_brain = \"codex\"\n"));
        jarvis::SettingsStore s; s.load();
        s.setAgentMode(QStringLiteral("build"));
        s.setWakeNotify(QStringLiteral("always"));
        s.setPermissionLevel(QStringLiteral("high"));
        check(s.saveConfig(), "saveConfig: all three modes");
        jarvis::SettingsStore s2; s2.load();
        check(s2.agentMode()       == QStringLiteral("build"),  "coexist: agent_mode=build");
        check(s2.wakeNotify()      == QStringLiteral("always"), "coexist: wake_notify=always");
        check(s2.permissionLevel() == QStringLiteral("high"),   "coexist: permission_level=high");
    }

    // =========================================================================
    // 21. Profile isolation env overrides (jarvis#76 item 15)
    // =========================================================================
    {
        const QString cfgBefore = jarvis::Config::configDir();
        const QString dataBefore = jarvis::dataDir();
        qputenv("JARVIS_CONFIG_DIR", "/tmp/jarvis-profile-b/config");
        qputenv("JARVIS_DATA_DIR", "/tmp/jarvis-profile-b/data");
        check(jarvis::Config::configDir() == QStringLiteral("/tmp/jarvis-profile-b/config"),
              "JARVIS_CONFIG_DIR overrides the config root");
        check(jarvis::dataDir() == QStringLiteral("/tmp/jarvis-profile-b/data"),
              "JARVIS_DATA_DIR overrides the data root");
        check(jarvis::Config::controlTokenPath()
                  == QStringLiteral("/tmp/jarvis-profile-b/config/control_token"),
              "control_token follows the profile config root");
        check(jarvis::SessionStore::defaultDbPath()
                  == QStringLiteral("/tmp/jarvis-profile-b/data/jarvis.db"),
              "jarvis.db follows the profile data root");
        qunsetenv("JARVIS_CONFIG_DIR");
        qunsetenv("JARVIS_DATA_DIR");
        check(jarvis::Config::configDir() == cfgBefore,
              "unset -> config root byte-identical to before");
        check(jarvis::dataDir() == dataBefore,
              "unset -> data root byte-identical to before");
    }

    // =========================================================================
    // Summary
    // =========================================================================
    std::fprintf(stderr, "\n%d checks passed, %d failed\n", g_passes, g_failures);
    if (g_failures == 0) {
        std::fprintf(stderr, "PASS settings_modes_comprehensive_test\n");
        return 0;
    }
    std::fprintf(stderr, "FAIL settings_modes_comprehensive_test\n");
    return 1;
}
