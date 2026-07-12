pragma Singleton
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import CindroSidebar

// Shared, fully-restyled HUD controls used by the multi-page shell. Exposed as
// inline components on a single QML type so pages can do `Widgets.PillButton{}`.
// No default-Qt chrome anywhere — every control is hand-drawn from Theme.qml,
// with neon glow on accented states.
QtObject {
    id: kit

    // ---- PillButton ---------------------------------------------------------
    component PillButton: Item {
        id: pb
        property string label: ""
        property bool primary: false
        property bool danger: false
        property bool busy: false
        property bool enabledBtn: true
        signal clicked()

        implicitWidth: pbText.implicitWidth + 34
        implicitHeight: 34
        opacity: enabledBtn ? 1.0 : 0.40

        // glow halo behind primary buttons (hover/press)
        Rectangle {
            anchors.fill: parent
            anchors.margins: -2
            radius: Theme.radiusSm + 2
            color: "transparent"
            border.color: Theme.accentGlow
            border.width: 2
            opacity: (pb.primary && pb.enabledBtn && pbMa.containsMouse) ? 0.6 : 0.0
            Behavior on opacity { NumberAnimation { duration: Theme.durFast } }
            layer.enabled: opacity > 0.01
            layer.effect: MultiEffect { blurEnabled: true; blur: 0.8; blurMax: 18 }
        }

        Rectangle {
            anchors.fill: parent
            radius: Theme.radiusSm
            color: pb.primary
                   ? (pbMa.pressed ? Qt.darker(Theme.accent, 1.2) : Theme.accentDim)
                   : (pbMa.containsMouse ? Theme.surfaceStrong : Theme.surface)
            border.width: 1
            border.color: pb.primary ? Theme.accent
                          : pb.danger ? Qt.rgba(1, 0.30, 0.369, 0.45)
                          : (pbMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft)
            Behavior on color { ColorAnimation { duration: Theme.durFast } }
            Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
            scale: pbMa.pressed && pb.enabledBtn ? 0.97 : 1.0
            Behavior on scale { NumberAnimation { duration: 80 } }

            Text {
                id: pbText
                anchors.centerIn: parent
                text: pb.busy ? "•••" : pb.label.toUpperCase()
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackMid
                color: pb.primary ? Theme.accentBright
                       : pb.danger ? Theme.danger
                       : Theme.text
            }
        }
        MouseArea {
            id: pbMa
            anchors.fill: parent
            enabled: pb.enabledBtn
            hoverEnabled: true
            cursorShape: pb.enabledBtn ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: pb.clicked()
        }
    }

    // ---- StyledField (masked-capable text input) ----------------------------
    component StyledField: Rectangle {
        id: sf
        property alias text: tf.text
        property string placeholder: ""
        property bool masked: false
        signal accepted()

        implicitHeight: 38
        radius: Theme.radiusSm
        color: Theme.surfaceInput
        border.width: 1
        border.color: tf.activeFocus ? Theme.accent : Theme.hairlineSoft
        Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

        // focus glow line at the bottom edge
        Rectangle {
            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: 10; anchors.rightMargin: 10
            anchors.bottomMargin: 1
            height: 1
            color: Theme.accent
            opacity: tf.activeFocus ? 0.8 : 0.0
            Behavior on opacity { NumberAnimation { duration: Theme.durFast } }
        }

        TextField {
            id: tf
            anchors.fill: parent
            anchors.leftMargin: 12
            anchors.rightMargin: 12
            verticalAlignment: TextInput.AlignVCenter
            placeholderText: sf.placeholder
            placeholderTextColor: Theme.textFaint
            color: Theme.text
            font.family: Theme.fontSans
            font.pixelSize: 13
            selectByMouse: true
            selectionColor: Theme.accentDim
            echoMode: sf.masked ? TextInput.Password : TextInput.Normal
            background: null
            onAccepted: sf.accepted()
        }
    }

    // ---- StyledSwitch -------------------------------------------------------
    component StyledSwitch: Item {
        id: sw
        property bool checked: false
        signal toggled(bool value)
        implicitWidth: 44
        implicitHeight: 24

        Rectangle {
            anchors.fill: parent
            radius: height / 2
            color: sw.checked ? Theme.accentDim : Theme.surfaceInput
            border.width: 1
            border.color: sw.checked ? Theme.accent : Theme.hairlineSoft
            Behavior on color { ColorAnimation { duration: Theme.durMid } }
            Behavior on border.color { ColorAnimation { duration: Theme.durMid } }

            Rectangle {
                id: knob
                width: 16; height: 16; radius: 8
                y: (parent.height - height) / 2
                x: sw.checked ? parent.width - width - 4 : 4
                color: sw.checked ? Theme.accentBright : Theme.textMuted
                Behavior on x { NumberAnimation { duration: 150; easing.type: Easing.OutCubic } }
                Behavior on color { ColorAnimation { duration: Theme.durMid } }
                layer.enabled: sw.checked
                layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 12; brightness: 0.2 }
            }
        }
        MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: { sw.checked = !sw.checked; sw.toggled(sw.checked) }
        }
    }

    // ---- StyledCombo --------------------------------------------------------
    component StyledCombo: ComboBox {
        id: cb
        implicitHeight: 38
        property color fieldColor: Theme.surfaceInput

        background: Rectangle {
            radius: Theme.radiusSm
            color: cb.pressed ? Theme.surfaceStrong : cb.fieldColor
            border.color: cb.activeFocus || cb.hovered ? Theme.accent : Theme.hairlineSoft
            border.width: 1
            Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
        }
        contentItem: Text {
            leftPadding: 12
            rightPadding: 28
            text: cb.displayText
            color: Theme.text
            font.pixelSize: 13
            font.family: Theme.fontSans
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }
        indicator: Canvas {
            x: cb.width - 20
            y: (cb.height - 6) / 2
            width: 10; height: 6
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                ctx.strokeStyle = Theme.accent; ctx.lineWidth = 1.4
                ctx.lineCap = "round"; ctx.lineJoin = "round"
                ctx.beginPath(); ctx.moveTo(1,1); ctx.lineTo(5,5); ctx.lineTo(9,1); ctx.stroke()
            }
        }
        popup: Popup {
            y: cb.height + 6
            width: cb.width
            implicitHeight: Math.min(contentItem.implicitHeight + 10, 280)
            padding: 5
            background: Rectangle {
                radius: Theme.radiusSm
                color: Qt.rgba(0.039, 0.071, 0.110, 0.97)
                border.color: Theme.accentDim
                border.width: 1
            }
            contentItem: ListView {
                clip: true
                implicitHeight: contentHeight
                model: cb.popup.visible ? cb.delegateModel : null
                spacing: 2
                ScrollIndicator.vertical: ScrollIndicator {}
            }
        }
        delegate: ItemDelegate {
            id: itemDel
            required property var modelData
            required property int index
            width: cb.width - 10
            height: 30
            contentItem: Text {
                text: itemDel.modelData
                color: itemDel.highlighted ? Theme.accentBright : Theme.text
                font.pixelSize: 13
                font.family: Theme.fontSans
                verticalAlignment: Text.AlignVCenter
                leftPadding: 6
            }
            highlighted: cb.highlightedIndex === itemDel.index
            background: Rectangle {
                radius: Theme.radiusXs
                color: itemDel.highlighted ? Theme.accentFaint : "transparent"
            }
        }
    }

    // ---- SectionCard (HUD framed) ------------------------------------------
    component SectionCard: Rectangle {
        default property alias content: cardCol.data
        property string title: ""
        property string subtitle: ""
        implicitHeight: cardCol.implicitHeight + 30
        radius: Theme.radius
        color: Theme.panelSoft
        border.color: Theme.hairlineSoft
        border.width: 1

        // top inner sheen
        Rectangle {
            anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
            anchors.topMargin: 1; anchors.leftMargin: Theme.radius; anchors.rightMargin: Theme.radius
            height: 1
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: Theme.accentDim }
                GradientStop { position: 1.0; color: "transparent" }
            }
        }

        ColumnLayout {
            id: cardCol
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: 16
            spacing: 12
        }
    }
}
