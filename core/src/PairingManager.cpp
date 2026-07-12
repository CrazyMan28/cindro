#include "jarvis/PairingManager.h"

#include <qrencode.h>

#include <QJsonObject>
#include <QRandomGenerator>
#include <QTextStream>

namespace jarvis {

QJsonObject PairingCode::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("code"), code);
    o.insert(QStringLiteral("payload"), payload);
    o.insert(QStringLiteral("qr_svg"), qrSvg);
    o.insert(QStringLiteral("expires_at"), expiresAt);
    return o;
}

QString PairingManager::genCode()
{
    // Uniform 000000..999999, zero-padded to 6 digits.
    const quint32 n = QRandomGenerator::system()->bounded(1000000u);
    return QStringLiteral("%1").arg(n, 6, 10, QLatin1Char('0'));
}

void PairingManager::prune()
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    for (int i = m_codes.size() - 1; i >= 0; --i) {
        if (m_codes[i].expiresAt <= now)
            m_codes.remove(i);
    }
}

PairingCode PairingManager::start(const QString &host, const QString &fp, qint64 ttlMs)
{
    prune();

    PairingCode pc;
    // Avoid an accidental clash with a still-active code.
    do {
        pc.code = genCode();
    } while (isValid(pc.code));

    pc.expiresAt = QDateTime::currentMSecsSinceEpoch() + ttlMs;
    pc.payload = QStringLiteral("jarvis://pair?host=%1&code=%2&fp=%3")
                     .arg(host, pc.code, fp);
    pc.qrSvg = renderQrSvg(pc.payload);

    m_codes.push_back(pc);
    return pc;
}

bool PairingManager::isValid(const QString &code)
{
    prune();
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    for (const PairingCode &pc : m_codes) {
        if (pc.code == code && pc.expiresAt > now)
            return true;
    }
    return false;
}

bool PairingManager::consume(const QString &code)
{
    prune();
    const qint64 now = QDateTime::currentMSecsSinceEpoch();

    // In a brute-force cooldown: refuse fast (no per-attempt delay to amplify),
    // treating every attempt as a failure until the window elapses.
    if (m_cooldownUntil > now)
        return false;

    for (int i = 0; i < m_codes.size(); ++i) {
        if (m_codes[i].code == code && m_codes[i].expiresAt > now) {
            m_codes.remove(i);
            m_failCount = 0; // a legitimate success resets the throttle
            return true;
        }
    }

    // Failure. Once past the threshold, drop all pending codes and open a short
    // cooldown. This is a purely non-blocking counter+timestamp gate — never
    // sleep here: consume() runs on the daemon's single Qt event-loop thread, so
    // a blocking delay would freeze every client (a trivially-triggerable DoS).
    if (++m_failCount >= kMaxFailedAttempts) {
        m_codes.clear();
        m_cooldownUntil = now + kCooldownMs;
        m_failCount = 0;
    }
    return false;
}

QString PairingManager::renderQrSvg(const QString &payload)
{
    QRcode *qr = QRcode_encodeString(payload.toUtf8().constData(), 0,
                                     QR_ECLEVEL_M, QR_MODE_8, /*casesensitive=*/1);
    if (!qr)
        return QString();

    const int n = qr->width;          // modules per side
    const int quiet = 4;              // quiet-zone modules (spec recommends >=4)
    const int total = n + 2 * quiet;  // logical viewBox size in modules

    QString svg;
    QTextStream out(&svg);
    out << "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 "
        << total << ' ' << total << "\" shape-rendering=\"crispEdges\">";
    // White background (includes quiet zone).
    out << "<rect width=\"" << total << "\" height=\"" << total
        << "\" fill=\"#ffffff\"/>";
    // Black modules: emit one 1x1 rect per dark module.
    out << "<path fill=\"#000000\" d=\"";
    for (int y = 0; y < n; ++y) {
        for (int x = 0; x < n; ++x) {
            // The least-significant bit of each byte marks a dark module.
            if (qr->data[y * n + x] & 1)
                out << 'M' << (x + quiet) << ' ' << (y + quiet) << "h1v1h-1z";
        }
    }
    out << "\"/></svg>";

    QRcode_free(qr);
    return svg;
}

} // namespace jarvis
