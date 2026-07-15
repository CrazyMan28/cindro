// SecretCipher: protect/unprotect round-trip when an OS backend is available
// on this machine, corrupt-input handling, and backendName()/available()
// consistency. Environment-tolerant: a CI box with no keyring daemon (Linux)
// still passes — available() just comes back false and the round-trip
// assertions are skipped (SettingsStore's plaintext fallback covers that case;
// see settings_modes_comprehensive_test.cpp check 20).

#include "jarvis/SecretCipher.h"

#include <QByteArray>

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

int main()
{
    using jarvis::SecretCipher;

    const QString backend = SecretCipher::backendName();
    check(backend == QStringLiteral("dpapi") || backend == QStringLiteral("secretservice") ||
              backend == QStringLiteral("none"),
          "backendName() is one of dpapi/secretservice/none");

    if (!SecretCipher::available()) {
        std::fprintf(stderr,
            "  (SecretCipher unavailable on this box/build [backend=%s]; skipping round-trip "
            "checks — SettingsStore falls back to plaintext in this case)\n",
            qUtf8Printable(backend));
    } else {
        const QByteArray plaintext = QByteArrayLiteral("{\"anthropic\":\"sk-ant-round-trip-test\"}");
        const QByteArray stored = SecretCipher::protect(plaintext);
        check(!stored.isEmpty(), "protect() returns non-empty bytes when available");

        bool ok = false;
        const QByteArray recovered = SecretCipher::unprotect(stored, &ok);
        check(ok, "unprotect() reports success for its own protect() output");
        check(recovered == plaintext, "unprotect(protect(x)) == x");

        // Corrupt/garbage input must fail cleanly, never crash.
        bool ok2 = true;
        const QByteArray garbage = SecretCipher::unprotect(QByteArrayLiteral("not a real blob"), &ok2);
        check(!ok2, "unprotect() of garbage input reports failure");
        check(garbage.isEmpty(), "unprotect() of garbage input returns empty");

        // Empty input must also fail cleanly rather than crash.
        bool ok3 = true;
        const QByteArray empty = SecretCipher::unprotect(QByteArray(), &ok3);
        check(!ok3, "unprotect() of empty input reports failure");
        check(empty.isEmpty(), "unprotect() of empty input returns empty");
    }

    std::fprintf(stderr, "secret_cipher_test: %d passed, %d failed\n", g_passes, g_failures);
    return g_failures == 0 ? 0 : 1;
}
