pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// CANVAS page: model-rendered generative widgets. The model calls the engine's
// render_widget MCP tool, which appends a {ts,title,spec} record to the widgets
// file bus; Bridge polls it and emits widgetRendered(). Each widget renders in a
// card via the safe WidgetRenderer JSON-DSL interpreter (newest on top, capped).
Item {
    id: page

    // Emitted when a widget `action` resolves to a chat "send" — the host
    // (AppShell) routes it through the live chat panel (creating a session if
    // needed) and surfaces the Chat page. If nothing is connected, handleAction()
    // falls back to bridge.sendMessage so the action still fires.
    signal sendChat(string text)

    ListModel { id: widgetModel }
    readonly property int cap: 20

    Connections {
        target: bridge
        function onWidgetRendered(widget) {
            var id = widget.id !== undefined ? ("" + widget.id) : ""
            var row = {
                "ts": widget.ts !== undefined ? widget.ts : 0,
                "title": widget.title !== undefined ? ("" + widget.title) : "",
                "id": id,
                // store the spec tree as an opaque var for WidgetRenderer
                "spec": widget.spec !== undefined ? widget.spec : ({})
            }
            // UPDATE-by-id: a non-empty id that already exists replaces in place
            // (the append-only bus keeps history; the desktop collapses by id).
            if (id.length > 0) {
                for (var i = 0; i < widgetModel.count; i++) {
                    if (widgetModel.get(i).id === id) {
                        widgetModel.set(i, row)
                        return
                    }
                }
            }
            // Genuinely new: newest on top; cap so a chatty session can't grow it.
            widgetModel.insert(0, row)
            while (widgetModel.count > page.cap)
                widgetModel.remove(widgetModel.count - 1)
        }
    }

    // Interpret a button `action` map from the safe DSL — a fixed allow-set
    // (send / skill). Unknown keys do nothing. Nothing is ever eval'd.
    function handleAction(action) {
        if (!action || typeof action !== "object")
            return
        if (typeof action.send === "string" && action.send.length > 0) {
            // Prefer routing through the chat panel (via AppShell) so the message
            // lands in the transcript; sendChat has a bridge fallback if no host
            // is connected. Emitting the signal lets AppShell own the routing.
            page.sendChat(action.send)
        } else if (typeof action.skill === "string" && action.skill.length > 0) {
            bridge.skillInvoke(action.skill,
                               (typeof action.args === "string") ? action.args : "")
        }
    }

    function relTime(ms) {
        if (!ms || ms <= 0) return ""
        var t = ms < 1e12 ? ms * 1000 : ms
        var diff = Date.now() - t
        if (diff < 0 || diff < 60000) return "just now"
        if (diff < 3600000) return Math.floor(diff / 60000) + "m ago"
        if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago"
        return Math.floor(diff / 86400000) + "d ago"
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        PageHeader {
            Layout.fillWidth: true
            title: "Canvas"
            subtitle: "Widgets Jarvis renders for you. Ask it to draw or show something visual."
        }

        // ---- empty state ---------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: widgetModel.count === 0

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 8
                width: Math.min(parent.width - 40, 460)

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "No widgets yet"
                    color: Theme.textMuted
                    font.family: Theme.fontDisplay
                    font.pixelSize: 14
                    font.letterSpacing: Theme.trackMid
                }
                Text {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    text: "Jarvis-rendered widgets appear here. Try: ‘show me a duck’."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                    wrapMode: Text.WordWrap
                }
            }
        }

        // ---- widget cards --------------------------------------------------
        ListView {
            id: list
            visible: widgetModel.count > 0
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 12
            model: widgetModel
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
            }

            delegate: Rectangle {
                id: card
                required property string title
                required property var spec
                required property double ts
                required property string id

                width: ListView.view ? ListView.view.width : 0
                implicitHeight: cardCol.implicitHeight + 28
                radius: Theme.radius
                color: Theme.panelSoft
                border.width: 1
                border.color: Theme.hairlineSoft

                // left accent seam
                Rectangle {
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    anchors.margins: 10
                    width: 3
                    radius: 1.5
                    color: Theme.accent
                    opacity: 0.7
                }

                ColumnLayout {
                    id: cardCol
                    anchors.fill: parent
                    anchors.leftMargin: 22
                    anchors.rightMargin: 14
                    anchors.topMargin: 14
                    anchors.bottomMargin: 14
                    spacing: 10

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8

                        Text {
                            text: card.title
                            visible: card.title.length > 0
                            color: Theme.text
                            font.family: Theme.fontDisplay
                            font.pixelSize: 13
                            font.weight: Font.DemiBold
                            font.letterSpacing: Theme.trackTight
                        }
                        Item { Layout.fillWidth: true }
                        Text {
                            text: page.relTime(card.ts)
                            visible: text.length > 0
                            color: Theme.textFaint
                            font.family: Theme.fontMono
                            font.pixelSize: 10
                        }
                        // "pop out" -> spawn a standalone frameless always-on-top
                        // desktop window hosting just this widget (live-updates too).
                        Rectangle {
                            Layout.preferredWidth: 22
                            Layout.preferredHeight: 22
                            radius: Theme.radiusXs
                            color: popArea.containsMouse ? Theme.surface : "transparent"
                            border.width: 1
                            border.color: popArea.containsMouse ? Theme.hairline : "transparent"
                            Text {
                                anchors.centerIn: parent
                                text: "⧉"   // ⧉ pop-out glyph
                                color: popArea.containsMouse ? Theme.accentBright : Theme.textMuted
                                font.pixelSize: 13
                            }
                            MouseArea {
                                id: popArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: bridge.popOutWidget(card.id, card.title, card.spec)
                            }
                        }
                    }

                    // the safe DSL interpreter renders the spec tree
                    WidgetRenderer {
                        Layout.fillWidth: true
                        node: card.spec
                        onActionRequested: function(action) { page.handleAction(action) }
                    }
                }
            }
        }
    }
}
