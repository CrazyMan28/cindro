// Unit test for the Wave 7 plugin marketplace backend.
//
//   1. Sign a manifest (+payload hash) with a publisher Ed25519 key, register
//      that key as trusted, and verify() => verified.
//   2. Tamper a signed field (permissions / endpoint / payload) => verify fails.
//   3. Verify a manifest signed by a key NOT in the trusted file => fails.
//   4. PluginSandbox::plan() derives ReadWritePaths + PrivateNetwork from the
//      declared permission grammar (filesystem:<p> / network:<host>).
//
// Uses a temp HOME so it never touches the real ~/.config/jarvis.

#include "jarvis/PluginRegistry.h"
#include "jarvis/PluginSandbox.h"
#include "jarvis/PluginSigner.h"

#include <sodium.h>

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QProcessEnvironment>
#include <QTemporaryDir>

#include <cstdio>

using namespace jarvis;

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

static PluginManifest sampleManifest()
{
    PluginManifest m;
    m.id = QStringLiteral("acme-mcp");
    m.name = QStringLiteral("ACME MCP");
    m.author = QStringLiteral("ACME");
    m.version = QStringLiteral("1.0.0");
    m.kind = QStringLiteral("mcp");
    m.mcpCommand = QStringLiteral("acme-mcp --stdio");
    m.mcpEnvKeys = QStringList{QStringLiteral("ACME_TOKEN")};
    m.permissions = QStringList{QStringLiteral("filesystem:/tmp/acme"),
                                QStringLiteral("network:api.acme.test")};
    return m;
}

