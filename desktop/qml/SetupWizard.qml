pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import JarvisSidebar

// SetupWizard — the first-launch flow shown by Main.qml while settings report
// setup_complete=false. A modal full-cover overlay with four steps:
//   (i)   welcome + assistant name
//   (ii)  pick a voice (reuses tts_voice + voice.list_voices)
//   (iii) brain / key — if no codex/claude CLI, prompt for a Mistral API key
//   (iv)  permission level + the auto-update toggle
// Finish persists { setup_complete:true, assistant_name, tts_voice,
// permission_level, auto_update } (+ a Mistral key when one was entered) and
// emits finished() so Main drops the overlay.
//
// SELF-CONTAINED + non-blocking: every bridge call is guarded by bridge.connected
// so it instantiates cleanly offscreen in gui_selftest (no daemon).
Item {
    id: wiz
    anchors.fill: parent

    signal finished()

    // ---- wizard state ------------------------------------------------------
    property int step: 0
    readonly property int stepCount: 5
    property string assistantName: "Jarvis"
    property string userName: ""                  // the human's name — saved as a memory
    property string ttsVoice: ""                 // "" => daemon default voice
    property var voiceList: []                    // [{id,label}] from voice.list_voices
    property string permissionLevel: "medium"     // high | medium | low
    property bool autoUpdate: true
    property bool hasCli: true                     // codex OR claude on PATH
    property bool mistralKeySet: false             // a Mistral key already exists
    property string mistralKey: ""                 // key typed in step (iii)
    property bool saving: false
    // Optional Phone & Twilio step (v) — all blank => skipped. Persisted via
    // phone.config set (separate from settings.set) on finish.
    property string phoneSid: ""                   // Twilio Account SID (secret)
    property string phoneAuth: ""                  // Twilio Auth Token (secret)
    property string phoneFrom: ""                  // Twilio From Number

    function load() {
        if (!bridge || !bridge.connected) return
        bridge.loadSettings()
        bridge.listVoices()
    }
    Component.onCompleted: load()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) wiz.load() }
        function onSettingsLoaded(s) {
            wiz.hasCli = (s.available_brains !== undefined)
                         && (s.available_brains.codex === true || s.available_brains.claude === true)
            wiz.mistralKeySet = (s.api_keys_set !== undefined) && (s.api_keys_set.mistral === true)
            if (s.assistant_name !== undefined && ("" + s.assistant_name).length)
                wiz.assistantName = "" + s.assistant_name
            if (s.user_name !== undefined && ("" + s.user_name).length)
                wiz.userName = "" + s.user_name
            if (s.tts_voice !== undefined) wiz.ttsVoice = "" + s.tts_voice
            wiz.permissionLevel = (s.permission_level === "high" || s.permission_level === "low")
                                  ? s.permission_level : "medium"
            wiz.autoUpdate = (s.auto_update === undefined) ? true : (s.auto_update === true)
            voiceCombo.syncFromState()
        }
        function onVoicesListed(voices) {
            wiz.voiceList = voices !== undefined ? voices : []
            voiceCombo.refill()
        }
    }

    // Voice picker helpers (combo shows labels; we persist the id slug).
    function voiceLabels() {
        var out = []
        for (var i = 0; i < wiz.voiceList.length; i++) {
            var v = wiz.voiceList[i]
            out.push((v && v.label !== undefined && ("" + v.label).length) ? ("" + v.label) : ("" + v.id))
        }
        if (out.length === 0) out.push("Default voice")
        return out
    }
    function voiceIdForIndex(idx) {
        if (idx >= 0 && idx < wiz.voiceList.length) return "" + wiz.voiceList[idx].id
        return wiz.ttsVoice
    }
    function voiceIndexForId(id) {
        for (var i = 0; i < wiz.voiceList.length; i++)
            if (("" + wiz.voiceList[i].id) === id) return i
        return 0
    }

    function finish() {
        wiz.saving = true
        var name = wiz.assistantName.trim()
        var patch = {
            "setup_complete": true,
            "assistant_name": name.length ? name : "Jarvis",
            "user_name": wiz.userName.trim(),
            "tts_voice": wiz.ttsVoice,
            "permission_level": wiz.permissionLevel,
            "auto_update": wiz.autoUpdate
        }
        // Persist a Mistral key whenever one was entered and none is set yet. Needed
        // both for the api brain (no-CLI path) AND for Voxtral voice/STT-TTS even when
        // codex/claude drive chat — so we no longer gate it on !hasCli.
        if (!wiz.mistralKeySet && wiz.mistralKey.trim().length > 0)
            patch["api_keys"] = { "mistral": wiz.mistralKey.trim() }
        if (bridge && bridge.connected)
            bridge.saveSettings(patch)
        // Optional Phone & Twilio (step v) — phone.config is a SEPARATE control
        // method from settings.set, so send it on its own. Only include a secret
        // when the user actually typed one; all-blank => nothing sent (skipped).
        if (bridge && bridge.connected) {
            var pp = {}
            if (wiz.phoneSid.trim().length > 0)  pp["twilio_account_sid"] = wiz.phoneSid.trim()
            if (wiz.phoneAuth.trim().length > 0) pp["twilio_auth_token"]  = wiz.phoneAuth.trim()
            if (wiz.phoneFrom.trim().length > 0) pp["twilio_from_number"] = wiz.phoneFrom.trim()
            if (Object.keys(pp).length > 0) bridge.phoneConfigSet(pp)
        }
        wiz.finished()
    }

    // ---- backdrop (modal: swallow all clicks to the UI behind) -------------
    Rectangle {
        anchors.fill: parent
        color: Theme.bgDeep
        opacity: 0.96
    }
    HudFx { anchors.fill: parent; dense: true }
    MouseArea { anchors.fill: parent; hoverEnabled: true }   // block pass-through

    // ---- wizard card -------------------------------------------------------
    Rectangle {
        id: card
        anchors.centerIn: parent
        width: Math.min(parent.width - 48, 560)
        height: Math.min(parent.height - 48, 620)
        radius: Theme.radius + 4
        color: Theme.surface
        border.width: 1
        border.color: Theme.accentDim
        clip: true

        // top energy seam
        Rectangle {
            anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
            anchors.leftMargin: 18; anchors.rightMargin: 18; anchors.topMargin: 1
            height: 1
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: Theme.accent }
                GradientStop { position: 1.0; color: "transparent" }
            }
            opacity: 0.8
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 26
            spacing: 16

            // ---- header: reactor + step title ------------------------------
            RowLayout {
                Layout.fillWidth: true
                spacing: 14
                ArcReactor {
                    size: 52
                    thinking: false
                    Layout.alignment: Qt.AlignVCenter
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Text {
                        text: "FIRST-TIME SETUP"
                        color: Theme.accent
                        font.family: Theme.fontDisplay
                        font.pixelSize: 10
                        font.letterSpacing: Theme.trackWide
                        font.weight: Font.DemiBold
                    }
                    Text {
                        text: [ "Welcome", "Voice", "Brain", "Permissions", "Phone" ][wiz.step]
                        color: Theme.text
                        font.family: Theme.fontDisplay
                        font.pixelSize: 20
                        font.weight: Font.DemiBold
                    }
                }
                Text {
                    text: "Step " + (wiz.step + 1) + " / " + wiz.stepCount
                    color: Theme.textFaint
                    font.family: Theme.fontMono
                    font.pixelSize: 11
                    Layout.alignment: Qt.AlignTop
                }
            }

            Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairlineSoft }

            // ---- step body -------------------------------------------------
            StackLayout {
                id: stack
                Layout.fillWidth: true
                Layout.fillHeight: true
                currentIndex: wiz.step

                // (i) Welcome + assistant name -------------------------------
                ColumnLayout {
                    spacing: 14
                    Text {
                        Layout.fillWidth: true
                        text: "Let's get you set up. This only takes a moment."
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        text: "What should I call myself?"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                    }
                    Widgets.StyledField {
                        id: nameField
                        Layout.fillWidth: true
                        text: wiz.assistantName
                        placeholder: "Jarvis"
                        onTextChanged: wiz.assistantName = text
                    }
                    Text {
                        Layout.fillWidth: true
                        text: "This name is shown across the app. You can change it later in Settings."
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                        wrapMode: Text.WordWrap
                    }
                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairlineSoft; Layout.topMargin: 4 }
                    Text {
                        text: "And what should I call you?"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                    }
                    Widgets.StyledField {
                        id: userNameField
                        Layout.fillWidth: true
                        text: wiz.userName
                        placeholder: "Your name (optional)"
                        onTextChanged: wiz.userName = text
                    }
                    Text {
                        Layout.fillWidth: true
                        text: "Saved as a memory so I can address you by name. Optional — leave blank to skip."
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                        wrapMode: Text.WordWrap
                    }
                    Item { Layout.fillHeight: true }
                }

                // (ii) Voice -------------------------------------------------
                ColumnLayout {
                    spacing: 14
                    Text {
                        Layout.fillWidth: true
                        text: "Pick the voice " + (wiz.assistantName.length ? wiz.assistantName : "Jarvis") + " speaks with."
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        wrapMode: Text.WordWrap
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10
                        Widgets.StyledCombo {
                            id: voiceCombo
                            Layout.fillWidth: true
                            model: wiz.voiceLabels()
                            function refill() { model = wiz.voiceLabels(); syncFromState() }
                            function syncFromState() { currentIndex = wiz.voiceIndexForId(wiz.ttsVoice) }
                            onActivated: wiz.ttsVoice = wiz.voiceIdForIndex(currentIndex)
                        }
                        Widgets.PillButton {
                            label: "Preview"
                            enabledBtn: bridge.connected && wiz.voiceList.length > 0
                            onClicked: if (bridge.connected) bridge.previewVoice(wiz.voiceIdForIndex(voiceCombo.currentIndex))
                        }
                    }
                    Text {
                        Layout.fillWidth: true
                        text: "Voices are powered by Voxtral (Mistral). The default works great if you're not sure."
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                        wrapMode: Text.WordWrap
                    }
                    Item { Layout.fillHeight: true }
                }

                // (iii) Brain / key ------------------------------------------
                ColumnLayout {
                    spacing: 14
                    // CLI present: chat is covered — but voice/vision still want a key.
                    ColumnLayout {
                        visible: wiz.hasCli
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            Layout.fillWidth: true
                            text: "✓ Codex / Claude CLI detected"
                            color: Theme.ok
                            font.family: Theme.fontSans
                            font.pixelSize: 14
                            font.weight: Font.Medium
                        }
                        Text {
                            Layout.fillWidth: true
                            text: "Chat is ready with the smartest brains. Voice, vision and STT/TTS use Voxtral (Mistral) — add a key below to enable them."
                            color: Theme.textMuted
                            font.family: Theme.fontSans
                            font.pixelSize: 12
                            wrapMode: Text.WordWrap
                        }
                    }
                    // Mistral key — required for the api brain (no CLI) AND for Voxtral
                    // voice / STT-TTS even when a CLI drives chat. Offered until set.
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 10
                        Text {
                            Layout.fillWidth: true
                            text: wiz.mistralKeySet
                                  ? "✓ Mistral API key already set"
                                  : (wiz.hasCli ? "Add a Mistral key for voice + vision (optional)"
                                                : "No Codex or Claude CLI found")
                            color: wiz.mistralKeySet ? Theme.ok : (wiz.hasCli ? Theme.text : Theme.amber)
                            font.family: Theme.fontSans
                            font.pixelSize: 14
                            font.weight: Font.Medium
                        }
                        Text {
                            visible: !wiz.mistralKeySet
                            Layout.fillWidth: true
                            text: wiz.hasCli
                                  ? "Powers spoken replies + voice input (Voxtral) and image understanding. Skip it and Jarvis still chats via your CLI."
                                  : "Add a Mistral API key and Jarvis works right away — chat, voice, vision, and computer use via the function-calling loop."
                            color: Theme.textMuted
                            font.family: Theme.fontSans
                            font.pixelSize: 12
                            wrapMode: Text.WordWrap
                        }
                        Widgets.StyledField {
                            visible: !wiz.mistralKeySet
                            Layout.fillWidth: true
                            masked: true
                            placeholder: "Paste your Mistral API key…"
                            onTextChanged: wiz.mistralKey = text
                        }
                        Text {
                            visible: !wiz.mistralKeySet
                            Layout.fillWidth: true
                            text: "Get a key at console.mistral.ai →"
                            color: Theme.accent
                            font.family: Theme.fontSans
                            font.pixelSize: 12
                            MouseArea {
                                anchors.fill: parent
                                cursorShape: Qt.PointingHandCursor
                                onClicked: Qt.openUrlExternally("https://console.mistral.ai/")
                            }
                        }
                        Text {
                            visible: !wiz.mistralKeySet
                            Layout.fillWidth: true
                            text: "Stored locally (0600), never in git. See docs/MISTRAL_SETUP.md. You can skip this and add a key later in Settings."
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                            wrapMode: Text.WordWrap
                        }
                    }
                    Item { Layout.fillHeight: true }
                }

                // (iv) Permissions + auto-update -----------------------------
                ColumnLayout {
                    spacing: 12
                    Text {
                        Layout.fillWidth: true
                        text: "How cautious should Jarvis be before risky actions?"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        wrapMode: Text.WordWrap
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Repeater {
                            model: [
                                { key: "high",   name: "Cautious",   sub: "Ask before HIGH + MEDIUM" },
                                { key: "medium", name: "Balanced",   sub: "Ask before HIGH only" },
                                { key: "low",    name: "Autonomous", sub: "Only confirm the worst" }
                            ]
                            delegate: Rectangle {
                                id: pseg
                                required property var modelData
                                Layout.fillWidth: true
                                Layout.preferredHeight: 60
                                radius: Theme.radiusSm
                                readonly property bool sel: wiz.permissionLevel === pseg.modelData.key
                                color: pseg.sel ? Theme.accentDim
                                       : (psegMa.containsMouse ? Theme.surfaceStrong : Theme.surfaceDeep)
                                border.width: 1
                                border.color: pseg.sel ? Theme.accent
                                              : (psegMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft)
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                                ColumnLayout {
                                    anchors.centerIn: parent
                                    width: pseg.width - 14
                                    spacing: 2
                                    Text {
                                        text: pseg.modelData.name.toUpperCase()
                                        color: pseg.sel ? Theme.accentBright : Theme.text
                                        font.family: Theme.fontDisplay
                                        font.pixelSize: 12
                                        font.weight: Font.DemiBold
                                        font.letterSpacing: Theme.trackMid
                                        Layout.alignment: Qt.AlignHCenter
                                    }
                                    Text {
                                        text: pseg.modelData.sub
                                        color: Theme.textMuted
                                        font.family: Theme.fontSans
                                        font.pixelSize: 9
                                        horizontalAlignment: Text.AlignHCenter
                                        Layout.fillWidth: true
                                        Layout.alignment: Qt.AlignHCenter
                                        wrapMode: Text.WordWrap
                                    }
                                }
                                MouseArea {
                                    id: psegMa
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: wiz.permissionLevel = pseg.modelData.key
                                }
                            }
                        }
                    }
                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairlineSoft; Layout.topMargin: 2 }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2
                            Text {
                                text: "Keep Jarvis up to date automatically"
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 13
                                Layout.fillWidth: true
                            }
                            Text {
                                text: "Checks for updates in the background and notifies you — never installs without your OK."
                                color: Theme.textMuted
                                font.family: Theme.fontSans
                                font.pixelSize: 11
                                Layout.fillWidth: true
                                wrapMode: Text.WordWrap
                            }
                        }
                        Widgets.StyledSwitch {
                            checked: wiz.autoUpdate
                            onToggled: function(v) { wiz.autoUpdate = v }
                        }
                    }
                    Item { Layout.fillHeight: true }
                }

                // (v) Phone & Twilio (optional) ------------------------------
                ColumnLayout {
                    spacing: 12
                    Text {
                        Layout.fillWidth: true
                        text: "Connect a Twilio number so " + (wiz.assistantName.length ? wiz.assistantName : "Jarvis")
                              + " can screen calls and text you. Optional — skip and set it up later in Phone → Settings."
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        text: "Twilio Account SID"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                    }
                    Widgets.StyledField {
                        Layout.fillWidth: true
                        masked: true
                        placeholder: "ACxxxxxxxx…  (optional)"
                        onTextChanged: wiz.phoneSid = text
                    }
                    Text {
                        text: "Twilio Auth Token"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                    }
                    Widgets.StyledField {
                        Layout.fillWidth: true
                        masked: true
                        placeholder: "Auth token  (optional)"
                        onTextChanged: wiz.phoneAuth = text
                    }
                    Text {
                        text: "Twilio From Number"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                    }
                    Widgets.StyledField {
                        Layout.fillWidth: true
                        placeholder: "+1XXXXXXXXXX  (optional)"
                        onTextChanged: wiz.phoneFrom = text
                    }
                    Text {
                        Layout.fillWidth: true
                        text: "Stored locally in ~/.config/jarvis/phone.env (0600), never in git."
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        Layout.fillWidth: true
                        text: "Get credentials at twilio.com/console →"
                        color: Theme.accent
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Qt.openUrlExternally("https://www.twilio.com/console")
                        }
                    }
                    Item { Layout.fillHeight: true }
                }
            }

            // ---- footer: step dots + nav -----------------------------------
            RowLayout {
                Layout.fillWidth: true
                spacing: 8

                Row {
                    spacing: 6
                    Layout.alignment: Qt.AlignVCenter
                    Repeater {
                        model: wiz.stepCount
                        delegate: Rectangle {
                            required property int index
                            width: 7; height: 7; radius: 3.5
                            color: index === wiz.step ? Theme.accent
                                   : (index < wiz.step ? Theme.accentDim : Theme.hairline)
                        }
                    }
                }

                Item { Layout.fillWidth: true }

                Widgets.PillButton {
                    label: "Back"
                    visible: wiz.step > 0
                    enabledBtn: !wiz.saving
                    onClicked: if (wiz.step > 0) wiz.step--
                }
                Widgets.PillButton {
                    label: wiz.step === wiz.stepCount - 1
                           ? (wiz.saving ? "Finishing…" : "Finish")
                           : "Next"
                    primary: true
                    busy: wiz.saving
                    enabledBtn: !wiz.saving
                    onClicked: {
                        if (wiz.step < wiz.stepCount - 1) wiz.step++
                        else wiz.finish()
                    }
                }
            }
        }
    }
}
