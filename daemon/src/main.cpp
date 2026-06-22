// jarvisd — the headless Jarvis daemon.
//
// Responsibilities (Workflow #1):
//   - ensure ~/.config/jarvis exists,
//   - load config.toml (or defaults),
//   - ensure a 0600 control_token (32 random bytes hex via libsodium),
//   - serve the Contract A control WebSocket on 127.0.0.1:<control_port>.

#include "ControlServer.h"
#include "DeviceServer.h"

#include "jarvis/Config.h"

#include <sodium.h>

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QLoggingCategory>

#include <cstdio>

namespace {

// Read an existing control token, or generate + persist a fresh one (0600).
// Returns the token, or an empty string on unrecoverable I/O error.
QString ensureControlToken()
{
    const QString path = jarvis::Config::controlTokenPath();
    const QFileInfo fi(path);

    // Make sure ~/.config/jarvis exists.
    QDir dir = fi.absoluteDir();
    if (!dir.exists())
        dir.mkpath(QStringLiteral("."));

    // Reuse an existing non-empty token.
    if (QFile::exists(path)) {
        QFile f(path);
        if (f.open(QIODevice::ReadOnly)) {
            const QByteArray existing = f.readAll().trimmed();
            f.close();
            if (!existing.isEmpty())
                return QString::fromLatin1(existing);
        }
    }

    // Generate 32 random bytes, hex-encode.
    unsigned char buf[32];
    randombytes_buf(buf, sizeof(buf));
    const QByteArray token = QByteArray(reinterpret_cast<const char *>(buf), sizeof(buf)).toHex();

    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        std::fprintf(stderr, "jarvisd: cannot write control token to %s\n", qPrintable(path));
        return QString();
    }
    f.write(token);
    f.close();
    // Restrict to owner read/write (0600).
    QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);

    return QString::fromLatin1(token);
}

} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("jarvisd"));
    QCoreApplication::setOrganizationName(QStringLiteral("jarvis"));

    if (sodium_init() < 0) {
        std::fprintf(stderr, "jarvisd: libsodium init failed\n");
        return 1;
    }

    // Ensure config dir + load config.
    QDir().mkpath(jarvis::Config::configDir());
    const jarvis::Config config = jarvis::Config::load();

    const QString token = ensureControlToken();
    if (token.isEmpty()) {
        std::fprintf(stderr, "jarvisd: failed to obtain control token\n");
        return 1;
    }

    auto *server = new jarvis::ControlServer(config, token, &app);
    if (!server->start()) {
        std::fprintf(stderr, "jarvisd: %s\n", qPrintable(server->lastError()));
        return 1;
    }

    std::fprintf(stderr,
                 "jarvisd: control WS listening on ws://127.0.0.1:%d/control/ws\n",
                 config.controlPort);

    // Contract C: the device channel (phone). Reuses the ControlServer's shared
    // session/store/registry machinery. A bind failure here is non-fatal — the
    // control WS (desktop) keeps working — but is logged.
    auto *deviceServer = new jarvis::DeviceServer(config, server, &app);
    if (!deviceServer->start()) {
        std::fprintf(stderr, "jarvisd: device WS not started: %s\n",
                     qPrintable(deviceServer->lastError()));
    } else {
        std::fprintf(stderr,
                     "jarvisd: device WS listening on ws://%s:%d/device/ws\n",
                     qPrintable(jarvis::ControlServer::tailnetHost()),
                     config.devicePort);
    }

    return app.exec();
}
