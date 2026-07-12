pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// AGENTS page: the custom-agent (subagent) library. Lists agents (agents.list)
// with their "when to use", views an agent's full definition (agents.get),
// CREATES a new agent via a form that writes an AGENT.md (agents.create — the
// user defines what it does + when to call it + its system prompt), DISPATCHES a
// task to one (agents.dispatch — spawns a child session that runs as the agent
// and reports back in Chat), and removes one (agents.remove). Mirrors SkillsPage.
Item {
    id: page

    // Emitted when an agent is dispatched: the parent (AppShell) jumps to Chat so
    // the user watches the spawned child session report back.
    signal runAgent(string sessionId, string agent)

    ListModel { id: agentModel }

    function refresh() { bridge.agentsList() }
    Component.onCompleted: if (bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onAgentsChanged() { page.refresh() }
        function onAgentsListed(agents) {
            agentModel.clear()
            for (var i = 0; i < agents.length; i++) {
                var a = agents[i]
                var tools = a.tools !== undefined ? a.tools : []
                agentModel.append({
                    "name": a.name !== undefined ? a.name : "",
                    "description": a.description !== undefined ? a.description : "",
                    "whenToUse": a.when_to_use !== undefined ? a.when_to_use : "",
                    "brain": a.brain !== undefined ? a.brain : "",
                    "model": a.model !== undefined ? a.model : "",
                    "profile": a.profile !== undefined ? a.profile : "",
                    "color": (a.color !== undefined && ("" + a.color).length > 0) ? a.color : Theme.violet,
                    "toolsCsv": Array.isArray(tools) ? tools.join(", ") : ("" + tools)
                })
            }
        }
        function onAgentLoaded(name, frontmatter, systemPrompt, path) {
            viewDialog.openWith(name, frontmatter, systemPrompt, path)
        }
        function onAgentDispatched(sessionId, agent) {
            page.runAgent(sessionId, agent)
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            PageHeader {
                Layout.fillWidth: true
                title: "Agents"
                subtitle: "Custom subagents Orin can dispatch — you define what each does + when to call it. Type / in Chat to dispatch."
            }
            Widgets.PillButton {
                label: "+ New Agent"
                primary: true
                Layout.alignment: Qt.AlignTop
                onClicked: createDialog.openFresh()
            }
        }

        // ---- empty state ---------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: agentModel.count === 0

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 12
                width: parent.width - 60

                ArcReactor {
                    Layout.alignment: Qt.AlignHCenter
                    size: 84
                    tint: Theme.violet
                }
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "NO AGENTS YET"
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
                    text: "Define a specialist agent (research, code review, summarizing…) with a role + when to use it. Orin can then dispatch tasks to it, and it reports back in Chat."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 13
                    lineHeight: 1.3
                }
            }
        }

        // ---- agent list ----------------------------------------------------
        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: agentModel.count > 0
            clip: true
            spacing: 10
            model: agentModel
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
                required property string name
                required property string description
                required property string whenToUse
                required property string brain
                required property string model
                required property string profile
                required property string color
                required property string toolsCsv

                width: ListView.view.width
                implicitHeight: content.implicitHeight + 26
                radius: Theme.radius
                color: Theme.surfaceStrong
                border.color: rowMa.containsMouse ? Theme.accentDim : Qt.rgba(0.694, 0.294, 1.0, 0.30)
                border.width: 1
                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                // accent seam in the agent's colour
                Rectangle {
                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.margins: 1
                    width: 3; radius: 1.5
                    color: row.color
                }

                MouseArea {
                    id: rowMa
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: bridge.agentGet(row.name)
                }

                ColumnLayout {
                    id: content
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.leftMargin: 16
                    anchors.rightMargin: 14
                    anchors.topMargin: 14
                    spacing: 8

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8

                        // agent glyph: a small head/spark
                        Canvas {
                            width: 16; height: 16
                            Layout.alignment: Qt.AlignVCenter
                            onPaint: {
                                var ctx = getContext("2d"); ctx.reset()
                                ctx.strokeStyle = row.color
                                ctx.lineWidth = 1.4; ctx.lineCap = "round"; ctx.lineJoin = "round"
                                ctx.beginPath(); ctx.arc(8, 6, 3.2, 0, Math.PI * 2); ctx.stroke()
                                ctx.beginPath()
                                ctx.moveTo(3, 15); ctx.quadraticCurveTo(8, 9.5, 13, 15); ctx.stroke()
                            }
                        }

                        Text {
                            text: row.name
                            color: Theme.text
                            font.family: Theme.fontMono
                            font.pixelSize: 14
                            font.weight: Font.Medium
                        }

                        // brain chip
                        Rectangle {
                            visible: row.brain.length > 0
                            radius: 5
                            implicitWidth: brTxt.implicitWidth + 12
                            implicitHeight: 17
                            color: Theme.accentFaint
                            Text {
                                id: brTxt
                                anchors.centerIn: parent
                                text: row.brain
                                color: Theme.accent
                                font.family: Theme.fontSans
                                font.pixelSize: 9
                            }
                        }
                        // profile chip
                        Rectangle {
                            visible: row.profile.length > 0
                            radius: 5
                            implicitWidth: prTxt.implicitWidth + 12
                            implicitHeight: 17
                            color: Qt.rgba(0.694, 0.294, 1.0, 0.14)
                            Text {
                                id: prTxt
                                anchors.centerIn: parent
                                text: row.profile
                                color: Theme.violet
                                font.family: Theme.fontSans
                                font.pixelSize: 9
                            }
                        }

                        Item { Layout.fillWidth: true }

                        Widgets.PillButton {
                            label: "View"
                            onClicked: bridge.agentGet(row.name)
                        }
                        Widgets.PillButton {
                            label: "Dispatch"
                            primary: true
                            enabledBtn: bridge.connected
                            onClicked: dispatchDialog.openFor(row.name)
                        }
                        Widgets.PillButton {
                            label: "Remove"
                            danger: true
                            opacity: rowMa.containsMouse ? 1.0 : 0.5
                            onClicked: bridge.agentRemove(row.name)
                        }
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: row.description.length > 0
                        text: row.description
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                        wrapMode: Text.WordWrap
                        lineHeight: 1.25
                        maximumLineCount: 2
                        elide: Text.ElideRight
                    }

                    // when-to-use line (this is the heart of the agent — when Jarvis calls it)
                    Text {
                        Layout.fillWidth: true
                        visible: row.whenToUse.length > 0
                        text: "↪ when: " + row.whenToUse
                        color: Theme.accent
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                        wrapMode: Text.WordWrap
                        lineHeight: 1.2
                        maximumLineCount: 2
                        elide: Text.ElideRight
                    }
                }
            }
        }
    }

    // ===== View agent dialog (agents.get) ==================================
    Popup {
        id: viewDialog
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 36, 560)
        height: Math.min(page.height - 60, 560)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        property string agentName: ""
        property string agentPath: ""
        property string agentPrompt: ""
        property var agentFm: ({})

        function openWith(name, frontmatter, prompt, path) {
            agentName = name
            agentFm = frontmatter || {}
            agentPrompt = prompt || ""
            agentPath = path || ""
            open()
        }

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.accentDim
            border.width: 1
        }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.55) }

        contentItem: ColumnLayout {
            spacing: 0

            RowLayout {
                Layout.fillWidth: true
                Layout.margins: 20
                Layout.bottomMargin: 8
                spacing: 10
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 3
                    Text {
                        text: viewDialog.agentName
                        color: Theme.accentBright
                        font.family: Theme.fontMono
                        font.pixelSize: 16
                        font.weight: Font.DemiBold
                    }
                    Text {
                        visible: viewDialog.agentPath.length > 0
                        Layout.fillWidth: true
                        text: viewDialog.agentPath
                        color: Theme.textFaint
                        font.family: Theme.fontMono
                        font.pixelSize: 10
                        elide: Text.ElideMiddle
                    }
                }
                Widgets.PillButton {
                    label: "Dispatch"
                    primary: true
                    onClicked: { dispatchDialog.openFor(viewDialog.agentName); viewDialog.close() }
                }
            }

            Rectangle { Layout.fillWidth: true; Layout.leftMargin: 16; Layout.rightMargin: 16; height: 1; color: Theme.hairlineSoft }

            Flickable {
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.margins: 16
                Layout.topMargin: 12
                clip: true
                contentHeight: bodyCol.implicitHeight
                ScrollBar.vertical: ScrollBar { width: 5 }

                ColumnLayout {
                    id: bodyCol
                    width: parent.width
                    spacing: 12

                    Repeater {
                        model: Object.keys(viewDialog.agentFm)
                        delegate: RowLayout {
                            required property string modelData
                            Layout.fillWidth: true
                            spacing: 10
                            Text {
                                text: modelData
                                color: Theme.textFaint
                                font.family: Theme.fontMono
                                font.pixelSize: 11
                                Layout.preferredWidth: 110
                            }
                            Text {
                                Layout.fillWidth: true
                                text: "" + viewDialog.agentFm[modelData]
                                color: Theme.textMuted
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                                wrapMode: Text.WordWrap
                            }
                        }
                    }

                    Rectangle {
                        visible: Object.keys(viewDialog.agentFm).length > 0
                        Layout.fillWidth: true; height: 1; color: Theme.hairlineFaint
                    }

                    Text {
                        text: "SYSTEM PROMPT"
                        color: Theme.textFaint
                        font.family: Theme.fontDisplay
                        font.pixelSize: 9
                        font.letterSpacing: 1.5
                    }
                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: promptText.implicitHeight + 24
                        radius: Theme.radiusSm
                        color: Theme.surfaceDeep
                        border.width: 1
                        border.color: Theme.hairlineFaint
                        Text {
                            id: promptText
                            anchors.fill: parent
                            anchors.margins: 12
                            text: viewDialog.agentPrompt.length > 0 ? viewDialog.agentPrompt : "(no system prompt)"
                            color: Theme.text
                            font.family: Theme.fontMono
                            font.pixelSize: 12
                            wrapMode: Text.WordWrap
                            lineHeight: 1.35
                        }
                    }
                }
            }
        }
    }

    // ===== Dispatch dialog (agents.dispatch) ===============================
    Popup {
        id: dispatchDialog
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 36, 480)
        height: Math.min(page.height - 80, 320)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape

        property string agentName: ""
        function openFor(name) { agentName = name; taskField.text = ""; open(); taskField.forceActiveFocus() }

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.accentDim
            border.width: 1
        }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.55) }

        contentItem: ColumnLayout {
            spacing: 14
            Layout.margins: 20

            Text {
                text: "DISPATCH → " + dispatchDialog.agentName
                color: Theme.accentBright
                font.family: Theme.fontDisplay
                font.pixelSize: 14
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackMid
            }
            Text {
                text: "The agent runs as its own child session and reports back in Chat."
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: 12
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                radius: Theme.radiusSm
                color: Theme.surfaceInput
                border.width: 1
                border.color: taskField.activeFocus ? Theme.accent : Theme.hairlineSoft
                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                ScrollView {
                    anchors.fill: parent
                    anchors.margins: 10
                    clip: true
                    TextArea {
                        id: taskField
                        placeholderText: "What should this agent do?"
                        placeholderTextColor: Theme.textFaint
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        wrapMode: TextArea.Wrap
                        selectByMouse: true
                        selectionColor: Theme.accentDim
                        background: null
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Item { Layout.fillWidth: true }
                Widgets.PillButton { label: "Cancel"; onClicked: dispatchDialog.close() }
                Widgets.PillButton {
                    label: "Dispatch"
                    primary: true
                    enabledBtn: bridge.connected && taskField.text.trim().length > 0
                    onClicked: {
                        bridge.agentDispatch(dispatchDialog.agentName, taskField.text.trim())
                        dispatchDialog.close()
                    }
                }
            }
        }
    }

    // ===== Create agent dialog (agents.create — self-authoring) ============
    Popup {
        id: createDialog
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 36, 560)
        height: Math.min(page.height - 50, 640)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape

        function openFresh() {
            nameField.text = ""
            descField.text = ""
            whenField.text = ""
            brainField.text = ""
            modelField.text = ""
            profileField.text = ""
            promptField.text = ""
            open()
        }

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.accentDim
            border.width: 1
        }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.55) }

        contentItem: ColumnLayout {
            spacing: 12
            Layout.margins: 20

            Text {
                text: "DEFINE AGENT"
                color: Theme.accentBright
                font.family: Theme.fontDisplay
                font.pixelSize: 15
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackMid
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 5
                    Text { text: "Name"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    Widgets.StyledField { id: nameField; Layout.fillWidth: true; placeholder: "research-bot" }
                }
                ColumnLayout {
                    Layout.preferredWidth: 150; spacing: 5
                    Text { text: "Brain (optional)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    Widgets.StyledField { id: brainField; Layout.fillWidth: true; placeholder: "codex|claude|api" }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 5
                    Text { text: "Model (optional)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    Widgets.StyledField { id: modelField; Layout.fillWidth: true; placeholder: "blank = brain default" }
                }
                ColumnLayout {
                    Layout.preferredWidth: 150; spacing: 5
                    Text { text: "Profile (optional)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    Widgets.StyledField { id: profileField; Layout.fillWidth: true; placeholder: "coworker|coder" }
                }
            }

            ColumnLayout {
                Layout.fillWidth: true; spacing: 5
                Text { text: "What it does"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                Widgets.StyledField { id: descField; Layout.fillWidth: true; placeholder: "Researches a topic deeply across sources" }
            }
            ColumnLayout {
                Layout.fillWidth: true; spacing: 5
                Text { text: "When to call it"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                Widgets.StyledField { id: whenField; Layout.fillWidth: true; placeholder: "When the user asks to research / investigate something" }
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 5
                Text { text: "System prompt (the agent's role)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                Rectangle {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    radius: Theme.radiusSm
                    color: Theme.surfaceInput
                    border.width: 1
                    border.color: promptField.activeFocus ? Theme.accent : Theme.hairlineSoft
                    Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                    ScrollView {
                        anchors.fill: parent
                        anchors.margins: 10
                        clip: true
                        TextArea {
                            id: promptField
                            placeholderText: "You are a meticulous research agent. Always cite sources…"
                            placeholderTextColor: Theme.textFaint
                            color: Theme.text
                            font.family: Theme.fontMono
                            font.pixelSize: 12
                            wrapMode: TextArea.Wrap
                            selectByMouse: true
                            selectionColor: Theme.accentDim
                            background: null
                        }
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Item { Layout.fillWidth: true }
                Widgets.PillButton { label: "Cancel"; onClicked: createDialog.close() }
                Widgets.PillButton {
                    label: "Create agent"
                    primary: true
                    enabledBtn: bridge.connected && nameField.text.trim().length > 0
                    onClicked: {
                        bridge.agentCreate(nameField.text.trim(),
                                           descField.text.trim(),
                                           whenField.text.trim(),
                                           promptField.text,
                                           brainField.text.trim(),
                                           modelField.text.trim(),
                                           profileField.text.trim())
                        createDialog.close()
                    }
                }
            }
        }
    }
}