int main()
{
    if (sodium_init() < 0) {
        std::fprintf(stderr, "FAIL: libsodium init failed\n");
        return 1;
    }

    QTemporaryDir tmp;
    if (!tmp.isValid()) {
        std::fprintf(stderr, "FAIL: cannot create temp dir\n");
        return 1;
    }
    qputenv("HOME", tmp.path().toLocal8Bit());
    const QString keysPath = tmp.filePath(QStringLiteral("plugin_keys.json"));

    // --- publisher keypair -------------------------------------------------
    unsigned char pk[crypto_sign_PUBLICKEYBYTES];
    unsigned char sk[crypto_sign_SECRETKEYBYTES];
    crypto_sign_keypair(pk, sk);
    const QByteArray pubkey(reinterpret_cast<const char *>(pk), sizeof(pk));
    const QByteArray secret(reinterpret_cast<const char *>(sk), sizeof(sk));
    const QString keyId = PluginSigner::keyIdFor(pubkey);
    check(keyId.size() == 16, "key id is 16 hex chars");

    // --- 1. sign -> verify ok ----------------------------------------------
    PluginManifest m = sampleManifest();
    const QString payloadHash =
        QStringLiteral("deadbeef00000000000000000000000000000000000000000000000000000000");
    m.signature = PluginSigner::sign(m, payloadHash, secret);
    check(!m.signature.isEmpty(), "sign produced a signature token");
    check(m.signature.startsWith(QStringLiteral("ed25519:") + keyId + QStringLiteral(":")),
          "signature token carries the signer key id");

    // Untrusted until the publisher key is registered.
    {
        const QHash<QString, QByteArray> none;
        const VerifyResult vr = PluginSigner::verify(m, payloadHash, none);
        check(!vr.verified, "verify fails when no keys are trusted");
        check(vr.keyTrusted == false, "untrusted key reported");
    }

    // Register the publisher key as trusted.
    check(PluginSigner::addTrustedKey(pubkey, QStringLiteral("ACME publisher"), keysPath),
          "addTrustedKey writes plugin_keys.json");
    const auto trusted = PluginSigner::loadTrustedKeys(keysPath);
    check(trusted.contains(keyId), "trusted keys file round-trips the key id");

    {
        const VerifyResult vr = PluginSigner::verify(m, payloadHash, trusted);
        check(vr.verified, "verify OK for a trusted, untampered manifest");
        check(vr.signatureValid, "signature reported valid");
        check(vr.keyTrusted, "key reported trusted");
        check(vr.permissions.size() == 2, "declared permissions surfaced");
    }

    // --- 2. tamper -> verify fails -----------------------------------------
    {
        PluginManifest t = m; // keep the original signature
        t.permissions << QStringLiteral("filesystem:/etc"); // privilege escalation
        const VerifyResult vr = PluginSigner::verify(t, payloadHash, trusted);
        check(!vr.verified, "verify FAILS when permissions are tampered");
    }
    {
        PluginManifest t = m;
        t.mcpCommand = QStringLiteral("evil --stdio"); // swap the launcher
        const VerifyResult vr = PluginSigner::verify(t, payloadHash, trusted);
        check(!vr.verified, "verify FAILS when the launch command is tampered");
    }
    {
        // Tamper the payload hash (a changed SKILL.md / script) -> fails.
        const QString otherHash =
            QStringLiteral("ffffffff00000000000000000000000000000000000000000000000000000000");
        const VerifyResult vr = PluginSigner::verify(m, otherHash, trusted);
        check(!vr.verified, "verify FAILS when the payload hash changes");
    }

    // --- 3. unknown signing key -> verify fails ----------------------------
    {
        unsigned char pk2[crypto_sign_PUBLICKEYBYTES];
        unsigned char sk2[crypto_sign_SECRETKEYBYTES];
        crypto_sign_keypair(pk2, sk2);
        const QByteArray secret2(reinterpret_cast<const char *>(sk2), sizeof(sk2));

        PluginManifest u = sampleManifest();
        u.signature = PluginSigner::sign(u, payloadHash, secret2);
        const VerifyResult vr = PluginSigner::verify(u, payloadHash, trusted);
        check(!vr.verified, "verify FAILS for a manifest signed by an unknown key");
        check(!vr.keyTrusted, "unknown signer key reported untrusted");
    }

    // --- payload directory hashing is stable + tamper-sensitive ------------
    {
        QDir().mkpath(tmp.filePath(QStringLiteral("pkg")));
        const QString pkgDir = tmp.filePath(QStringLiteral("pkg"));
        QFile f(QDir(pkgDir).filePath(QStringLiteral("SKILL.md")));
        f.open(QIODevice::WriteOnly);
        f.write("# Skill\nhello\n");
        f.close();
        const QString h1 = PluginSigner::hashPayloadDir(pkgDir);
        check(!h1.isEmpty(), "payload dir hash is non-empty");
        const QString h1b = PluginSigner::hashPayloadDir(pkgDir);
        check(h1 == h1b, "payload dir hash is deterministic");
        QFile f2(QDir(pkgDir).filePath(QStringLiteral("SKILL.md")));
        f2.open(QIODevice::WriteOnly);
        f2.write("# Skill\nTAMPERED\n");
        f2.close();
        const QString h2 = PluginSigner::hashPayloadDir(pkgDir);
        check(h1 != h2, "payload dir hash changes when a file changes");
    }

    // --- 4. sandbox plan derives confinement from permissions --------------
    {
        PluginManifest s = sampleManifest();
        s.mcpEnvKeys = QStringList{QStringLiteral("ACME_TOKEN")};
        QProcessEnvironment env;
        env.insert(QStringLiteral("ACME_TOKEN"), QStringLiteral("secret123"));
        env.insert(QStringLiteral("SHOULD_NOT_PASS"), QStringLiteral("nope"));

        // Force the systemd-run path so we can assert the unit properties.
        const SandboxPlan p = PluginSandbox::plan(
            s, s.permissions, env, /*forceSystemdRun=*/true, /*forceFallback=*/false);
        check(p.usesSystemdRun, "plan uses systemd-run when forced");
        check(p.program == QStringLiteral("systemd-run"), "program is systemd-run");
        check(p.readWritePaths.contains(QStringLiteral("/tmp/acme")),
              "filesystem:<p> permission becomes a ReadWritePaths entry");
        check(p.networkAllowed, "network:<host> permission allows the network");
        check(p.allowedEnv.size() == 1 &&
                  p.allowedEnv.first().startsWith(QStringLiteral("ACME_TOKEN=")),
              "only declared env_keys cross the sandbox boundary");

        const QString joined = p.arguments.join(QLatin1Char(' '));
        check(joined.contains(QStringLiteral("ReadWritePaths=/tmp/acme")),
              "argv carries ReadWritePaths");
        check(joined.contains(QStringLiteral("ProtectHome=read-only")),
              "argv hardens with ProtectHome=read-only");
        check(!joined.contains(QStringLiteral("PrivateNetwork=yes")),
              "network grant => no PrivateNetwork isolation");

        // A plugin with NO network permission must get PrivateNetwork=yes.
        PluginManifest noNet = sampleManifest();
        noNet.permissions = QStringList{QStringLiteral("filesystem:/tmp/x")};
        const SandboxPlan pn = PluginSandbox::plan(
            noNet, noNet.permissions, env, true, false);
        check(!pn.networkAllowed, "no network permission => network not allowed");
        check(pn.arguments.join(QLatin1Char(' '))
                  .contains(QStringLiteral("PrivateNetwork=yes")),
              "no network grant => PrivateNetwork=yes isolation");
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS plugin_sign_verify\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL plugin_sign_verify (%d failures)\n", g_failures);
    return 1;
}
