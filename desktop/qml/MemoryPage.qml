pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// MEMORY page: the long-term memory store Jarvis injects into every brain turn.
// A live search box (memory.search) over a full list (memory.list), an inline
// "remember…" composer (memory.add), and per-row remove (memory.remove).
// Wires Contract A v3 memory.* and degrades to an empty state when the daemon
// has not yet shipped the methods (Wave 6).
Item {
    id: page

    ListModel { id: memModel }
    property bool searching: false   // true while showing search results (scored)
    property string query: ""

    function refresh() {
        if (page.query.trim().length > 0)
            bridge.memorySearch(page.query.trim())
        else
            bridge.memoryList()
    }
    Component.onCompleted: if (bridge.connected) refresh()
    // Re-query every time the user NAVIGATES to this page (the page object is
    // built once, so memories added from chat after that wouldn't show without
    // this). Fixes the "MEMORY EMPTY" page even though memory.list has rows.
    onVisibleChanged: if (visible && bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onMemoriesListed(memories, isSearch) {
            page.searching = isSearch
            memModel.clear()
            for (var i = 0; i < memories.length; i++) {
                var m = memories[i]
                var tags = m.tags !== undefined ? m.tags : []
                memModel.append({
                    "mid": m.id !== undefined ? ("" + m.id) : "",
                    "text": m.text !== undefined ? m.text : "",
                    "tagsCsv": Array.isArray(tags) ? tags.join(", ") : ("" + tags),
                    "created": m.created !== undefined ? m.created : 0,
                    "score": (m.score !== undefined && m.score !== null) ? Number(m.score) : -1
                })
            }
        }
        // After add/remove the bridge re-queries memory.list; if a search is live,
        // re-run it so the view reflects the mutation in context.
        function onMemoryChanged() {
            if (page.query.trim().length > 0)
                bridge.memorySearch(page.query.trim())
        }
    }

    function relTime(ms) {
        if (!ms || ms <= 0) return "—"
        // created may be epoch seconds or millis; normalize to millis.
        var t = ms < 1e12 ? ms * 1000 : ms
        var diff = Date.now() - t
        if (diff < 0) return "just now"
        if (diff < 60000) return "just now"
        if (diff < 3600000) return Math.floor(diff/60000) + "m ago"
        if (diff < 86400000) return Math.floor(diff/3600000) + "h ago"
        return Math.floor(diff/86400000) + "d ago"
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        PageHeader {
            Layout.fillWidth: true
            title: "Memory"
            subtitle: "Long-term recall injected into every session. Search, add, or prune what Cindro remembers."
        }

        // ---- search + add composer ----------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 10

            // search row
            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                Widgets.StyledField {
                    id: searchField
                    Layout.fillWidth: true
                    placeholder: "Search memory…"
                    onTextChanged: {
                        page.query = text
                        searchDebounce.restart()
                    }
                    onAccepted: { searchDebounce.stop(); page.refresh() }
                }
                Widgets.PillButton {
                    label: page.query.trim().length > 0 ? "Clear" : "Refresh"
                    onClicked: {
                        if (page.query.trim().length > 0) {
                            searchField.text = ""
                            page.query = ""
                        }
                        page.refresh()
                    }
                }
            }

            Timer {
                id: searchDebounce
                interval: 220
                onTriggered: page.refresh()
            }

            // add row
            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                Widgets.StyledField {
                    id: addField
                    Layout.fillWidth: true
                    placeholder: "Remember this…  (tag with #work #project)"
                    onAccepted: page.commitAdd()
                }
                Widgets.PillButton {
                    label: "+ Remember"
                    primary: true
                    enabledBtn: bridge.connected && addField.text.trim().length > 0
                    onClicked: page.commitAdd()
                }
            }
        }

        // ---- empty state ---------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: memModel.count === 0

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 12
                width: parent.width - 60

                ArcReactor {
                    Layout.alignment: Qt.AlignHCenter
                    size: 84
                    tint: Theme.accent
                }
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: page.searching ? "NO MATCHES" : "MEMORY EMPTY"
                    color: Theme.accentBright
                    font.family: Theme.fontDisplay
                    font.pixelSize: 15
                    font.weight: Font.DemiBold
                    font.letterSpacing: Theme.trackMid
                }
                Text {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                    text: page.searching
                          ? "No stored memory matches that query."
                          : "Anything you ask Cindro to remember — or that it self-curates — shows up here and is recalled across sessions."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 13
                    lineHeight: 1.3
                }
            }
        }

        // ---- memory list ---------------------------------------------------
        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: memModel.count > 0
            clip: true
            spacing: 9
            model: memModel
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                width: 5
                background: Item {}
                contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
            }

            delegate: Rectangle {
                id: row
                required property int index
                required property string mid
                required property string text
                required property string tagsCsv
                required property real created
                required property real score

                width: ListView.view.width
                implicitHeight: content.implicitHeight + 24
                radius: Theme.radius
                color: Theme.panelSoft
                border.color: rowMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft
                border.width: 1
                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                // glowing left seam — the "memory node" marker
                Rectangle {
                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.margins: 1
                    width: 3; radius: 1.5
                    color: Theme.violet
                    opacity: 0.7
                }

                MouseArea { id: rowMa; anchors.fill: parent; hoverEnabled: true }

                ColumnLayout {
                    id: content
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.leftMargin: 16
                    anchors.rightMargin: 14
                    anchors.topMargin: 12
                    spacing: 8

                    Text {
                        Layout.fillWidth: true
                        text: row.text
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        lineHeight: 1.3
                        wrapMode: Text.WordWrap
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8

                        // tag chips
                        Flow {
                            Layout.fillWidth: true
                            spacing: 6
                            Repeater {
                                model: row.tagsCsv.length > 0
                                       ? row.tagsCsv.split(",").map(function(s){ return s.trim() }).filter(function(s){ return s.length>0 })
                                       : []
                                delegate: Rectangle {
                                    required property string modelData
                                    radius: 6
                                    implicitWidth: tagTxt.implicitWidth + 14
                                    implicitHeight: 18
                                    color: "transparent"
                                    border.width: 1
                                    border.color: Qt.rgba(0.694, 0.294, 1.0, 0.45)   // violet
                                    Text {
                                        id: tagTxt
                                        anchors.centerIn: parent
                                        text: "#" + parent.modelData.replace(/^#/, "")
                                        color: Theme.violet
                                        font.family: Theme.fontMono
                                        font.pixelSize: 10
                                    }
                                }
                            }
                        }

                        // score (search) or relative time
                        Text {
                            visible: page.searching && row.score >= 0
                            text: "score " + row.score.toFixed(2)
                            color: Theme.accent
                            font.family: Theme.fontMono
                            font.pixelSize: 10
                        }
                        Text {
                            visible: !(page.searching && row.score >= 0)
                            text: page.relTime(row.created)
                            color: Theme.textFaint
                            font.family: Theme.fontMono
                            font.pixelSize: 10
                        }

                        Widgets.PillButton {
                            label: "Forget"
                            danger: true
                            opacity: rowMa.containsMouse ? 1.0 : 0.55
                            onClicked: bridge.memoryRemove(row.mid)
                        }
                    }
                }
            }
        }
    }

    // ---- actions -----------------------------------------------------------
    // Parse "#tag" tokens out of the add field, send the remainder as the memory
    // text plus a tags array.
    function commitAdd() {
        var raw = addField.text.trim()
        if (raw.length === 0 || !bridge.connected)
            return
        var tags = []
        var m = raw.match(/#[\w-]+/g)
        if (m) {
            for (var i = 0; i < m.length; i++)
                tags.push(m[i].substring(1))
            raw = raw.replace(/#[\w-]+/g, "").replace(/\s+/g, " ").trim()
        }
        if (raw.length === 0)
            return
        bridge.memoryAdd(raw, tags)
        addField.text = ""
    }
}
