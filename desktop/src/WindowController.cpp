#include "WindowController.h"

#include <QQuickWindow>
#include <QWindow>
#include <QScreen>
#include <QRect>
#include <QSize>
#include <QRegion>
#include <QSettings>

#include <LayerShellQt/Window>

WindowController::WindowController(QObject *parent)
    : QObject(parent)
{
    QSettings s;
    m_initialMode = s.value(QStringLiteral("window/mode"), QStringLiteral("float")).toString();
    if (m_initialMode != QStringLiteral("dock"))
        m_initialMode = QStringLiteral("float");
    m_mode = m_initialMode;
}

void WindowController::registerWindows(QObject *floatWin, QObject *dockWin)
{
    m_float = qobject_cast<QQuickWindow *>(floatWin);
    m_dock = qobject_cast<QQuickWindow *>(dockWin);
    // QML applies the initial mode explicitly after this (so its modeChanged
    // handler is connected and the shared panel mounts into the right window).
}

// Install the wlr-layer-shell role on the dock window. Must run before the
// surface is first shown. Follows spikes/RESULTS.md exactly: no useLayerShell();
// accumulate Anchors with |=; LayerTop; anchor Top|Right|Bottom;
// exclusiveZone=width; scope "jarvis-sidebar"; KeyboardInteractivityOnDemand.
void WindowController::configureDockSurface()
{
    if (m_dockConfigured || !m_dock)
        return;

    // The QPlatformWindow must exist before LayerShellQt can wrap it.
    m_dock->create();

    auto *w = LayerShellQt::Window::get(m_dock);
    if (!w)
        return;

    LayerShellQt::Window::Anchors anchors;
    anchors |= LayerShellQt::Window::AnchorTop;
    anchors |= LayerShellQt::Window::AnchorRight;
    anchors |= LayerShellQt::Window::AnchorBottom;

    w->setLayer(LayerShellQt::Window::LayerTop);
    w->setAnchors(anchors);
    w->setExclusiveZone(m_dockWidth);
    w->setScope(QStringLiteral("jarvis-sidebar"));
    w->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityOnDemand);

    m_dockConfigured = true;
}

// Install the wlr-layer-shell OVERLAY role on the distinct-cursor window. It is a
// full-screen, input-transparent surface that draws the agent cursor + the
// "JARVIS IS DRIVING" banner ON TOP of everything while a real-screen take-over
// is live. Per the spike: no useLayerShell(); accumulate Anchors with |=. Crucial
// difference from the dock: LayerOverlay, exclusiveZone 0 (reserves no space),
// KeyboardInteractivityNone, and an EMPTY input region (QWindow::setMask with an
// empty QRegion) so it NEVER steals pointer/keyboard input from the real desktop.
void WindowController::configureOverlay(QObject *overlayWin)
{
    if (!m_overlay)
        m_overlay = qobject_cast<QQuickWindow *>(overlayWin);
    if (m_overlayConfigured || !m_overlay)
        return;

    m_overlay->create();

    auto *w = LayerShellQt::Window::get(m_overlay);
    if (!w)
        return;

    // Anchor to all four edges so the surface spans the whole output.
    LayerShellQt::Window::Anchors anchors;
    anchors |= LayerShellQt::Window::AnchorTop;
    anchors |= LayerShellQt::Window::AnchorRight;
    anchors |= LayerShellQt::Window::AnchorBottom;
    anchors |= LayerShellQt::Window::AnchorLeft;

    w->setLayer(LayerShellQt::Window::LayerOverlay);
    w->setAnchors(anchors);
    w->setExclusiveZone(0);   // reserve NO space — float above the desktop
    w->setScope(QStringLiteral("jarvis-driving-overlay"));
    w->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityNone);

    // Empty input region => fully click-through. On Wayland, setMask sets the
    // surface input region; an empty region means no input is ever delivered here.
    m_overlay->setFlag(Qt::WindowTransparentForInput, true);
    m_overlay->setMask(QRegion());

    m_overlayConfigured = true;
}

void WindowController::showOverlay()
{
    if (!m_overlay)
        return;
    configureOverlay(m_overlay);
    m_overlay->show();
    // Re-assert the empty input region after the surface maps (some compositors
    // reset the input region on (re)map).
    m_overlay->setMask(QRegion());
    m_overlay->raise();
}

void WindowController::hideOverlay()
{
    if (m_overlay)
        m_overlay->hide();
}

void WindowController::applyMode(const QString &mode, bool persist)
{
    if (mode == QStringLiteral("dock")) {
        if (m_float)
            m_float->hide();
        configureDockSurface();
        if (m_dock) {
            m_dock->show();
            m_dock->raise();
            m_dock->requestActivate();
        }
        m_mode = QStringLiteral("dock");
    } else if (mode == QStringLiteral("hidden")) {
        // Unmap the sidebar; releasing the exclusive zone lets tiled windows reflow.
        if (m_dock)
            m_dock->hide();
        m_mode = QStringLiteral("hidden");
        persist = false; // never persist the transient hidden state
    } else { // float
        if (m_dock)
            m_dock->hide();
        if (m_float) {
            // Force a windowed (non-maximized) state at the intended size; some
            // KWin placements maximize a frameless toplevel on first map.
            m_float->setVisibility(QWindow::Windowed);

            // LAUNCH PLACEMENT: open FULLY on-screen, centered within the CURRENT
            // output's available work area, clamped so the whole window fits. If
            // the window is taller than the work area, shrink its height to fit.
            int fw = 620, fh = 880;
            QRect geo(0, 0, fw, fh);
            if (QScreen *scr = m_float->screen()) {
                const QRect avail = scr->availableGeometry();
                // Shrink to fit the work area (leave a small margin so chrome/edges
                // are never clipped).
                fw = qMin(fw, avail.width());
                fh = qMin(fh, avail.height());
                geo.setSize(QSize(fw, fh));

                // Center, then clamp so x>=workX, y>=workY and the far edges stay
                // inside the work area.
                int x = avail.x() + (avail.width() - fw) / 2;
                int y = avail.y() + (avail.height() - fh) / 2;
                x = qBound(avail.x(), x, avail.x() + avail.width() - fw);
                y = qBound(avail.y(), y, avail.y() + avail.height() - fh);
                geo.moveTo(x, y);
            }
            m_float->setMinimumSize(QSize(380, qMin(520, fh)));
            m_float->setMaximumSize(QSize(16777215, 16777215));
            m_float->setGeometry(geo);
            m_float->show();
            // Re-assert geometry after the surface maps (KWin may override on map).
            QMetaObject::invokeMethod(m_float, [w = m_float, geo]() {
                if (w) {
                    w->setVisibility(QWindow::Windowed);
                    w->setGeometry(geo);
                }
            }, Qt::QueuedConnection);
            m_float->raise();
            m_float->requestActivate();
        }
        m_mode = QStringLiteral("float");
    }

    if (persist) {
        QSettings s;
        s.setValue(QStringLiteral("window/mode"), m_mode);
    }
    emit modeChanged();
}

void WindowController::dock()
{
    applyMode(QStringLiteral("dock"), /*persist=*/true);
}

void WindowController::undock()
{
    applyMode(QStringLiteral("float"), /*persist=*/true);
}

void WindowController::hideDock()
{
    applyMode(QStringLiteral("hidden"), /*persist=*/false);
}
