pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// SKILLS page: the self-authored skill library. Lists skills (skills.list) with a
// "self-authored" badge, views a skill's frontmatter + body (skills.get), CREATES
// a new skill via a form that writes a SKILL.md (skills.create — self-authoring),
// runs a skill (skills.invoke -> the rendered text is injected into Chat), and
// removes one (skills.remove). Wires Contract A v3 skills.*.
Item {
    id: page

    // Emitted when a skill is invoked: the parent (AppShell) routes the rendered
    // text into the Chat composer/transcript.
    signal runSkill(string name, string message)

    ListModel { id: skillModel }
    ListModel { id: archivedModel }

    function refresh() { bridge.skillsList(); bridge.skillsListArchived() }
    Component.onCompleted: if (bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onSkillsListed(skills) {
            skillModel.clear()
            for (var i = 0; i < skills.length; i++) {
                var s = skills[i]
                var tags = s.tags !== undefined ? s.tags : []
                skillModel.append({
                    "name": s.name !== undefined ? s.name : "",
                    "group": s.group !== undefined ? s.group : "",
                    "description": s.description !== undefined ? s.description : "",
                    "tagsCsv": Array.isArray(tags) ? tags.join(", ") : ("" + tags),
                    "selfAuthored": s.self_authored === true,
                    "pinned": s.pinned === true,
                    "useCount": s.use_count !== undefined ? Number(s.use_count) : 0
                })
            }
        }
        function onSkillsArchivedListed(skills) {
            archivedModel.clear()
            for (var i = 0; i < skills.length; i++) {
                var s = skills[i]
                archivedModel.append({
                    "name": s.name !== undefined ? s.name : "",
                    "group": s.group !== undefined ? s.group : "",
                    "description": s.description !== undefined ? s.description : ""
                })
            }
        }
        function onSkillLoaded(name, frontmatter, body, path) {
            viewDialog.openWith(name, frontmatter, body, path)
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
                title: "Skills"
                subtitle: "Reusable playbooks Jarvis can run — and author for itself. /invoke drops one into Chat."
            }
            Widgets.PillButton {
                label: "+ New Skill"
                primary: true
                Layout.alignment: Qt.AlignTop
                onClicked: createDialog.openFresh()
            }
        }

        // ---- empty state ---------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: skillModel.count === 0

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
                    text: "NO SKILLS YET"
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
                    text: "Author a skill to teach Jarvis a repeatable task once. It saves a SKILL.md and the skill becomes invokable from Chat."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 13
                    lineHeight: 1.3
                }
            }
        }

        // ---- archived skills (jarvis#76 item 2) -----------------------------
        // The stale sweep ARCHIVES unused agent-created skills instead of
        // deleting them; restore any of them here.
        Widgets.SectionCard {
            Layout.fillWidth: true
            visible: archivedModel.count > 0
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 8
                Text {
                    text: "ARCHIVED (" + archivedModel.count + ") — unused skills parked by the sweep; restore brings one back instantly"
                    color: Theme.textMuted
                    font.family: Theme.fontDisplay
                    font.pixelSize: 10
                    font.letterSpacing: Theme.trackMid
                }
                Repeater {
                    model: archivedModel
                    delegate: RowLayout {
                        id: arow
                        required property string name
                        required property string group
                        required property string description
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            text: arow.name
                            color: Theme.textMuted
                            font.family: Theme.fontMono
                            font.pixelSize: 12
                        }
                        Text {
                            Layout.fillWidth: true
                            text: arow.description
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                            elide: Text.ElideRight
                        }
                        Widgets.PillButton {
                            label: "Restore"
                            onClicked: bridge.skillUnarchive(arow.name)
                        }
                    }
                }
            }
        }

        // ---- skill grid/list ----------------------------------------------
        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: skillModel.count > 0
            clip: true
            spacing: 10
            model: skillModel
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
                required property string group
                required property string description
                required property string tagsCsv
                required property bool selfAuthored
                required property bool pinned
                required property int useCount

                width: ListView.view.width
                implicitHeight: content.implicitHeight + 26
                radius: Theme.radius
                color: row.selfAuthored ? Theme.surfaceStrong : Theme.panelSoft
                border.color: rowMa.containsMouse ? Theme.accentDim
                              : (row.selfAuthored ? Qt.rgba(0.694, 0.294, 1.0, 0.30) : Theme.hairlineSoft)
                border.width: 1
                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                // self-authored skills get a violet "learned-by-Jarvis" seam.
                Rectangle {
                    visible: row.selfAuthored
                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.margins: 1
                    width: 3; radius: 1.5
                    color: Theme.violet
                }

                MouseArea {
                    id: rowMa
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: bridge.skillGet(row.name)
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

                        // skill glyph
                        Canvas {
                            width: 16; height: 16
                            Layout.alignment: Qt.AlignVCenter
                            onPaint: {
                                var ctx = getContext("2d"); ctx.reset()
                                ctx.strokeStyle = row.selfAuthored ? Theme.violet : Theme.accent
                                ctx.lineWidth = 1.4; ctx.lineCap = "round"; ctx.lineJoin = "round"
                                // lightning / spark glyph
                                ctx.beginPath()
                                ctx.moveTo(9, 1); ctx.lineTo(3, 9); ctx.lineTo(8, 9)
                                ctx.lineTo(7, 15); ctx.lineTo(13, 7); ctx.lineTo(8, 7); ctx.closePath()
                                ctx.stroke()
                            }
                        }

                        Text {
                            text: row.name
                            color: Theme.text
                            font.family: Theme.fontMono
                            font.pixelSize: 14
                            font.weight: Font.Medium
                        }

                        // self-authored badge
                        Rectangle {
                            visible: row.selfAuthored
                            radius: 5
                            implicitWidth: saTxt.implicitWidth + 14
                            implicitHeight: 17
                            color: Qt.rgba(0.694, 0.294, 1.0, 0.14)
                            border.width: 1
                            border.color: Qt.rgba(0.694, 0.294, 1.0, 0.45)
                            Text {
                                id: saTxt
                                anchors.centerIn: parent
                                text: "self-authored"
                                color: Theme.violet
                                font.family: Theme.fontSans
                                font.pixelSize: 9
                                font.letterSpacing: 0.4
                            }
                        }

                        // group chip
                        Rectangle {
                            visible: row.group.length > 0
                            radius: 5
                            implicitWidth: grpTxt.implicitWidth + 12
                            implicitHeight: 17
                            color: Theme.accentFaint
                            Text {
                                id: grpTxt
                                anchors.centerIn: parent
                                text: row.group
                                color: Theme.accent
                                font.family: Theme.fontSans
                                font.pixelSize: 9
                            }
                        }

                        // usage chip (jarvis#76 item 2): how alive this skill is.
                        Rectangle {
                            visible: row.useCount > 0
                            radius: 5
                            implicitWidth: useTxt.implicitWidth + 12
                            implicitHeight: 17
                            color: Qt.rgba(0.24, 0.90, 0.63, 0.10)
                            Text {
                                id: useTxt
                                anchors.centerIn: parent
                                text: "\u26a1 " + row.useCount
                                color: Theme.success
                                font.family: Theme.fontSans
                                font.pixelSize: 9
                            }
                        }
                        // pinned = exempt from the stale-archive sweep.
                        Rectangle {
                            visible: row.pinned
                            radius: 5
                            implicitWidth: pinTxt.implicitWidth + 12
                            implicitHeight: 17
                            color: Theme.accentFaint
                            border.width: 1
                            border.color: Theme.accentDim
                            Text {
                                id: pinTxt
                                anchors.centerIn: parent
                                text: "\ud83d\udccc pinned"
                                color: Theme.accent
                                font.family: Theme.fontSans
                                font.pixelSize: 9
                            }
                        }

                        Item { Layout.fillWidth: true }

                        Widgets.PillButton {
                            label: row.pinned ? "Unpin" : "Pin"
                            opacity: rowMa.containsMouse || row.pinned ? 1.0 : 0.5
                            onClicked: bridge.skillPin(row.name, !row.pinned)
                        }
                        Widgets.PillButton {
                            label: "View"
                            onClicked: bridge.skillGet(row.name)
                        }
                        Widgets.PillButton {
                            label: "Run"
                            primary: true
                            enabledBtn: bridge.connected
                            // Send "/name" into chat; the model loads it via skill_load.
                            onClicked: page.runSkill(row.name, "")
                        }
                        Widgets.PillButton {
                            label: "Remove"
                            danger: true
                            opacity: rowMa.containsMouse ? 1.0 : 0.5
                            onClicked: bridge.skillRemove(row.name)
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
                }
            }
        }
    }

    // ===== View skill dialog (skills.get) ==================================
    Popup {
        id: viewDialog
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 36, 560)
        height: Math.min(page.height - 60, 560)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        property string skillName: ""
        property string skillPath: ""
        property string skillBody: ""
        property var skillFm: ({})

        function openWith(name, frontmatter, body, path) {
            skillName = name
            skillFm = frontmatter || {}
            skillBody = body || ""
            skillPath = path || ""
            open()
        }

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.accentDim
            border.width: 1
            Rectangle {
                anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 16; anchors.rightMargin: 16; anchors.topMargin: 1
                height: 2; radius: 1
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Theme.violet }
                    GradientStop { position: 0.5; color: Theme.accent }
                    GradientStop { position: 1.0; color: Theme.magenta }
                }
                opacity: 0.85
            }
        }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.55) }

        contentItem: ColumnLayout {
            spacing: 0

            // header
            RowLayout {
                Layout.fillWidth: true
                Layout.margins: 20
                Layout.bottomMargin: 8
                spacing: 10
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 3
                    Text {
                        text: viewDialog.skillName
                        color: Theme.accentBright
                        font.family: Theme.fontMono
                        font.pixelSize: 16
                        font.weight: Font.DemiBold
                    }
                    Text {
                        visible: viewDialog.skillPath.length > 0
                        Layout.fillWidth: true
                        text: viewDialog.skillPath
                        color: Theme.textFaint
                        font.family: Theme.fontMono
                        font.pixelSize: 10
                        elide: Text.ElideMiddle
                    }
                }
                Widgets.PillButton {
                    label: "Run"
                    primary: true
                    onClicked: { page.runSkill(viewDialog.skillName, ""); viewDialog.close() }
                }
            }

            Rectangle { Layout.fillWidth: true; Layout.leftMargin: 16; Layout.rightMargin: 16; height: 1; color: Theme.hairlineSoft }

            // frontmatter + body
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

                    // frontmatter key/value rows
                    Repeater {
                        model: Object.keys(viewDialog.skillFm)
                        delegate: RowLayout {
                            required property string modelData
                            Layout.fillWidth: true
                            spacing: 10
                            Text {
                                text: modelData
                                color: Theme.textFaint
                                font.family: Theme.fontMono
                                font.pixelSize: 11
                                Layout.preferredWidth: 96
                            }
                            Text {
                                Layout.fillWidth: true
                                text: "" + viewDialog.skillFm[modelData]
                                color: Theme.textMuted
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                                wrapMode: Text.WordWrap
                            }
                        }
                    }

                    Rectangle {
                        visible: Object.keys(viewDialog.skillFm).length > 0
                        Layout.fillWidth: true; height: 1; color: Theme.hairlineFaint
                    }

                    // body (markdown source, monospaced)
                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: bodyText.implicitHeight + 24
                        radius: Theme.radiusSm
                        color: Theme.surfaceDeep
                        border.width: 1
                        border.color: Theme.hairlineFaint
                        Text {
                            id: bodyText
                            anchors.fill: parent
                            anchors.margins: 12
                            text: viewDialog.skillBody.length > 0 ? viewDialog.skillBody : "(empty body)"
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

    // ===== Create skill dialog (skills.create — SELF-AUTHORING) ============
    Popup {
        id: createDialog
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 36, 520)
        height: Math.min(page.height - 50, 600)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape

        function openFresh() {
            nameField.text = ""
            groupField.text = ""
            descField.text = ""
            bodyField.text = ""
            open()
        }

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.accentDim
            border.width: 1
            Rectangle {
                anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 16; anchors.rightMargin: 16; anchors.topMargin: 1
                height: 2; radius: 1
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Theme.magenta }
                    GradientStop { position: 0.5; color: Theme.accent }
                    GradientStop { position: 1.0; color: Theme.violet }
                }
                opacity: 0.85
            }
        }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.55) }

        contentItem: ColumnLayout {
            spacing: 14
            Layout.margins: 20

            Text {
                text: "AUTHOR SKILL"
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
                    Widgets.StyledField { id: nameField; Layout.fillWidth: true; placeholder: "deploy-staging" }
                }
                ColumnLayout {
                    Layout.preferredWidth: 150; spacing: 5
                    Text { text: "Group (optional)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    Widgets.StyledField { id: groupField; Layout.fillWidth: true; placeholder: "ops" }
                }
            }

            ColumnLayout {
                Layout.fillWidth: true; spacing: 5
                Text { text: "Description"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                Widgets.StyledField { id: descField; Layout.fillWidth: true; placeholder: "What this skill does / when to use it" }
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 5
                Text { text: "Body (Markdown)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                Rectangle {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    radius: Theme.radiusSm
                    color: Theme.surfaceInput
                    border.width: 1
                    border.color: bodyField.activeFocus ? Theme.accent : Theme.hairlineSoft
                    Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                    ScrollView {
                        anchors.fill: parent
                        anchors.margins: 10
                        clip: true
                        TextArea {
                            id: bodyField
                            placeholderText: "## Steps\n1. …\n\nUse {{VAR}} for template vars the loader substitutes at /invoke."
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
                    label: "Create skill"
                    primary: true
                    enabledBtn: bridge.connected && nameField.text.trim().length > 0
                    onClicked: {
                        bridge.skillCreate(nameField.text.trim(),
                                           descField.text.trim(),
                                           bodyField.text,
                                           groupField.text.trim())
                        createDialog.close()
                    }
                }
            }
        }
    }
}
