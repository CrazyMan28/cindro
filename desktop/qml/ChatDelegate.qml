import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// One row in the chat transcript. Renders by `kind`:
//   message (user right / accent-tinted, assistant left / surface),
//   tool_call chip, tool_result row, diff block, approval card, error.
// Colors come from the Theme singleton. Each row fades + slides in.
Item {
    id: del

    // model roles (provided by ListModel append in JarvisPanel)
    required property string kind
    required property string role
    required property string text
    required property string callId
    required property string toolName
    required property string approvalId
    required property string risk
    required property bool ok

    signal allow(string approvalId)
    signal deny(string approvalId)
    signal always(string approvalId)

    implicitHeight: loader.item ? loader.item.implicitHeight : 0

    readonly property bool isUser: kind === "message" && role === "user"
    readonly property bool isAssistant: kind === "message" && role === "assistant"

    // entrance animation
    opacity: 0
    transform: Translate { id: slide; y: 8 }
    Component.onCompleted: appear.start()
    ParallelAnimation {
        id: appear
        NumberAnimation { target: del; property: "opacity"; from: 0; to: 1; duration: 220; easing.type: Easing.OutCubic }
        NumberAnimation { target: slide; property: "y"; from: 8; to: 0; duration: 260; easing.type: Easing.OutCubic }
    }

    Loader {
        id: loader
        width: parent.width
        sourceComponent: {
            switch (del.kind) {
            case "message":      return messageComp
            case "tool_call":    return toolCallComp
            case "tool_result":  return toolResultComp
            case "diff":         return diffComp
            case "approval":     return approvalComp
            case "error":        return errorComp
            default:             return messageComp
            }
        }
    }

    // ===== Message bubble (role-edged with glow) =============================
    Component {
        id: messageComp
        Item {
            implicitHeight: bubble.y + bubble.implicitHeight
            anchors.left: parent.left
            anchors.right: parent.right

            // role label
            Row {
                id: roleTag
                visible: del.isAssistant || del.isUser
                spacing: 5
                anchors.left: del.isUser ? undefined : parent.left
                anchors.right: del.isUser ? parent.right : undefined
                anchors.leftMargin: 5
                anchors.rightMargin: 5
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 4; height: 4; radius: 2
                    color: del.isUser ? Theme.amber : Theme.accent
                }
                Text {
                    text: del.isUser ? "OPERATOR" : "J.A.R.V.I.S"
                    color: del.isUser ? Theme.amber : Theme.accent
                    opacity: 0.8
                    font.family: Theme.fontDisplay
                    font.pixelSize: 9
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
            }

            Rectangle {
                id: bubble
                y: roleTag.visible ? roleTag.implicitHeight + 5 : 0
                radius: Theme.radiusSm
                width: Math.min(parent.width * 0.90, msgText.implicitWidth + 30)
                implicitHeight: msgText.implicitHeight + 22
                anchors.right: del.isUser ? parent.right : undefined
                anchors.left: del.isUser ? undefined : parent.left

                color: del.isUser ? Qt.rgba(1.0, 0.706, 0.329, 0.10)
                                  : (del.isAssistant ? Theme.surfaceStrong : Theme.surface)
                border.width: 1
                border.color: del.isUser ? Theme.amberDim : Theme.accentDim

                // role-colored edge bar (glowing)
                Rectangle {
                    anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.topMargin: 4; anchors.bottomMargin: 4
                    anchors.left: del.isUser ? undefined : parent.left
                    anchors.right: del.isUser ? parent.right : undefined
                    anchors.leftMargin: 1; anchors.rightMargin: 1
                    width: 2.5
                    radius: 1.5
                    color: del.isUser ? Theme.amber : Theme.accent
                    layer.enabled: true
                    layer.effect: MultiEffect { blurEnabled: true; blur: 0.5; blurMax: 10; brightness: 0.15 }
                }

                Text {
                    id: msgText
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.leftMargin: del.isUser ? 13 : 15
                    anchors.rightMargin: del.isUser ? 15 : 13
                    anchors.topMargin: 11
                    anchors.bottomMargin: 11
                    text: del.text
                    color: Theme.text
                    wrapMode: Text.Wrap
                    font.family: Theme.fontSans
                    font.pixelSize: 14
                    lineHeight: 1.4
                    textFormat: Text.PlainText
                }
            }
        }
    }

    // ===== Tool call — HUD "module" =========================================
    Component {
        id: toolCallComp
        Rectangle {
            anchors.left: parent.left
            radius: Theme.radiusXs
            width: Math.min(parent.width, chipRow.implicitWidth + 30)
            implicitHeight: chipRow.implicitHeight + 16
            color: Theme.surfaceDeep
            border.color: Theme.accentDim
            border.width: 1

            // left module tab
            Rectangle {
                anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                anchors.margins: 1
                width: 3; radius: 1
                color: Theme.accent
            }

            RowLayout {
                id: chipRow
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                spacing: 9

                Text {
                    text: "▸ MODULE"
                    color: Theme.accent
                    opacity: 0.7
                    font.family: Theme.fontDisplay
                    font.pixelSize: 8
                    font.letterSpacing: Theme.trackMid
                }
                Text {
                    text: del.toolName
                    color: Theme.accentBright
                    font.weight: Font.Medium
                    font.pixelSize: 12
                    font.family: Theme.fontMono
                }
                Text {
                    Layout.maximumWidth: del.width * 0.5
                    text: del.text
                    color: Theme.textFaint
                    elide: Text.ElideRight
                    font.pixelSize: 11
                    font.family: Theme.fontMono
                }
            }
        }
    }

    // ===== Tool result ========================================================
    Component {
        id: toolResultComp
        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            radius: Theme.radiusXs
            implicitHeight: resCol.implicitHeight + 18
            color: Qt.rgba(0, 0, 0, 0.18)
            border.color: Theme.hairlineSoft
            border.width: 1
            clip: true

            // status edge
            Rectangle {
                width: 3
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.topMargin: 1
                anchors.bottomMargin: 1
                radius: 2
                color: del.ok ? Theme.ok : Theme.danger
                opacity: 0.8
            }
            ColumnLayout {
                id: resCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.leftMargin: 16
                anchors.rightMargin: 12
                anchors.topMargin: 9
                spacing: 3
                Text {
                    text: del.ok ? "OUTPUT" : "FAULT"
                    color: del.ok ? Theme.success : Theme.danger
                    font.pixelSize: 9
                    font.letterSpacing: Theme.trackMid
                    font.family: Theme.fontDisplay
                    font.weight: Font.DemiBold
                    opacity: 0.9
                }
                Text {
                    Layout.fillWidth: true
                    text: del.text
                    color: Theme.textMuted
                    wrapMode: Text.Wrap
                    maximumLineCount: 12
                    elide: Text.ElideRight
                    font.pixelSize: 12
                    font.family: Theme.fontMono
                    lineHeight: 1.35
                    textFormat: Text.PlainText
                }
            }
        }
    }

    // ===== Diff (reviewable per-file panel w/ Stage/Commit/Revert/PR) ========
    Component {
        id: diffComp
        DiffReviewPanel {
            path: del.toolName
            patch: del.text
        }
    }

    // ===== Approval / AUTHORIZE panel ========================================
    Component {
        id: approvalComp
        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            radius: Theme.radius
            implicitHeight: apprCol.implicitHeight + 24
            color: Qt.rgba(1.0, 0.706, 0.329, 0.06)
            border.color: Theme.amberDim
            border.width: 1

            // pulsing amber top edge (glowing) — demands attention
            Rectangle {
                id: apprEdge
                anchors.top: parent.top
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                anchors.topMargin: 1
                height: 2; radius: 1
                color: Theme.amber
                layer.enabled: true
                layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 12; brightness: 0.2 }
                SequentialAnimation on opacity {
                    loops: Animation.Infinite
                    NumberAnimation { from: 1.0; to: 0.45; duration: 900; easing.type: Easing.InOutSine }
                    NumberAnimation { from: 0.45; to: 1.0; duration: 900; easing.type: Easing.InOutSine }
                }
            }

            ColumnLayout {
                id: apprCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                anchors.topMargin: 14
                spacing: 11

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text {
                        text: "⚠ AUTHORIZE REQUIRED"
                        color: Theme.amber
                        font.weight: Font.DemiBold
                        font.letterSpacing: Theme.trackMid
                        font.pixelSize: 11
                        font.family: Theme.fontDisplay
                    }
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        visible: del.risk.length > 0
                        radius: 6
                        implicitWidth: riskText.implicitWidth + 14
                        implicitHeight: riskText.implicitHeight + 7
                        color: "transparent"
                        border.color: del.risk === "high" ? Theme.danger : Theme.warn
                        border.width: 1
                        Text {
                            id: riskText
                            anchors.centerIn: parent
                            text: del.risk
                            color: del.risk === "high" ? Theme.danger : Theme.warn
                            font.pixelSize: 10
                            font.letterSpacing: 0.8
                            font.family: Theme.fontSans
                            font.weight: Font.Medium
                        }
                    }
                }

                Text {
                    Layout.fillWidth: true
                    text: del.text
                    color: Theme.text
                    wrapMode: Text.Wrap
                    font.pixelSize: 13
                    font.family: Theme.fontSans
                    lineHeight: 1.4
                    textFormat: Text.PlainText
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    ApprovalButton {
                        label: "Authorize"; primary: true
                        onClicked: del.allow(del.approvalId)
                    }
                    ApprovalButton {
                        label: "Always"
                        onClicked: del.always(del.approvalId)
                    }
                    ApprovalButton {
                        label: "Deny"; danger: true
                        onClicked: del.deny(del.approvalId)
                    }
                }
            }
        }
    }

    // ===== Error ==============================================================
    Component {
        id: errorComp
        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            radius: Theme.radiusXs
            implicitHeight: errRow.implicitHeight + 18
            color: Qt.rgba(1, 0.42, 0.42, 0.08)
            border.color: Qt.rgba(1, 0.42, 0.42, 0.30)
            border.width: 1
            RowLayout {
                id: errRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 11
                spacing: 9
                Text {
                    text: "!"
                    color: Theme.danger
                    font.bold: true
                    font.pixelSize: 14
                    Layout.alignment: Qt.AlignTop
                }
                Text {
                    Layout.fillWidth: true
                    text: del.text
                    color: Theme.danger
                    wrapMode: Text.Wrap
                    font.pixelSize: 12
                    font.family: Theme.fontMono
                    lineHeight: 1.35
                    textFormat: Text.PlainText
                }
            }
        }
    }

    // ---- approval button (custom, no default Qt look) ----------------------
    component ApprovalButton: Item {
        id: ab
        property string label: ""
        property bool primary: false
        property bool danger: false
        signal clicked()
        Layout.fillWidth: true
        implicitHeight: 36

        Rectangle {
            anchors.fill: parent
            radius: Theme.radiusXs
            color: ab.primary
                   ? (abMa.pressed ? Qt.darker(Theme.amber, 1.15) : Theme.amber)
                   : (abMa.containsMouse ? Theme.surfaceStrong : "transparent")
            border.width: 1
            border.color: ab.primary ? Theme.amber
                          : ab.danger ? Qt.rgba(1, 0.30, 0.369, 0.45)
                          : Theme.hairlineSoft
            Behavior on color { ColorAnimation { duration: 110 } }
            scale: abMa.pressed ? 0.97 : 1.0
            Behavior on scale { NumberAnimation { duration: 80 } }

            Text {
                anchors.centerIn: parent
                text: ab.label.toUpperCase()
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackTight
                color: ab.primary ? Theme.inkOnAccent
                       : ab.danger ? Theme.danger
                       : Theme.textMuted
            }
        }
        MouseArea {
            id: abMa
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: ab.clicked()
        }
    }
}
