pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// WIDGETS page: the REUSABLE widget library (saved_widgets.json), distinct from
// the ad-hoc CANVAS. Save a canvas with its ★ button (or the widget_save MCP
// tool) and it shows up here to re-render onto the Canvas or into chat, or to
// delete. Each card previews the saved spec via the same safe WidgetRenderer DSL.
Item {
    id: page

    // Emitted after a saved widget is rendered, so the shell can surface the right
    // page (chat vs canvas).
    signal renderedToChat()
    signal renderedToCanvas()

    ListModel { id: savedModel }

    Component.onCompleted: if (bridge.connected) bridge.refreshSavedWidgets()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) bridge.refreshSavedWidgets() }
        function onSavedWidgetsListed(widgets) {
            savedModel.clear()
            for (var i = 0; i < widgets.length; i++) {
                var w = widgets[i]
                savedModel.append({
                    "wid": w.id !== undefined ? ("" + w.id) : "",
                    "name": w.name !== undefined ? ("" + w.name) : "",
                    // Store the spec as a JSON STRING (a ListModel var role mangles
                    // nested arrays); the delegate JSON.parse's it back to a tree.
                    "spec": JSON.stringify(w.spec !== undefined ? w.spec : ({}))
                })
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        PageHeader {
            Layout.fillWidth: true
            title: "Widgets"
            subtitle: "Your reusable widget library. Save a canvas (★) to keep it here, then render it again anytime."
        }

        // ---- empty state ---------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: savedModel.count === 0

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 8
                width: Math.min(parent.width - 40, 460)
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "No saved widgets yet"
                    color: Theme.textMuted
                    font.family: Theme.fontDisplay
                    font.pixelSize: 14
                    font.letterSpacing: Theme.trackMid
                }
                Text {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                    text: "On the Canvas, tap ★ on a widget to save it here — or ask Cindro to ‘save this as a widget’."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                }
            }
        }

        // ---- saved widget cards --------------------------------------------
        ListView {
            id: list
            visible: savedModel.count > 0
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 12
            model: savedModel
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
            }

            delegate: Rectangle {
                id: card
                required property string wid
                required property string name
                required property string spec
                readonly property var specTree: {
                    try { return JSON.parse(card.spec) } catch (e) { return ({}) }
                }
                width: ListView.view ? ListView.view.width : 0
                implicitHeight: cardCol.implicitHeight + 28
                radius: Theme.radius
                color: Theme.panelSoft
                border.width: 1
                border.color: Theme.hairlineSoft

                Rectangle {   // amber accent seam — distinguishes saved widgets
                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.margins: 10
                    width: 3; radius: 1.5
                    color: Theme.amber
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
                            text: "★ " + (card.name.length > 0 ? card.name : "Widget")
                            color: Theme.text
                            font.family: Theme.fontDisplay
                            font.pixelSize: 13
                            font.weight: Font.DemiBold
                            font.letterSpacing: Theme.trackTight
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                        Widgets.PillButton {
                            label: "→ Canvas"
                            onClicked: { bridge.renderSavedWidget(card.wid, "canvas"); page.renderedToCanvas() }
                        }
                        Widgets.PillButton {
                            label: "→ Chat"
                            onClicked: { bridge.renderSavedWidget(card.wid, "chat"); page.renderedToChat() }
                        }
                        Widgets.PillButton {
                            label: "📌 Home"
                            primary: true
                            onClicked: bridge.renderSavedWidget(card.wid, "home")
                        }
                        Rectangle {
                            Layout.preferredWidth: 26; Layout.preferredHeight: 26
                            radius: Theme.radiusXs
                            color: delMa.containsMouse ? Qt.rgba(1,0.3,0.37,0.12) : "transparent"
                            border.width: 1
                            border.color: delMa.containsMouse ? Theme.danger : Theme.hairlineSoft
                            Text {
                                anchors.centerIn: parent; text: "✕"
                                color: delMa.containsMouse ? Theme.danger : Theme.textMuted
                                font.pixelSize: 13
                            }
                            MouseArea {
                                id: delMa
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: bridge.deleteSavedWidget(card.wid)
                            }
                        }
                    }

                    // live preview of the saved spec
                    WidgetRenderer {
                        Layout.fillWidth: true
                        node: card.specTree
                    }
                }
            }
        }
    }
}
