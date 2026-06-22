import QtQuick

Rectangle {
    width: 420; height: 900
    color: "#0b0f1a"
    Column {
        anchors.centerIn: parent
        spacing: 18
        Rectangle { width: 360; height: 4; color: "#00e5ff"; anchors.horizontalCenter: parent.horizontalCenter }
        Text { text: "JARVIS"; color: "#00e5ff"; font.pixelSize: 56; font.bold: true
               anchors.horizontalCenter: parent.horizontalCenter }
        Text { text: "layer-shell sidebar probe\nanchored RIGHT • KWin"; color: "#9fb3c8"
               font.pixelSize: 18; horizontalAlignment: Text.AlignHCenter
               anchors.horizontalCenter: parent.horizontalCenter }
        Rectangle { width: 360; height: 4; color: "#00e5ff"; anchors.horizontalCenter: parent.horizontalCenter }
    }
}
