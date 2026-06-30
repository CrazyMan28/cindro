#include "WindowController.h"

#include <QByteArray>
#include <QGuiApplication>
#include <QQuickWindow>
#include <QRect>
#include <QScreen>
#include <QSettings>
#include <QSize>
#include <QWindow>

// <windows.h> (with NOMINMAX/WIN32_LEAN_AND_MEAN) is force-included via
// windows/shell/posix_compat.h for every Windows target; include it explicitly too
// so this file is self-describing and also compiles if the /FI is ever dropped.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN 1
#endif
#ifndef NOMINMAX
#define NOMINMAX 1
#endif
#include <windows.h>
#include <shellapi.h>

namespace {
// Global hotkey id (RegisterHotKey) + the tray callback / tray icon ids.
constexpr int kHotkeyId = 0xB0B1;
constexpr UINT kTrayCallbackMsg = WM_APP + 0x20;
constexpr UINT kTrayIconId = 1;

HWND hwndOf(QQuickWindow *win)
{
    if (!win)
        return nullptr;
    return reinterpret_cast<HWND>(win->winId()); // forces native creation
}
} // namespace

WindowController::WindowController(QObject *parent)
    : QObject(parent)
{
    QSettings s;
    m_initialMode = s.value(QStringLiteral("window/mode"), QStringLiteral("float")).toString();
    if (m_initialMode != QStringLiteral("dock"))
        m_initialMode = QStringLiteral("float");
    m_mode = m_initialMode;

    // Service the global hotkey (WM_HOTKEY) + tray callbacks on the GUI thread.
    qApp->installNativeEventFilter(this);
    installHotkey();
}

WindowController::~WindowController()
{
    removeTray();
    removeHotkey();
    if (qApp)
        qApp->removeNativeEventFilter(this);
}

void WindowController::registerWindows(QObject *floatWin, QObject *dockWin)
{
    m_float = qobject_cast<QQuickWindow *>(floatWin);
    m_dock = qobject_cast<QQuickWindow *>(dockWin);
    // Wire the tray icon now that we have a real window HWND to receive callbacks.
    installTray();
    // QML applies the initial mode explicitly after this (its modeChanged handler
    // is connected and the shared panel mounts into the right window).
}

// Right-edge "sidebar" geometry — the Windows analogue of the layer-shell dock.
void WindowController::anchorDockToRight(QQuickWindow *win)
{
    if (!win)
        return;
    QScreen *scr = win->screen() ? win->screen() : QGuiApplication::primaryScreen();
    if (!scr)
        return;
    const QRect avail = scr->availableGeometry();
    const int w = qMin(m_dockWidth, avail.width());
    win->setMinimumSize(QSize(qMin(380, w), 480));
    win->setMaximumSize(QSize(16777215, 16777215));
    win->setGeometry(QRect(avail.right() - w + 1, avail.top(), w, avail.height()));
}

void WindowController::centerFloat(QQuickWindow *win)
{
    if (!win)
        return;
    int fw = 620, fh = 880;
    QRect geo(0, 0, fw, fh);
    if (QScreen *scr = win->screen() ? win->screen() : QGuiApplication::primaryScreen()) {
        const QRect avail = scr->availableGeometry();
        fw = qMin(fw, avail.width());
        fh = qMin(fh, avail.height());
        geo.setSize(QSize(fw, fh));
        int x = avail.x() + (avail.width() - fw) / 2;
        int y = avail.y() + (avail.height() - fh) / 2;
        x = qBound(avail.x(), x, avail.x() + avail.width() - fw);
        y = qBound(avail.y(), y, avail.y() + avail.height() - fh);
        geo.moveTo(x, y);
    }
    win->setMinimumSize(QSize(380, qMin(520, fh)));
    win->setMaximumSize(QSize(16777215, 16777215));
    win->setGeometry(geo);
}

