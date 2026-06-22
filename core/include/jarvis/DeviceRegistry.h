#pragma once

// DeviceRegistry — Contract C paired-device store + daemon ed25519 identity.
//
// Paired phones are persisted in ~/.config/jarvis/devices.json (mode 0600).
// Each entry records the device's ed25519 public key (base64), a human name,
// when it paired and when it was last seen. The daemon itself owns a long-lived
// ed25519 identity keypair persisted in ~/.config/jarvis/identity.key (0600);
// its public-key fingerprint (fp) is surfaced in the pairing payload/QR so the
// phone can pin the daemon it talks to.
//
// All signature verification uses libsodium crypto_sign_verify_detached over
// the stored device public key (Contract C handshake challenge/response).

#include <QByteArray>
#include <QDateTime>
#include <QString>
#include <QVector>
#include <optional>

namespace jarvis {

struct DeviceRow {
    QString id;            // stable device id (fp of the device pubkey)
    QString name;          // human label sent by the device at hello
    QByteArray pubkey;     // raw ed25519 public key (32 bytes)
    qint64 pairedAt = 0;   // unix ms
    qint64 lastSeen = 0;   // unix ms

    // {id,name,paired_at,last_seen} — pubkey is NOT echoed to control clients.
    QJsonObject toJson() const;
};

class DeviceRegistry {
public:
    DeviceRegistry() = default;

    // ~/.config/jarvis/devices.json
    static QString devicesFilePath();
    // ~/.config/jarvis/identity.key (daemon ed25519 secret+public key blob, 0600)
    static QString identityFilePath();

    // Load devices.json + ensure the daemon identity keypair exists (generating
    // and persisting one on first run). Never throws.
    void load();

    // --- daemon identity ---------------------------------------------------
    QByteArray identityPublicKey() const { return m_identityPk; } // 32 raw bytes
    // base64 of the raw public key.
    QString identityPublicKeyB64() const;
    // Short fingerprint of the public key (sha256 -> first 16 hex chars) used as
    // the `fp` in the pairing payload.
    QString identityFingerprint() const;

    // --- device CRUD -------------------------------------------------------
    QVector<DeviceRow> list() const { return m_devices; }
    std::optional<DeviceRow> get(const QString &id) const;
    // Pair (or re-pair) a device by its raw ed25519 public key. Returns the row
    // (id derived from the pubkey fingerprint). Persists devices.json (0600).
    DeviceRow pair(const QByteArray &pubkey, const QString &name);
    // Remove a paired device by id. Returns true if a row was removed.
    bool revoke(const QString &id);
    // Stamp last_seen=now for a device id (persists). No-op if unknown.
    void touch(const QString &id);

    // --- crypto -----------------------------------------------------------
    // Verify a detached ed25519 signature over `message` against the stored
    // public key for `deviceId`. False if the device is unknown or sig is bad.
    bool verify(const QString &deviceId, const QByteArray &message,
                const QByteArray &signature) const;

    // Fingerprint (id) for a raw ed25519 public key: sha256 -> first 16 hex.
    static QString fingerprintFor(const QByteArray &pubkey);

    QString lastError() const { return m_lastError; }

private:
    bool persist();             // write devices.json atomically (0600)
    void ensureIdentity();      // load or generate identity.key (0600)

    QVector<DeviceRow> m_devices;
    QByteArray m_identityPk;     // 32 raw bytes
    QByteArray m_identitySk;     // 64 raw bytes (libsodium secret key)
    QString m_lastError;
};

} // namespace jarvis
