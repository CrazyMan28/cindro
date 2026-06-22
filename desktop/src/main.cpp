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
#include <QList>

#include <LayerShellQt/Window>

#include "Bridge.h"

namespace {

constexpr auto kIpcName = "jarvis-sidebar";

// Apply the proven LayerShellQt configuration to the QQuickWindow.
// Follows spikes/RESULTS.md exactly: no useLayerShell(); accumulate Anchors with |=;
// LayerTop; anchor Top|Right|Bottom; exclusiveZone=width; KeyboardInteractivityOnDemand;
// scope "jarvis-sidebar".
void configureLayerShell(QWindow *window, int width)
{
    auto *w = LayerShellQt::Window::get(window);
    if (!w)
        return;

    LayerShellQt::Window::Anchors anchors;
    anchors |= LayerShellQt::Window::AnchorTop;
    anchors |= LayerShellQt::Window::AnchorRight;
    anchors |= LayerShellQt::Window::AnchorBottom;

    w->setLayer(LayerShellQt::Window::LayerTop);
    w->setAnchors(anchors);
    w->setExclusiveZone(width);
    w->setScope(QStringLiteral("jarvis-sidebar"));
    w->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityOnDemand);
}

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

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("Jarvis sidebar (LayerShellQt)"));
    parser.addHelpOption();
    QCommandLineOption toggleOpt(QStringLiteral("toggle"),
                                 QStringLiteral("Toggle a running instance, else show."));
    parser.addOption(toggleOpt);
    parser.process(app);

    const int sidebarWidth = 460;

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

    // Register/expose the Bridge as a context property (also QML_ELEMENT registered).
    auto *bridge = new Bridge(&app);
    engine.rootContext()->setContextProperty(QStringLiteral("bridge"), bridge);

    // The window MUST be turned into a wlr-layer-shell surface BEFORE it is first
    // mapped, otherwise the compositor maps it as an ordinary xdg-toplevel and it
    // ends up a floating window (the bug this fixes). Main.qml therefore declares
    // `visible: false`; here — on a DIRECT connection so it runs synchronously
    // during loadFromModule(), before the event loop ever maps the surface — we:
    //   1. create the QPlatformWindow (LayerShellQt::Window::get needs it),
    //   2. install + configure the layer-shell role (anchors/layer/zone/scope),
    //   3. only then make the window visible so it maps as a layer surface.
    QObject::connect(
        &engine, &QQmlApplicationEngine::objectCreated, &app,
        [sidebarWidth](QObject *obj, const QUrl &) {
            auto *window = qobject_cast<QQuickWindow *>(obj);
            if (!window)
                return;
            // The QPlatformWindow must exist before LayerShellQt can wrap it,
            // and the layer-shell role must be set before the first show().
            window->create();
            configureLayerShell(window, sidebarWidth);
            window->show();
        },
        Qt::DirectConnection);

    engine.loadFromModule(QStringLiteral("JarvisSidebar"), QStringLiteral("Main"));
    if (engine.rootObjects().isEmpty())
        return -1;

    // Wire the IPC toggle: hide if visible, show+raise otherwise.
    QObject::connect(server, &QLocalServer::newConnection, &app, [server, &engine]() {
        QLocalSocket *conn = server->nextPendingConnection();
        if (!conn)
            return;
        QObject::connect(conn, &QLocalSocket::readyRead, conn, [conn, &engine]() {
            const QByteArray cmd = conn->readAll().trimmed();
            if (cmd == "toggle" && !engine.rootObjects().isEmpty()) {
                if (auto *win = qobject_cast<QQuickWindow *>(engine.rootObjects().first())) {
                    if (win->isVisible()) {
                        win->hide();
                    } else {
                        win->show();
                        win->raise();
                        win->requestActivate();
                    }
                }
            }
            conn->disconnectFromServer();
        });
        QObject::connect(conn, &QLocalSocket::disconnected, conn, &QLocalSocket::deleteLater);
    });

    // Kick off the control connection once the event loop is running.
    QTimer::singleShot(0, bridge, &Bridge::connectToDaemon);

    return app.exec();
}
