pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// Settings page: per-provider masked API-key fields (write-only; the saved/empty
// badge comes from settings.get api_keys_set), a default-brain selector, a
// default-model ComboBox (model.list), and theme toggles. Save -> settings.set.
Item {
    id: page

    // provider key id -> field text (write-only; never pre-filled with secrets)
    property var providers: [
        { id: "codex",     label: "Codex CLI",  hint: "OpenAI key used by the Codex brain" },
        { id: "claude",    label: "Claude CLI", hint: "Anthropic key used by the Claude brain" },
        { id: "openai",    label: "OpenAI API", hint: "Direct OpenAI API (api brain)" },
        { id: "anthropic", label: "Anthropic API", hint: "Direct Anthropic API (api brain)" },
        { id: "ollama",    label: "Ollama",     hint: "Local Ollama endpoint / token (optional)" }
    ]

    property var keysSet: ({})                 // provider -> bool (from settings.get)
    property var pendingKeys: ({})             // provider -> new value to save
    property var modelsByBrain: ({})
    property var canDrive: ({})                 // brain -> bool (computer-use drive)
    property string defaultBrain: "codex"
    property string defaultModel: ""
    property string claudeAccount: "pro"        // "pro" (default) | "max"
    property string ttsVoice: ""                 // preferred TTS voice slug
    property var voiceList: []                   // [{id,label}] from voice.list_voices
    property string sttProvider: "voxtral"       // STT provider id
    property string ttsProvider: "voxtral"       // TTS provider id
    property var sttProviders: []                // [{id,label,available}]
    property var ttsProviders: []                // [{id,label,available}]
    property var voicesByProvider: ({})          // {provider: [{id,label}]}
    property bool glow: true
    property bool compact: false
    property bool authLockEnabled: false        // require phone+fingerprint to open
    property bool dirty: false
    property bool saving: false

    // Google connectors (connectors.list rows: {id,name,service,enabled,risk,...}).
    property var connectors: []
    // The four known Google services, in display order.
    readonly property var connectorServices: [
        { service: "calendar", label: "Google Calendar" },
        { service: "docs",     label: "Google Docs" },
        { service: "drive",    label: "Google Drive" },
        { service: "gmail",    label: "Gmail" }
    ]
    // The connector row (if any) already added for a given service id.
    function connectorFor(service) {
        for (var i = 0; i < page.connectors.length; i++)
            if (page.connectors[i].service === service)
                return page.connectors[i]
        return null
    }

    // ---- Devices / phone pairing state -------------------------------------
    property bool pairing: false               // waiting on devices.pair_start
    property string pairSvg: ""                // raw qr_svg markup from the daemon
    property string pairCode: ""               // 6-digit pairing code
    property string pairPayload: ""            // jarvis://pair?... deep link
    property double pairExpiresAt: 0           // epoch seconds the code expires
    property int pairRemaining: 0              // live countdown (seconds), driven by a Timer
    property bool devicesLoaded: false

    // SVG -> data URI so the qsvg image plugin renders it inside an Image{}.
    function pairSvgUri() {
        if (!page.pairSvg || page.pairSvg.length === 0) return ""
        return "data:image/svg+xml;utf8," + encodeURIComponent(page.pairSvg)
    }

    function load() { bridge.loadSettings(); bridge.listVoices(); bridge.connectorsList() }
    function loadDevices() { page.devicesLoaded = true; bridge.devicesList() }
    Component.onCompleted: if (bridge.connected) { load(); loadDevices() }

    // Live expiry countdown for an active pairing code.
    Timer {
        id: pairTick
        interval: 1000
        repeat: true
        running: page.pairCode.length > 0 && page.pairExpiresAt > 0
        onTriggered: {
            var rem = Math.round(page.pairExpiresAt - (Date.now() / 1000))
            page.pairRemaining = rem > 0 ? rem : 0
            if (page.pairRemaining <= 0) {
                // code expired: clear it so the bay returns to its idle prompt
                page.pairCode = ""
                page.pairSvg = ""
                page.pairPayload = ""
                page.pairExpiresAt = 0
            }
        }
    }

    Connections {
        target: bridge
        function onConnectedChanged() {
            if (bridge.connected) { page.load(); page.loadDevices() }
        }
        function onPairingStarted(qrSvg, code, payload, expiresAt) {
            page.pairing = false
            page.pairSvg = qrSvg
            page.pairCode = code
            page.pairPayload = payload
            page.pairExpiresAt = expiresAt
            page.pairRemaining = Math.max(0, Math.round(expiresAt - (Date.now() / 1000)))
            // a fresh pairing usually precedes a device showing up
            page.loadDevices()
        }
        function onDevicesListed(devices) {
            devicesModel.clear()
            for (var i = 0; i < devices.length; i++) {
                var d = devices[i]
                devicesModel.append({
                    "did": d.id !== undefined ? d.id : "",
                    "dname": d.name !== undefined && d.name.length ? d.name : "Unnamed device",
                    "pairedAt": d.paired_at !== undefined ? d.paired_at : "",
                    "lastSeen": d.last_seen !== undefined ? d.last_seen : ""
                })
            }
        }
        function onDevicesChanged() {
            // a paired device was just revoked; the active QR (if any) stays valid
        }
        function onSettingsLoaded(s) {
            page.keysSet = s.api_keys_set !== undefined ? s.api_keys_set : ({})
            page.modelsByBrain = s.models_by_brain !== undefined ? s.models_by_brain : ({})
            page.canDrive = s.can_drive !== undefined ? s.can_drive : ({})
            page.defaultBrain = s.default_brain !== undefined ? s.default_brain : "codex"
            page.defaultModel = s.default_model !== undefined ? s.default_model : ""
            page.claudeAccount = (s.claude_account === "max") ? "max" : "pro"
            page.ttsVoice = s.tts_voice !== undefined ? s.tts_voice : ""
            page.sttProvider = s.stt_provider !== undefined ? s.stt_provider : "voxtral"
            page.ttsProvider = s.tts_provider !== undefined ? s.tts_provider : "voxtral"
            if (s.stt_providers !== undefined) page.sttProviders = s.stt_providers
            if (s.tts_providers !== undefined) page.ttsProviders = s.tts_providers
            page.authLockEnabled = s.auth_lock_enabled === true
            if (s.theme !== undefined) {
                page.glow = s.theme.glow !== undefined ? s.theme.glow : true
                page.compact = s.theme.compact !== undefined ? s.theme.compact : false
            }
            page.pendingKeys = ({})
            page.dirty = false
            brainCombo.syncFromState()
            modelCombo.syncFromState()
            claudeAccountCombo.syncFromState()
            sttProviderCombo.syncFromState()
            ttsProviderCombo.syncFromState()
            voiceCombo.syncFromState()
        }
        function onVoicesListed(voices) {
            page.voiceList = voices !== undefined ? voices : []
            voiceCombo.refill()
        }
        function onVoiceProvidersListed(sttProviders, ttsProviders, voicesByProvider) {
            if (sttProviders !== undefined && sttProviders.length) page.sttProviders = sttProviders
            if (ttsProviders !== undefined && ttsProviders.length) page.ttsProviders = ttsProviders
            page.voicesByProvider = voicesByProvider !== undefined ? voicesByProvider : ({})
            // Repopulate the voice list from the active TTS provider's voices.
            var vs = page.voicesByProvider[page.ttsProvider]
            if (vs !== undefined && vs.length) { page.voiceList = vs; voiceCombo.refill() }
            sttProviderCombo.syncFromState()
            ttsProviderCombo.syncFromState()
        }
        function onSettingsSaved() {
            page.saving = false
            page.pendingKeys = ({})
            page.dirty = false
            // re-pull so api_keys_set badges flip to "saved"
            page.load()
        }
        function onConnectorsListed(connectors) {
            page.connectors = connectors !== undefined ? connectors : []
        }
        function onConnectorsChanged() {
            // a connector was added; the Bridge auto re-lists, but refresh defensively
            bridge.connectorsList()
        }
    }

    // Paired phones (devices.list).
    ListModel { id: devicesModel }

    function currentModels() {
        var m = page.modelsByBrain[page.defaultBrain]
        return (m && m.length) ? m : [page.defaultModel].filter(function(x){return x && x.length})
    }

    // Voice picker helpers: the combo shows labels, but we persist the id slug.
    function voiceLabels() {
        var out = []
        var seenCurrent = false
        for (var i = 0; i < page.voiceList.length; i++) {
            var v = page.voiceList[i]
            var id = (v && v.id !== undefined) ? ("" + v.id) : ""
            var label = (v && v.label !== undefined && ("" + v.label).length) ? ("" + v.label) : id
            out.push(label)
            if (id === page.ttsVoice) seenCurrent = true
        }
        // If the saved voice isn't in the curated list, surface it so it's not lost.
        if (page.ttsVoice.length > 0 && !seenCurrent)
            out.unshift(page.ttsVoice + " (saved)")
        if (out.length === 0)
            out.push("en_paul_neutral")
        return out
    }
    // Map a combo row index back to its voice id slug.
    function voiceIdForIndex(idx) {
        var labels = page.voiceLabels()
        var offset = 0
        var seenCurrent = false
        for (var i = 0; i < page.voiceList.length; i++)
            if (("" + page.voiceList[i].id) === page.ttsVoice) seenCurrent = true
        if (page.ttsVoice.length > 0 && !seenCurrent) {
            if (idx === 0) return page.ttsVoice
            offset = 1
        }
        var li = idx - offset
        if (li >= 0 && li < page.voiceList.length)
            return "" + page.voiceList[li].id
        return page.ttsVoice
    }

    // Provider picker helpers: combos show labels, persist the id. Unavailable
    // local providers are shown with a "(not installed)" hint.
    function providerLabels(list) {
        var out = []
        for (var i = 0; i < list.length; i++) {
            var p = list[i]
            var label = (p && p.label !== undefined && ("" + p.label).length) ? ("" + p.label) : ("" + p.id)
            if (p && p.available === false) label += " (not installed)"
            out.push(label)
        }
        if (out.length === 0) out.push("voxtral")
        return out
    }
    function providerIdForIndex(list, idx) {
        if (idx >= 0 && idx < list.length) return "" + list[idx].id
        return "voxtral"
    }
    function providerIndexForId(list, id) {
        for (var i = 0; i < list.length; i++)
            if (("" + list[i].id) === id) return i
        return 0
    }

    function save() {
        page.saving = true
        var patch = {
            "default_brain": page.defaultBrain,
            "default_model": page.defaultModel,
            "claude_account": page.claudeAccount,
            "tts_voice": page.ttsVoice,
            "stt_provider": page.sttProvider,
            "tts_provider": page.ttsProvider,
            "auth_lock_enabled": page.authLockEnabled,
            "theme": { "glow": page.glow, "compact": page.compact }
        }
        // only send keys the user actually typed (write-only)
        var hasKeys = false
        var keys = {}
        for (var k in page.pendingKeys) {
            if (page.pendingKeys[k] !== undefined) { keys[k] = page.pendingKeys[k]; hasKeys = true }
        }
        if (hasKeys) patch["api_keys"] = keys
        bridge.saveSettings(patch)
    }

    Flickable {
        anchors.fill: parent
        anchors.margins: 18
        contentHeight: col.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        ScrollBar.vertical: ScrollBar {
            policy: ScrollBar.AsNeeded
            width: 5
            background: Item {}
            contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
        }

        ColumnLayout {
            id: col
            width: parent.width
            spacing: 16

            RowLayout {
                Layout.fillWidth: true
                PageHeader {
                    Layout.fillWidth: true
                    title: "Settings"
                    subtitle: "Provider keys are write-only — they are never read back."
                }
                Widgets.PillButton {
                    label: page.saving ? "Saving…" : "Save"
                    primary: true
                    enabledBtn: page.dirty && !page.saving
                    busy: page.saving
                    Layout.alignment: Qt.AlignTop
                    onClicked: page.save()
                }
            }

            // ===== Defaults =================================================
            Widgets.SectionCard {
                Layout.fillWidth: true
                Text {
                    text: "// DEFAULTS"
                    color: Theme.accent
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 14
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 5
                        Text { text: "Default brain"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                        Widgets.StyledCombo {
                            id: brainCombo
                            Layout.fillWidth: true
                            model: ["codex", "claude", "api"]
                            function syncFromState() {
                                var i = model.indexOf(page.defaultBrain)
                                currentIndex = i >= 0 ? i : 0
                            }
                            onActivated: {
                                page.defaultBrain = currentText
                                page.dirty = true
                                modelCombo.refill()
                            }
                        }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 5
                        Text { text: "Default model"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                        Widgets.StyledCombo {
                            id: modelCombo
                            Layout.fillWidth: true
                            model: page.currentModels()
                            function refill() { model = page.currentModels(); syncFromState() }
                            function syncFromState() {
                                var i = model.indexOf(page.defaultModel)
                                currentIndex = i >= 0 ? i : 0
                                if (i < 0 && model.length > 0) page.defaultModel = model[0]
                            }
                            onActivated: { page.defaultModel = currentText; page.dirty = true }
                        }
                    }
                }

                // Per-brain "can drive the computer-use desktop" indicator — the
                // choice is HONORED; no silent substitution. codex + claude can
                // drive headless; the api brain only with an OpenAI/Anthropic key.
                Text {
                    Layout.fillWidth: true
                    Layout.topMargin: 2
                    text: {
                        var cd = page.canDrive[page.defaultBrain]
                        if (cd === true) return "✓ " + page.defaultBrain + " can drive the computer-use desktop"
                        if (page.defaultBrain === "api")
                            return "⚠ api can't drive without an OpenAI/Anthropic key — pick codex or claude, or set a key below"
                        return "⚠ " + page.defaultBrain + " can't drive the computer-use desktop headless"
                    }
                    color: (page.canDrive[page.defaultBrain] === true) ? Theme.ok : Theme.amber
                    font.family: Theme.fontSans
                    font.pixelSize: 11
                    wrapMode: Text.WordWrap
                }
            }

            // ===== Claude account =========================================
            Widgets.SectionCard {
                Layout.fillWidth: true
                visible: true
                Text {
                    text: "// CLAUDE ACCOUNT"
                    color: Theme.accent
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                Text {
                    Layout.fillWidth: true
                    text: "Which Claude login the claude brain runs as. Defaults to Pro."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                    wrapMode: Text.WordWrap
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 14
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 5
                        Text { text: "Account"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                        Widgets.StyledCombo {
                            id: claudeAccountCombo
                            Layout.fillWidth: true
                            // index 0 == Pro (default), index 1 == Max
                            model: ["Pro (ogkihi2024@gmail.com)", "Max (issac676767@proton.me)"]
                            function syncFromState() {
                                currentIndex = (page.claudeAccount === "max") ? 1 : 0
                            }
                            onActivated: {
                                page.claudeAccount = (currentIndex === 1) ? "max" : "pro"
                                page.dirty = true
                            }
                        }
                    }
                }
                // Max-quota warning, only when Max is selected.
                Text {
                    Layout.fillWidth: true
                    visible: page.claudeAccount === "max"
                    text: "⚠ Max — uses your Max quota (issac676767@proton.me)."
                    color: Theme.amber
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                    wrapMode: Text.WordWrap
                }
            }

            // ===== Voice ====================================================
            Widgets.SectionCard {
                Layout.fillWidth: true
                Text {
                    text: "// VOICE"
                    color: Theme.accent
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                Text {
                    Layout.fillWidth: true
                    text: "Which engine Jarvis uses to hear (STT) and speak (TTS), and the voice."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                    wrapMode: Text.WordWrap
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 14
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 5
                        Text { text: "STT provider"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                        Widgets.StyledCombo {
                            id: sttProviderCombo
                            Layout.fillWidth: true
                            model: page.providerLabels(page.sttProviders)
                            function refill() { model = page.providerLabels(page.sttProviders); syncFromState() }
                            function syncFromState() {
                                model = page.providerLabels(page.sttProviders)
                                currentIndex = page.providerIndexForId(page.sttProviders, page.sttProvider)
                            }
                            onActivated: {
                                page.sttProvider = page.providerIdForIndex(page.sttProviders, currentIndex)
                                page.dirty = true
                            }
                        }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 5
                        Text { text: "TTS provider"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                        Widgets.StyledCombo {
                            id: ttsProviderCombo
                            Layout.fillWidth: true
                            model: page.providerLabels(page.ttsProviders)
                            function refill() { model = page.providerLabels(page.ttsProviders); syncFromState() }
                            function syncFromState() {
                                model = page.providerLabels(page.ttsProviders)
                                currentIndex = page.providerIndexForId(page.ttsProviders, page.ttsProvider)
                            }
                            onActivated: {
                                page.ttsProvider = page.providerIdForIndex(page.ttsProviders, currentIndex)
                                page.dirty = true
                                // Repoint the voice list at the new provider's voices.
                                var vs = page.voicesByProvider[page.ttsProvider]
                                page.voiceList = (vs !== undefined && vs.length) ? vs : []
                                voiceCombo.refill()
                            }
                        }
                    }
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 14
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 5
                        Text { text: "TTS voice"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                        Widgets.StyledCombo {
                            id: voiceCombo
                            Layout.fillWidth: true
                            model: page.voiceLabels()
                            function refill() { model = page.voiceLabels(); syncFromState() }
                            function syncFromState() {
                                // Find the row whose id matches the saved slug.
                                var idx = 0
                                for (var i = 0; i < model.length; i++) {
                                    if (page.voiceIdForIndex(i) === page.ttsVoice) { idx = i; break }
                                }
                                currentIndex = idx
                            }
                            onActivated: {
                                page.ttsVoice = page.voiceIdForIndex(currentIndex)
                                page.dirty = true
                            }
                        }
                    }
                }
            }

            // ===== Providers ================================================
            Text {
                text: "// API KEYS"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
                Layout.topMargin: 2
                Layout.leftMargin: 2
            }

            Repeater {
                model: page.providers
                delegate: Widgets.SectionCard {
                    id: provCard
                    required property var modelData
                    Layout.fillWidth: true

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2
                            Text {
                                text: provCard.modelData.label
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 14
                                font.weight: Font.Medium
                            }
                            Text {
                                text: provCard.modelData.hint
                                color: Theme.textFaint
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                            }
                        }
                        // saved/empty badge from api_keys_set
                        Rectangle {
                            property bool isSet: page.keysSet[provCard.modelData.id] === true
                            radius: 7
                            implicitWidth: badge.implicitWidth + 18
                            implicitHeight: 22
                            color: "transparent"
                            border.width: 1
                            border.color: isSet ? Theme.ok : Theme.hairline
                            Text {
                                id: badge
                                anchors.centerIn: parent
                                text: parent.isSet ? "saved" : "empty"
                                color: parent.isSet ? Theme.ok : Theme.textFaint
                                font.family: Theme.fontSans
                                font.pixelSize: 11
                                font.letterSpacing: 0.6
                            }
                        }
                    }

                    Widgets.StyledField {
                        Layout.fillWidth: true
                        masked: true
                        placeholder: (page.keysSet[provCard.modelData.id] === true)
                                     ? "•••••••••• (set — type to replace)"
                                     : "Paste API key…"
                        onTextChanged: {
                            var pk = page.pendingKeys
                            pk[provCard.modelData.id] = text
                            page.pendingKeys = pk
                            page.dirty = true
                        }
                    }
                }
            }

            // ===== Appearance ===============================================
            Widgets.SectionCard {
                Layout.fillWidth: true
                Text {
                    text: "// APPEARANCE"
                    color: Theme.accent
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                RowLayout {
                    Layout.fillWidth: true
                    Text { text: "Accent glow"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 13; Layout.fillWidth: true }
                    Widgets.StyledSwitch {
                        checked: page.glow
                        onToggled: function(v) { page.glow = v; page.dirty = true }
                    }
                }
                RowLayout {
                    Layout.fillWidth: true
                    Text { text: "Compact density"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 13; Layout.fillWidth: true }
                    Widgets.StyledSwitch {
                        checked: page.compact
                        onToggled: function(v) { page.compact = v; page.dirty = true }
                    }
                }
                // accent swatch row (the one accent, shown for confirmation)
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text { text: "Accent"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 13; Layout.fillWidth: true }
                    Rectangle {
                        width: 22; height: 22; radius: 6
                        color: Theme.accent
                        border.color: Theme.accentGlow
                        border.width: page.glow ? 2 : 0
                    }
                    Text { text: "#29E7FF"; color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 12 }
                }
            }

            // ===== Security ================================================
            Text {
                text: "// SECURITY"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
                Layout.topMargin: 2
                Layout.leftMargin: 2
            }

            Widgets.SectionCard {
                Layout.fillWidth: true
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 10
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Text {
                            text: "Require phone + fingerprint to open Jarvis"
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 13
                            Layout.fillWidth: true
                            wrapMode: Text.WordWrap
                        }
                        Text {
                            text: "Two factors: a tap on your paired phone AND its fingerprint unlock. Fails open when no phone is paired."
                            color: Theme.textMuted
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                            Layout.fillWidth: true
                            wrapMode: Text.WordWrap
                        }
                    }
                    Widgets.StyledSwitch {
                        checked: page.authLockEnabled
                        onToggled: function(v) { page.authLockEnabled = v; page.dirty = true }
                    }
                }
            }

            // ===== Connectors ==============================================
            Text {
                text: "// CONNECTORS"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
                Layout.topMargin: 2
                Layout.leftMargin: 2
            }

            Widgets.SectionCard {
                Layout.fillWidth: true

                Text {
                    text: "Google services Jarvis can use (added disabled — authorize to enable)"
                    color: Theme.textMuted
                    font.family: Theme.fontSans
                    font.pixelSize: 11
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                }

                Repeater {
                    model: page.connectorServices
                    delegate: RowLayout {
                        id: connRow
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: 10

                        property var row: page.connectorFor(connRow.modelData.service)
                        property bool added: connRow.row !== null
                        property bool enabled: connRow.added && connRow.row.enabled === true

                        Text {
                            text: connRow.modelData.label
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 13
                            Layout.fillWidth: true
                        }

                        // State badge: Enabled / Added / not added.
                        Rectangle {
                            visible: connRow.added
                            radius: Theme.radiusSm
                            color: "transparent"
                            border.color: connRow.enabled ? Theme.accent : Theme.textFaint
                            border.width: 1
                            implicitHeight: badgeText.implicitHeight + 6
                            implicitWidth: badgeText.implicitWidth + 14
                            Text {
                                id: badgeText
                                anchors.centerIn: parent
                                text: connRow.enabled ? "Enabled" : "Added"
                                color: connRow.enabled ? Theme.accent : Theme.textMuted
                                font.family: Theme.fontMono
                                font.pixelSize: 10
                            }
                        }

                        Widgets.PillButton {
                            label: connRow.added ? "Added" : "Add"
                            enabledBtn: !connRow.added
                            Layout.alignment: Qt.AlignVCenter
                            onClicked: {
                                if (connRow.added) return
                                // Placeholder creds for the framework/mock; real creds
                                // come from the paste-config flow later.
                                bridge.connectorAdd(connRow.modelData.service, "", "", "")
                            }
                        }
                    }
                }
            }

            // ===== Devices ==================================================
            Text {
                text: "// DEVICES"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
                Layout.topMargin: 2
                Layout.leftMargin: 2
            }

            // ---- Pair a phone -----------------------------------------------
            Widgets.SectionCard {
                Layout.fillWidth: true

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 10
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Text {
                            text: "Pair a phone"
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 14
                            font.weight: Font.Medium
                        }
                        Text {
                            text: "Scan the QR in the Jarvis app, or enter the code manually."
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 12
                        }
                    }
                    Widgets.PillButton {
                        label: page.pairing ? "Generating…"
                               : (page.pairCode.length > 0 ? "New code" : "Pair a phone")
                        primary: true
                        busy: page.pairing
                        enabledBtn: bridge.connected && !page.pairing
                        Layout.alignment: Qt.AlignVCenter
                        onClicked: { page.pairing = true; bridge.devicesPairStart() }
                    }
                }

                // QR + code panel — only while an unexpired code is live.
                Rectangle {
                    Layout.fillWidth: true
                    Layout.topMargin: 4
                    visible: page.pairCode.length > 0
                    implicitHeight: pairRow.implicitHeight + 28
                    radius: Theme.radiusSm
                    color: Theme.surfaceDeep
                    border.width: 1
                    border.color: Theme.accentDim

                    // top energy seam (arc-reactor accent)
                    Rectangle {
                        anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
                        anchors.leftMargin: 14; anchors.rightMargin: 14; anchors.topMargin: 1
                        height: 1
                        gradient: Gradient {
                            orientation: Gradient.Horizontal
                            GradientStop { position: 0.0; color: "transparent" }
                            GradientStop { position: 0.5; color: Theme.accent }
                            GradientStop { position: 1.0; color: "transparent" }
                        }
                        opacity: 0.7
                    }

                    RowLayout {
                        id: pairRow
                        anchors.fill: parent
                        anchors.margins: 14
                        spacing: 16

                        // QR rendered from qr_svg via the qsvg image plugin
                        Rectangle {
                            Layout.alignment: Qt.AlignVCenter
                            implicitWidth: 132
                            implicitHeight: 132
                            radius: Theme.radiusXs
                            color: "#EAF6FF"   // light quiet-zone so the QR scans
                            border.width: 1
                            border.color: Theme.accentGlow

                            Image {
                                anchors.fill: parent
                                anchors.margins: 8
                                source: page.pairSvgUri()
                                sourceSize.width: 232
                                sourceSize.height: 232
                                fillMode: Image.PreserveAspectFit
                                smooth: false
                                cache: false
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.alignment: Qt.AlignVCenter
                            spacing: 8

                            Text {
                                text: "PAIRING CODE"
                                color: Theme.textMuted
                                font.family: Theme.fontDisplay
                                font.pixelSize: 10
                                font.letterSpacing: Theme.trackWide
                            }
                            Text {
                                text: page.pairCode
                                color: Theme.accentBright
                                font.family: Theme.fontMono
                                font.pixelSize: 30
                                font.letterSpacing: 6
                                font.weight: Font.DemiBold
                            }
                            RowLayout {
                                spacing: 6
                                Rectangle {
                                    width: 6; height: 6; radius: 3
                                    Layout.alignment: Qt.AlignVCenter
                                    color: page.pairRemaining > 30 ? Theme.success
                                           : (page.pairRemaining > 0 ? Theme.amber : Theme.danger)
                                }
                                Text {
                                    text: page.pairRemaining > 0
                                          ? ("Expires in " + page.pairRemaining + "s")
                                          : "Expired — request a new code"
                                    color: page.pairRemaining > 0 ? Theme.textMuted : Theme.danger
                                    font.family: Theme.fontSans
                                    font.pixelSize: 12
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                visible: page.pairPayload.length > 0
                                text: page.pairPayload
                                color: Theme.textFaint
                                font.family: Theme.fontMono
                                font.pixelSize: 10
                                elide: Text.ElideRight
                                maximumLineCount: 1
                            }
                        }
                    }
                }
            }

            // ---- Paired devices list ----------------------------------------
            Widgets.SectionCard {
                Layout.fillWidth: true
                Text {
                    text: "// PAIRED"
                    color: Theme.accent
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }

                Text {
                    visible: devicesModel.count === 0
                    Layout.fillWidth: true
                    text: page.devicesLoaded ? "No devices paired yet."
                                             : "Loading paired devices…"
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                }

                Repeater {
                    model: devicesModel
                    delegate: Rectangle {
                        id: devRow
                        required property int index
                        required property string did
                        required property string dname
                        required property string pairedAt
                        required property string lastSeen

                        Layout.fillWidth: true
                        implicitHeight: devContent.implicitHeight + 22
                        radius: Theme.radiusSm
                        color: Theme.panelSoft
                        border.width: 1
                        border.color: Theme.hairlineSoft

                        RowLayout {
                            id: devContent
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.leftMargin: 14
                            anchors.rightMargin: 14
                            spacing: 12

                            // phone glyph node
                            Rectangle {
                                width: 30; height: 30; radius: Theme.radiusXs
                                Layout.alignment: Qt.AlignVCenter
                                color: Theme.accentFaint
                                border.width: 1
                                border.color: Theme.accentDim
                                Rectangle {
                                    anchors.centerIn: parent
                                    width: 13; height: 19; radius: 3
                                    color: "transparent"
                                    border.width: 1.4
                                    border.color: Theme.accent
                                    Rectangle {
                                        anchors.bottom: parent.bottom
                                        anchors.horizontalCenter: parent.horizontalCenter
                                        anchors.bottomMargin: 2
                                        width: 5; height: 1.4; radius: 0.7
                                        color: Theme.accent
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2
                                Text {
                                    text: devRow.dname
                                    color: Theme.text
                                    font.family: Theme.fontSans
                                    font.pixelSize: 14
                                    font.weight: Font.Medium
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: {
                                        var parts = []
                                        if (devRow.lastSeen && devRow.lastSeen.length)
                                            parts.push("last seen " + devRow.lastSeen)
                                        if (devRow.pairedAt && devRow.pairedAt.length)
                                            parts.push("paired " + devRow.pairedAt)
                                        return parts.length ? parts.join("  ·  ") : devRow.did
                                    }
                                    color: Theme.textFaint
                                    font.family: Theme.fontMono
                                    font.pixelSize: 11
                                    elide: Text.ElideRight
                                }
                            }

                            Widgets.PillButton {
                                label: "Revoke"
                                danger: true
                                Layout.alignment: Qt.AlignVCenter
                                onClicked: bridge.devicesRevoke(devRow.did)
                            }
                        }
                    }
                }
            }

            Item { Layout.preferredHeight: 6 }
        }
    }
}
