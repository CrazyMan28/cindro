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
    // True ONLY for live assistant messages — drives the typewriter reveal below.
    required property bool streaming

    signal allow(string approvalId)
    signal deny(string approvalId)
    signal always(string approvalId)
    // A button inside an inline widget (render_widget) fired its action map.
    signal widgetAction(var action)
    // Emitted as the typewriter reveal grows the bubble, so the panel can keep the
    // transcript pinned to the bottom while text streams in.
    signal grew()

    implicitHeight: loader.item ? loader.item.implicitHeight : 0

    readonly property bool isUser: kind === "message" && role === "user"
    readonly property bool isAssistant: kind === "message" && role === "assistant"

    // ---- Typewriter reveal (live assistant messages only) ------------------
    // `shown` is the number of characters currently revealed. For a streaming
    // assistant message it animates 0 -> text.length; otherwise it's the full
    // length immediately (history, user messages, tool rows).
    property int shown: (streaming && isAssistant) ? 0 : text.length
    readonly property string displayText:
        (streaming && isAssistant) ? text.substring(0, shown) : text

    Timer {
        id: typer
        // ~3 chars per tick at 12ms ≈ 250 chars/s — smooth but not sluggish.
        interval: 12
        repeat: true
        running: del.streaming && del.isAssistant && del.shown < del.text.length
        onTriggered: {
            del.shown = Math.min(del.text.length, del.shown + 3)
            del.grew()
        }
    }

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
            case "widget":       return widgetComp
            case "tool":         return unifiedToolComp
            case "tool_call":    return toolCallComp
            case "tool_result":  return toolResultComp
            case "diff":         return diffComp
            case "approval":     return approvalComp
            case "question":     return questionComp
            case "error":        return errorComp
            default:             return messageComp
            }
        }
    }

    // ===== Inline widget (render_widget) ====================================
    // The model's render_widget output, drawn INLINE in the transcript via the
    // safe WidgetRenderer JSON-DSL — not floated on top of the chat. del.text is
    // the spec as a JSON STRING (a ListModel var role mangles nested children/ops
    // arrays, so we parse it back into a clean tree here); del.toolName is the
    // title; del.callId is the widget id (used for "pop out").
    Component {
        id: widgetComp
        Rectangle {
            id: wCard
            anchors.left: parent.left
            anchors.right: parent.right
            radius: Theme.radiusSm
            property bool saved: false   // ★ -> saved into the Widgets library
            readonly property var specTree: {
                try { return JSON.parse(del.text) } catch (e) { return ({}) }
            }
            implicitHeight: wCol.implicitHeight + 20
            color: Theme.surfaceDeep
            border.width: 1
            border.color: Theme.accentDim
            clip: true

            // Reveal the save / pop-out actions on hover (HoverHandler doesn't
            // swallow clicks meant for the widget itself).
            HoverHandler { id: wHover }

            // left accent seam — reads as a Jarvis-produced module
            Rectangle {
                anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                anchors.margins: 1
                width: 3; radius: 1
                color: Theme.accent
                opacity: 0.7
            }

            ColumnLayout {
                id: wCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.leftMargin: 14
                anchors.rightMargin: 12
                anchors.topMargin: 10
                spacing: 8

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 7
                    Text {
                        // An ad-hoc model render is a CANVAS (the reusable, saved
                        // kind live on the Widgets tab). Save ★ promotes it to one.
                        text: "◆ CANVAS"
                        color: Theme.accent
                        opacity: 0.75
                        font.family: Theme.fontDisplay
                        font.pixelSize: 8
                        font.letterSpacing: Theme.trackMid
                    }
                    Text {
                        visible: del.toolName.length > 0
                        Layout.maximumWidth: del.width * 0.6
                        text: del.toolName
                        color: Theme.accentBright
                        font.family: Theme.fontDisplay
                        font.pixelSize: 11
                        font.weight: Font.DemiBold
                        font.letterSpacing: Theme.trackTight
                        elide: Text.ElideRight
                    }
                    Item { Layout.fillWidth: true }
                    // save ★ -> persist this canvas into the reusable Widgets tab.
                    // Revealed on hover; turns into a ✓ once saved.
                    Rectangle {
                        Layout.preferredWidth: 20; Layout.preferredHeight: 20
                        radius: Theme.radiusXs
                        visible: wHover.hovered || wCard.saved
                        color: saveMa.containsMouse ? Theme.surface : "transparent"
                        border.width: 1
                        border.color: saveMa.containsMouse ? Theme.hairline : "transparent"
                        Text {
                            anchors.centerIn: parent
                            text: wCard.saved ? "✓" : "★"
                            color: wCard.saved ? Theme.success
                                   : (saveMa.containsMouse ? Theme.amber : Theme.textMuted)
                            font.pixelSize: 12
                        }
                        MouseArea {
                            id: saveMa
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                bridge.saveWidget(
                                    del.toolName.length > 0 ? del.toolName : "Canvas widget",
                                    wCard.specTree)
                                wCard.saved = true
                            }
                        }
                    }
                    // pop out -> standalone always-on-top window hosting this widget
                    Rectangle {
                        visible: wHover.hovered
                        Layout.preferredWidth: 20; Layout.preferredHeight: 20
                        radius: Theme.radiusXs
                        color: popMa.containsMouse ? Theme.surface : "transparent"
                        border.width: 1
                        border.color: popMa.containsMouse ? Theme.hairline : "transparent"
                        Text {
                            anchors.centerIn: parent
                            text: "⧉"
                            color: popMa.containsMouse ? Theme.accentBright : Theme.textMuted
                            font.pixelSize: 12
                        }
                        MouseArea {
                            id: popMa
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: bridge.popOutWidget(del.callId, del.toolName, wCard.specTree)
                        }
                    }
                }

                // the safe DSL interpreter renders the spec tree inline
                WidgetRenderer {
                    Layout.fillWidth: true
                    node: wCard.specTree
                    onActionRequested: function(action) { del.widgetAction(action) }
                }
            }
        }
    }

    // ===== Unified tool card (call + result merged) =========================
    // Collapsed by default: a small spinning reactor while running, a check / error
    // glyph when done, the tool name + status. Click to expand the INPUT (params)
    // and OUTPUT. `del.text` is a JSON envelope {i:input, o:output, d:done, s:server}.
    Component {
        id: unifiedToolComp
        Rectangle {
            id: toolCard
            anchors.left: parent.left
            anchors.right: parent.right
            radius: Theme.radiusXs
            property var td: {
                try { return JSON.parse(del.text) }
                catch (e) { return { i: "", o: del.text, d: true, s: "" } }
            }
            readonly property bool toolDone: td.d === true
            readonly property string inputText: td.i || ""
            readonly property string outputText: td.o || ""
            // Cap the text actually handed to the Text element: Text measures the
            // WHOLE string for layout even when maximumLineCount elides it, so a
            // 50KB tool output otherwise stalls the whole chat. Bound to a few KB;
            // the full output is one tap away (the model can re-print it).
            readonly property string outputClamped: outputText.length > 4000
                ? outputText.substring(0, 4000) + "\n… (" + outputText.length + " chars, truncated)"
                : outputText
            readonly property string server: td.s || ""
            property bool expanded: false
            implicitHeight: toolCol.implicitHeight + 16
            color: Theme.surfaceDeep
            border.width: 1
            border.color: !toolDone ? Theme.accentDim
                          : (del.ok ? Theme.hairlineSoft : Theme.danger)
            clip: true

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: toolCard.expanded = !toolCard.expanded
            }

            ColumnLayout {
                id: toolCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.leftMargin: 12
                anchors.rightMargin: 12
                anchors.topMargin: 8
                spacing: 6

                // ---- header: status + name + server + state + chevron ----
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 9
                    ArcReactor {
                        visible: !toolCard.toolDone
                        Layout.preferredWidth: 16; Layout.preferredHeight: 16
                        size: 16; spinning: true; thinking: true; tint: Theme.accent
                    }
                    Text {
                        visible: toolCard.toolDone
                        text: del.ok ? "✓" : "✕"
                        color: del.ok ? Theme.success : Theme.danger
                        font.pixelSize: 14; font.weight: Font.Bold
                    }
                    Text {
                        text: del.toolName
                        color: Theme.accentBright
                        font.family: Theme.fontMono
                        font.pixelSize: 12
                        font.weight: Font.Medium
                    }
                    Text {
                        visible: toolCard.server.length > 0
                        text: "· " + toolCard.server
                        color: Theme.textFaint
                        font.family: Theme.fontMono
                        font.pixelSize: 10
                    }
                    Item { Layout.fillWidth: true }
                    Text {
                        text: !toolCard.toolDone ? "running…"
                              : (del.ok ? "done" : "failed")
                        color: !toolCard.toolDone ? Theme.accent
                               : (del.ok ? Theme.textFaint : Theme.danger)
                        font.family: Theme.fontDisplay
                        font.pixelSize: 9
                        font.letterSpacing: Theme.trackMid
                    }
                    Text {
                        text: toolCard.expanded ? "▴" : "▾"
                        color: Theme.textFaint
                        font.pixelSize: 11
                    }
                }

                // ---- collapsed: a single-line preview ----
                Text {
                    visible: !toolCard.expanded
                           && (toolCard.outputText.length > 0 || toolCard.inputText.length > 0)
                    Layout.fillWidth: true
                    text: toolCard.outputText.length > 0 ? toolCard.outputText
                                                         : toolCard.inputText
                    color: Theme.textFaint
                    elide: Text.ElideRight
                    maximumLineCount: 1
                    font.family: Theme.fontMono
                    font.pixelSize: 11
                    textFormat: Text.PlainText
                }

                // ---- expanded: INPUT params + OUTPUT ----
                ColumnLayout {
                    visible: toolCard.expanded
                    Layout.fillWidth: true
                    spacing: 3
                    Text {
                        visible: toolCard.inputText.length > 0
                        text: "INPUT"
                        color: Theme.accent
                        font.pixelSize: 9; font.family: Theme.fontDisplay
                        font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold
                    }
                    Text {
                        visible: toolCard.inputText.length > 0
                        Layout.fillWidth: true
                        text: toolCard.inputText
                        color: Theme.textMuted
                        wrapMode: Text.Wrap
                        font.family: Theme.fontMono
                        font.pixelSize: 11
                        textFormat: Text.PlainText
                    }
                    Text {
                        visible: toolCard.outputText.length > 0
                        Layout.topMargin: toolCard.inputText.length > 0 ? 5 : 0
                        text: del.ok ? "OUTPUT" : "FAULT"
                        color: del.ok ? Theme.success : Theme.danger
                        font.pixelSize: 9; font.family: Theme.fontDisplay
                        font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold
                    }
                    Text {
                        visible: toolCard.outputText.length > 0
                        Layout.fillWidth: true
                        text: toolCard.outputClamped
                        color: Theme.textMuted
                        wrapMode: Text.Wrap
                        maximumLineCount: 24
                        elide: Text.ElideRight
                        font.family: Theme.fontMono
                        font.pixelSize: 11
                        lineHeight: 1.35
                        textFormat: Text.PlainText
                    }
                }
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

                // role-colored edge bar. THE "random bright text" BUG: this bar used
                // CONDITIONAL left/right anchors (anchors.left: isUser?undefined:left,
                // anchors.right: isUser?right:undefined). On ListView delegate REUSE
                // (reuseItems:true) when isUser flips, the old anchor wasn't cleared
                // before the new one was set, so the 2.5px bar briefly anchored BOTH
                // left AND right → stretched the full bubble width → flooded it with
                // the bar's color (cyan for assistant, amber for user). Fixed by
                // positioning with an explicit x (no flipping anchors), so it can
                // never span the bubble.
                Rectangle {
                    anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.topMargin: 4; anchors.bottomMargin: 4
                    width: 2.5
                    x: del.isUser ? (bubble.width - width - 1) : 1
                    radius: 1.5
                    color: del.isUser ? Theme.amber : Theme.accent
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
                    text: del.displayText
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

                // small spinning reactor — the "Jarvis is calling a tool" mark
                ArcReactor {
                    Layout.alignment: Qt.AlignVCenter
                    Layout.preferredWidth: 14
                    Layout.preferredHeight: 14
                    size: 14
                    spinning: true
                    thinking: true
                    tint: Theme.accent
                }
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
            id: resCard
            anchors.left: parent.left
            anchors.right: parent.right
            radius: Theme.radiusXs
            // Collapsed by default to keep the transcript tidy; click to expand the
            // full output. A FAULT (failed) result auto-expands so errors are visible.
            property bool expanded: !del.ok
            readonly property bool clamped: del.text.length > 140 || del.text.indexOf('\n') >= 0
            implicitHeight: resCol.implicitHeight + 18
            color: Qt.rgba(0, 0, 0, 0.18)
            border.color: Theme.hairlineSoft
            border.width: 1
            clip: true

            MouseArea {
                anchors.fill: parent
                cursorShape: resCard.clamped ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: if (resCard.clamped) resCard.expanded = !resCard.expanded
            }

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
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text {
                        text: del.ok ? "OUTPUT" : "FAULT"
                        color: del.ok ? Theme.success : Theme.danger
                        font.pixelSize: 9
                        font.letterSpacing: Theme.trackMid
                        font.family: Theme.fontDisplay
                        font.weight: Font.DemiBold
                        opacity: 0.9
                    }
                    Item { Layout.fillWidth: true }
                    Text {
                        visible: resCard.clamped
                        text: resCard.expanded ? "▴ collapse" : "▾ expand"
                        color: Theme.textFaint
                        font.pixelSize: 9
                        font.family: Theme.fontDisplay
                        font.letterSpacing: Theme.trackMid
                    }
                }
                Text {
                    Layout.fillWidth: true
                    // Cap the string fed to the layout engine (it measures the whole
                    // thing even when elided) so a giant result can't stall the chat.
                    text: del.text.length > 6000
                          ? del.text.substring(0, 6000) + "\n… (" + del.text.length + " chars, truncated)"
                          : del.text
                    color: Theme.textMuted
                    wrapMode: Text.Wrap
                    maximumLineCount: resCard.expanded ? 60 : 2
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
                // Only run the GPU blur layer + pulse while the app is focused — no
                // sense burning frames on a glow no one is looking at.
                layer.enabled: Qt.application.active
                layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 12; brightness: 0.2 }
                SequentialAnimation on opacity {
                    running: Qt.application.active
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

    // ===== Question (ask_user) — cyan card with tappable answers =============
    Component {
        id: questionComp
        Rectangle {
            id: qRoot
            anchors.left: parent.left
            anchors.right: parent.right
            radius: Theme.radius
            property bool answered: false
            property string chosen: ""
            // del.text is a JSON envelope {q, options}; fall back to plain text.
            property var parsed: {
                try { return JSON.parse(del.text) }
                catch (e) { return { "q": del.text, "options": [] } }
            }
            implicitHeight: qCol.implicitHeight + 28
            color: Qt.rgba(0.0, 0.78, 0.92, 0.06)
            border.color: Theme.accent
            border.width: 1

            function answer(a) {
                if (qRoot.answered) return
                qRoot.answered = true
                qRoot.chosen = a
                bridge.answerQuestion(del.approvalId, a)
            }

            // pulsing cyan top edge — demands attention like the approval card
            Rectangle {
                anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 14; anchors.rightMargin: 14; anchors.topMargin: 1
                height: 2; radius: 1; color: Theme.accent
                layer.enabled: Qt.application.active
                layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 12; brightness: 0.2 }
                SequentialAnimation on opacity {
                    running: Qt.application.active
                    loops: Animation.Infinite
                    NumberAnimation { from: 1.0; to: 0.45; duration: 900; easing.type: Easing.InOutSine }
                    NumberAnimation { from: 0.45; to: 1.0; duration: 900; easing.type: Easing.InOutSine }
                }
            }

            ColumnLayout {
                id: qCol
                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                anchors.leftMargin: 14; anchors.rightMargin: 14; anchors.topMargin: 14
                spacing: 11

                Text {
                    text: "❔ ORIN IS ASKING"
                    color: Theme.accent
                    font.weight: Font.DemiBold
                    font.letterSpacing: Theme.trackMid
                    font.pixelSize: 11
                    font.family: Theme.fontDisplay
                }
                Text {
                    Layout.fillWidth: true
                    text: qRoot.parsed.q ? qRoot.parsed.q : del.text
                    color: Theme.text
                    wrapMode: Text.Wrap
                    font.pixelSize: 13
                    font.family: Theme.fontSans
                    lineHeight: 1.4
                    textFormat: Text.PlainText
                }
                Flow {
                    Layout.fillWidth: true
                    spacing: 8
                    visible: !qRoot.answered
                    Repeater {
                        model: qRoot.parsed.options ? qRoot.parsed.options : []
                        ApprovalButton {
                            label: modelData
                            primary: true
                            onClicked: qRoot.answer(modelData)
                        }
                    }
                }
                Rectangle {
                    Layout.fillWidth: true
                    visible: !qRoot.answered
                    radius: Theme.radiusSm
                    color: Qt.rgba(1, 1, 1, 0.05)
                    border.color: Theme.hairline
                    border.width: 1
                    implicitHeight: 34
                    TextInput {
                        id: customInput
                        anchors.fill: parent
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        verticalAlignment: TextInput.AlignVCenter
                        color: Theme.text
                        font.pixelSize: 13
                        font.family: Theme.fontSans
                        clip: true
                        onAccepted: if (text.trim().length) qRoot.answer(text.trim())
                        Text {
                            anchors.fill: parent
                            verticalAlignment: Text.AlignVCenter
                            visible: !customInput.text.length
                            text: "Type a custom answer, then Enter…"
                            color: Theme.textFaint
                            font: customInput.font
                        }
                    }
                }
                Text {
                    visible: qRoot.answered
                    text: "✓ " + qRoot.chosen
                    color: Theme.success
                    font.pixelSize: 12
                    font.family: Theme.fontSans
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
