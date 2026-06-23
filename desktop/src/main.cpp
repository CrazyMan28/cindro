#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QLocalServer>
#include <QLocalSocket>
#include <QCommandLineParser>
#include <QObject>
#include <QTimer>
#include <QUrl>
#include <QtQml>

#include "Bridge.h"
#include "FrameProvider.h"
#include "WindowController.h"

namespace {

constexpr auto kIpcName = "jarvis-sidebar";

// Best-effort single-instance toggle: if an instance is already listening on the
// local socket, send it a "toggle" line and return true (caller should exit).
bool sendToggleToRunningInstance()
{
    QLocalSocket socket;
    socket.connectToServer(QString::fromLatin1(kIpcName));
    if (!socket.waitForConnected(300))
        return false;
    socket.write("toggle\n");
    socket.flush();
    socket.waitForBytesWritten(300);
    socket.disconnectFromServer();
    return true;
}

} // namespace

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("jarvis-sidebar"));
    app.setOrganizationName(QStringLiteral("jarvis"));
    app.setOrganizationDomain(QStringLiteral("jarvis.local"));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("Jarvis desktop app"));
    parser.addHelpOption();
    QCommandLineOption toggleOpt(QStringLiteral("toggle"),
                                 QStringLiteral("Toggle a running instance, else show."));
    parser.addOption(toggleOpt);
    // Design preview: seeds a sample transcript in QML (read via Qt.application.arguments).
    QCommandLineOption demoOpt(QStringLiteral("demo"),
                               QStringLiteral("Seed sample transcript content (design preview)."));
    parser.addOption(demoOpt);
    parser.process(app);

    if (parser.isSet(toggleOpt)) {
        // If another instance is up, toggle it and quit. Otherwise fall through and show.
        if (sendToggleToRunningInstance())
            return 0;
    }

    // Become the singleton instance owner. Remove any stale socket first.
    QLocalServer::removeServer(QString::fromLatin1(kIpcName));
    auto *server = new QLocalServer(&app);
    server->listen(QString::fromLatin1(kIpcName));

    QQmlApplicationEngine engine;

    // FrameProvider: serves the latest agent-desktop video frame to QML via the
    // "jarvisframe" image provider (COMPUTER page live preview). The engine takes
    // ownership of the provider, so the Bridge only borrows the pointer.
    auto *frameProvider = new FrameProvider();
    engine.addImageProvider(QStringLiteral("jarvisframe"), frameProvider);

    // Bridge (Contract A WS client) — context property + QML_ELEMENT registered.
    auto *bridge = new Bridge(&app);
    bridge->setFrameProvider(frameProvider);
    engine.rootContext()->setContextProperty(QStringLiteral("bridge"), bridge);

    // WindowController is QML_SINGLETON; register the concrete instance so C++
    // and QML share one object that survives engine teardown order.
    auto *windowController = new WindowController(&app);
    qmlRegisterSingletonInstance("JarvisSidebar", 1, 0, "WindowController", windowController);

    engine.loadFromModule(QStringLiteral("JarvisSidebar"), QStringLiteral("Main"));
    if (engine.rootObjects().isEmpty())
        return -1;

    // IPC toggle: hide the active surface if it's visible; otherwise re-show the
    // current mode via the controller (which knows float vs dock).
    QObject::connect(server, &QLocalServer::newConnection, &app,
                     [server, windowController]() {
        QLocalSocket *conn = server->nextPendingConnection();
        if (!conn)
            return;
        QObject::connect(conn, &QLocalSocket::readyRead, conn, [conn, windowController]() {
            const QByteArray cmd = conn->readAll().trimmed();
            if (cmd == "toggle") {
                if (windowController->mode() == QStringLiteral("hidden"))
                    windowController->dock();
                else if (windowController->docked())
                    windowController->hideDock();
                else
                    windowController->undock(); // re-show floating
            }
            conn->disconnectFromServer();
        });
        QObject::connect(conn, &QLocalSocket::disconnected, conn, &QLocalSocket::deleteLater);
    });

    // Kick off the control connection once the event loop is running.
    QTimer::singleShot(0, bridge, &Bridge::connectToDaemon);

    return app.exec();
}
