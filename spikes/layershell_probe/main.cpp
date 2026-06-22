#include <QGuiApplication>
#include <QQuickView>
#include <QUrl>
#include <QTimer>
#include <LayerShellQt/Shell>
#include <LayerShellQt/Window>

int main(int argc, char **argv) {
    QGuiApplication app(argc, argv);
    LayerShellQt::Shell::useLayerShell();

    QQuickView view;
    view.setResizeMode(QQuickView::SizeRootObjectToView);
    view.resize(420, 900);

    if (auto *w = LayerShellQt::Window::get(&view)) {
        LayerShellQt::Window::Anchors anchors;
        anchors |= LayerShellQt::Window::AnchorTop;
        anchors |= LayerShellQt::Window::AnchorRight;
        anchors |= LayerShellQt::Window::AnchorBottom;
        w->setLayer(LayerShellQt::Window::LayerTop);
        w->setAnchors(anchors);
        w->setExclusiveZone(420);
        w->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityOnDemand);
        w->setScope("jarvis-probe");
    }

    view.setSource(QUrl::fromLocalFile(
        "/home/user/projects/computer_use/spikes/layershell_probe/main.qml"));
    view.show();

    QTimer::singleShot(300000, &app, &QGuiApplication::quit);
    return app.exec();
}
