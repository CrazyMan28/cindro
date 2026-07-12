pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CindroSidebar

// IN-APP BROWSER page: a live preview of the agent's controlled Chrome tab.
// We do NOT embed QtWebEngine — the desktop drives the per-session computer-use
// engine's browser bridge and renders the returned screenshot (browser.screenshot)
// plus a URL bar + back/forward/reload and click-by-snapshot (browser.snapshot ->
// browser.click{ref}). The preview polls while the page is open.
Item {
    id: page

    property string currentUrl: ""
    property string pageTitle: ""
    property bool canBack: false
    property bool canForward: false
    property string shotData: ""        // data: URI built from the b64 PNG
    property bool snapshotOpen: false
    ListModel { id: snapModel }

    Timer {
        id: poll
        interval: 1200
        repeat: true
        running: page.visible && bridge.connected && bridge.coworkerSessionId.length > 0
        onTriggered: bridge.browserScreenshot()
    }

    function refreshNow() {
        if (!bridge.connected) return
        bridge.browserStatus()
        bridge.browserScreenshot()
    }
    Component.onCompleted: refreshNow()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refreshNow() }
        function onCoworkerSessionIdChanged() { if (bridge.coworkerSessionId.length) page.refreshNow() }
        function onBrowserStatusReady(url, title, canBack, canForward) {
            page.currentUrl = url
            page.pageTitle = title
            page.canBack = canBack
            page.canForward = canForward
            if (url.length && !urlField.activeFocus)
                urlField.text = url
        }
        function onBrowserShot(b64Png) {
            if (b64Png.length === 0) return
            page.shotData = "data:image/png;base64," + b64Png
        }
        function onBrowserSnapshotReady(nodes) {
            snapModel.clear()
            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i]
                snapModel.append({
                    "ref": n.ref !== undefined ? ("" + n.ref) : "",
                    "role": n.role !== undefined ? n.role : "",
                    "label": n.name !== undefined ? n.name : (n.text !== undefined ? n.text : "")
                })
            }
            page.snapshotOpen = true
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 12

        PageHeader {
            Layout.fillWidth: true
            title: "Browser"
            subtitle: "Live view of the agent's controlled tab. Navigate, or click an element from the snapshot."
        }

        // ---- nav bar --------------------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            NavBtn { glyph: "back";    enabledBtn: page.canBack;    onActivated: bridge.browserBack() }
            NavBtn { glyph: "forward"; enabledBtn: page.canForward; onActivated: bridge.browserForward() }
            NavBtn { glyph: "reload";  enabledBtn: true;            onActivated: bridge.browserReload() }

            Widgets.StyledField {
                id: urlField
                Layout.fillWidth: true
                placeholder: "https://…"
                onAccepted: page.go()
            }
            Widgets.PillButton {
                label: "Go"
                primary: true
                enabledBtn: bridge.connected && urlField.text.trim().length > 0
                onClicked: page.go()
            }
            Widgets.PillButton {
                label: page.snapshotOpen ? "Hide DOM" : "Snapshot"
                onClicked: {
                    if (page.snapshotOpen) page.snapshotOpen = false
                    else bridge.browserSnapshot()
                }
            }
        }

        // ---- title strip ----------------------------------------------------
        Text {
            Layout.fillWidth: true
            text: page.pageTitle.length ? page.pageTitle : (page.currentUrl.length ? page.currentUrl : "—")
            color: Theme.textMuted
            font.family: Theme.fontSans
            font.pixelSize: 12
            elide: Text.ElideRight
        }

        // ---- preview + snapshot side panel ---------------------------------
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 12

            // screenshot preview
            HudFrame {
                Layout.fillWidth: true
                Layout.fillHeight: true
                fill: Theme.surfaceDeep
                active: bridge.connected

                Item {
                    anchors.fill: parent
                    anchors.margins: 10
                    clip: true

                    Image {
                        id: shot
                        anchors.fill: parent
                        fillMode: Image.PreserveAspectFit
                        cache: false
                        source: page.shotData
                        visible: page.shotData.length > 0
                        asynchronous: true
                    }

                    // empty / no-feed state
                    ColumnLayout {
                        anchors.centerIn: parent
                        width: parent.width - 60
                        spacing: 14
                        visible: page.shotData.length === 0
                        ArcReactor {
                            Layout.alignment: Qt.AlignHCenter
                            size: 96; tint: Theme.accent
                            thinking: !bridge.connected
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            text: bridge.coworkerSessionId.length > 0 ? "NO PAGE LOADED" : "NO ACTIVE BROWSER"
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
                            text: bridge.coworkerSessionId.length > 0
                                  ? "Type a URL above and hit Go to drive the agent's tab."
                                  : "Start a co-worker session on the Computer page, then a browser tab appears here."
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 13
                            lineHeight: 1.3
                        }
                    }
                }
            }

            // snapshot (click-by-ref) panel
            Rectangle {
                visible: page.snapshotOpen
                Layout.preferredWidth: 240
                Layout.fillHeight: true
                radius: Theme.radius
                color: Theme.panelSoft
                border.width: 1
                border.color: Theme.hairlineSoft

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 8
                    Text {
                        text: "// SNAPSHOT"
                        color: Theme.accent
                        font.family: Theme.fontDisplay
                        font.pixelSize: 10
                        font.letterSpacing: Theme.trackMid
                        font.weight: Font.DemiBold
                    }
                    ListView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 5
                        model: snapModel
                        boundsBehavior: Flickable.StopAtBounds
                        ScrollBar.vertical: ScrollBar {
                            policy: ScrollBar.AsNeeded; width: 4
                            background: Item {}
                            contentItem: Rectangle { implicitWidth: 3; radius: 2; color: Theme.hairline; opacity: 0.5 }
                        }
                        delegate: Rectangle {
                            id: srow
                            required property int index
                            required property string ref
                            required property string role
                            required property string label
                            width: ListView.view.width
                            implicitHeight: 36
                            radius: Theme.radiusXs
                            color: srowMa.containsMouse ? Theme.surfaceStrong : Theme.surface
                            border.width: 1
                            border.color: srowMa.containsMouse ? Theme.accentDim : Theme.hairlineFaint
                            ColumnLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 9
                                anchors.rightMargin: 9
                                spacing: 0
                                Text {
                                    Layout.fillWidth: true
                                    text: srow.label.length ? srow.label : srow.role
                                    color: Theme.text
                                    font.family: Theme.fontSans
                                    font.pixelSize: 11
                                    elide: Text.ElideRight
                                }
                                Text {
                                    text: srow.role + "  #" + srow.ref
                                    color: Theme.textFaint
                                    font.family: Theme.fontMono
                                    font.pixelSize: 9
                                }
                            }
                            MouseArea {
                                id: srowMa
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: bridge.browserClick(srow.ref)
                            }
                        }
                        Text {
                            anchors.centerIn: parent
                            visible: snapModel.count === 0
                            text: "Empty snapshot."
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                        }
                    }
                }
            }
        }
    }

    function go() {
        var u = urlField.text.trim()
        if (u.length === 0) return
        if (u.indexOf("://") === -1 && u.indexOf("about:") !== 0)
            u = "https://" + u
        bridge.browserNavigate(u)
    }

    // ---- small canvas nav button -------------------------------------------
    component NavBtn: Item {
        id: nb
        property string glyph: "reload"
        property bool enabledBtn: true
        signal activated()
        width: 34; height: 34
        opacity: enabledBtn ? 1.0 : 0.35

        Rectangle {
            anchors.fill: parent
            radius: Theme.radiusSm
            color: nbMa.containsMouse && nb.enabledBtn ? Theme.surfaceStrong : Theme.surface
            border.width: 1
            border.color: nbMa.containsMouse && nb.enabledBtn ? Theme.accentDim : Theme.hairlineSoft
            Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
            Canvas {
                anchors.centerIn: parent
                width: 16; height: 16
                onPaint: {
                    var ctx = getContext("2d"); ctx.reset()
                    ctx.strokeStyle = nb.enabledBtn ? Theme.accent : Theme.textFaint
                    ctx.lineWidth = 1.6; ctx.lineCap = "round"; ctx.lineJoin = "round"
                    if (nb.glyph === "back") {
                        ctx.beginPath(); ctx.moveTo(10, 3); ctx.lineTo(5, 8); ctx.lineTo(10, 13); ctx.stroke()
                    } else if (nb.glyph === "forward") {
                        ctx.beginPath(); ctx.moveTo(6, 3); ctx.lineTo(11, 8); ctx.lineTo(6, 13); ctx.stroke()
                    } else {
                        // reload arc
                        ctx.beginPath(); ctx.arc(8, 8, 5, -0.4, Math.PI * 1.5); ctx.stroke()
                        ctx.beginPath()
                        ctx.moveTo(12.5, 5); ctx.lineTo(13, 8.2); ctx.lineTo(9.8, 7.6); ctx.stroke()
                    }
                }
                Connections {
                    target: nb
                    function onEnabledBtnChanged() { parent.requestPaint() }
                }
            }
            MouseArea {
                id: nbMa
                anchors.fill: parent
                hoverEnabled: true
                enabled: nb.enabledBtn
                cursorShape: nb.enabledBtn ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: nb.activated()
            }
        }
    }
}
