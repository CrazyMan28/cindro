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
    // Take-over overlay preview: boot straight into the driving overlay with a
    // FAKE agent pointer looping, for screenshot / visual verification.
    QCommandLineOption drivingDemoOpt(QStringLiteral("driving-demo"),
                                      QStringLiteral("Show the take-over overlay with a fake agent pointer."));
    parser.addOption(drivingDemoOpt);
    // Start straight on the Voice Mode page (the plasmoid's "Voice Mode" button
    // launches `jarvis-sidebar --voice`).
    QCommandLineOption voiceOpt(QStringLiteral("voice"),
                                QStringLiteral("Open the app on the Voice Mode page."));
    parser.addOption(voiceOpt);
    // CI/integration test: load the full UI (offscreen), verify it renders, then
    // exit 0. The QML load failing already exits non-zero (rootObjects empty); a
    // crash within the settle window also fails. Used by the `gui_selftest` ctest.
    QCommandLineOption selftestOpt(QStringLiteral("selftest"),
                                   QStringLiteral("Load the UI, verify it renders, then exit."));
    parser.addOption(selftestOpt);
    parser.process(app);

    if (parser.isSet(toggleOpt)) {
        // If another instance is up, toggle it and quit. Otherwise fall through and show.
        if (sendToggleToRunningInstance())
            return 0;
    }

    // Become the singleton instance owner. Remove any stale socket first.
    auto *server = new QLocalServer(&app);
    if (!parser.isSet(selftestOpt)) {
        // A --selftest run must NOT hijack a running instance's singleton socket.
        QLocalServer::removeServer(QString::fromLatin1(kIpcName));
        server->listen(QString::fromLatin1(kIpcName));
    }

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

    // --voice: AppShell reads this context property in Component.onCompleted to
    // boot onto the Voice Mode page.
    engine.rootContext()->setContextProperty(QStringLiteral("startOnVoice"),
                                              parser.isSet(voiceOpt));

    // WindowController is QML_SINGLETON; register the concrete instance so C++
    // and QML share one object that survives engine teardown order.
    auto *windowController = new WindowController(&app);
    qmlRegisterSingletonInstance("JarvisSidebar", 1, 0, "WindowController", windowController);

    engine.loadFromModule(QStringLiteral("JarvisSidebar"), QStringLiteral("Main"));
    if (engine.rootObjects().isEmpty())
        return -1;

    // --selftest: the UI loaded with a non-empty root tree. Let it settle (so
    // Component.onCompleted across all pages runs and any load-time error surfaces),
    // then exit 0. A crash in that window fails the test.
    if (parser.isSet(selftestOpt)) {
        QTimer::singleShot(2000, &app, []() {
            qInfo("jarvis-sidebar selftest: UI rendered OK");
            QCoreApplication::exit(0);
        });
        return app.exec();
    }

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

    // --driving-demo: arm the take-over overlay with a fake agent pointer so the
    // overlay can be rendered/verified without a live take-over. Deferred until
    // after the QML tree is up so Main.qml's onDrivingChanged maps the overlay.
    if (parser.isSet(drivingDemoOpt))
        QTimer::singleShot(0, bridge, &Bridge::startDrivingDemo);

    return app.exec();
}
