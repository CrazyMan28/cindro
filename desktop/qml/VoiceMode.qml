pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import QtQuick.Effects
import JarvisSidebar

// VoiceMode — the "spinny thing": a full-page voice UI built around a big glowing
// ORB (an ArcReactor wrapped in a reactive concentric-ring Canvas). The orb's
// animation reflects bridge.voiceState:
//   idle      slow pulse / gentle spin
//   listening reactive ripple (audio-in)
//   thinking  fast spin + orbiting dots + a rotating whimsical status phrase
//   speaking  waveform-ish pulse
//
// Push-to-talk: press-and-hold the button (or hold Space) to startListening,
// release to stopListening. The transcript and Jarvis's reply render under the
// orb. Model-rendered widgets (bridge.widgetRendered) pop near the orb via the
// shared WidgetRenderer, so "show me a duck" appears right beside the reactor.
Item {
    id: page
    focus: true

    // ---- voice state (mirrors bridge.voiceState) ---------------------------
    readonly property string vstate: bridge.voiceState   // idle|listening|thinking|speaking
    property string heardText: ""        // last transcript (sttText)
    property string replyText: ""        // last assistant message
    property string voiceError: ""       // capture/playback failure surfaced to the user

    // Which brain + model backs the voice session (mirrors the chat picker). The
    // model list repopulates per brain via bridge.listModels.
    property string selectedBrain: "codex"
    property var modelOptions: []
    property string selectedModel: ""

    // Whimsical "thinking" phrases (mirrors JarvisPanel WORK_PHRASES idea).
    property var thinkingPhrases: [
        "Pondering the universe", "Summoning electrons", "Reticulating splines",
        "Consulting the oracle", "Bending spacetime", "Herding photons",
        "Untangling the matrix", "Caffeinating neurons", "Galaxy-braining",
        "Manifesting", "Locking in", "Computing the meaning of life",
        "Aligning the stars", "Overthinking it", "Vibing"
    ]
    property string thinkingPhrase: thinkingPhrases[0]
    Timer {
        interval: 2200; repeat: true
        running: page.vstate === "thinking"
        onRunningChanged: if (running) phraseRoll.triggered()
        id: phraseRoll
        onTriggered: page.thinkingPhrase =
            page.thinkingPhrases[Math.floor(Math.random() * page.thinkingPhrases.length)]
    }

    // Latest model-rendered widget node, shown beside the orb.
    property var widgetNode: undefined
    property string widgetTitle: ""

    // Ensure a dedicated voice session exists when the page first appears, so the
    // model can answer "what's on my screen" via the computer-use screenshot tool.
    Component.onCompleted: {
        if (bridge.connected) {
            bridge.listModels(page.selectedBrain)
            bridge.setVoicePreferences(page.selectedBrain, page.selectedModel)
        }
    }

    Connections {
        target: bridge
        function onConnectedChanged() {
            if (bridge.connected) {
                bridge.listModels(page.selectedBrain)
                bridge.setVoicePreferences(page.selectedBrain, page.selectedModel)
            }
        }
        // Populate the voice model picker for the selected brain.
        function onModelsListed(brain, models) {
            if (brain && brain.length > 0 && brain !== page.selectedBrain)
                return
            if (models && models.length > 0) {
                page.modelOptions = models
                page.selectedModel = models[0]
                bridge.setVoicePreferences(page.selectedBrain, page.selectedModel)
            }
        }
        // Push-to-talk transcript.
        function onSttText(text) { page.heardText = text; page.voiceError = "" }
        // Surface mic/capture failures so voice mode never just silently does nothing.
        function onErrorOccurred(message) {
            var m = ("" + message).toLowerCase()
            if (m.indexOf("audio") !== -1 || m.indexOf("capture") !== -1
                || m.indexOf("mic") !== -1)
                page.voiceError = "" + message
        }
        // Assistant reply: show it AND read it back via TTS (drives "speaking").
        function onSessionEvent(ev) {
            // ONLY react while actively in a hands-free voice conversation. VoiceMode
            // stays instantiated across the app, so without this guard a normal MAIN
            // CHAT reply would get spoken here — ignoring the chat's speaker toggle.
            if (!bridge.handsFree)
                return
            var kind = ev.kind !== undefined ? ev.kind : ""
            if (kind === "message"
                && (ev.role === undefined || ev.role === "assistant")
                && ev.text !== undefined && ("" + ev.text).trim().length > 0) {
                page.replyText = "" + ev.text
                bridge.speak(ev.text)
            }
        }
        // Model-rendered widgets are handled by the FloatingWidgetLayer below (they
        // pop up beside the orb and can be dragged anywhere).
    }

    // ---- Space-to-talk -----------------------------------------------------
    // Hold Space to listen, release to send. autoRepeat is ignored so a held key
    // doesn't re-trigger startListening.
    // Space toggles the hands-free conversation on/off (no holding).
    Keys.onPressed: function(e) {
        if (e.key === Qt.Key_Space && !e.isAutoRepeat) {
            if (bridge.handsFree) bridge.stopConversation()
            else bridge.startConversation()
            e.accepted = true
        }
    }
    // Start listening hands-free as soon as the page is shown; stop when it leaves.
    onVisibleChanged: {
        if (visible) {
            page.forceActiveFocus()
            if (bridge.connected) bridge.startConversation()
        } else {
            bridge.stopConversation()
        }
    }

    // ---- background wash ---------------------------------------------------
    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: Theme.bgTop }
            GradientStop { position: 1.0; color: Theme.bgBottom }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        PageHeader {
            Layout.fillWidth: true
            title: "Voice Mode"
            subtitle: "Just talk — Jarvis is listening. Tap the orb or Space to start/stop."
        }

        // ---- which AI backs the voice session: brain + model ----------------
        RowLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: 8

            Text {
                text: "BRAIN"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackWide
                Layout.alignment: Qt.AlignVCenter
            }
            ComboBox {
                id: vBrainPicker
                Layout.preferredWidth: 112
                Layout.preferredHeight: 30
                model: ["codex", "claude"]
                currentIndex: Math.max(0, model.indexOf(page.selectedBrain))
                onActivated: {
                    page.selectedBrain = currentText
                    page.modelOptions = []
                    page.selectedModel = ""
                    bridge.listModels(currentText)
                    bridge.setVoicePreferences(currentText, "")
                    bridge.resetVoiceSession()
                }
                background: Rectangle {
                    radius: Theme.radiusSm; color: Theme.surfaceInput
                    border.width: 1; border.color: Theme.hairlineSoft
                }
                contentItem: Text {
                    leftPadding: 10; rightPadding: 24
                    text: vBrainPicker.displayText; color: Theme.text
                    font.pixelSize: 12; font.family: Theme.fontSans
                    verticalAlignment: Text.AlignVCenter; elide: Text.ElideRight
                }
            }
            Text {
                text: "MODEL"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackWide
                Layout.alignment: Qt.AlignVCenter
            }
            ComboBox {
                id: vModelPicker
                Layout.preferredWidth: 196
                Layout.preferredHeight: 30
                model: page.modelOptions
                enabled: page.modelOptions.length > 0
                onActivated: {
                    page.selectedModel = currentText
                    bridge.setVoicePreferences(page.selectedBrain, currentText)
                    bridge.resetVoiceSession()
                }
                background: Rectangle {
                    radius: Theme.radiusSm; color: Theme.surfaceInput
                    border.width: 1; border.color: Theme.hairlineSoft
                }
                contentItem: Text {
                    leftPadding: 10; rightPadding: 24
                    text: vModelPicker.displayText.length > 0 ? vModelPicker.displayText : "default"
                    color: Theme.text
                    font.pixelSize: 12; font.family: Theme.fontSans
                    verticalAlignment: Text.AlignVCenter; elide: Text.ElideRight
                }
            }
        }

        // ---- center stage: orb + (optional) widget beside it ---------------
        Item {
            id: stage
            Layout.fillWidth: true
            Layout.fillHeight: true

            // The glowing orb cluster, centered.
            Item {
                id: orbCluster
                anchors.centerIn: parent
                width: Math.min(stage.width, stage.height) * 0.62
                height: width

                // --- reactive concentric-ring Canvas (the "spinny" halo) -----
                // A set of pulsing rings whose radius/alpha animate off `phase`.
                // The animation cadence depends on voiceState.
                property real phase: 0.0
                NumberAnimation on phase {
                    from: 0.0; to: Math.PI * 2
                    duration: page.vstate === "listening" ? 900
                              : page.vstate === "thinking" ? 500
                              : page.vstate === "speaking" ? 550 : 3200
                    loops: Animation.Infinite
                    running: page.visible
                }
                onPhaseChanged: rings.requestPaint()

                Canvas {
                    id: rings
                    anchors.fill: parent
                    onPaint: {
                        var ctx = getContext("2d"); ctx.reset()
                        var cx = width / 2, cy = height / 2
                        var base = Math.min(width, height) / 2
                        var ph = orbCluster.phase
                        var st = page.vstate

                        // accent color from theme
                        var ar = Theme.accent.r, ag = Theme.accent.g, ab = Theme.accent.b

                        // number of rings + how much they breathe depends on state
                        var ringCount = (st === "listening" || st === "speaking") ? 5 : 4
                        for (var i = 0; i < ringCount; i++) {
                            var t = i / ringCount
                            // breathing offset; "listening" ripples outward fast
                            var breathe
                            if (st === "listening")
                                breathe = 0.10 * Math.sin(ph - i * 0.9)
                            else if (st === "speaking")
                                breathe = 0.07 * Math.sin(ph * 1.6 - i * 0.6)
                            else if (st === "thinking")
                                breathe = 0.04 * Math.sin(ph - i * 0.5)
                            else
                                breathe = 0.03 * Math.sin(ph - i * 0.4)
                            var r = base * (0.42 + 0.50 * t) * (1.0 + breathe)
                            if (r <= 0) continue
                            var a = (0.30 - 0.22 * t) * (st === "idle" ? 0.7 : 1.0)
                            ctx.beginPath()
                            ctx.strokeStyle = Qt.rgba(ar, ag, ab, Math.max(0, a))
                            ctx.lineWidth = Math.max(1, base * 0.012)
                            ctx.arc(cx, cy, r, 0, Math.PI * 2)
                            ctx.stroke()
                        }
                    }
                }

                // --- the ArcReactor core (brand centerpiece) -----------------
                // thinking == orbiting dots; spinning always on so idle has motion.
                ArcReactor {
                    id: reactor
                    anchors.centerIn: parent
                    size: orbCluster.width * 0.66
                    tint: Theme.accent
                    spinning: true
                    thinking: page.vstate === "thinking"
                    // a touch larger core when speaking so it "talks"; while listening
                    // the core swells with the live mic level so you can SEE it hearing you
                    coreScale: page.vstate === "speaking" ? 1.14
                               : page.vstate === "listening" ? (1.0 + 0.26 * bridge.voiceLevel)
                               : 1.0
                    // Ease the core size so the level reaction reads smooth, not jittery.
                    Behavior on coreScale { NumberAnimation { duration: 90; easing.type: Easing.OutQuad } }
                }

                // tap the orb to start/stop the hands-free conversation
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        page.forceActiveFocus()
                        if (bridge.handsFree) bridge.stopConversation()
                        else bridge.startConversation()
                    }
                }
            }

            // --- draggable widgets the model pops up, floating over/beside the orb ---
            // Jarvis can "show me a duck" / pop up a calendar etc. right here in voice
            // mode; each card is draggable. The CANVAS tab keeps the full list.
            FloatingWidgetLayer {
                anchors.fill: parent
                maxCards: 4
            }
        }

        // ---- status line under the orb: state + rotating phrase ------------
        Text {
            Layout.alignment: Qt.AlignHCenter
            horizontalAlignment: Text.AlignHCenter
            color: Theme.accent
            opacity: 0.9
            font.family: Theme.fontDisplay
            font.pixelSize: 13
            font.letterSpacing: Theme.trackMid
            text: {
                switch (page.vstate) {
                case "listening": return "LISTENING…"
                case "thinking":  return page.thinkingPhrase.toUpperCase() + "…"
                case "speaking":  return "SPEAKING…"
                default:          return "READY"
                }
            }
        }

        // Capture failure (e.g. no microphone) — so voice mode is never silently dead.
        Text {
            visible: page.voiceError.length > 0
            Layout.alignment: Qt.AlignHCenter
            Layout.maximumWidth: 520
            horizontalAlignment: Text.AlignHCenter
            text: "⚠ " + page.voiceError
            color: Theme.danger
            font.family: Theme.fontSans
            font.pixelSize: 12
            wrapMode: Text.WordWrap
        }

        // ---- transcript + reply --------------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            Layout.maximumWidth: 640
            Layout.alignment: Qt.AlignHCenter
            spacing: 6

            Text {
                visible: page.heardText.length > 0
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignHCenter
                text: "“" + page.heardText + "”"
                color: Theme.textMuted
                font.family: Theme.fontSans
                font.pixelSize: 14
                font.italic: true
                wrapMode: Text.WordWrap
            }
            Text {
                visible: page.replyText.length > 0
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignHCenter
                text: page.replyText
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: 15
                wrapMode: Text.WordWrap
                maximumLineCount: 6
                elide: Text.ElideRight
            }
        }

        // ---- conversation toggle (hands-free; no holding) ------------------
        Item {
            id: pttWrap
            Layout.alignment: Qt.AlignHCenter
            implicitWidth: 240
            implicitHeight: 56

            Rectangle {
                id: ptt
                anchors.fill: parent
                radius: height / 2
                color: bridge.handsFree ? Theme.accentDim : Theme.surface
                border.width: 1
                border.color: Theme.accentGlow
                layer.enabled: bridge.handsFree
                layer.effect: MultiEffect {
                    blurEnabled: true
                    blur: 0.6
                    blurMax: 24
                    brightness: 0.2
                }

                Text {
                    anchors.centerIn: parent
                    text: bridge.handsFree ? "STOP" : "START TALKING"
                    color: Theme.text
                    font.family: Theme.fontDisplay
                    font.pixelSize: 13
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
            }

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    page.forceActiveFocus()
                    if (bridge.handsFree) bridge.stopConversation()
                    else bridge.startConversation()
                }
            }
        }

        // ---- hint line ------------------------------------------------------
        Text {
            Layout.alignment: Qt.AlignHCenter
            Layout.bottomMargin: 4
            horizontalAlignment: Text.AlignHCenter
            text: "Just talk — Jarvis listens and replies. Try: \"what's on my screen\" or \"show me a duck\"."
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: 12
            wrapMode: Text.WordWrap
        }
    }
}
