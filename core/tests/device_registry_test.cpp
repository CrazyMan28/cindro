// Unit test for the Contract C core: DeviceRegistry (ed25519 identity +
// pair/verify/revoke round-trip) and PairingManager (6-digit code lifecycle +
// QR SVG render). Uses a temp HOME so it never touches the real ~/.config.

#include "jarvis/DeviceRegistry.h"
#include "jarvis/PairingManager.h"

#include <sodium.h>

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QTemporaryDir>

#include <cstdio>

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

int main()
{
    if (sodium_init() < 0) {
        std::fprintf(stderr, "FAIL: libsodium init failed\n");
        return 1;
    }

    // Isolate HOME so identity.key / devices.json land in a throwaway dir.
    QTemporaryDir tmp;
    if (!tmp.isValid()) {
        std::fprintf(stderr, "FAIL: cannot create temp dir\n");
        return 1;
    }
    qputenv("HOME", tmp.path().toLocal8Bit());

    // --- DeviceRegistry: identity ------------------------------------------
    jarvis::DeviceRegistry reg;
    reg.load();
    check(!reg.identityPublicKey().isEmpty(), "daemon identity public key exists");
    check(reg.identityPublicKey().size() == crypto_sign_PUBLICKEYBYTES,
          "identity public key is 32 bytes");
    check(!reg.identityFingerprint().isEmpty(), "identity fingerprint non-empty");
    const QString fp1 = reg.identityFingerprint();

    // identity.key must be 0600.
    {
        const QFile::Permissions perms =
            QFile::permissions(jarvis::DeviceRegistry::identityFilePath());
        const auto mask = QFile::ReadOwner | QFile::WriteOwner | QFile::ReadGroup |
                          QFile::WriteGroup | QFile::ReadOther | QFile::WriteOther |
                          QFile::ExeOwner | QFile::ExeGroup | QFile::ExeOther;
        check((perms & mask) == (QFile::ReadOwner | QFile::WriteOwner),
              "identity.key is mode 0600");
    }

    // Identity must persist across reload.
    {
        jarvis::DeviceRegistry reg2;
        reg2.load();
        check(reg2.identityFingerprint() == fp1, "identity persists across reload");
    }

    // --- DeviceRegistry: pair + verify -------------------------------------
    unsigned char dpk[crypto_sign_PUBLICKEYBYTES];
    unsigned char dsk[crypto_sign_SECRETKEYBYTES];
    crypto_sign_keypair(dpk, dsk);
    const QByteArray devicePk(reinterpret_cast<const char *>(dpk), sizeof(dpk));

    const jarvis::DeviceRow paired = reg.pair(devicePk, QStringLiteral("Pixel Test"));
    check(!paired.id.isEmpty(), "pair returns a device id");
    check(paired.name == QStringLiteral("Pixel Test"), "device name stored");
    check(reg.list().size() == 1, "one device registered");

    // Sign a challenge with the device secret key; the registry must verify it.
    const QByteArray nonce = QByteArray("challenge-nonce-12345");
    unsigned char sig[crypto_sign_BYTES];
    unsigned long long siglen = 0;
    crypto_sign_detached(sig, &siglen,
                         reinterpret_cast<const unsigned char *>(nonce.constData()),
                         static_cast<unsigned long long>(nonce.size()), dsk);
    const QByteArray signature(reinterpret_cast<const char *>(sig), int(siglen));
    check(reg.verify(paired.id, nonce, signature), "verify accepts a valid signature");

    // Tampered message must not verify.
    check(!reg.verify(paired.id, QByteArray("wrong-nonce"), signature),
          "verify rejects a tampered message");
    // Unknown device must not verify.
    check(!reg.verify(QStringLiteral("deadbeef"), nonce, signature),
          "verify rejects an unknown device");

    // devices.json must be 0600.
    {
        const QFile::Permissions perms =
            QFile::permissions(jarvis::DeviceRegistry::devicesFilePath());
        check((perms & (QFile::ReadGroup | QFile::ReadOther)) == 0,
              "devices.json is owner-only");
    }

    // Pairing must survive reload (persisted to devices.json).
    {
        jarvis::DeviceRegistry reg3;
        reg3.load();
        check(reg3.list().size() == 1, "device persists across reload");
        check(reg3.verify(paired.id, nonce, signature),
              "reloaded registry verifies the same signature");
    }

    // Revoke removes it.
    check(reg.revoke(paired.id), "revoke removes the device");
    check(reg.list().isEmpty(), "no devices after revoke");
    check(!reg.verify(paired.id, nonce, signature),
          "verify fails after revoke");

    // --- PairingManager ----------------------------------------------------
    jarvis::PairingManager pm;
    const jarvis::PairingCode pc =
        pm.start(QStringLiteral("100.1.2.3:8796"), fp1);
    check(pc.code.size() == 6, "pairing code is 6 digits");
    bool allDigits = true;
    for (QChar c : pc.code)
        if (!c.isDigit())
            allDigits = false;
    check(allDigits, "pairing code is all digits");
    check(pc.payload.startsWith(QStringLiteral("jarvis://pair?host=100.1.2.3:8796")),
          "payload encodes host");
    check(pc.payload.contains(QStringLiteral("code=") + pc.code),
          "payload encodes code");
    check(pc.payload.contains(QStringLiteral("fp=") + fp1),
          "payload encodes daemon fp");
    check(pc.qrSvg.startsWith(QStringLiteral("<svg")) &&
              pc.qrSvg.contains(QStringLiteral("</svg>")),
          "qr_svg is a valid SVG document");
    check(pc.expiresAt > QDateTime::currentMSecsSinceEpoch(),
          "code has a future expiry");

    check(pm.isValid(pc.code), "fresh code is valid");
    check(!pm.isValid(QStringLiteral("000000")) || pc.code == QStringLiteral("000000"),
          "unrelated code is not valid");
    check(pm.consume(pc.code), "consume accepts the valid code");
    check(!pm.isValid(pc.code), "code is single-use (invalid after consume)");
    check(!pm.consume(pc.code), "cannot consume the same code twice");

    // Expired code: ttl in the past must be invalid immediately.
    const jarvis::PairingCode expired =
        pm.start(QStringLiteral("h"), QStringLiteral("f"), -1);
    check(!pm.isValid(expired.code), "expired code is invalid");

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS device_registry_test\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL device_registry_test (%d failures)\n", g_failures);
    return 1;
}
