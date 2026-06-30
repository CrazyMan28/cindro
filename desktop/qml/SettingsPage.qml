pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Dialogs
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
        { id: "mistral",   label: "Mistral API", hint: "Direct Mistral API (api brain) — mistral-large/small-latest" },
        { id: "ollama",    label: "Ollama",     hint: "Local Ollama endpoint / token (optional)" }
    ]

    property var keysSet: ({})                 // provider -> bool (from settings.get)
    property var pendingKeys: ({})             // provider -> new value to save
    property var modelsByBrain: ({})
    property var canDrive: ({})                 // brain -> bool (computer-use drive)
    property string defaultBrain: "codex"
    property string defaultModel: ""
    property string claudeAccount: "pro"        // "pro" (default) | "max"
    property string ttsVoice: ""                 // preferred TTS voice slug (the default)
    property var voiceList: []                   // [{id,label}] from voice.list_voices
    // Named voice library (record/upload your own voice + set one as default).
    property var libraryVoices: []               // custom voices [{id,label,is_default,source,raw}]
    property bool clipReady: false               // a candidate clip is recorded/uploaded
    property string clipInfo: ""                 // status line under the record/upload row
    property bool cleanClip: true                // auto-clean (ffmpeg trim) on save
    property string sttProvider: "voxtral"       // STT provider id
    property string ttsProvider: "voxtral"       // TTS provider id
    property var sttProviders: []                // [{id,label,available}]
    property var ttsProviders: []                // [{id,label,available}]
    property var voicesByProvider: ({})          // {provider: [{id,label}]}
    property bool glow: true
    property bool compact: false
    property bool authLockEnabled: false        // require phone+fingerprint to open
    property string permissionLevel: "medium"   // ask-before-risky: high|medium|low
    property string agentMode: "coworker"        // plan|build|coworker (soft mode)
    property string wakeNotify: "ping"           // silent|ping|always (bg-job/wake)
    property bool hasDesktopPin: false           // a desktop unlock PIN is set
    property string pendingPin: ""               // new PIN to save (write-only)
    property bool dirty: false
    property bool saving: false

    // ---- Updates (auto-updater) --------------------------------------------
    property bool autoUpdate: true               // periodic auto-update-check
    property string appVersion: ""               // running JARVIS_VERSION (settings.get)
    property bool updateChecking: false          // a update.check is in flight
    property bool updateApplying: false          // a update.apply is in flight
    property bool updateBehind: false            // the last check found an update
    property string updateLatest: ""             // the available version/SHA
    property string updateStatus: ""             // human status line under the row

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

    // Whole seconds left before the pairing code expires. The daemon sends
    // `expires_at` as epoch MILLISECONDS; the old code subtracted Date.now()/1000
    // (seconds) from it, a unit mismatch that produced a garbage countdown and an
    // instantly-"Expired" code. Normalize (tolerating an epoch-seconds value too)
    // and diff against Date.now() in the same unit.
    function pairSecondsLeft() {
        if (page.pairExpiresAt <= 0) return 0
        var ms = page.pairExpiresAt > 1e11 ? page.pairExpiresAt : page.pairExpiresAt * 1000
        return Math.max(0, Math.round((ms - Date.now()) / 1000))
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
            page.pairRemaining = page.pairSecondsLeft()
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
            page.pairRemaining = page.pairSecondsLeft()
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
            page.permissionLevel = (s.permission_level === "high" || s.permission_level === "low")
                                   ? s.permission_level : "medium"
            page.agentMode = (s.agent_mode === "plan" || s.agent_mode === "build")
                             ? s.agent_mode : "coworker"
            page.wakeNotify = (s.wake_notify === "silent" || s.wake_notify === "always")
                              ? s.wake_notify : "ping"
            page.hasDesktopPin = (s.has_desktop_pin === true)
            page.pendingPin = ""
            page.autoUpdate = (s.auto_update === undefined) ? true : (s.auto_update === true)
            page.appVersion = s.version !== undefined ? s.version : ""
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
            // The named voices (record/upload) are flagged custom:true — pull them
            // out for the Default Voice manager below.
            page.libraryVoices = page.voiceList.filter(function (v) { return v && v.custom === true })
            voiceCombo.refill()
        }
        // A candidate reference clip was recorded/uploaded and is ready to name+save.
        function onVoiceClipCaptured(bytes, format) {
            page.clipReady = true
            page.clipInfo = "clip ready — " + Math.round(bytes / 1024) + " KB (" + format + ")"
        }
        // The library changed (after create/delete/set-default/rename): refresh the
        // manager rows + the picker, and adopt the new default voice id.
        function onVoiceLibraryChanged(voices, defaultVoice) {
            page.libraryVoices = voices !== undefined ? voices : []
            if (defaultVoice !== undefined && defaultVoice.length) page.ttsVoice = defaultVoice
            bridge.listVoices()          // refresh the full picker (stock + custom)
            voiceCombo.syncFromState()
        }
        function onVoiceCloneResult(ok, error) {
            if (ok) { page.clipReady = false; page.clipInfo = "saved ✓" }
            else { page.clipInfo = "⚠ " + (error && error.length ? error : "failed") }
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
        // ---- Auto-updater results ------------------------------------------
        function onUpdateChecked(current, latest, behind, version, reason) {
            page.updateChecking = false
            page.updateBehind = behind === true
            page.updateLatest = latest !== undefined ? latest : ""
            if (version !== undefined && version.length) page.appVersion = version
            if (behind === true)
                page.updateStatus = "Update available (" + (page.updateLatest.length
                    ? page.updateLatest : "newer") + ")"
            else if (reason !== undefined && reason.length)
                page.updateStatus = reason
            else
                page.updateStatus = "Up to date"
        }
        function onUpdateApplied(updated, to, reason) {
            page.updateApplying = false
            if (updated === true) {
                page.updateBehind = false
                page.updateStatus = "Updated to " + (to && to.length ? to : "latest")
                    + " — Jarvis is restarting…"
            } else {
                page.updateStatus = (reason && reason.length) ? reason : "No update applied"
            }
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

    // Upload an audio clip to clone as a named voice.
    FileDialog {
        id: voiceFileDialog
        title: "Choose a voice clip"
        nameFilters: ["Audio (*.mp3 *.wav *.ogg *.flac *.opus *.m4a *.webm)", "All files (*)"]
        onAccepted: bridge.loadVoiceClipFromFile("" + selectedFile)
    }

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
            "permission_level": page.permissionLevel,
            "agent_mode": page.agentMode,
            "wake_notify": page.wakeNotify,
            "auto_update": page.autoUpdate,
            "theme": { "glow": page.glow, "compact": page.compact }
        }
        // PIN is write-only: only send when the user typed/cleared one.
        if (page.pendingPin.length > 0)
            patch["desktop_pin"] = (page.pendingPin === "__CLEAR__") ? "" : page.pendingPin
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
                // drive headless; the api brain only with an OpenAI/Mistral key.
                Text {
                    Layout.fillWidth: true
                    Layout.topMargin: 2
                    text: {
                        var cd = page.canDrive[page.defaultBrain]
                        if (cd === true) return "✓ " + page.defaultBrain + " can drive the computer-use desktop"
                        if (page.defaultBrain === "api")
                            return "⚠ api can't drive without an OpenAI/Mistral key — pick codex or claude, or set a key below"
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
                            model: ["Pro (you@example.com)", "Max (you-max@example.com)"]
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
                    text: "⚠ Max — uses your Max quota (you-max@example.com)."
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

                // ---- Default voice: record/upload your own, set as default ----
                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairlineSoft; Layout.topMargin: 4 }
                Text {
                    text: "DEFAULT VOICE — RECORD YOUR OWN OR UPLOAD A CLIP"
                    color: Theme.accent
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                Text {
                    Layout.fillWidth: true
                    text: "The default voice is used everywhere Jarvis speaks — read-back, voice mode, and phone calls (when it calls you and when it answers)."
                    color: Theme.textMuted
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                    wrapMode: Text.WordWrap
                }

                // Saved voices — each row: default dot · name · source · preview / set-default / delete
                Repeater {
                    model: page.libraryVoices
                    delegate: RowLayout {
                        id: voiceRow
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            text: voiceRow.modelData.is_default ? "●" : "○"
                            color: voiceRow.modelData.is_default ? Theme.success : Theme.textFaint
                            font.pixelSize: 14
                        }
                        Text {
                            Layout.fillWidth: true
                            text: ("" + (voiceRow.modelData.label !== undefined ? voiceRow.modelData.label : voiceRow.modelData.id))
                                  + (voiceRow.modelData.is_default ? "  ·  default" : "")
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 13
                            elide: Text.ElideRight
                        }
                        Text {
                            text: voiceRow.modelData.source === "record" ? "recorded"
                                  : (voiceRow.modelData.raw === true ? "raw clip" : "clip")
                            color: Theme.textFaint
                            font.family: Theme.fontMono
                            font.pixelSize: 10
                        }
                        Widgets.PillButton {
                            label: "Preview"
                            onClicked: bridge.previewVoice(voiceRow.modelData.id)
                        }
                        Widgets.PillButton {
                            label: "Set default"
                            primary: !voiceRow.modelData.is_default
                            enabledBtn: !voiceRow.modelData.is_default
                            onClicked: bridge.setDefaultVoice(voiceRow.modelData.id)
                        }
                        Widgets.PillButton {
                            label: "Delete"
                            danger: true
                            onClicked: bridge.deleteVoiceClone(voiceRow.modelData.id)
                        }
                    }
                }
                Text {
                    visible: page.libraryVoices.length === 0
                    text: "No saved voices yet — record or upload one below."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                }

                // Record / upload + name + save
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Widgets.StyledField {
                        id: voiceNameField
                        Layout.fillWidth: true
                        placeholder: "Voice name (e.g. My Voice)"
                    }
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Widgets.PillButton {
                        label: bridge.voiceCloneState === "recording" ? "Stop recording" : "● Record"
                        danger: bridge.voiceCloneState === "recording"
                        busy: bridge.voiceCloneState === "saving"
                        onClicked: bridge.voiceCloneState === "recording"
                                   ? bridge.stopVoiceCloneRecording()
                                   : bridge.recordVoiceClone(20)
                    }
                    Widgets.PillButton {
                        label: "Upload clip"
                        enabledBtn: bridge.voiceCloneState !== "recording"
                        onClicked: voiceFileDialog.open()
                    }
                    Text {
                        Layout.fillWidth: true
                        text: page.clipInfo
                        color: page.clipInfo.indexOf("⚠") === 0 ? Theme.danger : Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                        elide: Text.ElideRight
                    }
                    Widgets.StyledSwitch {
                        checked: page.cleanClip
                        onToggled: function (value) { page.cleanClip = value }
                    }
                    Text {
                        text: "Auto-clean"
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                    }
                    Widgets.PillButton {
                        label: "Save voice"
                        primary: true
                        enabledBtn: page.clipReady && voiceNameField.text.trim().length > 0
                                    && bridge.voiceCloneState !== "saving"
                        onClicked: {
                            bridge.saveVoiceClone(voiceNameField.text, page.cleanClip)
                            voiceNameField.text = ""
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

            // Desktop unlock PIN — the reliable fallback when the phone can't approve.
            Widgets.SectionCard {
                Layout.fillWidth: true
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text {
                        text: "Unlock PIN" + (page.hasDesktopPin ? "  — set ✓" : "")
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 13
                        Layout.fillWidth: true
                    }
                    Text {
                        text: "A local PIN to unlock the desktop when your phone can't approve (or isn't paired). Leave blank to keep the current one."
                        color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11
                        Layout.fillWidth: true; wrapMode: Text.WordWrap
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Widgets.StyledField {
                            id: pinSetField
                            Layout.fillWidth: true
                            masked: true
                            placeholder: page.hasDesktopPin ? "New PIN (4–8 digits)" : "Set a PIN (4–8 digits)"
                            onTextChanged: { page.pendingPin = text; if (text.length > 0) page.dirty = true }
                        }
                        Widgets.PillButton {
                            visible: page.hasDesktopPin
                            label: "Clear"; danger: true
                            onClicked: { page.pendingPin = "__CLEAR__"; page.dirty = true; pinSetField.text = "" }
                        }
                    }
                }
            }

            // ===== Mode ===================================================
            Text {
                text: "// MODE"
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
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 12

                    Text {
                        text: "How Jarvis works with you (also the HUD chip — click it to switch live)"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Repeater {
                            model: [
                                { key: "plan",     name: "Plan",      sub: "Research + plan, no changes", tint: Theme.violet },
                                { key: "coworker", name: "Co-worker", sub: "Balanced, ask before risky",  tint: Theme.accent },
                                { key: "build",    name: "Build",     sub: "Execute autonomously",        tint: Theme.amber }
                            ]
                            delegate: Rectangle {
                                id: mseg
                                required property var modelData
                                Layout.fillWidth: true
                                Layout.preferredHeight: 58
                                radius: Theme.radiusSm
                                readonly property bool sel: page.agentMode === mseg.modelData.key
                                color: mseg.sel ? Qt.rgba(mseg.modelData.tint.r, mseg.modelData.tint.g, mseg.modelData.tint.b, 0.16)
                                           : (msegMa.containsMouse ? Theme.surfaceStrong : Theme.surface)
                                border.width: 1
                                border.color: mseg.sel ? mseg.modelData.tint
                                              : (msegMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft)
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                                ColumnLayout {
                                    anchors.centerIn: parent
                                    width: mseg.width - 16
                                    spacing: 2
                                    Text {
                                        text: mseg.modelData.name.toUpperCase()
                                        color: mseg.sel ? mseg.modelData.tint : Theme.text
                                        font.family: Theme.fontDisplay
                                        font.pixelSize: 12
                                        font.weight: Font.DemiBold
                                        font.letterSpacing: Theme.trackMid
                                        Layout.alignment: Qt.AlignHCenter
                                    }
                                    Text {
                                        text: mseg.modelData.sub
                                        color: Theme.textMuted
                                        font.family: Theme.fontSans
                                        font.pixelSize: 10
                                        Layout.alignment: Qt.AlignHCenter
                                        horizontalAlignment: Text.AlignHCenter
                                        Layout.fillWidth: true
                                        wrapMode: Text.WordWrap
                                    }
                                }
                                MouseArea {
                                    id: msegMa
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        if (page.agentMode !== mseg.modelData.key) {
                                            page.agentMode = mseg.modelData.key
                                            page.dirty = true
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Text {
                        text: "When a background job finishes (or a sleep / monitor wake fires)"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        Layout.fillWidth: true
                        Layout.topMargin: 4
                        wrapMode: Text.WordWrap
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Repeater {
                            model: [
                                { key: "silent", name: "Silent", sub: "Wake Jarvis only" },
                                { key: "ping",   name: "Ping",   sub: "Notify phone for long jobs" },
                                { key: "always", name: "Always", sub: "Notify on every wake" }
                            ]
                            delegate: Rectangle {
                                id: wseg
                                required property var modelData
                                Layout.fillWidth: true
                                Layout.preferredHeight: 52
                                radius: Theme.radiusSm
                                readonly property bool sel: page.wakeNotify === wseg.modelData.key
                                color: wseg.sel ? Theme.accentDim
                                           : (wsegMa.containsMouse ? Theme.surfaceStrong : Theme.surface)
                                border.width: 1
                                border.color: wseg.sel ? Theme.accent
                                              : (wsegMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft)
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                                ColumnLayout {
                                    anchors.centerIn: parent
                                    width: wseg.width - 16
                                    spacing: 2
                                    Text {
                                        text: wseg.modelData.name.toUpperCase()
                                        color: wseg.sel ? Theme.accentBright : Theme.text
                                        font.family: Theme.fontDisplay
                                        font.pixelSize: 11
                                        font.weight: Font.DemiBold
                                        font.letterSpacing: Theme.trackMid
                                        Layout.alignment: Qt.AlignHCenter
                                    }
                                    Text {
                                        text: wseg.modelData.sub
                                        color: Theme.textMuted
                                        font.family: Theme.fontSans
                                        font.pixelSize: 9
                                        Layout.alignment: Qt.AlignHCenter
                                        horizontalAlignment: Text.AlignHCenter
                                        Layout.fillWidth: true
                                        wrapMode: Text.WordWrap
                                    }
                                }
                                MouseArea {
                                    id: wsegMa
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        if (page.wakeNotify !== wseg.modelData.key) {
                                            page.wakeNotify = wseg.modelData.key
                                            page.dirty = true
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ===== Permissions ============================================
            Text {
                text: "// PERMISSIONS"
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
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 12

                    Text {
                        text: "How cautious Jarvis is before risky actions"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        text: "Tools are auto-ranked by risk. HIGH = irreversible / touches your real world (delete files, destructive shell, your real screen, ssh, installs, sending things out). MEDIUM = reversible / scoped to the agent (edit files, agent desktop, memory). LOW = read-only (read, list, search, render)."
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                    }

                    // 3-way segmented selector
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Repeater {
                            model: [
                                { key: "high",   name: "Cautious",    sub: "Ask before HIGH + MEDIUM" },
                                { key: "medium", name: "Balanced",    sub: "Ask before HIGH only" },
                                { key: "low",    name: "Autonomous",  sub: "Only confirm the worst" }
                            ]
                            delegate: Rectangle {
                                id: seg
                                required property var modelData
                                Layout.fillWidth: true
                                Layout.preferredHeight: 58
                                radius: Theme.radiusSm
                                readonly property bool sel: page.permissionLevel === seg.modelData.key
                                color: seg.sel ? Theme.accentDim
                                           : (segMa.containsMouse ? Theme.surfaceStrong : Theme.surface)
                                border.width: 1
                                border.color: seg.sel ? Theme.accent
                                              : (segMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft)
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                                ColumnLayout {
                                    anchors.centerIn: parent
                                    width: seg.width - 16
                                    spacing: 2
                                    Text {
                                        text: seg.modelData.name.toUpperCase()
                                        color: seg.sel ? Theme.accentBright : Theme.text
                                        font.family: Theme.fontDisplay
                                        font.pixelSize: 12
                                        font.weight: Font.DemiBold
                                        font.letterSpacing: Theme.trackMid
                                        Layout.alignment: Qt.AlignHCenter
                                    }
                                    Text {
                                        text: seg.modelData.sub
                                        color: Theme.textMuted
                                        font.family: Theme.fontSans
                                        font.pixelSize: 10
                                        Layout.alignment: Qt.AlignHCenter
                                        horizontalAlignment: Text.AlignHCenter
                                        Layout.fillWidth: true
                                        wrapMode: Text.WordWrap
                                    }
                                }
                                MouseArea {
                                    id: segMa
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        if (page.permissionLevel !== seg.modelData.key) {
                                            page.permissionLevel = seg.modelData.key
                                            page.dirty = true
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Text {
                        text: "Jarvis calls ask_user (tap to approve on your phone or here) before any action above your chosen line. This is a policy, not the sandbox — capability limits still apply."
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 10
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                    }
                }
            }

            // ===== Updates =================================================
            Text {
                text: "// UPDATES"
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
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 12

                    // Auto-update toggle (default ON) + the running version.
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2
                            Text {
                                text: "Automatic updates"
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 13
                                Layout.fillWidth: true
                            }
                            Text {
                                text: "Check the main branch periodically and notify you when an update is ready. Updates are never installed without your confirmation."
                                color: Theme.textMuted
                                font.family: Theme.fontSans
                                font.pixelSize: 11
                                Layout.fillWidth: true
                                wrapMode: Text.WordWrap
                            }
                        }
                        Widgets.StyledSwitch {
                            checked: page.autoUpdate
                            onToggled: function(v) { page.autoUpdate = v; page.dirty = true }
                        }
                    }

                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairlineSoft }

                    // Manual check + the result line + an "Update now" affordance.
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2
                            Text {
                                text: "Current version: " + (page.appVersion.length ? page.appVersion : "unknown")
                                color: Theme.text
                                font.family: Theme.fontMono
                                font.pixelSize: 12
                                Layout.fillWidth: true
                            }
                            Text {
                                visible: page.updateStatus.length > 0
                                text: page.updateStatus
                                color: page.updateBehind ? Theme.amber
                                       : (page.updateStatus.indexOf("Up to date") === 0 ? Theme.ok : Theme.textMuted)
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                                Layout.fillWidth: true
                                wrapMode: Text.WordWrap
                            }
                        }
                        Widgets.PillButton {
                            label: page.updateChecking ? "Checking…" : "Check for updates"
                            busy: page.updateChecking
                            enabledBtn: bridge.connected && !page.updateChecking && !page.updateApplying
                            Layout.alignment: Qt.AlignVCenter
                            onClicked: {
                                page.updateChecking = true
                                page.updateStatus = "Checking for updates…"
                                bridge.checkForUpdates()
                            }
                        }
                        Widgets.PillButton {
                            visible: page.updateBehind
                            label: page.updateApplying ? "Updating…" : "Update now"
                            primary: true
                            busy: page.updateApplying
                            enabledBtn: bridge.connected && !page.updateApplying
                            Layout.alignment: Qt.AlignVCenter
                            onClicked: {
                                page.updateApplying = true
                                page.updateStatus = "Downloading + installing the update…"
                                bridge.applyUpdate()
                            }
                        }
                    }
                }
            }

            // ===== Browser extension =======================================
            Text {
                text: "// BROWSER EXTENSION"
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
                ColumnLayout {
                    id: extCol
                    property bool extCopied: false
                    Layout.fillWidth: true
                    spacing: 10

                    Text {
                        text: "Add the Jarvis extension to Chrome or Edge for the in-browser agent + side panel. It ships with Jarvis at the folder below — Chrome blocks one-click installs of unpacked extensions, so load it once:"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        text: "1.  Open  chrome://extensions       2.  Enable \"Developer mode\" (top-right)       3.  Click \"Load unpacked\" and pick this folder:"
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                    }
                    Rectangle {
                        Layout.fillWidth: true
                        radius: 6
                        color: "#0C141D"
                        border.color: Theme.hairlineSoft
                        border.width: 1
                        implicitHeight: extPathText.implicitHeight + 16
                        Text {
                            id: extPathText
                            anchors.fill: parent
                            anchors.margins: 8
                            text: bridge.extensionPath()
                            color: Theme.text
                            font.family: Theme.fontMono
                            font.pixelSize: 12
                            wrapMode: Text.WrapAnywhere
                            verticalAlignment: Text.AlignVCenter
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Widgets.PillButton {
                            label: "Open chrome://extensions"
                            primary: true
                            enabledBtn: bridge.connected
                            onClicked: bridge.openExtensionsPage()
                        }
                        Widgets.PillButton {
                            label: "Open folder"
                            enabledBtn: bridge.connected
                            onClicked: bridge.openExtensionFolder()
                        }
                        Widgets.PillButton {
                            label: extCol.extCopied ? "Copied ✓" : "Copy path"
                            enabledBtn: bridge.connected
                            onClicked: {
                                bridge.copyToClipboard(bridge.extensionPath())
                                extCol.extCopied = true
                                extCopyReset.restart()
                            }
                        }
                        Item { Layout.fillWidth: true }
                    }
                    Timer { id: extCopyReset; interval: 1500; onTriggered: extCol.extCopied = false }
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
                id: connCard
                Layout.fillWidth: true
                property bool showHelp: false

                Text {
                    text: "Connect Google services. Each needs OAuth credentials from Google Cloud — open the guide below, then paste Client ID / secret / refresh token and Connect."
                    color: Theme.textMuted
                    font.family: Theme.fontSans
                    font.pixelSize: 11
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                }

                // ---- "How to set up (Google Cloud)" expander --------------------
                Text {
                    text: (connCard.showHelp ? "▾ " : "▸ ") + "How to set up (Google Cloud)"
                    color: Theme.accent
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                    Layout.fillWidth: true
                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: connCard.showHelp = !connCard.showHelp
                    }
                }
                Text {
                    visible: connCard.showHelp
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    color: Theme.textMuted
                    font.family: Theme.fontMono
                    font.pixelSize: 10
                    lineHeight: 1.35
                    text:
                        "1. console.cloud.google.com → create a project.\n" +
                        "2. APIs & Services → Library → ENABLE the APIs you want: Google Calendar, Google Drive, Google Docs, Gmail.\n" +
                        "3. APIs & Services → OAuth consent screen → External; add your own Google account under \"Test users\".\n" +
                        "4. APIs & Services → Credentials → Create credentials → OAuth client ID → application type \"Desktop app\". Copy the Client ID + Client secret.\n" +
                        "5. Refresh token: open developers.google.com/oauthplayground → gear ⚙ (top right) → tick \"Use your own OAuth credentials\" → paste your Client ID + secret. On the left pick the scopes for the service (e.g. Calendar API → calendar.readonly), Authorize, then \"Exchange authorization code for tokens\" and copy the refresh_token.\n" +
                        "6. Paste the three values below for that service and tap Connect. Secrets are stored locally (0600) and never shown again.\n" +
                        "Full guide: docs/JARVIS_GOOGLE_CONNECTORS.md"
                }

                Repeater {
                    model: page.connectorServices
                    delegate: ColumnLayout {
                        id: connRow
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: 8

                        property var row: page.connectorFor(connRow.modelData.service)
                        property bool added: connRow.row !== null
                        property bool isOn: connRow.added && connRow.row.enabled === true
                        property bool expanded: false

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 10

                            Text {
                                text: connRow.modelData.label
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 13
                                Layout.fillWidth: true
                            }

                            Rectangle {
                                visible: connRow.added
                                radius: Theme.radiusSm
                                color: "transparent"
                                border.color: connRow.isOn ? Theme.accent : Theme.textFaint
                                border.width: 1
                                implicitHeight: cbT.implicitHeight + 6
                                implicitWidth: cbT.implicitWidth + 14
                                Text {
                                    id: cbT
                                    anchors.centerIn: parent
                                    text: connRow.isOn ? "Connected" : "Added (no creds)"
                                    color: connRow.isOn ? Theme.accent : Theme.textMuted
                                    font.family: Theme.fontMono
                                    font.pixelSize: 10
                                }
                            }

                            Widgets.PillButton {
                                label: connRow.added ? "Added"
                                       : (connRow.expanded ? "Cancel" : "Connect")
                                enabledBtn: !connRow.added
                                Layout.alignment: Qt.AlignVCenter
                                onClicked: {
                                    if (connRow.added) return
                                    connRow.expanded = !connRow.expanded
                                }
                            }
                        }

                        // Credential entry, revealed by "Connect".
                        ColumnLayout {
                            visible: connRow.expanded && !connRow.added
                            Layout.fillWidth: true
                            Layout.leftMargin: 4
                            spacing: 6

                            Widgets.StyledField {
                                id: fClientId
                                Layout.fillWidth: true
                                placeholder: "Client ID"
                            }
                            Widgets.StyledField {
                                id: fSecret
                                Layout.fillWidth: true
                                masked: true
                                placeholder: "Client secret"
                            }
                            Widgets.StyledField {
                                id: fToken
                                Layout.fillWidth: true
                                masked: true
                                placeholder: "Refresh token"
                            }
                            Widgets.PillButton {
                                label: "Connect " + connRow.modelData.label
                                Layout.alignment: Qt.AlignRight
                                onClicked: {
                                    bridge.connectorAdd(
                                        connRow.modelData.service,
                                        fClientId.text.trim(),
                                        fSecret.text.trim(),
                                        fToken.text.trim())
                                    connRow.expanded = false
                                }
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
