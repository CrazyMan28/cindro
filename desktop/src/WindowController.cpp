#include "WindowController.h"

#include <QQuickWindow>
#include <QWindow>
#include <QScreen>
#include <QGuiApplication>
#include <QRect>
#include <QSize>
#include <QRegion>
#include <QSettings>
#include <QDebug>

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
void WindowController::configureOverlay(QObject *overlayWin,
                                        const QString &screenName, int screenIndex)
{
    auto *win = qobject_cast<QQuickWindow *>(overlayWin);
    if (!win)
        return;
    // Resolve the real QScreen for THIS overlay and pin the QWindow to it BEFORE
    // create(), so each output gets its own layer-shell surface (banner + glow on
    // every monitor). Match by name first (stable across reconnects), else fall
    // back to the screen index. The QML `screen:` binding alone does NOT move the
    // window — it silently no-ops because the QML screen wrapper isn't a QScreen*,
    // which left every overlay stacked on the primary output.
    const QList<QScreen *> screens = QGuiApplication::screens();
    QScreen *target = nullptr;
    if (!screenName.isEmpty()) {
        for (QScreen *s : screens) {
            if (s->name() == screenName) { target = s; break; }
        }
    }
    if (!target && screenIndex >= 0 && screenIndex < screens.size())
        target = screens.at(screenIndex);
    if (target)
        win->setScreen(target);
    m_overlay = win;

    win->create();

    auto *w = LayerShellQt::Window::get(win);
    const QString outName = target ? target->name() : QStringLiteral("<default>");
    const QRect outGeo = target ? target->geometry() : win->geometry();
    if (!w) {
        qInfo().noquote() << "[jarvis-overlay] FAILED to obtain layer-shell surface for output"
                          << outName;
        return;
    }
    // Pin the layer surface to its OUTPUT explicitly (the current LayerShellQt API).
    // QWindow::screen() is unreliable for a not-yet-shown window (it returns the
    // PRIMARY), so the old ScreenFromQWindow stacked every surface on one monitor.
    if (target)
        w->setScreen(target);
    qInfo().noquote() << "[jarvis-overlay] layer-shell OVERLAY surface on output"
                      << outName << "geometry" << outGeo;

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
    // GRAB THE KEYBOARD while driving so the user's Esc reaches the QML
    // Keys.onEscapePressed handler in DrivingOverlay.qml and STOPS the take-over.
    // This was previously KeyboardInteractivityNone because the OnDemand grab on the
    // OLD single-seat setup STOLE the agent's typed text (it landed in the overlay
    // instead of the window the agent clicked). That no longer applies: the agent now
    // types on a SEPARATE compositor seat (the KWin fork's "jarvis" seat), so giving
    // the overlay the USER's keyboard does not touch the agent's input. The overlay
    // only exists while driving (Main.qml's Instantiator is active: bridge.driving),
    // so this exclusive keyboard grab is inherently scoped to the driving session.
    //
    // KEYBOARD vs POINTER are independent protocol concerns here: keyboard focus for a
    // layer surface is governed by zwlr_layer_surface_v1.set_keyboard_interactivity
    // (Exclusive => the compositor routes keys to this surface), while pointer
    // hit-testing is governed by the wl_surface input region. So we can grab the
    // keyboard AND keep the pointer fully click-through at the same time.
    w->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityExclusive);

    // Pointer click-through (UNCHANGED): WindowTransparentForInput sets an EMPTY
    // wl_surface input region at the protocol level, so the mouse passes straight
    // through to the real desktop and the overlay NEVER eats the agent's or the user's
    // clicks. The empty input region affects POINTER only; the exclusive keyboard grab
    // above still delivers Esc to the QML Keys handler. (The banner MouseArea is now
    // cosmetic for clicks while driving — Esc is the live stop path.)
    win->setFlag(Qt::WindowTransparentForInput, true);

    // Show NOW — AFTER the layer-shell role is installed. The QML delegate keeps
    // the window hidden (visible:false) precisely so this is the first map; showing
    // earlier makes it a normal xdg-toplevel (one output, single virtual desktop).
    // A true layer-shell OVERLAY maps on its pinned output and on ALL desktops.
    win->show();
    // Nudge the compositor to hand this surface keyboard focus now (the layer-shell
    // Exclusive interactivity grants it; this just makes Esc land immediately on the
    // first map). Pointer stays click-through via the empty input region above.
    win->requestActivate();
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
    // Request keyboard focus so the Esc key is routed here (Exclusive keyboard
    // interactivity grabs it while driving). Pointer events still pass through via the
    // empty input region.
    m_overlay->requestActivate();
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

void WindowController::present()
{
    // Raise + focus the currently-mapped window so a new session's chat surfaces.
    // Mirrors the raise/requestActivate path in applyMode for each surface.
    if (m_mode == QStringLiteral("hidden")) {
        // Nothing is mapped — re-dock so there is a window to raise.
        applyMode(QStringLiteral("dock"), /*persist=*/false);
        return;
    }
    if (m_mode == QStringLiteral("dock") && m_dock) {
        m_dock->show();
        m_dock->raise();
        m_dock->requestActivate();
    } else if (m_float) {
        // Preserve the user's window size. present() runs on EVERY new session, so
        // forcing Windowed here would "shrink" a Maximized/FullScreen window every
        // time. Only un-minimize/un-hide; otherwise just raise + focus in place.
        const QWindow::Visibility vis = m_float->visibility();
        if (vis == QWindow::Hidden || vis == QWindow::Minimized)
            m_float->setVisibility(QWindow::Windowed);
        m_float->raise();
        m_float->requestActivate();
    }
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
