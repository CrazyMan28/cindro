import QtQuick
import QtQuick.Layouts
import JarvisSidebar

// HUD page header: a tracked uppercase title with a small leading bracket, an
// optional subtitle, and a neon underline that fades out to the right.
ColumnLayout {
    id: hdr
    property string title: ""
    property string subtitle: ""
    Layout.fillWidth: true
    spacing: 4

    RowLayout {
        Layout.fillWidth: true
        spacing: 9

        // leading bracket mark
        Canvas {
            width: 8; height: 18
            Layout.alignment: Qt.AlignVCenter
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                ctx.strokeStyle = Theme.accent
                ctx.lineWidth = 1.6
                ctx.lineCap = "round"
                ctx.beginPath()
                ctx.moveTo(7, 1); ctx.lineTo(1, 1); ctx.lineTo(1, 17); ctx.lineTo(7, 17)
                ctx.stroke()
            }
        }

        Text {
            text: hdr.title.toUpperCase()
            color: Theme.text
            font.family: Theme.fontDisplay
            font.pixelSize: 18
            font.weight: Font.DemiBold
            font.letterSpacing: Theme.trackMid
        }
    }

    Text {
        visible: hdr.subtitle.length > 0
        text: hdr.subtitle
        color: Theme.textFaint
        font.family: Theme.fontSans
        font.pixelSize: 12
        Layout.fillWidth: true
        Layout.leftMargin: 17
        wrapMode: Text.WordWrap
    }

    Rectangle {
        Layout.fillWidth: true
        Layout.topMargin: 6
        height: 1
        gradient: Gradient {
            orientation: Gradient.Horizontal
            GradientStop { position: 0.0; color: Theme.accent }
            GradientStop { position: 0.35; color: Theme.accentDim }
            GradientStop { position: 0.7; color: Theme.hairlineSoft }
            GradientStop { position: 1.0; color: "transparent" }
        }
    }
}