void WindowController::applyMode(const QString &mode, bool persist)
{
    if (mode == QStringLiteral("dock")) {
        if (m_float)
            m_float->hide();
        if (m_dock) {
            anchorDockToRight(m_dock);
            m_dock->setVisibility(QWindow::Windowed);
            m_dock->show();
            m_dock->raise();
            m_dock->requestActivate();
        }
        m_mode = QStringLiteral("dock");
    } else if (mode == QStringLiteral("hidden")) {
        if (m_dock)
            m_dock->hide();
        if (m_float)
            m_float->hide();
        m_mode = QStringLiteral("hidden");
        persist = false; // never persist the transient hidden state
    } else { // float
        if (m_dock)
            m_dock->hide();
        if (m_float) {
            m_float->setVisibility(QWindow::Windowed);
            centerFloat(m_float);
            m_float->show();
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
    if (m_mode == QStringLiteral("hidden")) {
        applyMode(QStringLiteral("dock"), /*persist=*/false);
        return;
    }
    QQuickWindow *win = (m_mode == QStringLiteral("dock")) ? m_dock.data() : m_float.data();
    if (!win)
        win = m_float ? m_float.data() : m_dock.data();
    if (!win)
        return;
    const QWindow::Visibility vis = win->visibility();
    if (vis == QWindow::Hidden || vis == QWindow::Minimized)
        win->setVisibility(QWindow::Windowed);
    win->show();
    win->raise();
    win->requestActivate();
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

void WindowController::toggleVisibility()
{
    if (m_mode == QStringLiteral("hidden"))
        applyMode(m_initialMode, /*persist=*/false);
    else
        hideDock();
}

// ---- driving overlay -------------------------------------------------------
// Transparent, click-through, always-on-top layered window pinned to one monitor.
// Minimal compiling implementation: the shared DrivingOverlay.qml draws the agent
// cursor + banner; here we only make the native window non-interactive and topmost.
void WindowController::configureOverlay(QObject *overlayWin,
                                        const QString &screenName, int screenIndex)
{
    auto *win = qobject_cast<QQuickWindow *>(overlayWin);
    if (!win)
        return;
    m_overlay = win;

    // Resolve + pin the target monitor (name first, then index) before create().
    const QList<QScreen *> screens = QGuiApplication::screens();
    QScreen *target = nullptr;
    if (!screenName.isEmpty()) {
        for (QScreen *sc : screens) {
            if (sc->name() == screenName) { target = sc; break; }
        }
    }
    if (!target && screenIndex >= 0 && screenIndex < screens.size())
        target = screens.at(screenIndex);
    if (target)
        win->setScreen(target);

    win->setFlags(Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint | Qt::Tool |
                  Qt::WindowDoesNotAcceptFocus);
    win->setColor(Qt::transparent);
    // Qt's own click-through hint (empty input region at the platform level).
    win->setFlag(Qt::WindowTransparentForInput, true);

    const QRect geo = target ? target->geometry() : win->geometry();
    win->setGeometry(geo);
    win->show();

    // Belt-and-suspenders at the Win32 level: layered + transparent (mouse passes
    // through) + topmost + no-activate, so the overlay never steals input.
    if (HWND hwnd = hwndOf(win)) {
        LONG_PTR ex = ::GetWindowLongPtr(hwnd, GWL_EXSTYLE);
        ex |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        ::SetWindowLongPtr(hwnd, GWL_EXSTYLE, ex);
        ::SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                       SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

void WindowController::showOverlay()
{
    if (!m_overlay)
        return;
    configureOverlay(m_overlay);
    m_overlay->show();
    m_overlay->raise();
}

void WindowController::hideOverlay()
{
    if (m_overlay)
        m_overlay->hide();
}

// ---- tray icon (Shell_NotifyIcon) ------------------------------------------
void WindowController::installTray()
{
    if (m_trayInstalled)
        return;
    HWND hwnd = hwndOf(m_float ? m_float.data() : m_dock.data());
    if (!hwnd)
        return;

    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = hwnd;
    nid.uID = kTrayIconId;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    nid.uCallbackMessage = kTrayCallbackMsg;
    nid.hIcon = ::LoadIconW(nullptr, IDI_APPLICATION);
    const wchar_t tip[] = L"Jarvis (Ctrl+Alt+J to toggle)";
    wcsncpy_s(nid.szTip, tip, _TRUNCATE);
    if (::Shell_NotifyIconW(NIM_ADD, &nid))
        m_trayInstalled = true;
}

void WindowController::removeTray()
{
    if (!m_trayInstalled)
        return;
    HWND hwnd = hwndOf(m_float ? m_float.data() : m_dock.data());
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = hwnd;
    nid.uID = kTrayIconId;
    ::Shell_NotifyIconW(NIM_DELETE, &nid);
    m_trayInstalled = false;
}

// ---- global hotkey (Ctrl+Alt+J) --------------------------------------------
void WindowController::installHotkey()
{
    if (m_hotkeyInstalled)
        return;
    // hwnd == NULL => WM_HOTKEY is posted to THIS (GUI) thread's message queue,
    // delivered through Qt's event dispatcher to our nativeEventFilter().
    if (::RegisterHotKey(nullptr, kHotkeyId,
                         MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'J'))
        m_hotkeyInstalled = true;
}

void WindowController::removeHotkey()
{
    if (!m_hotkeyInstalled)
        return;
    ::UnregisterHotKey(nullptr, kHotkeyId);
    m_hotkeyInstalled = false;
}

bool WindowController::nativeEventFilter(const QByteArray &eventType, void *message,
                                         qintptr *result)
{
    Q_UNUSED(result);
    if (eventType != QByteArrayLiteral("windows_generic_MSG"))
        return false;
    auto *msg = static_cast<MSG *>(message);
    if (!msg)
        return false;

    if (msg->message == WM_HOTKEY && static_cast<int>(msg->wParam) == kHotkeyId) {
        toggleVisibility();
        return true;
    }
    if (msg->message == kTrayCallbackMsg) {
        const UINT mouse = LOWORD(msg->lParam);
        if (mouse == WM_LBUTTONUP)
            toggleVisibility();
        else if (mouse == WM_RBUTTONUP || mouse == WM_LBUTTONDBLCLK)
            present();
        return true;
    }
    return false;
}
