#pragma once

// AuthChallengeStore — in-memory, short-lived "unlock challenges" for the 2FA +
// fingerprint cross-device unlock (FEATURE: phone POSSESSION+TAP + BIOMETRIC).
//
// auth.request mints a challenge here (TTL ~120s); the daemon FCM-pushes paired
// phones with {kind:"auth", challenge_id}. The phone opens an Approve screen,
// runs BiometricPrompt, and on success calls auth.approve{challenge_id} over its
// already-authed device WS (device WS auth = ed25519 challenge/response = factor
// "possession"; BiometricPrompt on the phone = factor "biometric"). The daemon
// flips the challenge to "approved" and the desktop lock-gate unlocks.
//
// This type is pure logic (no Qt signals, no sockets) so a unit test can drive
// the whole lifecycle — create / approve / expire / deny — without a daemon.

#include <QJsonObject>
#include <QString>
#include <QVector>
#include <optional>

namespace jarvis {

struct AuthChallenge {
    QString id;            // 24 random hex chars (libsodium randombytes)
    qint64 createdAt = 0;  // unix ms
    qint64 expiresAt = 0;  // unix ms
    QString state = QStringLiteral("pending"); // pending|approved|denied|expired
    QString origin = QStringLiteral("desktop"); // desktop|extension
    QString approvedByDevice;                   // device id that approved (if any)

    // {challenge_id,state,expires_at,origin} — never leaks pubkeys/secrets.
    QJsonObject toJson() const;
};

class AuthChallengeStore {
public:
    AuthChallengeStore() = default;

    // Default challenge lifetime.
    static constexpr qint64 kDefaultTtlMs = 120000; // 120s

    // Mint a fresh challenge (id = 24 random hex, state="pending"). `origin` tags
    // where the gate lives ("desktop"|"extension") so the phone can show context.
    AuthChallenge create(qint64 ttlMs = kDefaultTtlMs,
                         const QString &origin = QStringLiteral("desktop"));

    // Prunes-on-read: if a challenge is pending and now>expiresAt, it flips to
    // "expired" before returning. Unknown ids yield std::nullopt.
    std::optional<AuthChallenge> get(const QString &id);

    // Approve only if the challenge is currently pending AND unexpired; sets
    // state="approved" + approvedByDevice and returns true. False otherwise
    // (unknown / already-decided / expired).
    bool approve(const QString &id, const QString &deviceId);

    // Deny only a still-pending challenge (pending->denied). False otherwise.
    bool deny(const QString &id);

    // Sweep expired pending challenges (flip to "expired").
    void prune();

    // {challenge_id,state,expires_at}. An UNKNOWN id reports state="expired" so
    // callers never leak whether a given challenge ever existed.
    QJsonObject statusJson(const QString &id);

private:
    static QString genId(); // 24 random hex chars (libsodium randombytes)

    QVector<AuthChallenge> m_challenges;
};

} // namespace jarvis
