#include "jarvis/PluginSigner.h"

#include <sodium.h>

#include <QCryptographicHash>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

namespace jarvis {

QString PluginSigner::trustedKeysPath()
{
    return QDir::homePath() + QStringLiteral("/.config/jarvis/plugin_keys.json");
}

QString PluginSigner::keyIdFor(const QByteArray &pubkey)
{
    const QByteArray hash =
        QCryptographicHash::hash(pubkey, QCryptographicHash::Sha256).toHex();
    return QString::fromLatin1(hash.left(16));
}

QByteArray PluginSigner::canonicalString(const PluginManifest &m,
                                         const QString &payloadSha256Hex)
{
    // Deterministic, signature-FREE serialization. Every signed field appears
    // exactly once in a fixed order; each list is length-prefixed so that
    // ["a","bc"] and ["ab","c"] (or reordering) cannot collide. Anything that
    // changes the plugin's identity or capabilities changes these bytes.
    auto field = [](const QString &k, const QString &v) {
        return k.toUtf8() + '=' + v.toUtf8() + '\n';
    };
    auto listField = [](const QString &k, QStringList v) {
        v.sort(); // canonical order: the permission/env set, not its writing order
        QByteArray out = k.toUtf8() + '=' + QByteArray::number(v.size()) + '\n';
        for (const QString &e : v)
            out += QByteArray::number(e.toUtf8().size()) + ':' + e.toUtf8() + '\n';
        return out;
    };

    QByteArray c;
    c += QByteArray("jarvis-plugin-v1\n");
    c += field(QStringLiteral("id"), m.id);
    c += field(QStringLiteral("name"), m.name);
    c += field(QStringLiteral("author"), m.author);
    c += field(QStringLiteral("version"), m.version);
    c += field(QStringLiteral("kind"), m.kind);
    c += field(QStringLiteral("transport"), m.effectiveTransport());
    c += field(QStringLiteral("endpoint"), m.effectiveEndpoint());
    c += field(QStringLiteral("skill_path"), m.skillPath);
    c += listField(QStringLiteral("env_keys"), m.mcpEnvKeys);
    c += listField(QStringLiteral("permissions"), m.permissions);
    c += field(QStringLiteral("payload_sha256"), payloadSha256Hex);
    return c;
}

QString PluginSigner::hashPayloadDir(const QString &payloadDir)
{
    QDir dir(payloadDir);
    if (!dir.exists())
        return QString();

    // Collect every file under the dir, relative + sorted, excluding the
    // manifest itself (which carries the signature we're computing).
    QStringList rels;
    QDirIterator it(payloadDir, QDir::Files | QDir::NoDotAndDotDot,
                    QDirIterator::Subdirectories);
    while (it.hasNext()) {
        it.next();
        const QString rel = dir.relativeFilePath(it.filePath());
        if (rel == QStringLiteral("jarvis-plugin.toml"))
            continue;
        rels << rel;
    }
    rels.sort();

    QCryptographicHash h(QCryptographicHash::Sha256);
    for (const QString &rel : rels) {
        // Length-prefix the path + contents so file boundaries are unambiguous.
        const QByteArray relBytes = rel.toUtf8();
        h.addData(QByteArray::number(relBytes.size()));
        h.addData(":");
        h.addData(relBytes);
        QFile f(dir.filePath(rel));
        if (f.open(QIODevice::ReadOnly)) {
            const QByteArray data = f.readAll();
            f.close();
            h.addData(QByteArray::number(data.size()));
            h.addData(":");
            h.addData(data);
        } else {
            h.addData("0:");
        }
    }
    return QString::fromLatin1(h.result().toHex());
}

QString PluginSigner::sign(const PluginManifest &m,
                           const QString &payloadSha256Hex,
                           const QByteArray &secretKey)
{
    if (secretKey.size() != crypto_sign_SECRETKEYBYTES)
        return QString();

    const QByteArray canon = canonicalString(m, payloadSha256Hex);
    unsigned char sig[crypto_sign_BYTES];
    unsigned long long siglen = 0;
    crypto_sign_detached(sig, &siglen,
                         reinterpret_cast<const unsigned char *>(canon.constData()),
                         static_cast<unsigned long long>(canon.size()),
                         reinterpret_cast<const unsigned char *>(secretKey.constData()));

    // Derive the public key from the secret key to compute the key id.
    unsigned char pk[crypto_sign_PUBLICKEYBYTES];
    crypto_sign_ed25519_sk_to_pk(
        pk, reinterpret_cast<const unsigned char *>(secretKey.constData()));
    const QByteArray pubkey(reinterpret_cast<const char *>(pk), sizeof(pk));

    const QByteArray sigB64 =
        QByteArray(reinterpret_cast<const char *>(sig), int(siglen)).toBase64();
    return QStringLiteral("ed25519:") + keyIdFor(pubkey) + QStringLiteral(":") +
           QString::fromLatin1(sigB64);
}

std::optional<PluginSigner::SignatureToken>
PluginSigner::parseSignature(const QString &token)
{
    // "ed25519:<keyId>:<base64 sig>"
    const QStringList parts = token.split(QLatin1Char(':'));
    if (parts.size() != 3)
        return std::nullopt;
    if (parts[0] != QStringLiteral("ed25519"))
        return std::nullopt;
    SignatureToken t;
    t.keyId = parts[1].trimmed();
    t.sig = QByteArray::fromBase64(parts[2].trimmed().toLatin1());
    if (t.keyId.isEmpty() || t.sig.size() != crypto_sign_BYTES)
        return std::nullopt;
    return t;
}

QHash<QString, QByteArray> PluginSigner::loadTrustedKeys(const QString &path)
{
    QHash<QString, QByteArray> out;
    const QString p = path.isEmpty() ? trustedKeysPath() : path;
    QFile f(p);
    if (!f.open(QIODevice::ReadOnly))
        return out; // no trusted keys yet
    const QByteArray raw = f.readAll();
    f.close();

    QJsonParseError perr{};
    const QJsonDocument doc = QJsonDocument::fromJson(raw, &perr);
    if (perr.error != QJsonParseError::NoError || !doc.isObject())
        return out;
    const QJsonObject keys = doc.object().value(QStringLiteral("keys")).toObject();
    for (auto it = keys.constBegin(); it != keys.constEnd(); ++it) {
        // value may be a bare base64 string or an object {pubkey,name}.
        QString b64;
        if (it.value().isString())
            b64 = it.value().toString();
        else if (it.value().isObject())
            b64 = it.value().toObject().value(QStringLiteral("pubkey")).toString();
        const QByteArray pk = QByteArray::fromBase64(b64.toLatin1());
        if (pk.size() == crypto_sign_PUBLICKEYBYTES)
            out.insert(it.key(), pk);
    }
    return out;
}

bool PluginSigner::addTrustedKey(const QByteArray &pubkey, const QString &name,
                                 const QString &path)
{
    if (pubkey.size() != crypto_sign_PUBLICKEYBYTES)
        return false;
    const QString p = path.isEmpty() ? trustedKeysPath() : path;
    QDir().mkpath(QFileInfo(p).absolutePath());

    // Read-modify-write the keys object so we don't clobber other publishers.
    QJsonObject keys;
    {
        QFile f(p);
        if (f.open(QIODevice::ReadOnly)) {
            const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
            f.close();
            if (doc.isObject())
                keys = doc.object().value(QStringLiteral("keys")).toObject();
        }
    }
    QJsonObject entry;
    entry.insert(QStringLiteral("pubkey"), QString::fromLatin1(pubkey.toBase64()));
    if (!name.isEmpty())
        entry.insert(QStringLiteral("name"), name);
    keys.insert(keyIdFor(pubkey), entry);

    QJsonObject root;
    root.insert(QStringLiteral("keys"), keys);

    QSaveFile f(p);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    if (!f.commit())
        return false;
    QFile::setPermissions(p, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    return true;
}

VerifyResult PluginSigner::verify(const PluginManifest &m,
                                  const QString &payloadSha256Hex,
                                  const QHash<QString, QByteArray> &trustedKeys)
{
    VerifyResult r;
    r.permissions = m.permissions;

    if (m.signature.isEmpty()) {
        r.error = QStringLiteral("manifest is unsigned");
        return r;
    }
    r.signaturePresent = true;

    auto tok = parseSignature(m.signature);
    if (!tok) {
        r.error = QStringLiteral("malformed signature token");
        return r;
    }
    r.keyId = tok->keyId;

    const auto it = trustedKeys.find(tok->keyId);
    if (it == trustedKeys.end()) {
        r.error = QStringLiteral("signing key not trusted: ") + tok->keyId;
        // Still report whether the signature is self-consistent? We cannot —
        // without the pubkey we can't check. Leave signatureValid=false.
        return r;
    }
    r.keyTrusted = true;

    const QByteArray &pubkey = it.value();
    const QByteArray canon = canonicalString(m, payloadSha256Hex);
    const bool ok =
        crypto_sign_verify_detached(
            reinterpret_cast<const unsigned char *>(tok->sig.constData()),
            reinterpret_cast<const unsigned char *>(canon.constData()),
            static_cast<unsigned long long>(canon.size()),
            reinterpret_cast<const unsigned char *>(pubkey.constData())) == 0;
    r.signatureValid = ok;
    r.verified = ok;
    if (!ok)
        r.error = QStringLiteral("signature does not verify (tampered manifest/payload)");
    return r;
}

VerifyResult PluginSigner::verifyPackageDir(const QString &packageDir,
                                            const QString &trustedKeysPathOverride)
{
    VerifyResult r;
    const QString manifestPath =
        QDir(packageDir).filePath(QStringLiteral("jarvis-plugin.toml"));
    QFile f(manifestPath);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        r.error = QStringLiteral("cannot open jarvis-plugin.toml in ") + packageDir;
        return r;
    }
    const QString text = QString::fromUtf8(f.readAll());
    f.close();
    auto man = PluginRegistry::parseManifest(text);
    if (!man) {
        r.error = QStringLiteral("jarvis-plugin.toml has no id");
        return r;
    }
    const QString payloadHash = hashPayloadDir(packageDir);
    const QHash<QString, QByteArray> trusted = loadTrustedKeys(trustedKeysPathOverride);
    return verify(*man, payloadHash, trusted);
}

} // namespace jarvis
