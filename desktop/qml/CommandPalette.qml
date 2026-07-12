pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Effects
import CindroSidebar

// CommandPalette — the ⌘K "Search or jump…" quick-switcher. A dim backdrop + a
// centered card with a search field and a filtered list of pages (and recent
// sessions). Arrow keys move, Enter jumps, Esc closes. Opens from the top-bar
// search field or Ctrl+K; navigates the shell via signals. All motion: backdrop
// fade, card scale/slide entrance, row hover.
Item {
    id: palette
    anchors.fill: parent
    visible: open
    z: 9000

    property bool open: false
    // [{key,label,section,index}] — the rail's pages.
    property var pages: []
    signal navigate(int index)
    signal openSession(string sid)

    ListModel { id: sessionModel }

    function show() {
        open = true
        bridge.listSessions()
        searchField.text = ""
        results.currentIndex = 0
        searchField.forceActiveFocus()
    }
    function hide() { open = false }

    onOpenChanged: if (open) { introAnim.restart(); refresh() }

    Connections {
        target: bridge
        function onSessionsListed(list) {
            sessionModel.clear()
            for (var i = 0; i < list.length && i < 6; i++) {
                var s = list[i]
                sessionModel.append({
                    "sid": s.id !== undefined ? "" + s.id : "",
                    "title": (s.title !== undefined && ("" + s.title).length > 0) ? "" + s.title : "Untitled session",
                    "brain": s.brain !== undefined ? "" + s.brain : ""
                })
            }
        }
    }

    // unified, filtered result list (pages first, then matching sessions)
    function buildResults() {
        var q = searchField.text.trim().toLowerCase()
        var out = []
        for (var i = 0; i < palette.pages.length; i++) {
            var p = palette.pages[i]
            if (q === "" || ("" + p.label).toLowerCase().indexOf(q) >= 0)
                out.push({ kind: "page", label: p.label, sub: p.section, key: p.key, index: p.index, sid: "" })
        }
        for (var j = 0; j < sessionModel.count; j++) {
            var s = sessionModel.get(j)
            if (q === "" || s.title.toLowerCase().indexOf(q) >= 0)
                out.push({ kind: "session", label: s.title, sub: "session · " + s.brain, key: "chat", index: -1, sid: s.sid })
        }
        return out
    }
    property var resultList: []
    function refresh() {
        resultList = buildResults()
        if (results.currentIndex >= resultList.length) results.currentIndex = Math.max(0, resultList.length - 1)
    }

    function activate(i) {
        if (i < 0 || i >= resultList.length) return
        var r = resultList[i]
        palette.hide()
        if (r.kind === "session") palette.openSession(r.sid)
        else palette.navigate(r.index)
    }

    // ---- dim backdrop ------------------------------------------------------
    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0.01, 0.02, 0.04, 0.62)
        opacity: palette.open ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 160 } }
        MouseArea { anchors.fill: parent; onClicked: palette.hide() }
    }

    // ---- centered card -----------------------------------------------------
    Rectangle {
        id: card
        width: Math.min(parent.width - 64, 460)
        anchors.horizontalCenter: parent.horizontalCenter
        y: 84
        height: cardCol.implicitHeight
        radius: 16
        color: Theme.surface
        border.color: Theme.accentDim
        border.width: 1
        clip: true

        // entrance: scale + slide-down
        transform: [
            Scale { id: cardScale; origin.x: card.width / 2; origin.y: 0; xScale: 1; yScale: 1 },
            Translate { id: cardSlide; y: 0 }
        ]
        ParallelAnimation {
            id: introAnim
            NumberAnimation { target: cardScale; properties: "xScale,yScale"; from: 0.96; to: 1; duration: 200; easing.type: Easing.OutCubic }
            NumberAnimation { target: cardSlide; property: "y"; from: -12; to: 0; duration: 220; easing.type: Easing.OutCubic }
            NumberAnimation { target: card; property: "opacity"; from: 0; to: 1; duration: 160 }
        }
        layer.enabled: true
        layer.effect: MultiEffect { shadowEnabled: true; shadowColor: "#000000"; shadowBlur: 1.0; shadowVerticalOffset: 18 }

        ColumnLayout {
            id: cardCol
            width: parent.width
            spacing: 0

            // search row
            RowLayout {
                Layout.fillWidth: true
                Layout.margins: 14
                spacing: 10
                Text { text: "⌕"; color: Theme.accent; font.pixelSize: 18 }
                TextField {
                    id: searchField
                    Layout.fillWidth: true
                    placeholderText: "Search pages and sessions…"
                    color: Theme.text
                    placeholderTextColor: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 14
                    background: null
                    onTextChanged: palette.refresh()
                    Keys.onDownPressed: results.currentIndex = Math.min(results.count - 1, results.currentIndex + 1)
                    Keys.onUpPressed: results.currentIndex = Math.max(0, results.currentIndex - 1)
                    Keys.onReturnPressed: palette.activate(results.currentIndex)
                    Keys.onEnterPressed: palette.activate(results.currentIndex)
                    Keys.onEscapePressed: palette.hide()
                }
                Rectangle {
                    radius: 5; implicitWidth: escT.implicitWidth + 12; implicitHeight: 18
                    color: Theme.surfaceStrong; border.color: Theme.hairlineSoft; border.width: 1
                    Text { id: escT; anchors.centerIn: parent; text: "ESC"; color: Theme.textFaint
                        font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 1 }
                }
            }

            Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairlineSoft }

            // results
            ListView {
                id: results
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(330, Math.max(54, contentHeight))
                Layout.margins: 8
                clip: true
                model: palette.resultList
                currentIndex: 0
                boundsBehavior: Flickable.StopAtBounds
                highlightMoveDuration: 120
                highlight: Rectangle { radius: Theme.radiusSm; color: Theme.navActive; border.color: Theme.accentDim; border.width: 1 }

                delegate: Item {
                    id: row
                    required property int index
                    required property var modelData
                    width: results.width
                    height: 46
                    readonly property bool sel: results.currentIndex === index
                    Row {
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.left: parent.left; anchors.leftMargin: 12
                        anchors.right: parent.right; anchors.rightMargin: 12
                        spacing: 12
                        Rectangle {
                            anchors.verticalCenter: parent.verticalCenter
                            width: 30; height: 30; radius: 8
                            color: row.modelData.kind === "session" ? Qt.rgba(0.357,0.549,1.0,0.16) : Theme.accentDim
                            Text { anchors.centerIn: parent
                                text: row.modelData.kind === "session" ? "⊚" : "▸"
                                color: row.modelData.kind === "session" ? Theme.accent2 : Theme.accent; font.pixelSize: 13 }
                        }
                        Column {
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 1
                            Text { text: row.modelData.label; color: row.sel ? Theme.accentBright : Theme.text
                                font.family: Theme.fontSans; font.pixelSize: 13; font.weight: Font.Medium }
                            Text { text: row.modelData.sub; color: Theme.textFaint
                                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 1 }
                        }
                    }
                    Text {
                        visible: row.sel
                        anchors.verticalCenter: parent.verticalCenter; anchors.right: parent.right; anchors.rightMargin: 14
                        text: "↵"; color: Theme.accent; font.pixelSize: 13
                    }
                    MouseArea {
                        anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onEntered: results.currentIndex = row.index
                        onClicked: palette.activate(row.index)
                    }
                }
            }
        }
    }

    // refresh the result list whenever sessions arrive
    Connections { target: sessionModel; function onCountChanged() { palette.refresh() } }
}
