pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Window
import QtQuick.Layouts
import JarvisSidebar

// StandaloneWidget — a "popped out" generative widget hosted in its OWN frameless,
// always-on-top desktop Window (NOT layer-shell, so it stays a normal movable
// window). It renders exactly ONE WidgetRenderer for a {id,title,spec} and live-
// updates: when a widgetRendered() record with the SAME id arrives, it swaps its
// node so updates flow to the popped-out copy too. On Wayland/KWin the
// WindowStaysOnTopHint maps to the xdg-toplevel "above" state.
//
// Window lifetime is owned by QML (Main.qml's Instantiator over a ListModel),
// mirroring the driving-overlay Instantiator-of-Window precedent. `closed` is
// emitted on the close button so the host removes this row from its model.
Window {
    id: win

    // The popped-out widget identity + content (fed by the Instantiator delegate).
    property string widgetId: ""
    property string widgetTitle: ""
    property var widgetSpec: ({})

    signal closed()

    flags: Qt.Window | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
    color: "transparent"
    title: widgetTitle.length > 0 ? widgetTitle : "Cindro widget"
    visible: true

    // A popped-out live widget is a VIEWER: hold a lease while this window is open
    // so its live job keeps updating even when the Canvas tab isn't visible, and
    // release it on close so the job can idle (battery).
    Component.onCompleted: {
        if (bridge && widgetId.length > 0)
            bridge.addWidgetViewer("widget:" + widgetId, "popout")
    }
    Component.onDestruction: {
        if (bridge && widgetId.length > 0)
            bridge.removeWidgetViewer("widget:" + widgetId)
    }

    // Size to the rendered content's implicit size plus the chrome (drag strip +
    // padding). Clamp so a huge/empty spec still yields a sane window.
    readonly property int chromeH: 34
    readonly property int padding: 14
    width: Math.max(180, Math.min(900, renderer.implicitWidth + padding * 2))
    height: Math.max(120, Math.min(900, renderer.implicitHeight + chromeH + padding * 2))

    // Live update: when the model re-renders the SAME id, swap the node so the
    // popped-out copy updates in lock-step with the in-app card.
    Connections {
        target: bridge
        function onWidgetRendered(widget) {
            var id = widget.id !== undefined ? ("" + widget.id) : ""
            if (id.length > 0 && id === win.widgetId) {
                win.widgetTitle = widget.title !== undefined ? ("" + widget.title) : win.widgetTitle
                win.widgetSpec = widget.spec !== undefined ? widget.spec : win.widgetSpec
            }
        }
    }

    Rectangle {
        anchors.fill: parent
        radius: Theme.radius
        color: Theme.panel
        border.width: 1
        border.color: Theme.hairline

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: win.padding
            spacing: 8

            // ---- drag strip + title + close --------------------------------
            RowLayout {
                Layout.fillWidth: true
                Layout.preferredHeight: 20
                spacing: 8

                // Drag handle: startSystemMove on press (normal movable window).
                MouseArea {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    cursorShape: Qt.SizeAllCursor
                    onPressed: win.startSystemMove()
                    Text {
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        text: win.widgetTitle.length > 0 ? win.widgetTitle : "widget"
                        color: Theme.text
                        font.family: Theme.fontDisplay
                        font.pixelSize: 12
                        font.weight: Font.DemiBold
                        font.letterSpacing: Theme.trackTight
                    }
                }

                // Close -> emit closed() so the host Instantiator drops this row.
                Rectangle {
                    Layout.preferredWidth: 20
                    Layout.preferredHeight: 20
                    radius: Theme.radiusXs
                    color: closeArea.containsMouse ? Theme.surface : "transparent"
                    border.width: 1
                    border.color: closeArea.containsMouse ? Theme.hairline : "transparent"
                    Text {
                        anchors.centerIn: parent
                        text: "✕"
                        color: closeArea.containsMouse ? Theme.accentBright : Theme.textMuted
                        font.pixelSize: 12
                    }
                    MouseArea {
                        id: closeArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: win.closed()
                    }
                }
            }

            // ---- the one widget --------------------------------------------
            WidgetRenderer {
                id: renderer
                Layout.fillWidth: true
                node: win.widgetSpec
                // A button inside a popped-out widget routes its action straight at
                // the bridge (no chat panel in this standalone window).
                onActionRequested: function(action) {
                    if (!action || typeof action !== "object")
                        return
                    if (typeof action.send === "string" && action.send.length > 0)
                        bridge.sendMessage(action.send)
                    else if (typeof action.skill === "string" && action.skill.length > 0)
                        bridge.skillInvoke(action.skill,
                                           (typeof action.args === "string") ? action.args : "")
                }
            }
        }
    }
}
