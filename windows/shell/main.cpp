// windows/shell/main.cpp — Windows COPY of desktop/src/main.cpp, edited (not
// byte-identical): two Windows-only additions layered on the shared body — a
// MessageBoxW surfaced when QML fails to load (a silent exit on Windows looks
// like nothing happened) and a forced windowController->present() on first
// launch (belt-and-suspenders in case the QML onCompleted show path hiccuped).
// It is compiled INSTEAD of the original on Windows via include-path
// precedence: windows/shell/ is searched BEFORE desktop/src/, so #include
// "WindowController.h" resolves to the Windows controller (tray + global hotkey,
// no LayerShellQt) while "Bridge.h"/"FrameProvider.h" still resolve to the shared,
// read-only desktop sources. The Linux original is never edited.

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
    parser.setApplicationDescription(QStringLiteral("Orin desktop app"));
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
    // --shot <path>: render the UI, grab the window to a PNG, then exit. Works under
    // QT_QPA_PLATFORM=offscreen (like --selftest) so it can capture the GUI even on a
    // locked/headless screen where wlr screencopy isn't available.
    QCommandLineOption shotOpt(QStringLiteral("shot"),
                               QStringLiteral("Render the UI, save a PNG to <path>, then exit."),
                               QStringLiteral("path"));
    parser.addOption(shotOpt);
    // --page <n>: start on a specific NavRail page index (for screenshots/testing).
    QCommandLineOption pageOpt(QStringLiteral("page"),
                               QStringLiteral("Start on page index <n>."),
                               QStringLiteral("n"), QStringLiteral("-1"));
    parser.addOption(pageOpt);
    QCommandLineOption peekOpt(QStringLiteral("peek"),
                               QStringLiteral("Open the chat agent-peek panel (screenshots)."));
    parser.addOption(peekOpt);
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
    // --page <n>: AppShell reads this and jumps there on load (-1 = leave default).
    engine.rootContext()->setContextProperty(QStringLiteral("startPage"),
                                              parser.value(pageOpt).toInt());
    engine.rootContext()->setContextProperty(QStringLiteral("startPeek"),
                                              parser.isSet(peekOpt));

    // WindowController is QML_SINGLETON; register the concrete instance so C++
    // and QML share one object that survives engine teardown order.
    auto *windowController = new WindowController(&app);
    qmlRegisterSingletonInstance("JarvisSidebar", 1, 0, "WindowController", windowController);

    engine.loadFromModule(QStringLiteral("JarvisSidebar"), QStringLiteral("Main"));
    if (engine.rootObjects().isEmpty()) {
        // Windows: a silent exit looks like "nothing happened". Surface it.
        // (windows.h / MessageBoxW come from the force-included posix_compat.h.)
        ::MessageBoxW(nullptr,
            L"Orin UI failed to load (QML).\n\nThis usually means a missing Qt "
            L"plugin/DLL next to jarvis-sidebar.exe. Please report it.",
            L"Orin", MB_OK | MB_ICONERROR);
        return -1;
    }

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

    // --shot: float the panel, let it settle, grab the float window to a PNG, exit.
    if (parser.isSet(shotOpt)) {
        const QString shotPath = parser.value(shotOpt);
        QTimer::singleShot(2600, &app, [&engine, windowController, shotPath]() {
            // Force the shared panel into the FLOAT window (otherwise it may be in
            // the dock window, which is unmapped offscreen → an empty grab).
            QMetaObject::invokeMethod(windowController, "undock");
            QQuickWindow *win = nullptr;
            for (QObject *o : engine.rootObjects()) {
                if (auto *w = qobject_cast<QQuickWindow *>(o)) {
                    if (o->objectName() == QStringLiteral("floatWin")) { win = w; break; }
                    if (!win) win = w;
                }
            }
            if (win) {
                // Render at a desktop width so screenshots represent the docked/wide
                // app (the float window is a narrow sidebar).
                win->resize(1180, 760);
                win->setVisible(true);
            }
            QTimer::singleShot(900, qApp, [win, shotPath]() {
                if (win) {
                    const QImage img = win->grabWindow();
                    if (!img.isNull() && img.save(shotPath))
                        qInfo("jarvis-sidebar shot saved: %s (%dx%d)",
                              qPrintable(shotPath), img.width(), img.height());
                    else
                        qWarning("jarvis-sidebar shot: grab/save failed");
                } else {
                    qWarning("jarvis-sidebar shot: no window found");
                }
                QCoreApplication::exit(0);
            });
        });
        return app.exec();
    }

    // IPC toggle: hide the active surface if it's visible; otherwise re-show the
    // current mode via the controller (which knows float vs dock).
    QObject::connect(server, &QLocalServer::newConnection, &app,
                     [server, windowController, bridge]() {
        QLocalSocket *conn = server->nextPendingConnection();
        if (!conn)
            return;
        QObject::connect(conn, &QLocalSocket::readyRead, conn, [conn, windowController, bridge]() {
            const QByteArray cmd = conn->readAll().trimmed();
            if (cmd == "toggle") {
                if (windowController->mode() == QStringLiteral("hidden")) {
                    windowController->dock();
                    bridge->requestNewChat();   // opening Orin -> fresh chat
                } else if (windowController->docked()) {
                    windowController->hideDock();
                } else {
                    windowController->undock(); // re-show floating
                    bridge->requestNewChat();   // opening Orin -> fresh chat
                }
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

    // Windows: force-show the window on first launch (belt-and-suspenders in case
    // the QML onCompleted show path hiccuped) so the GUI always appears.
    QTimer::singleShot(0, windowController, [windowController]() {
        windowController->present();
    });

    return app.exec();
}
