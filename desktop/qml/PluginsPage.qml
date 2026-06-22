pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// Plugins page: marketplace cards from plugins.catalog (name, author, version,
// kind badge, description, permissions list) with Install / Enable toggle / Remove.
// Wires plugins.catalog/install/set_enabled/remove.
Item {
    id: page

    ListModel { id: pluginsModel }

    function refresh() { bridge.loadPlugins() }
    Component.onCompleted: if (bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onPluginsListed(plugins) {
            pluginsModel.clear()
            for (var i = 0; i < plugins.length; i++) {
                var p = plugins[i]
                var perms = []
                if (p.permissions !== undefined)
                    for (var j = 0; j < p.permissions.length; j++) perms.push(p.permissions[j])
                pluginsModel.append({
                    "pid": p.id !== undefined ? p.id : "",
                    "name": p.name !== undefined ? p.name : "",
                    "author": p.author !== undefined ? p.author : "",
                    "version": p.version !== undefined ? p.version : "",
                    "kind": p.kind !== undefined ? p.kind : "mcp",
                    "description": p.description !== undefined ? p.description : "",
                    "permissions": perms.join("  •  "),
                    "permsList": perms,
                    "installed": p.installed === true,
                    "plugEnabled": p.enabled === true
                })
            }
        }
    }

    function kindColor(k) {
        if (k === "mcp") return Theme.accent
        if (k === "skill") return Theme.ok
        return Theme.warn // both
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            PageHeader {
                Layout.fillWidth: true
                title: "Plugins"
                subtitle: "Install MCP tools and skills to extend what Jarvis can do."
            }
            Widgets.PillButton {
                label: "Refresh"
                Layout.alignment: Qt.AlignTop
                onClicked: page.refresh()
            }
        }

        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 12
            model: pluginsModel
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                width: 5
                background: Item {}
                contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
            }

            delegate: Rectangle {
                id: card
                required property string pid
                required property string name
                required property string author
                required property string version
                required property string kind
                required property string description
                required property string permissions
                required property var permsList
                required property bool installed
                required property bool plugEnabled

                width: ListView.view.width
                implicitHeight: cardCol.implicitHeight + 30
                radius: Theme.radius
                color: Theme.panelSoft
                border.color: cardMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft
                border.width: 1
                Behavior on border.color { ColorAnimation { duration: 120 } }
                clip: true

                MouseArea { id: cardMa; anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.NoButton }

                // hologram sheen — a soft diagonal highlight that sweeps on hover
                Rectangle {
                    visible: cardMa.containsMouse
                    width: parent.width * 0.5
                    height: parent.height * 2.2
                    rotation: 22
                    y: -parent.height * 0.6
                    gradient: Gradient {
                        orientation: Gradient.Horizontal
                        GradientStop { position: 0.0; color: "transparent" }
                        GradientStop { position: 0.5; color: Qt.rgba(0.5, 0.9, 1.0, 0.06) }
                        GradientStop { position: 1.0; color: "transparent" }
                    }
                    NumberAnimation on x {
                        running: cardMa.containsMouse
                        loops: Animation.Infinite
                        from: -parent.width * 0.5; to: parent.width
                        duration: 2200
                    }
                }

                ColumnLayout {
                    id: cardCol
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: 16
                    spacing: 10

                    // header: name + version + kind badge
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 9
                        Text {
                            text: card.name
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 15
                            font.weight: Font.DemiBold
                        }
                        Text {
                            text: "v" + card.version
                            color: Theme.textFaint
                            font.family: Theme.fontMono
                            font.pixelSize: 11
                            Layout.alignment: Qt.AlignVCenter
                        }
                        Item { Layout.fillWidth: true }
                        // kind badge
                        Rectangle {
                            radius: 6
                            implicitWidth: kindTxt.implicitWidth + 16
                            implicitHeight: 20
                            color: "transparent"
                            border.width: 1
                            border.color: page.kindColor(card.kind)
                            Text {
                                id: kindTxt
                                anchors.centerIn: parent
                                text: card.kind.toUpperCase()
                                color: page.kindColor(card.kind)
                                font.family: Theme.fontSans
                                font.pixelSize: 10
                                font.letterSpacing: 1.0
                                font.weight: Font.DemiBold
                            }
                        }
                    }

                    Text {
                        text: "by " + card.author
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                    }

                    Text {
                        Layout.fillWidth: true
                        text: card.description
                        color: Theme.textMuted
                        wrapMode: Text.WordWrap
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        lineHeight: 1.35
                    }

                    // permission chips
                    Flow {
                        Layout.fillWidth: true
                        visible: card.permsList.length > 0
                        spacing: 6
                        Text {
                            text: "PERMS"
                            color: Theme.textFaint
                            font.family: Theme.fontDisplay
                            font.pixelSize: 9
                            font.letterSpacing: Theme.trackMid
                            height: 19
                            verticalAlignment: Text.AlignVCenter
                        }
                        Repeater {
                            model: card.permsList
                            delegate: Rectangle {
                                required property string modelData
                                radius: 5
                                implicitWidth: permTxt.implicitWidth + 14
                                implicitHeight: 19
                                color: Theme.amberDim
                                border.width: 1
                                border.color: Qt.rgba(1.0, 0.706, 0.329, 0.35)
                                Text {
                                    id: permTxt
                                    anchors.centerIn: parent
                                    text: modelData
                                    color: Theme.amber
                                    font.family: Theme.fontMono
                                    font.pixelSize: 10
                                }
                            }
                        }
                    }

                    // actions
                    RowLayout {
                        Layout.fillWidth: true
                        Layout.topMargin: 2
                        spacing: 10

                        // enable toggle (only when installed)
                        RowLayout {
                            visible: card.installed
                            spacing: 8
                            Text {
                                text: card.plugEnabled ? "Enabled" : "Disabled"
                                color: card.plugEnabled ? Theme.ok : Theme.textMuted
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                            }
                            Widgets.StyledSwitch {
                                checked: card.plugEnabled
                                onToggled: function(v) { bridge.setPluginEnabled(card.pid, v) }
                            }
                        }

                        Item { Layout.fillWidth: true }

                        Widgets.PillButton {
                            visible: card.installed
                            label: "Remove"
                            danger: true
                            onClicked: bridge.removePlugin(card.pid)
                        }
                        Widgets.PillButton {
                            visible: !card.installed
                            label: "Install"
                            primary: true
                            onClicked: bridge.installPlugin(card.pid)
                        }
                    }
                }
            }
        }
    }
}
