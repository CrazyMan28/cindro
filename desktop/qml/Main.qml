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

    // ---- 2FA + fingerprint cross-device unlock (LockGate) ------------------
    // When `locked`, a LockGate overlay covers BOTH windows' content; the panel
    // stays mounted underneath so unlocking is instant. `locked` is armed from the
    // persisted auth_lock_enabled setting on connect; FAIL-OPEN (no phone paired)
    // is handled INSIDE LockGate (it unlocks immediately).
    property bool locked: false
    property bool authChecked: false

    function applyLock(enabled) {
        // Only arm the gate ONCE per launch (never re-lock mid-session on a
        // settings refresh).
        if (floatWin.authChecked)
            return
        floatWin.authChecked = true
        floatWin.locked = enabled === true
    }

    Connections {
        target: bridge
        function onSettingsLoaded(s) {
            floatWin.applyLock(s.auth_lock_enabled === true)
        }
        function onConnectedChanged() {
            if (bridge.connected)
                bridge.loadSettings()
        }
        // A session was opened (locally from the Sessions page / a subagent click /
        // a remote session.opened broadcast). Navigate the shell to the CHAT page
        // (index 1 — Home is 0) and raise/focus the window so the chat is surfaced.
        // (This used to be 0 = Chat before the Home page was added; that stale 0 sent
        // every session-open to Home — including clicking a subagent.)
        function onSessionOpened(sid) {
            floatWin.panel.currentIndex = 1
            WindowController.present()
        }
        // A foreign session (Chrome/phone/scheduler) opened: ONLY raise the window so
        // the user notices Jarvis. Do NOT switch pages or the active chat — sessions
        // are separate and switched from the Sessions list.
        function onSessionFocusRequested() {
            WindowController.present()
        }
    }

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
        // Pull settings so the LockGate can arm from auth_lock_enabled. (Settings
        // also re-loads on connect via the Connections block above.)
        if (bridge.connected)
            bridge.loadSettings()
        // --voice: jump straight to the Voice Mode page. `startOnVoice` is a
        // context property set in main.cpp; guard with typeof so a normal launch
        // (where it is still defined as false) is unaffected.
        if (typeof startOnVoice !== "undefined" && startOnVoice)
            floatWin.panel.currentIndex = floatWin.panel.voiceIndex
    }

    // ---- distinct-cursor overlay: one per MONITOR, created/destroyed with the
    //  take-over state by the Instantiator below (multi-monitor: the banner +
    //  glow appear on EVERY screen). No manual show/hide needed.

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

        // ---- LockGate overlay (covers the floating window content) ---------
        // Drawn LAST so it covers floatBar + floatContainer. The panel stays
        // mounted underneath, so an unlock is instant. Active only when the FLOAT
        // surface is the one hosting the panel (the dock window has its own gate)
        // so only ONE auth.request fires per launch.
        Loader {
            anchors.fill: parent
            active: floatWin.locked && WindowController.mode !== "dock"
            z: 9999
            sourceComponent: LockGate {
                origin: "desktop"
                onUnlocked: floatWin.locked = false
            }
        }
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

            // ---- LockGate overlay (covers the docked sidebar content) ------
            // Active only when the DOCK surface hosts the panel, so exactly one
            // gate (and one auth.request) is live at a time.
            Loader {
                anchors.fill: parent
                active: floatWin.locked && WindowController.mode === "dock"
                z: 9999
                sourceComponent: LockGate {
                    origin: "desktop"
                    onUnlocked: floatWin.locked = false
                }
            }
        }
    }

    // ====================================================================
    //  DRIVING OVERLAY WINDOW  (full-screen, click-through wlr-layer-shell
    //  OVERLAY; role + empty input region installed in C++ by
    //  WindowController.configureOverlay). Hosts the distinct agent cursor +
    //  "JARVIS IS DRIVING" banner while a real-screen take-over is live.
    // ====================================================================
    //  ONE overlay per monitor: the Instantiator spawns a full-screen,
    //  click-through wlr-layer-shell OVERLAY on EVERY screen while a real-screen
    //  take-over is live, and destroys them all when it ends. Click-through +
    //  Esc-to-cancel are set per-surface in WindowController.configureOverlay.
    Instantiator {
        id: drivingOverlays
        active: bridge.driving
        model: bridge.driving ? Qt.application.screens : 0
        delegate: Window {
            required property var modelData
            required property int index
            objectName: "overlayWin"
            screen: modelData
            width: modelData ? modelData.width : 1920
            height: modelData ? modelData.height : 1080
            // MUST stay hidden until the layer-shell role is installed — showing it
            // first makes it a normal xdg-toplevel (LayerShellQt: "already has a
            // shell integration"), which only maps on one output + is tied to the
            // current virtual desktop. configureOverlay() installs the role THEN
            // shows it, so all monitors get a true all-desktop overlay.
            visible: false
            color: "transparent"
            flags: Qt.FramelessWindowHint
            title: "JARVIS DRIVING"
            // Pass the output NAME + INDEX (plain values) so C++ can resolve the
            // real QScreen and pin this surface to its own monitor.
            Component.onCompleted: WindowController.configureOverlay(
                this, modelData && modelData.name ? modelData.name : "", index)
            // Give the overlay THIS monitor's global virtual-desktop rect so it
            // can map the agent's global pointer to a local position and cull
            // events that belong to another output.
            DrivingOverlay {
                anchors.fill: parent
                screenX: modelData ? modelData.virtualX : 0
                screenY: modelData ? modelData.virtualY : 0
                screenW: modelData ? modelData.width : parent.width
                screenH: modelData ? modelData.height : parent.height
            }
        }
    }

    // ====================================================================
    //  STANDALONE ("popped out") WIDGET WINDOWS
    // ====================================================================
    //  Each "pop out" on the CANVAS page routes through Bridge::popOutWidget,
    //  which emits spawnStandaloneWidget({id,title,spec}). We append it here and
    //  an Instantiator spawns a StandaloneWidget Window per row — exactly the
    //  driving-overlay Instantiator-of-Window precedent. Closing a window removes
    //  its row (and so destroys the Window).
    ListModel { id: standaloneWidgetModel }

    Connections {
        target: bridge
        function onSpawnStandaloneWidget(w) {
            standaloneWidgetModel.append({
                "widgetId": w.id !== undefined ? ("" + w.id) : "",
                "widgetTitle": w.title !== undefined ? ("" + w.title) : "",
                "widgetSpec": w.spec !== undefined ? w.spec : ({})
            })
        }
    }

    Instantiator {
        id: standaloneWidgets
        model: standaloneWidgetModel
        delegate: StandaloneWidget {
            required property int index
            required property var model
            widgetId: model.widgetId
            widgetTitle: model.widgetTitle
            widgetSpec: model.widgetSpec
            onClosed: standaloneWidgetModel.remove(index)
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
