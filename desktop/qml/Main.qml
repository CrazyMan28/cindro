import QtQuick
import QtQuick.Window
import QtQuick.Controls.Basic
import JarvisSidebar

// Root = the FLOATING window (default launch mode): a frameless, MOVABLE /
// MINIMIZABLE / RESIZABLE xdg-toplevel. A custom titlebar drives
// startSystemMove / showMinimized / close. The DOCK window (right-anchored
// wlr-layer-shell sidebar; role installed in C++ by WindowController) is a child
// Window declared below.
//
// ONE shared JarvisPanel (chat state + bridge wiring) is reparented between the
// two windows' containers so the conversation survives dock/undock.
Window {
    id: floatWin
    objectName: "floatWin"
    width: 620
    height: 880
    minimumWidth: 520
    minimumHeight: 560
    visible: false               // shown by WindowController per persisted mode
    color: "transparent"
    title: "JARVIS"
    flags: Qt.Window | Qt.FramelessWindowHint

    // ---- the one shared content panel (initially parented to floatContainer) ----
    // AppShell wraps the NavRail + all five pages (Chat hosts the existing
    // JarvisPanel). One instance, reparented between the two windows so all page
    // state (incl. the live chat transcript) survives dock/undock.
    property AppShell panel: AppShell { parent: floatContainer }

    // Reparent the panel into a container and bind its geometry there.
    function mountInto(container) {
        panel.parent = container
        panel.x = 0
        panel.y = 0
        panel.width = Qt.binding(function() { return container.width })
        panel.height = Qt.binding(function() { return container.height })
        panel.visible = true
    }

    function applyInitialMode() {
        if (WindowController.initialMode === "dock")
            WindowController.dock()
        else
            WindowController.undock()
    }

    Connections {
        target: WindowController
        function onModeChanged() {
            if (WindowController.mode === "dock")
                floatWin.mountInto(dockContainer)
            else if (WindowController.mode === "float")
                floatWin.mountInto(floatContainer)
            // "hidden": panel stays in dockContainer; the dock window is unmapped
        }
    }

    // Register both windows once the tree is up, then apply the persisted mode.
    // The driving overlay is configured lazily the first time it's needed.
    Component.onCompleted: {
        WindowController.registerWindows(floatWin, dockWin)
        applyInitialMode()
    }

    // ---- distinct-cursor overlay: show/hide it as the take-over state flips --
    Connections {
        target: bridge
        function onDrivingChanged() {
            if (bridge.driving) {
                WindowController.configureOverlay(overlayWin)
                WindowController.showOverlay()
            } else {
                WindowController.hideOverlay()
            }
        }
    }

    // ---- Floating shell -----------------------------------------------------
    Rectangle {
        id: floatShell
        anchors.fill: parent
        radius: Theme.radius + 2
        antialiasing: true
        color: Theme.bgDeep
        border.width: 1
        // neon magenta->cyan->violet edge accent via gradient border emulation
        border.color: Theme.hairline
        clip: true

        // ambient HUD layer (gradient + hex + scanlines + corner blooms)
        HudFx {
            anchors.fill: parent
            dense: true
        }

        TitleBar {
            id: floatBar
            win: floatWin
            dockedSurface: false
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.topMargin: 4
            anchors.leftMargin: 2
            anchors.rightMargin: 2
            onRequestClose: floatWin.close()
        }

        Item {
            id: floatContainer
            anchors.top: floatBar.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
        }

        ResizeGrip { window: floatWin }
    }

    // ====================================================================
    //  DOCK WINDOW  (wlr-layer-shell sidebar — role installed in C++)
    // ====================================================================
    Window {
        id: dockWin
        objectName: "dockWin"
        width: WindowController.dockWidth
        height: 1080
        visible: false
        color: "transparent"
        title: "JARVIS"

        Rectangle {
            anchors.fill: parent
            color: Theme.bgDeep
            clip: true

            // ambient HUD layer
            HudFx {
                anchors.fill: parent
                dense: true
            }

            // left accent rail — neon energy seam where the dock meets the edge
            Rectangle {
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: 2
                gradient: Gradient {
                    GradientStop { position: 0.0; color: Theme.magenta }
                    GradientStop { position: 0.5; color: Theme.accent }
                    GradientStop { position: 1.0; color: Theme.violet }
                }
                opacity: 0.7
            }

            TitleBar {
                id: dockBar
                win: dockWin
                dockedSurface: true
                anchors.top: parent.top
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.topMargin: 4
                anchors.leftMargin: 8
                anchors.rightMargin: 2
                onRequestClose: dockWin.close()
            }

            Item {
                id: dockContainer
                anchors.top: dockBar.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
            }
        }
    }

    // ====================================================================
    //  DRIVING OVERLAY WINDOW  (full-screen, click-through wlr-layer-shell
    //  OVERLAY; role + empty input region installed in C++ by
    //  WindowController.configureOverlay). Hosts the distinct agent cursor +
    //  "JARVIS IS DRIVING" banner while a real-screen take-over is live.
    // ====================================================================
    Window {
        id: overlayWin
        objectName: "overlayWin"
        width: 1920
        height: 1080
        visible: false
        color: "transparent"
        // NOTE: NOT Qt.WindowTransparentForInput — pointer click-through is done
        // via the EMPTY input region set in WindowController.configureOverlay, so
        // the surface can still receive the Esc key for take-over cancel.
        flags: Qt.FramelessWindowHint
        title: "JARVIS DRIVING"

        DrivingOverlay {
            anchors.fill: parent
        }
    }

    // ---- bottom-right resize handle (custom; startSystemResize) ------------
    component ResizeGrip: Item {
        required property Window window
        width: 18; height: 18
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: 3
        anchors.bottomMargin: 3
        Canvas {
            anchors.fill: parent
            onPaint: {
                var ctx = getContext("2d")
                ctx.reset()
                ctx.strokeStyle = Theme.textFaint
                ctx.lineWidth = 1.2
                ctx.lineCap = "round"
                for (var i = 0; i < 3; i++) {
                    var o = 5 + i * 4
                    ctx.beginPath()
                    ctx.moveTo(width - 2, height - o)
                    ctx.lineTo(width - o, height - 2)
                    ctx.stroke()
                }
            }
        }
        MouseArea {
            anchors.fill: parent
            cursorShape: Qt.SizeFDiagCursor
            onPressed: window.startSystemResize(Qt.RightEdge | Qt.BottomEdge)
        }
    }
}
