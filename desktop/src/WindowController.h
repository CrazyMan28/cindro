#pragma once

#include <QObject>
#include <QPointer>
#include <QString>
#include <QtQml/qqmlregistration.h>

class QQuickWindow;
class QWindow;

// WindowController: owns the window-mode policy for the Jarvis desktop app.
//
// Two distinct surfaces are used (this is the only reliable way to switch a
// surface's *role* at runtime on KWin/wlroots — a wlr-layer-shell role can only
// be installed before a wl_surface is first committed, and there is no clean way
// to demote a layer surface back to an ordinary xdg-toplevel):
//
//   * floatWin  — a normal, movable/minimizable/resizable xdg-toplevel
//                 (DEFAULT launch mode). QML drives chrome (custom titlebar +
//                 startSystemMove / showMinimized / close).
//   * dockWin   — a right-anchored wlr-layer-shell sidebar. The layer-shell role
//                 is installed by configureDock() exactly once, before its first
//                 show(), per spikes/RESULTS.md.
//
// QML keeps a single content panel and reparents it between the two windows.
// The controller only manages which window is mapped and persists the last mode
// via QSettings so the next launch restores it.
class WindowController : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

    // "float" | "dock"  (the persisted/current mode). "hidden" is transient.
    Q_PROPERTY(QString mode READ mode NOTIFY modeChanged)
    Q_PROPERTY(bool docked READ docked NOTIFY modeChanged)
    // The mode persisted from the previous run; QML reads this once at startup
    // to decide whether to launch floating (default) or docked.
    Q_PROPERTY(QString initialMode READ initialMode CONSTANT)
    // Width used for the layer-shell exclusive zone.
    Q_PROPERTY(int dockWidth READ dockWidth CONSTANT)

public:
    explicit WindowController(QObject *parent = nullptr);

    QString mode() const { return m_mode; }
    bool docked() const { return m_mode == QStringLiteral("dock"); }
    QString initialMode() const { return m_initialMode; }
    int dockWidth() const { return m_dockWidth; }

    // Register the two QML windows (called once from QML Component.onCompleted).
    // Typed as QObject* so moc need not see the full QQuickWindow type here.
    Q_INVOKABLE void registerWindows(QObject *floatWin, QObject *dockWin);

    // ---- distinct-cursor / "JARVIS IS DRIVING" overlay ---------------------
    // Configure a transparent, full-screen, pointer-click-through wlr-layer-shell
    // OVERLAY surface (layer=Overlay, exclusiveZone=0, EXCLUSIVE keyboard interactivity
    // so the user's Esc reaches the QML cancel handler, empty pointer input region so
    // it NEVER steals the mouse). Used while a real-screen take-over is active to draw
    // the agent cursor + banner ON TOP of the user's desktop. The keyboard grab is safe
    // because the agent types on a separate "jarvis" compositor seat.
    // Idempotent; installs the role before the first show().
    // screenName/screenIndex identify which monitor this overlay belongs to. They
    // are passed as plain value types from QML (the QML screen wrapper does NOT
    // cross the C++ boundary as a QScreen*), so we resolve the real QScreen here
    // and pin the surface to it BEFORE create() — one layer-shell surface per
    // output. screenName is matched first; screenIndex is the fallback.
    Q_INVOKABLE void configureOverlay(QObject *overlayWin,
                                      const QString &screenName = QString(),
                                      int screenIndex = -1);
    // Map / unmap the overlay surface (called when bridge.driving flips).
    Q_INVOKABLE void showOverlay();
    Q_INVOKABLE void hideOverlay();

    // Raise + focus whichever window is currently mapped (dock or float). Used by
    // the session.opened flow to surface the new chat. If the app is hidden, dock
    // first so there is something to raise. Reuses the exact raise/requestActivate
    // calls in applyMode.
    Q_INVOKABLE void present();

    // Switch to the right-anchored layer-shell sidebar.
    Q_INVOKABLE void dock();
    // Return to the floating, movable window.
    Q_INVOKABLE void undock();
    // While docked, unmap the sidebar (releasing the exclusive zone so other
    // windows reflow). Re-docking maps it again.
    Q_INVOKABLE void hideDock();

signals:
    void modeChanged();

private:
    void applyMode(const QString &mode, bool persist);
    void configureDockSurface();   // install layer-shell role on dockWin (idempotent)

    QPointer<QQuickWindow> m_float;
    QPointer<QQuickWindow> m_dock;
    QPointer<QQuickWindow> m_overlay;

    QString m_mode;          // current mode
    QString m_initialMode;   // mode loaded from QSettings at construction
    bool m_dockConfigured = false;
    bool m_overlayConfigured = false;
    const int m_dockWidth = 540;
};
