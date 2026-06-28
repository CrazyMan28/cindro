pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// SlashPalette — the Claude-Code-style "/" menu for the chat composer. Type "/"
// and a scrollable, filterable, animated card rises ABOVE the input listing every
// COMMAND (built-ins), AGENT (custom subagents), and SKILL (self-authored). The
// host (JarvisPanel) drives selection from the TextArea's key handlers (so the
// input keeps focus + filters live): moveUp/moveDown/accept/current/hide. Picking
// emits pick(item) with {kind, name, label, sub, value}. Motion: card scale/slide
// entrance + gliding row highlight, matching CommandPalette.
Item {
    id: slash
    // Geometry is set by the host (JarvisPanel positions it above the composer).

    // The text AFTER the leading "/" (the host strips the slash). Filters live.
    property string query: ""
    property bool open: false
    property int currentIndex: 0
    // Width of the card (the host sizes it to the composer).
    property real cardWidth: Math.min(parent ? parent.width - 24 : 420, 460)

    signal pick(var item)

    visible: open && resultList.length > 0
    z: 9000

    // ---- data: skills + agents from the daemon ----------------------------
    ListModel { id: skillModel }
    ListModel { id: agentModel }

    // Built-in commands (immediate `cmd`, or `value` text inserted for ones that
    // take an argument). The host (JarvisPanel) interprets them in runSlashCommand.
    readonly property var commands: [
        { name: "new",      label: "/new",      sub: "Start a new chat",          value: "/new" },
        { name: "clear",    label: "/clear",    sub: "Clear this conversation",   value: "/clear" },
        { name: "voice",    label: "/voice",    sub: "Switch to voice mode",      value: "/voice" },
        { name: "agents",   label: "/agents",   sub: "Manage custom agents",      value: "/agents" },
        { name: "skills",   label: "/skills",   sub: "Manage skills",             value: "/skills" },
        { name: "dispatch", label: "/dispatch", sub: "Dispatch an agent: /dispatch <agent> <task>", value: "/dispatch " },
        { name: "agent",    label: "/agent",    sub: "Start this chat as an agent: /agent <name>",   value: "/agent " },
        { name: "model",    label: "/model",    sub: "Set the model: /model <name>",                 value: "/model " },
        { name: "brain",    label: "/brain",    sub: "Set the brain: /brain <codex|claude|api>",     value: "/brain " },
        { name: "resume",   label: "/resume",   sub: "Open a session: /resume <id>",                 value: "/resume " },
        { name: "help",     label: "/help",     sub: "List slash commands",       value: "/help" }
    ]

    function refresh() {
        if (bridge.connected) { bridge.skillsList(); bridge.agentsList() }
    }

    Connections {
        target: bridge
        function onSkillsListed(skills) {
            skillModel.clear()
            for (var i = 0; i < skills.length; i++) {
                var s = skills[i]
                skillModel.append({
                    "name": s.name !== undefined ? "" + s.name : "",
                    "description": s.description !== undefined ? "" + s.description : ""
                })
            }
            slash.rebuild()
        }
        function onAgentsListed(agents) {
            agentModel.clear()
            for (var i = 0; i < agents.length; i++) {
                var a = agents[i]
                agentModel.append({
                    "name": a.name !== undefined ? "" + a.name : "",
                    "whenToUse": a.when_to_use !== undefined ? "" + a.when_to_use : "",
                    "description": a.description !== undefined ? "" + a.description : ""
                })
            }
            slash.rebuild()
        }
    }

    // ---- filtered, grouped result list ------------------------------------
    property var resultList: []
    function rebuild() {
        var q = ("" + slash.query).trim().toLowerCase()
        var out = []
        function match(hay) { return q === "" || ("" + hay).toLowerCase().indexOf(q) >= 0 }

        for (var i = 0; i < slash.commands.length; i++) {
            var c = slash.commands[i]
            if (match(c.name) || match(c.label))
                out.push({ kind: "command", name: c.name, label: c.label, sub: c.sub,
                           value: c.value, group: "COMMANDS" })
        }
        for (var j = 0; j < agentModel.count; j++) {
            var a = agentModel.get(j)
            if (match(a.name) || match(a.whenToUse))
                out.push({ kind: "agent", name: a.name, label: "/dispatch " + a.name,
                           sub: a.whenToUse.length > 0 ? a.whenToUse : a.description,
                           value: "/dispatch " + a.name + " ", group: "AGENTS" })
        }
        for (var k = 0; k < skillModel.count; k++) {
            var s = skillModel.get(k)
            if (match(s.name))
                out.push({ kind: "skill", name: s.name, label: "/" + s.name,
                           sub: s.description, value: "/" + s.name + " ", group: "SKILLS" })
        }
        slash.resultList = out
        if (slash.currentIndex >= out.length)
            slash.currentIndex = Math.max(0, out.length - 1)
    }
    onQueryChanged: rebuild()
    onOpenChanged: if (open) { introAnim.restart(); currentIndex = 0; rebuild() }

    // ---- host-driven keyboard control -------------------------------------
    function moveDown() { if (resultList.length) currentIndex = Math.min(resultList.length - 1, currentIndex + 1); listView.positionViewAtIndex(currentIndex, ListView.Contain) }
    function moveUp()   { if (resultList.length) currentIndex = Math.max(0, currentIndex - 1); listView.positionViewAtIndex(currentIndex, ListView.Contain) }
    function current()  { return (currentIndex >= 0 && currentIndex < resultList.length) ? resultList[currentIndex] : null }
    function accept()   { var it = current(); if (it) { slash.open = false; slash.pick(it) } }
    function hide()     { slash.open = false }

    // ---- the card (anchored to the BOTTOM so it rises above the input) ----
    Rectangle {
        id: card
        width: slash.cardWidth
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        height: Math.min(slash.height - 8, Math.max(56, listView.contentHeight + 14))
        radius: 14
        color: Theme.surface
        border.color: Theme.accentDim
        border.width: 1
        clip: true

        transform: [
            Scale { id: cardScale; origin.x: card.width / 2; origin.y: card.height; xScale: 1; yScale: 1 },
            Translate { id: cardSlide; y: 0 }
        ]
        ParallelAnimation {
            id: introAnim
            NumberAnimation { target: cardScale; properties: "xScale,yScale"; from: 0.97; to: 1; duration: 180; easing.type: Easing.OutCubic }
            NumberAnimation { target: cardSlide; property: "y"; from: 12; to: 0; duration: 200; easing.type: Easing.OutCubic }
            NumberAnimation { target: card; property: "opacity"; from: 0; to: 1; duration: 150 }
        }
        layer.enabled: true
        layer.effect: MultiEffect { shadowEnabled: true; shadowColor: "#000000"; shadowBlur: 1.0; shadowVerticalOffset: -8 }

        ListView {
            id: listView
            anchors.fill: parent
            anchors.margins: 7
            clip: true
            model: slash.resultList
            currentIndex: slash.currentIndex
            boundsBehavior: Flickable.StopAtBounds
            highlightMoveDuration: 120
            highlight: Rectangle { radius: Theme.radiusSm; color: Theme.navActive; border.color: Theme.accentDim; border.width: 1 }

            delegate: Item {
                id: row
                required property int index
                required property var modelData
                width: listView.width
                height: 44
                readonly property bool sel: slash.currentIndex === index

                Row {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: parent.left; anchors.leftMargin: 10
                    anchors.right: parent.right; anchors.rightMargin: 10
                    spacing: 11

                    // kind glyph chip
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 28; height: 28; radius: 8
                        color: row.modelData.kind === "agent" ? Qt.rgba(0.694, 0.294, 1.0, 0.16)
                               : row.modelData.kind === "skill" ? Qt.rgba(0.357, 0.549, 1.0, 0.16)
                               : Theme.accentDim
                        Text {
                            anchors.centerIn: parent
                            text: row.modelData.kind === "agent" ? "✦"
                                  : row.modelData.kind === "skill" ? "⚡" : "›"
                            color: row.modelData.kind === "agent" ? Theme.violet
                                   : row.modelData.kind === "skill" ? Theme.accent2 : Theme.accent
                            font.pixelSize: 13
                        }
                    }
                    Column {
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width - 28 - 11 - (groupChip.width + 11)
                        spacing: 1
                        Text {
                            text: row.modelData.label
                            color: row.sel ? Theme.accentBright : Theme.text
                            font.family: Theme.fontMono; font.pixelSize: 13; font.weight: Font.Medium
                            elide: Text.ElideRight; width: parent.width
                        }
                        Text {
                            visible: ("" + row.modelData.sub).length > 0
                            text: row.modelData.sub
                            color: Theme.textFaint
                            font.family: Theme.fontSans; font.pixelSize: 11
                            elide: Text.ElideRight; width: parent.width
                        }
                    }
                    // group chip
                    Rectangle {
                        id: groupChip
                        anchors.verticalCenter: parent.verticalCenter
                        radius: 5
                        width: gcT.implicitWidth + 12; height: 16
                        color: Theme.surfaceStrong
                        Text {
                            id: gcT
                            anchors.centerIn: parent
                            text: row.modelData.group
                            color: Theme.textFaint
                            font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 1
                        }
                    }
                }

                MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onEntered: slash.currentIndex = row.index
                    onClicked: { slash.currentIndex = row.index; slash.accept() }
                }
            }
        }
    }
}
