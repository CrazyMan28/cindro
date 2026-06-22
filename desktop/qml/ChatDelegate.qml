import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts

// One row in the chat ListView. Renders by `kind`:
//   message (role user/assistant/system), tool_call, tool_result, diff,
//   approval (Allow/Deny/Always card), error.
Item {
    id: del

    // model roles (provided by ListModel append)
    required property string kind
    required property string role
    required property string text
    required property string callId
    required property string toolName
    required property string approvalId
    required property string risk

    // theme colors injected by the parent
    property color neon
    property color neon2
    property color accent
    property color okColor
    property color danger
    property color textMain
    property color textDim
    property color bgRaised
    property color bgPanel
    property color line

    signal allow(string approvalId)
    signal deny(string approvalId)
    signal always(string approvalId)

    implicitHeight: content.implicitHeight

    readonly property bool isUser: kind === "message" && role === "user"
    readonly property bool isAssistant: kind === "message" && role === "assistant"

    Item {
        id: content
        width: parent.width
        implicitHeight: loader.item ? loader.item.implicitHeight : 0

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
    }

    // ===== Message bubble =====================================================
    Component {
        id: messageComp
        Item {
            implicitHeight: bubble.implicitHeight
            anchors.left: parent.left
            anchors.right: parent.right

            Rectangle {
                id: bubble
                radius: 12
                width: Math.min(parent.width * 0.86, msgText.implicitWidth + 26)
                implicitHeight: msgText.implicitHeight + 20
                anchors.right: del.isUser ? parent.right : undefined
                anchors.left: del.isUser ? undefined : parent.left

                color: del.isUser ? del.neon2 : (del.isAssistant ? del.bgRaised : del.bgPanel)
                border.width: 1
                border.color: del.isUser ? del.neon2 : del.line

                Text {
                    id: msgText
                    anchors.fill: parent
                    anchors.margins: 10
                    text: del.text
                    color: del.isUser ? "#0a0612" : del.textMain
                    wrapMode: Text.Wrap
                    font.pixelSize: 13
                    font.family: del.isAssistant ? "sans-serif" : "sans-serif"
                    textFormat: Text.PlainText
                }
            }
        }
    }

    // ===== Tool call chip =====================================================
    Component {
        id: toolCallComp
        Rectangle {
            anchors.left: parent.left
            radius: 9
            width: Math.min(parent.width, chipRow.implicitWidth + 20)
            implicitHeight: chipRow.implicitHeight + 14
            color: del.bgPanel
            border.color: del.neon
            border.width: 1

            RowLayout {
                id: chipRow
                anchors.fill: parent
                anchors.margins: 8
                spacing: 8
                Text {
                    text: "⚙"
                    color: del.neon
                    font.pixelSize: 13
                }
                Text {
                    text: del.toolName
                    color: del.neon
                    font.bold: true
                    font.pixelSize: 12
                    font.family: "monospace"
                }
                Text {
                    Layout.maximumWidth: del.width * 0.55
                    text: del.text
                    color: del.textDim
                    elide: Text.ElideRight
                    font.pixelSize: 11
                    font.family: "monospace"
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
            radius: 9
            implicitHeight: resText.implicitHeight + 16
            color: del.bgPanel
            border.color: del.line
            border.width: 1

            Rectangle {
                width: 3
                height: parent.height
                radius: 2
                color: del.toolName === "error" ? del.danger : del.okColor
            }
            Text {
                id: resText
                anchors.fill: parent
                anchors.margins: 10
                anchors.leftMargin: 14
                text: del.text
                color: del.textDim
                wrapMode: Text.Wrap
                maximumLineCount: 12
                elide: Text.ElideRight
                font.pixelSize: 11
                font.family: "monospace"
                textFormat: Text.PlainText
            }
        }
    }

    // ===== Diff ===============================================================
    Component {
        id: diffComp
        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            radius: 9
            implicitHeight: diffCol.implicitHeight + 16
            color: "#0a1418"
            border.color: del.okColor
            border.width: 1

            ColumnLayout {
                id: diffCol
                anchors.fill: parent
                anchors.margins: 8
                spacing: 4
                Text {
                    text: "⛁ " + del.toolName
                    color: del.okColor
                    font.bold: true
                    font.pixelSize: 11
                    font.family: "monospace"
                }
                Text {
                    Layout.fillWidth: true
                    text: del.text
                    color: del.textMain
                    wrapMode: Text.NoWrap
                    maximumLineCount: 16
                    elide: Text.ElideRight
                    font.pixelSize: 11
                    font.family: "monospace"
                    textFormat: Text.PlainText
                }
            }
        }
    }

    // ===== Approval card ======================================================
    Component {
        id: approvalComp
        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            radius: 12
            implicitHeight: apprCol.implicitHeight + 20
            color: del.bgRaised
            border.color: del.accent
            border.width: 1

            ColumnLayout {
                id: apprCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 12
                spacing: 8

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text { text: "⚠"; color: del.accent; font.pixelSize: 16 }
                    Text {
                        text: "APPROVAL REQUIRED"
                        color: del.accent
                        font.bold: true
                        font.letterSpacing: 1
                        font.pixelSize: 11
                        font.family: "monospace"
                    }
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        visible: del.risk.length > 0
                        radius: 6
                        implicitWidth: riskText.implicitWidth + 12
                        implicitHeight: riskText.implicitHeight + 6
                        color: "transparent"
                        border.color: del.danger
                        border.width: 1
                        Text {
                            id: riskText
                            anchors.centerIn: parent
                            text: del.risk
                            color: del.danger
                            font.pixelSize: 10
                            font.family: "monospace"
                        }
                    }
                }

                Text {
                    Layout.fillWidth: true
                    text: del.text
                    color: del.textMain
                    wrapMode: Text.Wrap
                    font.pixelSize: 13
                    textFormat: Text.PlainText
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Button {
                        id: allowBtn
                        text: "ALLOW"
                        Layout.fillWidth: true
                        Layout.preferredHeight: 34
                        onClicked: del.allow(del.approvalId)
                        contentItem: Text {
                            text: allowBtn.text; horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                            font.bold: true; font.pixelSize: 12; font.family: "monospace"
                            color: del.bgPanel
                        }
                        background: Rectangle {
                            radius: 8
                            color: allowBtn.down ? Qt.darker(del.okColor, 1.2) : del.okColor
                        }
                    }
                    Button {
                        id: alwaysBtn
                        text: "ALWAYS"
                        Layout.fillWidth: true
                        Layout.preferredHeight: 34
                        onClicked: del.always(del.approvalId)
                        contentItem: Text {
                            text: alwaysBtn.text; horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                            font.bold: true; font.pixelSize: 12; font.family: "monospace"
                            color: del.neon
                        }
                        background: Rectangle {
                            radius: 8
                            color: "transparent"
                            border.color: del.neon
                            border.width: 1
                        }
                    }
                    Button {
                        id: denyBtn
                        text: "DENY"
                        Layout.fillWidth: true
                        Layout.preferredHeight: 34
                        onClicked: del.deny(del.approvalId)
                        contentItem: Text {
                            text: denyBtn.text; horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                            font.bold: true; font.pixelSize: 12; font.family: "monospace"
                            color: del.danger
                        }
                        background: Rectangle {
                            radius: 8
                            color: "transparent"
                            border.color: del.danger
                            border.width: 1
                        }
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
            radius: 9
            implicitHeight: errText.implicitHeight + 16
            color: "#1a0c12"
            border.color: del.danger
            border.width: 1
            Text {
                id: errText
                anchors.fill: parent
                anchors.margins: 10
                text: "⨯ " + del.text
                color: del.danger
                wrapMode: Text.Wrap
                font.pixelSize: 12
                font.family: "monospace"
                textFormat: Text.PlainText
            }
        }
    }
}
