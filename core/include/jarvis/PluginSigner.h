#pragma once

// PluginSigner — Ed25519 signing / verification for Jarvis plugin packages.
//
// A plugin package is a directory (or tarball) containing `jarvis-plugin.toml`
// plus its payload (the skill SKILL.md / scripts, or an mcp launcher). The
// manifest carries an Ed25519 `signature` computed over a CANONICAL byte string
// derived from the manifest's identity + declared capabilities + a SHA-256 of
// the payload. Signing and verification share `canonicalString()` so a tamper
// of any signed field — or of the payload — breaks the signature.
//
// Trusted publisher public keys live in ~/.config/jarvis/plugin_keys.json:
//   { "keys": { "<key-id>": "<base64 ed25519 public key>", ... } }
// `key-id` is the first 16 hex of sha256(pubkey) (same scheme as device fps).
//
// This class links libsodium directly (crypto_sign_*), mirroring DeviceRegistry.

#include "jarvis/PluginRegistry.h"

#include <QByteArray>
#include <QHash>
#include <QString>
#include <QStringList>
#include <optional>

namespace jarvis {

// Result of verifying a package's signature against the trusted-keys file.
struct VerifyResult {
    bool verified = false;       // signature valid AND signed by a trusted key
    bool signaturePresent = false;
    bool signatureValid = false; // sig verifies against the embedded/known key
    bool keyTrusted = false;     // the signing key id is in plugin_keys.json
    QString keyId;               // signer key id (sha256(pubkey)[:16] hex)
    QStringList permissions;     // declared permissions from the manifest
    QString error;               // human-readable reason when !verified
};

class PluginSigner {
public:
    // ~/.config/jarvis/plugin_keys.json
    static QString trustedKeysPath();

    // Key id for a raw 32-byte Ed25519 public key: sha256(pubkey)[:16] hex.
    static QString keyIdFor(const QByteArray &pubkey);

    // The canonical, signature-free byte string for a manifest + payload hash.
    // Deterministic: stable field order, explicit length-prefixing of arrays.
    // `payloadSha256Hex` is the lowercase hex sha256 of the package payload
    // (see hashPayloadDir); empty for a manifest-only package.
    static QByteArray canonicalString(const PluginManifest &m,
                                      const QString &payloadSha256Hex);

    // SHA-256 (lowercase hex) over every file in `payloadDir` EXCEPT
    // jarvis-plugin.toml, hashed in sorted relative-path order so it is stable.
    // Returns empty string if the dir doesn't exist (manifest-only package).
    static QString hashPayloadDir(const QString &payloadDir);

    // Sign canonicalString(m, payloadHash) with a raw 64-byte Ed25519 secret
    // key. Returns the signature token "ed25519:<keyId>:<base64 sig>" to drop
    // into the manifest's `signature =` field. Empty on bad key size.
    static QString sign(const PluginManifest &m, const QString &payloadSha256Hex,
                        const QByteArray &secretKey);

    // Parse a "ed25519:<keyId>:<base64 sig>" token. nullopt if malformed.
    struct SignatureToken {
        QString keyId;
        QByteArray sig; // raw 64 bytes
    };
    static std::optional<SignatureToken> parseSignature(const QString &token);

    // Load ~/.config/jarvis/plugin_keys.json -> { keyId -> raw pubkey }.
    // Missing/!file => empty map (no trusted keys). `path` overrides for tests.
    static QHash<QString, QByteArray> loadTrustedKeys(const QString &path = QString());

    // Add/replace a trusted key (writes plugin_keys.json, 0600). The key id is
    // derived from the pubkey. `path` overrides for tests. False on I/O error.
    static bool addTrustedKey(const QByteArray &pubkey, const QString &name,
                              const QString &path = QString());

    // Verify a package directory: parse jarvis-plugin.toml, hash the payload,
    // check the signature against the trusted keys. Never throws.
    static VerifyResult verifyPackageDir(const QString &packageDir,
                                         const QString &trustedKeysPathOverride = QString());

    // Verify an in-memory manifest + payload hash against the trusted keys.
    static VerifyResult verify(const PluginManifest &m,
                               const QString &payloadSha256Hex,
                               const QHash<QString, QByteArray> &trustedKeys);
};

} // namespace jarvis
