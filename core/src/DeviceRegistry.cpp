#include "jarvis/DeviceRegistry.h"
#include "jarvis/Config.h"

#include <sodium.h>

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

namespace jarvis {

QJsonObject DeviceRow::toJson() const
{
    // pubkey is deliberately NOT serialized to control clients.
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("paired_at"), pairedAt);
    o.insert(QStringLiteral("last_seen"), lastSeen);
    return o;
}

QString DeviceRegistry::devicesFilePath()
{
    return Config::configDir() + QStringLiteral("/devices.json");
}

QString DeviceRegistry::identityFilePath()
{
    return Config::configDir() + QStringLiteral("/identity.key");
}

QString DeviceRegistry::fingerprintFor(const QByteArray &pubkey)
{
    const QByteArray hash =
        QCryptographicHash::hash(pubkey, QCryptographicHash::Sha256).toHex();
    return QString::fromLatin1(hash.left(16));
}

QString DeviceRegistry::identityPublicKeyB64() const
{
    return QString::fromLatin1(m_identityPk.toBase64());
}

QString DeviceRegistry::identityFingerprint() const
{
    if (m_identityPk.isEmpty())
        return QString();
    return fingerprintFor(m_identityPk);
}

void DeviceRegistry::load()
{
    ensureIdentity();

    m_devices.clear();
    QFile f(devicesFilePath());
    if (!f.open(QIODevice::ReadOnly))
        return; // no file yet => empty registry (not an error)

    const QByteArray raw = f.readAll();
    f.close();

    QJsonParseError perr{};
    const QJsonDocument doc = QJsonDocument::fromJson(raw, &perr);
    if (perr.error != QJsonParseError::NoError || !doc.isObject())
        return;

    const QJsonArray arr = doc.object().value(QStringLiteral("devices")).toArray();
    for (const QJsonValue &v : arr) {
        const QJsonObject o = v.toObject();
        DeviceRow r;
        r.id = o.value(QStringLiteral("id")).toString();
        r.name = o.value(QStringLiteral("name")).toString();
        r.pubkey = QByteArray::fromBase64(
            o.value(QStringLiteral("pubkey")).toString().toLatin1());
        r.pairedAt = qint64(o.value(QStringLiteral("paired_at")).toDouble());
        r.lastSeen = qint64(o.value(QStringLiteral("last_seen")).toDouble());
        if (!r.id.isEmpty() && r.pubkey.size() == crypto_sign_PUBLICKEYBYTES)
            m_devices.push_back(r);
    }
}

void DeviceRegistry::ensureIdentity()
{
    const QString path = identityFilePath();

    // Make sure ~/.config/jarvis exists.
    const QFileInfo fi(path);
    QDir dir = fi.absoluteDir();
    if (!dir.exists())
        dir.mkpath(QStringLiteral("."));

    // Reuse an existing identity (pk[32] || sk[64], base64 on a single line).
    if (QFile::exists(path)) {
        QFile f(path);
        if (f.open(QIODevice::ReadOnly)) {
            const QByteArray blob = QByteArray::fromBase64(f.readAll().trimmed());
            f.close();
            if (blob.size() == crypto_sign_PUBLICKEYBYTES + crypto_sign_SECRETKEYBYTES) {
                m_identityPk = blob.left(crypto_sign_PUBLICKEYBYTES);
                m_identitySk = blob.mid(crypto_sign_PUBLICKEYBYTES);
                return;
            }
        }
    }

    // Generate a fresh ed25519 identity keypair and persist it (0600).
    unsigned char pk[crypto_sign_PUBLICKEYBYTES];
    unsigned char sk[crypto_sign_SECRETKEYBYTES];
    crypto_sign_keypair(pk, sk);
    m_identityPk = QByteArray(reinterpret_cast<const char *>(pk), sizeof(pk));
    m_identitySk = QByteArray(reinterpret_cast<const char *>(sk), sizeof(sk));

    QByteArray blob = m_identityPk + m_identitySk;
    QSaveFile f(path);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        f.write(blob.toBase64());
        // Commit before chmod so the file exists at `path`.
        if (f.commit())
            QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    }
    // Wipe the secret-key copy held in the temporary blob.
    sodium_memzero(blob.data(), size_t(blob.size()));
}

std::optional<DeviceRow> DeviceRegistry::get(const QString &id) const
{
    for (const DeviceRow &r : m_devices) {
        if (r.id == id)
            return r;
    }
    return std::nullopt;
}

DeviceRow DeviceRegistry::pair(const QByteArray &pubkey, const QString &name)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const QString id = fingerprintFor(pubkey);

    // Re-pairing an existing device updates its key/name and re-stamps.
    for (DeviceRow &r : m_devices) {
        if (r.id == id) {
            r.pubkey = pubkey;
            if (!name.isEmpty())
                r.name = name;
            r.pairedAt = now;
            r.lastSeen = now;
            persist();
            return r;
        }
    }

    DeviceRow r;
    r.id = id;
    r.name = name.isEmpty() ? QStringLiteral("device") : name;
    r.pubkey = pubkey;
    r.pairedAt = now;
    r.lastSeen = now;
    m_devices.push_back(r);
    persist();
    return r;
}

bool DeviceRegistry::revoke(const QString &id)
{
    for (int i = 0; i < m_devices.size(); ++i) {
        if (m_devices[i].id == id) {
            m_devices.remove(i);
            persist();
            return true;
        }
    }
    return false;
}

void DeviceRegistry::touch(const QString &id)
{
    for (DeviceRow &r : m_devices) {
        if (r.id == id) {
            r.lastSeen = QDateTime::currentMSecsSinceEpoch();
            persist();
            return;
        }
    }
}

bool DeviceRegistry::verify(const QString &deviceId, const QByteArray &message,
                            const QByteArray &signature) const
{
    auto row = get(deviceId);
    if (!row)
        return false;
    if (row->pubkey.size() != crypto_sign_PUBLICKEYBYTES)
        return false;
    if (signature.size() != crypto_sign_BYTES)
        return false;
    return crypto_sign_verify_detached(
               reinterpret_cast<const unsigned char *>(signature.constData()),
               reinterpret_cast<const unsigned char *>(message.constData()),
               static_cast<unsigned long long>(message.size()),
               reinterpret_cast<const unsigned char *>(row->pubkey.constData())) == 0;
}

bool DeviceRegistry::persist()
{
    QJsonArray arr;
    for (const DeviceRow &r : m_devices) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), r.id);
        o.insert(QStringLiteral("name"), r.name);
        o.insert(QStringLiteral("pubkey"), QString::fromLatin1(r.pubkey.toBase64()));
        o.insert(QStringLiteral("paired_at"), r.pairedAt);
        o.insert(QStringLiteral("last_seen"), r.lastSeen);
        arr.append(o);
    }
    QJsonObject root;
    root.insert(QStringLiteral("devices"), arr);

    const QString path = devicesFilePath();
    QDir().mkpath(QFileInfo(path).absolutePath());

    QSaveFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_lastError = QStringLiteral("cannot open devices.json for write: ") + f.errorString();
        return false;
    }
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    if (!f.commit()) {
        m_lastError = QStringLiteral("cannot commit devices.json: ") + f.errorString();
        return false;
    }
    QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    return true;
}

} // namespace jarvis
