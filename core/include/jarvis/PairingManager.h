#pragma once

// PairingManager — short-lived 6-digit pairing codes for the device channel.
//
// devices.pair_start (Contract A v2, surfaced in desktop Settings) asks for a
// fresh code; the manager mints a 6-digit code with a TTL, builds the
// `jarvis://pair?...` payload (host = tailnet-ip:devicePort, code, daemon fp)
// and renders that payload to an inline SVG QR via libqrencode. When a device
// connects to /device/ws and presents a matching, unexpired code, the daemon
// asks consume() — which removes the code so it is single-use.

#include <QDateTime>
#include <QString>
#include <QVector>

namespace jarvis {

struct PairingCode {
    QString code;        // 6 digits
    QString payload;     // jarvis://pair?host=..&code=..&fp=..
    QString qrSvg;       // inline <svg> of the payload
    qint64 expiresAt = 0; // unix ms

    QJsonObject toJson() const; // {code,payload,qr_svg,expires_at}
};

class PairingManager {
public:
    PairingManager() = default;

    // Default code lifetime.
    static constexpr qint64 kDefaultTtlMs = 5 * 60 * 1000; // 5 minutes

    // Mint a fresh pairing code. `host` is the tailnet endpoint the phone should
    // dial (e.g. "100.x.y.z:8796"); `fp` is the daemon identity fingerprint.
    PairingCode start(const QString &host, const QString &fp,
                      qint64 ttlMs = kDefaultTtlMs);

    // True if `code` is currently active (exists and not expired). Prunes
    // expired entries as a side effect.
    bool isValid(const QString &code);

    // Single-use: validate AND remove the code. Returns true if it was valid.
    bool consume(const QString &code);

    // Render any payload string to an inline SVG QR (libqrencode). Public so
    // tests can exercise it directly. Returns an empty string on failure.
    static QString renderQrSvg(const QString &payload);

private:
    void prune();
    static QString genCode(); // 6 random digits

    QVector<PairingCode> m_codes;

    // Brute-force throttle shared across BOTH pairing channels (device hello +
    // /control/pair): consecutive failed consume() attempts. Past the threshold
    // every pending code is dropped and a short cooldown refuses further attempts,
    // so the tiny window a guessed 6-digit code could be redeemed slams shut. A
    // single correct first attempt never trips this (success resets the counter).
    static constexpr int kMaxFailedAttempts = 5;
    static constexpr qint64 kCooldownMs = 30 * 1000; // 30s
    int m_failCount = 0;
    qint64 m_cooldownUntil = 0; // epoch ms; > now => in cooldown
};

} // namespace jarvis
