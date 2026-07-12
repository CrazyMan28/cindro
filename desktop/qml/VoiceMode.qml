pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import QtQuick.Effects
import CindroSidebar

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
    // Output sinks for the speaker picker: [{index,name,isDefault}].
    property var speakers: []

    // Whimsical "thinking" phrases (mirrors JarvisPanel WORK_PHRASES idea).
    property var thinkingPhrases: [
        "Conquering the world", "Just chillin", "Pondering the universe", "Cooking", "Summoning electrons",
        "Reticulating splines", "Bending spacetime", "Consulting the oracle", "Doing crimes (legal ones)", "Vibing",
        "Untangling the matrix", "Herding photons", "Caffeinating neurons", "Computing the meaning of life", "Manifesting",
        "Hacking the mainframe", "Plotting world domination", "Aligning the stars", "Overthinking it", "Galaxy-braining",
        "Locking in", "Spinning up the hamster wheel", "Bribing the compiler", "Negotiating with the GPU", "Untangling spaghetti code",
        "Counting to infinity (twice)", "Dividing by almost-zero", "Asking the rubber duck", "Polishing the pixels", "Warming up the flux capacitor",
        "Rerouting the neutrinos", "Feeding the neural net", "Petting the algorithm", "Convincing the linter", "Wrangling tensors",
        "Buffering enthusiasm", "Defragmenting thoughts", "Compiling brilliance", "Loading the vibes", "Tuning the antennae",
        "Charging the arc reactor", "Greasing the gears", "Whispering to the kernel", "Consulting ancient scrolls", "Brewing more coffee",
        "Sharpening the pencils", "Rolling for initiative", "Aligning the chakras", "Untwisting the logic", "Counting electrons",
        "Stretching before the sprint", "Booting the brain cells", "Summoning the muse", "Crunching the numbers", "Cross-referencing the cosmos",
        "Tickling the transistors", "Asking nicely", "Reading the fine print", "Triangulating the answer", "Synthesizing wisdom",
        "Doing the math (carrying the one)", "Politely arguing with physics", "Folding the proteins", "Dusting off the manual", "Calibrating the vibes",
        "Reverse-engineering reality", "Threading the needle", "Untangling the headphones", "Chasing the bug", "Following the breadcrumbs",
        "Connecting the dots", "Spinning plates", "Juggling chainsaws (safely)", "Pondering orbs", "Decrypting the universe",
        "Loading the enthusiasm", "Looking busy", "Pretending to think", "Actually thinking", "Thinking very hard",
        "Doing a little dance", "Consulting the spreadsheet", "Counting sheep (the smart ones)", "Rebooting the imagination", "Stacking the bytes",
        "Optimizing the optimizer", "Refactoring the cosmos", "Untangling causality", "Negotiating with entropy", "Bargaining with the deadline",
        "Warming the tubes", "Spooling up", "Engaging warp drive", "Plotting a course", "Scanning the horizon",
        "Reading the room", "Doing recon", "Gathering intel", "Assembling the squad", "Sharpening the axe",
        "Filing the paperwork", "Stamping the forms", "Convincing myself", "Double-checking twice", "Triple-checking once",
        "Measuring twice, cutting once", "Untying the Gordian knot", "Solving for x", "Carrying the remainder", "Rounding up the usual suspects",
        "Herding cats", "Counting the cats", "Naming the cats", "Befriending the firewall", "Sweet-talking the database",
        "Coaxing the cache", "Flattering the framework", "Whittling the wood", "Sketching the blueprint", "Drafting the masterplan",
        "Consulting my notes", "Remembering where I put it", "Finding the thing", "Locating the other thing", "Cross-stitching the logic",
        "Knitting the threads", "Weaving the tapestry", "Tightening the bolts", "Oiling the joints", "Spinning the dials",
        "Flipping the switches", "Pulling the levers", "Pressing the big red button (carefully)", "Reading the tea leaves", "Shaking the magic 8-ball",
        "Rolling the dice", "Drawing the cards", "Casting the runes", "Channeling the energy", "Focusing the beam",
        "Adjusting the dials", "Fine-tuning the model", "Annealing the network", "Backpropagating vibes", "Gradient-descending",
        "Climbing the loss landscape", "Escaping a local minimum", "Avoiding the saddle point", "Embedding the meaning", "Tokenizing the thoughts",
        "Attention is all I need", "Sampling the distribution", "Lowering the temperature", "Raising the stakes", "Doubling down",
        "Hedging my bets", "Reading ahead", "Skipping to the good part", "Saving the best for last", "Connecting to the hive mind",
        "Pinging the satellites", "Bouncing off the moon", "Phoning a friend", "Asking the audience", "Going with my gut",
        "Trusting the process", "Embracing the chaos", "Taming the chaos", "Befriending the chaos", "Surfing the data stream",
        "Riding the wave", "Catching the current", "Sailing the seven C's", "Charting the unknown", "Mapping the territory",
        "Drawing the map", "Folding the map", "Reading the compass", "Finding true north", "Recalculating the route",
        "Taking the scenic path", "Avoiding the traffic", "Beating the rush", "Catching the train of thought", "Boarding the idea express",
        "Connecting the flights", "Packing light", "Checking the luggage", "Going through customs", "Stamping the passport",
        "Touching grass (virtually)", "Stretching the legs", "Taking a deep breath", "Centering myself", "Finding my zen",
        "Channeling my inner genius", "Unleashing the kraken", "Releasing the hounds", "Wrapping it up", "Sprinkling in some magic"
    ]
    property string thinkingPhrase: thinkingPhrases[0]
    // Random interval each change (not a fixed beat) — organic drift.
    function randPhraseMs() { return 5000 + Math.floor(Math.random() * 9000) }
    Timer {
        id: phraseRoll
        interval: 7000; repeat: true
        running: page.vstate === "thinking"
        onRunningChanged: if (running) { interval = page.randPhraseMs(); phraseRoll.triggered() }
        onTriggered: {
            page.thinkingPhrase =
                page.thinkingPhrases[Math.floor(Math.random() * page.thinkingPhrases.length)]
            interval = page.randPhraseMs()
        }
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
        page.speakers = bridge.audioOutputs()
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
            subtitle: "Just talk — Cindro is listening. Tap the orb or Space to start/stop."
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
            Text {
                text: "SPEAKER"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackWide
                Layout.alignment: Qt.AlignVCenter
            }
            ComboBox {
                id: vSpeakerPicker
                Layout.preferredWidth: 210
                Layout.preferredHeight: 30
                model: page.speakers.map(function(s) { return s.name })
                onActivated: bridge.setTtsOutput(currentIndex)
                background: Rectangle {
                    radius: Theme.radiusSm; color: Theme.surfaceInput
                    border.width: 1; border.color: Theme.hairlineSoft
                }
                contentItem: Text {
                    leftPadding: 10; rightPadding: 24
                    text: vSpeakerPicker.displayText.length > 0 ? vSpeakerPicker.displayText : "default"
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
                    duration: page.vstate === "listening" ? 1100
                              : page.vstate === "thinking" ? 950
                              : page.vstate === "speaking" ? 900 : 2600
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
                    // Smooth, tasteful motion: gentle "breathing" while thinking/speaking
                    // (no abrupt size jump), and a soft swell with the live mic level while
                    // listening so you can see it hearing you. idle rests at 1.0.
                    property real pulse: 0.0
                    coreScale: page.vstate === "listening" ? (1.0 + 0.14 * bridge.voiceLevel)
                               : (page.vstate === "thinking" || page.vstate === "speaking")
                                 ? (1.0 + reactor.pulse)
                                 : 1.0
                    Behavior on coreScale { NumberAnimation { duration: 110; easing.type: Easing.OutQuad } }
                    SequentialAnimation on pulse {
                        running: page.vstate === "thinking" || page.vstate === "speaking"
                        loops: Animation.Infinite
                        NumberAnimation { from: 0.0; to: 0.08; duration: 620; easing.type: Easing.InOutSine }
                        NumberAnimation { from: 0.08; to: 0.0; duration: 620; easing.type: Easing.InOutSine }
                    }
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
            text: "Just talk — Cindro listens and replies. Try: \"what's on my screen\" or \"show me a duck\"."
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: 12
            wrapMode: Text.WordWrap
        }
    }
}
