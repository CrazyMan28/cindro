#pragma once

// windows/shell/WindowController.h — the Windows window controller.
//
// It exposes the EXACT SAME public interface (properties, Q_INVOKABLEs, the
// modeChanged signal, QML_ELEMENT + QML_SINGLETON) as desktop/src/WindowController.h
// so the shared, read-only QML (desktop/qml/*), the read-only Bridge, and the
// copied windows/shell/main.cpp all drive it unchanged. The Linux version is a
// wlr-layer-shell controller (LayerShellQt); this one uses ONLY portable Qt + Win32:
//
//   * "float" / "dock" are both normal top-level QQuickWindows. dock() anchors the
//     window to the right edge of the current screen's work area (the Windows
//     analogue of the layer-shell sidebar); float() centers a normal window.
//   * A system-tray icon (Win32 Shell_NotifyIcon) + a global show/hide hotkey
//     (Ctrl+Alt+J via RegisterHotKey) toggle the app. Both are serviced through a
//     QAbstractNativeEventFilter on the GUI thread — no QtWidgets dependency.
//   * The driving overlay is a transparent, click-through, top-most layered window
//     (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST) — a minimal compiling
//     implementation; the agent-cursor glow is drawn by the same shared QML.
//
// Same class name + signature surface => byte-identical call sites; the Linux and
// Windows controllers are selected purely by the include path in their builds.

#include <QAbstractNativeEventFilter>
#include <QObject>
#include <QPointer>
#include <QString>
#include <QtQml/qqmlregistration.h>

class QQuickWindow;

class WindowController : public QObject, public QAbstractNativeEventFilter
{
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

    // "float" | "dock"  (the persisted/current mode). "hidden" is transient.
    Q_PROPERTY(QString mode READ mode NOTIFY modeChanged)
    Q_PROPERTY(bool docked READ docked NOTIFY modeChanged)
    Q_PROPERTY(QString initialMode READ initialMode CONSTANT)
    Q_PROPERTY(int dockWidth READ dockWidth CONSTANT)

public:
    explicit WindowController(QObject *parent = nullptr);
    ~WindowController() override;

    QString mode() const { return m_mode; }
    bool docked() const { return m_mode == QStringLiteral("dock"); }
    QString initialMode() const { return m_initialMode; }
    int dockWidth() const { return m_dockWidth; }

    // Register the two QML windows (called once from QML Component.onCompleted).
    Q_INVOKABLE void registerWindows(QObject *floatWin, QObject *dockWin);

    // ---- driving overlay (transparent, click-through, top-most) -------------
    // screenName/screenIndex pin the surface to a monitor (matched by name first,
    // then index) so the multi-monitor call sites in the shared QML work as-is.
    Q_INVOKABLE void configureOverlay(QObject *overlayWin,
                                      const QString &screenName = QString(),
                                      int screenIndex = -1);
    Q_INVOKABLE void showOverlay();
    Q_INVOKABLE void hideOverlay();

    // Raise + focus whichever window is currently mapped (used by session.opened).
    Q_INVOKABLE void present();

    // Switch to the right-anchored sidebar / back to the floating window / hide it.
    Q_INVOKABLE void dock();
    Q_INVOKABLE void undock();
    Q_INVOKABLE void hideDock();

    // QAbstractNativeEventFilter: services the global hotkey (WM_HOTKEY) and the
    // tray-icon callback message on the GUI thread.
    bool nativeEventFilter(const QByteArray &eventType, void *message,
                           qintptr *result) override;

signals:
    void modeChanged();

private:
    void applyMode(const QString &mode, bool persist);
    void anchorDockToRight(QQuickWindow *win);   // right-edge geometry for "dock"
    void centerFloat(QQuickWindow *win);         // centered geometry for "float"

    // Tray + global hotkey (Win32). installTray() needs a mapped window's HWND as
    // the callback target, so it is wired after registerWindows().
    void installTray();
    void removeTray();
    void installHotkey();
    void removeHotkey();
    // Toggle visibility from the hotkey / a tray click.
    void toggleVisibility();

    QPointer<QQuickWindow> m_float;
    QPointer<QQuickWindow> m_dock;
    QPointer<QQuickWindow> m_overlay;

    QString m_mode;          // current mode
    QString m_initialMode;   // mode loaded from QSettings at construction
    const int m_dockWidth = 540;

    bool m_trayInstalled = false;
    bool m_hotkeyInstalled = false;
};
