#include "jarvis/AuthChallengeStore.h"

#include <sodium.h>

#include <QDateTime>

namespace jarvis {

QJsonObject AuthChallenge::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("challenge_id"), id);
    o.insert(QStringLiteral("state"), state);
    o.insert(QStringLiteral("expires_at"), expiresAt);
    o.insert(QStringLiteral("origin"), origin);
    return o;
}

QString AuthChallengeStore::genId()
{
    // 12 random bytes -> 24 hex chars. Same libsodium randombytes util style as
    // DeviceRegistry/PairingManager (cryptographically strong, never seeded).
    unsigned char buf[12];
    randombytes_buf(buf, sizeof(buf));
    static const char *hex = "0123456789abcdef";
    QString out;
    out.reserve(int(sizeof(buf)) * 2);
    for (unsigned char b : buf) {
        out.append(QLatin1Char(hex[b >> 4]));
        out.append(QLatin1Char(hex[b & 0x0F]));
    }
    return out;
}

void AuthChallengeStore::prune()
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    for (AuthChallenge &c : m_challenges) {
        if (c.state == QStringLiteral("pending") && now > c.expiresAt)
            c.state = QStringLiteral("expired");
    }
}

AuthChallenge AuthChallengeStore::create(qint64 ttlMs, const QString &origin)
{
    AuthChallenge c;
    // Avoid an accidental clash with a still-live challenge.
    do {
        c.id = genId();
    } while ([&] {
        for (const AuthChallenge &e : m_challenges)
            if (e.id == c.id)
                return true;
        return false;
    }());

    c.createdAt = QDateTime::currentMSecsSinceEpoch();
    c.expiresAt = c.createdAt + ttlMs;
    c.state = QStringLiteral("pending");
    c.origin = origin.isEmpty() ? QStringLiteral("desktop") : origin;

    m_challenges.push_back(c);
    return c;
}

std::optional<AuthChallenge> AuthChallengeStore::get(const QString &id)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    for (AuthChallenge &c : m_challenges) {
        if (c.id != id)
            continue;
        // Prune-on-read: a pending-but-expired challenge reports "expired".
        if (c.state == QStringLiteral("pending") && now > c.expiresAt)
            c.state = QStringLiteral("expired");
        return c;
    }
    return std::nullopt;
}

bool AuthChallengeStore::approve(const QString &id, const QString &deviceId)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    for (AuthChallenge &c : m_challenges) {
        if (c.id != id)
            continue;
        if (c.state != QStringLiteral("pending"))
            return false; // already approved/denied/expired
        if (now > c.expiresAt) {
            c.state = QStringLiteral("expired");
            return false;
        }
        c.state = QStringLiteral("approved");
        c.approvedByDevice = deviceId;
        return true;
    }
    return false;
}

bool AuthChallengeStore::deny(const QString &id)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    for (AuthChallenge &c : m_challenges) {
        if (c.id != id)
            continue;
        if (c.state != QStringLiteral("pending"))
            return false;
        if (now > c.expiresAt) {
            c.state = QStringLiteral("expired");
            return false;
        }
        c.state = QStringLiteral("denied");
        return true;
    }
    return false;
}

QJsonObject AuthChallengeStore::statusJson(const QString &id)
{
    const std::optional<AuthChallenge> c = get(id);
    QJsonObject o;
    o.insert(QStringLiteral("challenge_id"), id);
    if (c) {
        o.insert(QStringLiteral("state"), c->state);
        o.insert(QStringLiteral("expires_at"), c->expiresAt);
    } else {
        // Unknown id: report "expired" so callers never leak existence.
        o.insert(QStringLiteral("state"), QStringLiteral("expired"));
        o.insert(QStringLiteral("expires_at"), qint64(0));
    }
    return o;
}

} // namespace jarvis
