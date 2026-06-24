pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import JarvisSidebar

// A transparent overlay that floats DRAGGABLE widget cards the model renders via
// render_widget (-> bridge.widgetRendered). Dropped into BOTH the Chat transcript
// and Voice Mode so Jarvis can "pop up" a duck / calendar / anything right in
// context (in voice mode they spawn next to the orb), and the user can drag each
// card anywhere by its title strip. The CANVAS tab keeps the full persistent list
// separately; this layer is the in-the-moment pop-up.
//
// Same-id re-render updates a card in place; a new id spawns a fresh card
// (cascaded so they don't stack exactly). Cards cap at maxCards (oldest drops).
Item {
    id: layer

    // {wid, title, spec, px, py}
    ListModel { id: cards }

    property int maxCards: 5
    property int cascade: 0

    // Clear all floating cards (e.g. a "new chat").
    function clear() { cards.clear(); layer.cascade = 0 }

    Connections {
        target: bridge
        function onWidgetRendered(w) {
            if (!w || w.spec === undefined)
                return
            var wid = (w.id !== undefined && ("" + w.id).length > 0)
                      ? ("" + w.id) : ("w" + layer.cascade)
            var title = (w.title !== undefined) ? ("" + w.title) : ""
            // Update in place if a card with this id already exists.
            for (var i = 0; i < cards.count; i++) {
                if (cards.get(i).wid === wid) {
                    cards.setProperty(i, "title", title)
                    cards.setProperty(i, "spec", w.spec)
                    return
                }
            }
            var sx = 16 + (layer.cascade % 4) * 24
            var sy = 16 + (layer.cascade % 4) * 24
            layer.cascade++
            cards.append({ "wid": wid, "title": title, "spec": w.spec, "px": sx, "py": sy })
            while (cards.count > layer.maxCards)
                cards.remove(0)
        }
    }

    Repeater {
        model: cards
        delegate: Rectangle {
            id: card
            required property int index
            required property string wid
            required property string title
            required property var spec
            required property real px
            required property real py

            z: 50 + index
            width: Math.min(Math.max(cardCol.implicitWidth + 20, 150), layer.width - 16)
            height: cardCol.implicitHeight + 16
            radius: Theme.radiusSm
            color: Theme.panelSoft
            border.width: 1
            border.color: Theme.accentDim
            // Initial position from the model; drag moves x/y freely afterward.
            Component.onCompleted: { x = card.px; y = card.py }

            // soft drop shadow / glow so it reads as a floating pop-up
            layer.enabled: false

            ColumnLayout {
                id: cardCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 8
                spacing: 6

                // ---- drag handle strip (title + close) ----
                Item {
                    Layout.fillWidth: true
                    implicitHeight: 18

                    MouseArea {
                        anchors.fill: parent
                        anchors.margins: -6
                        drag.target: card
                        drag.axis: Drag.XAndYAxis
                        drag.minimumX: 0
                        drag.minimumY: 0
                        drag.maximumX: Math.max(0, layer.width - card.width)
                        drag.maximumY: Math.max(0, layer.height - card.height)
                        cursorShape: Qt.SizeAllCursor
                        onPressed: card.z = 200   // bring to front while dragging
                    }

                    RowLayout {
                        anchors.fill: parent
                        spacing: 6
                        Text {
                            Layout.fillWidth: true
                            text: card.title.length > 0 ? card.title : "WIDGET"
                            color: Theme.accent
                            font.family: Theme.fontDisplay
                            font.pixelSize: 10
                            font.letterSpacing: Theme.trackMid
                            font.weight: Font.DemiBold
                            elide: Text.ElideRight
                            verticalAlignment: Text.AlignVCenter
                        }
                        Text {
                            text: "✕"
                            color: closeMa.containsMouse ? Theme.accent : Theme.textMuted
                            font.pixelSize: 12
                            verticalAlignment: Text.AlignVCenter
                            MouseArea {
                                id: closeMa
                                anchors.fill: parent
                                anchors.margins: -6
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: cards.remove(card.index)
                            }
                        }
                    }
                }

                // ---- the rendered widget (safe DSL; clicks pass through to it) ----
                WidgetRenderer {
                    Layout.fillWidth: true
                    node: card.spec
                }
            }
        }
    }
}
