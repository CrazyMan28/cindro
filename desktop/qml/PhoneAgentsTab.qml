pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CindroSidebar

// AGENTS tab — live agent list with per-agent CONFIG panel:
// voice picker (speaker groups + emotion chips + ▶ preview), speaking-rate
// slider (0.5-2×), model chips (live from model.list, codex/claude agents
// only), thinking chips (minimal → xhigh).  Tap "Config" on any agent card
// to open the panel; tap "Call" to dial it directly via call_extension.
Item {
    id: tab
    property var phonePage

    // ---- async helpers --------------------------------------------------------
    property var  _pending: ({})
    property int  _seq: 0

    // phoneMcp path (existing tools: list_extensions, list_agents, call_extension)
    function callTool(tool, args, cb) {
        var id = "agents_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneMcp(id, tool, args || {})
    }

    // phone.http path (REST routes on the phone server)
    function callHttp(method, path, body, cb) {
        var id = "agentsH_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneHttp(id, method, path, body || {})
    }

    Connections {
        target: bridge
        function onPhoneResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
        function onPhoneHttpResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
        // Live model ids for the open agent's brain, same model.list RPC the
        // main model picker (ComputerPage.qml) uses — replaces the old
        // hardcoded per-brain chip list, which went stale the same way the
        // main picker's used to before it was wired to model.list. Broadcast
        // signal (bridge.listModels can be called from elsewhere too), so
        // only apply it while this panel is open and it's the brain we asked for.
        function onModelsListed(brain, models) {
            if (!tab.configMode || brain !== tab.configBrain) return
            tab.configModelOptions = models
        }
        // The user's NAMED cloned voices (Settings → Voice / VoiceLibrary), merged
        // in as a "Your voices" group shown FIRST so an agent (e.g. ext 101) can
        // speak on calls with a clone (clone:<slug> / jarvice). listVoices() is a
        // broadcast, so only apply while a config panel is open.
        function onVoicesListed(voices) {
            if (!tab.configMode) return
            var arr = voices || []
            var insertAt = 0
            for (var i = 0; i < arr.length; i++) {
                var v = arr[i]
                if (!v || v.custom !== true) continue   // only the user's clones
                var vid = v.id || ""
                if (!vid || tab._hasVid(vid)) continue
                voicesModel.insert(insertAt++, {
                    "vid": vid, "vname": v.label || vid,
                    "speaker": "Your voices", "emotion": v.label || vid
                })
            }
        }
    }

    // Which daemon brain (if any) the open agent's model picker should query
    // — codex/claude only; other extensions (Copilot, Echo, Hermes, Mistral
    // Screener, ...) have no selectable Jarvis-brain model. Mirrors android
    // AgentConfigScreen.kt's brainFor(), tui's brainForAgent(), and the
    // extension's brainForAgent() — keep all four in sync if the naming
    // convention changes.
    function brainForAgent(name) {
        var lc = (name || "").toLowerCase()
        if (lc.indexOf("claude") >= 0) return "claude"
        if (lc.indexOf("codex") >= 0 || lc.indexOf("gpt") >= 0) return "codex"
        return ""
    }

    // ---- list state -----------------------------------------------------------
    ListModel { id: agentModel }
    property bool  listLoading: false
    property string listError:   ""

    // ---- config panel state ---------------------------------------------------
    property bool   configMode:   false
    property string configExt:    ""
    property string configName:   ""
    property string configVoiceId: ""
    property string configVoiceName: "(default)"
    property real   configSpeed:  1.0
    property string configBrain:  ""
    property var    configModelOptions: []
    property string configModel:  ""
    property string configThinking: "low"
    property string configStatus: ""

    ListModel { id: voicesModel }   // {vid, vname, speaker, emotion}

    // ---- functions ------------------------------------------------------------
    function refresh() {
        tab.listLoading = true; tab.listError = ""
        tab.callTool("list_extensions", {}, function(r) {
            tab.listLoading = false
            if (r.error) {
                // fall back to list_agents
                tab.callTool("list_agents", {}, function(r2) {
                    if (r2.error) { tab.listError = r2.error.message || "Could not load agents."; return }
                    tab._populateAgents(r2.data)
                })
                return
            }
            tab._populateAgents(r.data)
        })
    }

    function _populateAgents(data) {
        var arr = data instanceof Array ? data : []
        agentModel.clear()
        for (var i = 0; i < arr.length; i++) {
            var a = arr[i]
            agentModel.append({
                "ext":    a.extension !== undefined ? ("" + a.extension) : ("" + (a.ext || "")),
                "aname":  a.name      !== undefined ? a.name              : ("Agent " + i),
                "status": a.status    !== undefined ? a.status            : "offline",
                "task":   a.current_task !== undefined ? a.current_task   : ""
            })
        }
    }

    function openConfig(ext, name) {
        tab.configExt = ext; tab.configName = name
        tab.configVoiceId = ""; tab.configVoiceName = "(default)"
        tab.configSpeed = 1.0
        tab.configBrain = tab.brainForAgent(name)
        tab.configModelOptions = []; tab.configModel = ""
        tab.configThinking = "low"; tab.configStatus = "Loading…"
        tab.configMode = true
        if (tab.configBrain !== "" && bridge.connected) bridge.listModels(tab.configBrain)

        // load voices — GET /api/voices (Mistral + on-device catalog) and, merged
        // in via voice.list_voices, the user's own cloned voices (see onVoicesListed).
        voicesModel.clear()
        bridge.listVoices()
        tab.callHttp("GET", "/api/voices", {}, function(r) {
            var arr = null
            if (!r.error) {
                var d = r.data
                if (d instanceof Array) arr = d
                else if (d && d.voices instanceof Array) arr = d.voices
            }
            if (arr && arr.length > 0) {
                for (var i = 0; i < arr.length; i++) {
                    var v = arr[i]
                    // Clones come from voice.list_voices as the "Your voices" group;
                    // skip the copies the phone server also lists to avoid dupes.
                    var vidRaw = "" + (v.id || "")
                    if (vidRaw.indexOf("clone:") === 0 || vidRaw === "jarvice") continue
                    if (tab._hasVid(vidRaw)) continue
                    var nm = v.label || v.name || ("Voice " + i)
                    var sp = v.speaker || (nm.indexOf(" - ") >= 0 ? nm.split(" - ")[0].trim() : nm.replace(/ *\(.*\)/, "").trim())
                    var em = v.emotion || (nm.indexOf(" - ") >= 0 ? nm.split(" - ")[1].trim() : "Default")
                    voicesModel.append({ "vid": v.id || "", "vname": nm, "speaker": sp, "emotion": em })
                }
            } else {
                // built-in fallback voice set (matches agent-phone Android app)
                var defaults = [
                    {vid:"",             vname:"Default",              speaker:"Default",  emotion:"Default"},
                    {vid:"jarvis-od",    vname:"Cindro (on-device)", speaker:"Cindro", emotion:"Cindro"},
                    {vid:"paul-cheerful",vname:"Paul - Cheerful",      speaker:"Paul",     emotion:"Cheerful"},
                    {vid:"paul-sad",     vname:"Paul - Sad",           speaker:"Paul",     emotion:"Sad"},
                    {vid:"paul-angry",   vname:"Paul - Angry",         speaker:"Paul",     emotion:"Angry"},
                    {vid:"paul-terrified",vname:"Paul - Terrified",    speaker:"Paul",     emotion:"Terrified"},
                    {vid:"paul-shouting",vname:"Paul - Shouting",      speaker:"Paul",     emotion:"Shouting"},
                    {vid:"oliver-cheerful",vname:"Oliver - Cheerful",  speaker:"Oliver",   emotion:"Cheerful"},
                    {vid:"oliver-sad",   vname:"Oliver - Sad",         speaker:"Oliver",   emotion:"Sad"},
                    {vid:"oliver-friendly",vname:"Oliver - Friendly",  speaker:"Oliver",   emotion:"Friendly"},
                    {vid:"jane-cheerful",vname:"Jane - Cheerful",      speaker:"Jane",     emotion:"Cheerful"},
                    {vid:"jane-sad",     vname:"Jane - Sad",           speaker:"Jane",     emotion:"Sad"},
                    {vid:"jane-friendly",vname:"Jane - Friendly",      speaker:"Jane",     emotion:"Friendly"},
                    {vid:"marie-cheerful",vname:"Marie - Cheerful",    speaker:"Marie",    emotion:"Cheerful"},
                    {vid:"marie-sad",    vname:"Marie - Sad",          speaker:"Marie",    emotion:"Sad"},
                    {vid:"marie-friendly",vname:"Marie - Friendly",    speaker:"Marie",    emotion:"Friendly"}
                ]
                for (var j = 0; j < defaults.length; j++) voicesModel.append(defaults[j])
            }
        })

        // load voice profile — GET /api/extensions/<ext>/voice
        tab.callHttp("GET", "/api/extensions/" + ext + "/voice", {}, function(r) {
            if (!r.error && r.data) {
                var d = r.data || {}
                tab.configVoiceId   = d.voice_id   || d.id   || ""
                tab.configVoiceName = d.voice_name || d.name || "(default)"
                tab.configSpeed     = d.speed      !== undefined ? d.speed : 1.0
            }
        })

        // load model config — GET /api/extensions/<ext>/model
        tab.callHttp("GET", "/api/extensions/" + ext + "/model", {}, function(r) {
            if (!r.error && r.data) {
                var d = r.data || {}
                tab.configModel    = d.model     || ""
                tab.configThinking = d.reasoning || d.thinking || "low"
            }
            tab.configStatus = ""
        })
    }

    // The chip to highlight as "current": the saved model if we have one,
    // else the first live-fetched option (mirrors firstModelForBrain's
    // "first entry is the default" convention) — computed at use, not at
    // fetch time, since configModel (from callHttp) and configModelOptions
    // (from the async bridge.listModels reply) can arrive in either order.
    function effectiveConfigModel() {
        if (tab.configModel !== "") return tab.configModel
        return tab.configModelOptions.length > 0 ? tab.configModelOptions[0] : ""
    }

    function setVoice(vid, vname) {
        tab.configVoiceId   = vid
        tab.configVoiceName = vname
        tab.configStatus = "Saving…"
        // PUT /api/extensions/<ext>/voice {voice_id, speed}
        tab.callHttp("PUT", "/api/extensions/" + tab.configExt + "/voice",
            { voice_id: vid, speed: tab.configSpeed }, function(r) {
            tab.configStatus = r.error ? ("Voice error: " + (r.error.message || "?")) : "Voice saved."
        })
    }

    function setSpeed(spd) {
        tab.configSpeed = spd
        // PUT /api/extensions/<ext>/voice {voice_id, speed}
        tab.callHttp("PUT", "/api/extensions/" + tab.configExt + "/voice",
            { voice_id: tab.configVoiceId, speed: spd }, function(r) {
            tab.configStatus = r.error ? ("Speed error: " + (r.error.message || "?")) : "Speed saved."
        })
    }

    function setModelConfig(model, thinking) {
        if (model    !== "") tab.configModel    = model
        if (thinking !== "") tab.configThinking = thinking
        tab.configStatus = "Saving model config…"
        // PUT /api/extensions/<ext>/model {model, reasoning}
        tab.callHttp("PUT", "/api/extensions/" + tab.configExt + "/model",
            { model: tab.configModel, reasoning: tab.configThinking }, function(r) {
            tab.configStatus = r.error ? ("Model error: " + (r.error.message || "?")) : "Model saved."
        })
    }

    function previewVoice(vid) {
        tab.configStatus = "Previewing…"
        // GET /api/voices/<voiceId>/sample — audio endpoint; desktop just shows status
        var voiceId = vid || tab.configVoiceId
        if (!voiceId) { tab.configStatus = "No voice selected."; return }
        tab.callHttp("GET", "/api/voices/" + encodeURIComponent(voiceId) + "/sample", {}, function(r) {
            tab.configStatus = r.error ? "Preview unavailable on this server." : "Playing preview…"
        })
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    // True if a voice id is already in voicesModel (de-dupe across the /api/voices
    // catalog and the merged VoiceLibrary clones).
    function _hasVid(vid) {
        for (var i = 0; i < voicesModel.count; i++)
            if (voicesModel.get(i).vid === vid) return true
        return false
    }

    // Return an array of unique speaker names from voicesModel
    function _speakers() {
        var seen = {}; var out = []
        for (var i = 0; i < voicesModel.count; i++) {
            var sp = voicesModel.get(i).speaker
            if (!seen[sp]) { seen[sp] = true; out.push(sp) }
        }
        return out
    }

    function _voicesForSpeaker(sp) {
        var out = []
        for (var i = 0; i < voicesModel.count; i++) {
            var v = voicesModel.get(i)
            if (v.speaker === sp) out.push({ vid: v.vid, emotion: v.emotion })
        }
        return out
    }

    // ---- UI -------------------------------------------------------------------
    Item {
        anchors.fill: parent

        // ════════════════════════════════════════════════════════════════════
        // LIST MODE
        // ════════════════════════════════════════════════════════════════════
        ColumnLayout {
            anchors.fill: parent
            spacing: 12
            visible: !tab.configMode

            // header
            RowLayout {
                Layout.fillWidth: true
                Text {
                    text: "AGENTS"; color: Theme.textFaint
                    font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                    Layout.fillWidth: true
                }
                Rectangle {
                    width: 26; height: 26; radius: Theme.radiusXs
                    color: _refMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                    border.color: Theme.hairlineSoft; border.width: 1
                    Text { anchors.centerIn: parent; text: "↺"; color: Theme.textMuted; font.pixelSize: 13 }
                    MouseArea { id: _refMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.refresh() }
                }
            }

            // loading / error / empty
            Item {
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: tab.listLoading || tab.listError.length > 0 || agentModel.count === 0

                ColumnLayout {
                    anchors.centerIn: parent; spacing: 10
                    ArcReactor {
                        size: 52; tint: Theme.textFaint; spinning: tab.listLoading
                        Layout.alignment: Qt.AlignHCenter
                    }
                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: tab.listLoading ? "Loading agents…"
                            : tab.listError.length > 0 ? tab.listError
                            : "No agents registered."
                        color: tab.listError.length > 0 ? Theme.danger : Theme.textFaint
                        font.family: Theme.fontSans; font.pixelSize: 12
                    }
                }
            }

            // agent list
            ListView {
                id: _agList
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: !tab.listLoading && tab.listError.length === 0 && agentModel.count > 0
                model: agentModel; spacing: 8; clip: true

                delegate: Rectangle {
                    id: _aCard
                    required property string ext
                    required property string aname
                    required property string status
                    required property string task
                    width: _agList.width; height: _aCardRow.implicitHeight + 20
                    radius: Theme.radiusSm
                    color: Theme.surfaceStrong
                    border.color: Theme.hairlineSoft; border.width: 1

                    RowLayout {
                        id: _aCardRow
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 12

                        // status dot + avatar
                        Rectangle {
                            width: 40; height: 40; radius: 20
                            color: _aCard.status === "online" ? Qt.rgba(0.22, 0.90, 0.63, 0.18) : Qt.rgba(0.36, 0.49, 0.58, 0.14)
                            Text {
                                anchors.centerIn: parent; text: "🤖"; font.pixelSize: 18
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true; spacing: 2
                            RowLayout {
                                spacing: 6
                                Text {
                                    text: _aCard.aname
                                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 13; font.weight: Font.Medium
                                    Layout.fillWidth: true; elide: Text.ElideRight
                                }
                                // status pill
                                Rectangle {
                                    height: 16; implicitWidth: _stLbl.implicitWidth + 12; radius: 8
                                    color: _aCard.status === "online" ? Qt.rgba(0.22, 0.90, 0.63, 0.22) : Qt.rgba(0.36, 0.49, 0.58, 0.18)
                                    Text {
                                        id: _stLbl; anchors.centerIn: parent; text: _aCard.status.toUpperCase()
                                        color: _aCard.status === "online" ? Theme.success : Theme.textMuted
                                        font.family: Theme.fontDisplay; font.pixelSize: 7; font.letterSpacing: 0.8
                                    }
                                }
                                Text {
                                    text: _aCard.ext
                                    color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 10
                                }
                            }
                            Text {
                                text: _aCard.task.length > 0 ? _aCard.task : "No current task"
                                color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10
                                maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true
                            }
                        }

                        // Call button
                        Rectangle {
                            height: 28; implicitWidth: _callBtnLbl.implicitWidth + 16; radius: Theme.radiusXs
                            color: _callBtnMa.containsMouse ? Theme.accent : (_aCard.status === "online" ? Theme.accentDim : "transparent")
                            border.color: _aCard.status === "online" ? Theme.accent : Theme.hairlineSoft; border.width: 1
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text { id: _callBtnLbl; anchors.centerIn: parent; text: "CALL"; color: _callBtnMa.containsMouse ? Theme.inkOnAccent : (_aCard.status === "online" ? Theme.accent : Theme.textMuted); font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                            MouseArea {
                                id: _callBtnMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                property string _ext: _aCard.ext
                                onClicked: { if (tab.phonePage) { tab.phonePage.tabIndex = 0 } tab.callTool("call_extension", { extension: _ext }, function(r) {}) }
                            }
                        }

                        // Config button
                        Rectangle {
                            height: 28; implicitWidth: _cfgBtnLbl.implicitWidth + 16; radius: Theme.radiusXs
                            color: _cfgBtnMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                            border.color: Theme.hairlineSoft; border.width: 1
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text { id: _cfgBtnLbl; anchors.centerIn: parent; text: "CONFIG"; color: Theme.textMuted; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                            MouseArea {
                                id: _cfgBtnMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                property string _ext:   _aCard.ext
                                property string _aname: _aCard.aname
                                onClicked: tab.openConfig(_ext, _aname)
                            }
                        }
                    }
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // CONFIG MODE
        // ════════════════════════════════════════════════════════════════════
        Flickable {
            anchors.fill: parent
            visible: tab.configMode
            contentWidth: width; contentHeight: _cfgCol.implicitHeight + 24; clip: true
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            ColumnLayout {
                id: _cfgCol; width: parent.width; spacing: 16

                // back header
                RowLayout {
                    Layout.fillWidth: true; spacing: 10
                    Rectangle {
                        width: 28; height: 28; radius: Theme.radiusXs
                        color: _backMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                        border.color: Theme.hairlineSoft; border.width: 1
                        Text { anchors.centerIn: parent; text: "←"; color: Theme.textMuted; font.pixelSize: 14 }
                        MouseArea { id: _backMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.configMode = false }
                    }
                    ColumnLayout { spacing: 1; Layout.fillWidth: true
                        Text { text: tab.configName; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 14; font.weight: Font.Medium }
                        Text { text: "Extension " + tab.configExt; color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 10 }
                    }
                    // preview voice button
                    Rectangle {
                        height: 30; implicitWidth: _pvLbl.implicitWidth + 16; radius: Theme.radiusXs
                        color: _pvMa.containsMouse ? Theme.accentDim : "transparent"; border.color: Theme.accentDim; border.width: 1
                        Text { id: _pvLbl; anchors.centerIn: parent; text: "▶ PREVIEW"; color: Theme.accent; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                        MouseArea { id: _pvMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.previewVoice(tab.configVoiceId) }
                    }
                }

                // status / feedback line
                Text {
                    text: tab.configStatus; visible: tab.configStatus.length > 0
                    color: tab.configStatus.indexOf("Error") >= 0 ? Theme.danger : Theme.accent
                    font.family: Theme.fontMono; font.pixelSize: 10
                    Layout.fillWidth: true
                }

                // ── VOICE section ─────────────────────────────────────────
                Text {
                    text: "VOICE"; color: Theme.textFaint
                    font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                }
                Rectangle {
                    Layout.fillWidth: true; height: _voiceCardCol.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    ColumnLayout {
                        id: _voiceCardCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 10

                        Text {
                            text: "Current: " + tab.configVoiceName
                            color: Theme.accent; font.family: Theme.fontSans; font.pixelSize: 11
                        }

                        // speaker groups — each row: speaker label + scrollable emotion chips
                        Repeater {
                            model: tab._speakers()
                            delegate: RowLayout {
                                required property string modelData
                                property string _sp: modelData
                                Layout.fillWidth: true; spacing: 8

                                Text {
                                    text: _sp; color: Theme.textFaint
                                    font.family: Theme.fontSans; font.pixelSize: 10
                                    width: 52; horizontalAlignment: Text.AlignLeft
                                }

                                // scrollable emotion chips for this speaker
                                Flickable {
                                    Layout.fillWidth: true; height: 28
                                    contentWidth: _emRow.implicitWidth; contentHeight: height; clip: true

                                    Row {
                                        id: _emRow; spacing: 6
                                        Repeater {
                                            model: tab._voicesForSpeaker(_sp)
                                            delegate: Rectangle {
                                                required property var modelData
                                                property string _vid:     modelData.vid
                                                property string _emotion: modelData.emotion
                                                height: 26; implicitWidth: _emLbl.implicitWidth + 18; radius: Theme.radiusXs
                                                color: tab.configVoiceId === _vid ? Qt.rgba(0.239,0.839,1.0,0.20) : (_emMa.containsMouse ? Qt.rgba(1,1,1,0.08) : Theme.surfaceStrong)
                                                border.color: tab.configVoiceId === _vid ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                                Text {
                                                    id: _emLbl; anchors.centerIn: parent; text: parent._emotion
                                                    color: tab.configVoiceId === parent._vid ? Theme.accent : Theme.textMuted
                                                    font.family: Theme.fontSans; font.pixelSize: 11
                                                }
                                                MouseArea {
                                                    id: _emMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                                    property string vid: parent._vid
                                                    property string vname: parent.modelData.emotion
                                                    onClicked: tab.setVoice(vid, vname)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // ── SPEAKING RATE section ─────────────────────────────────
                Text {
                    text: "SPEAKING RATE"; color: Theme.textFaint
                    font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                }
                Rectangle {
                    Layout.fillWidth: true; height: _spRateCol.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    ColumnLayout {
                        id: _spRateCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 6
                        Text {
                            text: Math.round(tab.configSpeed * 100) / 100 + "×"
                            color: Theme.accent; font.family: Theme.fontMono; font.pixelSize: 13; font.weight: Font.Medium
                        }
                        Slider {
                            id: _spSlider; Layout.fillWidth: true
                            from: 0.5; to: 2.0; value: tab.configSpeed
                            onMoved: tab.configSpeed = Math.round(value * 20) / 20
                            onPressedChanged: { if (!pressed) tab.setSpeed(tab.configSpeed) }
                        }
                        Text {
                            text: "0.5× slow  ·  1× normal  ·  2× fast"
                            color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10
                        }
                    }
                }

                // ── MODEL + THINKING section (codex/claude agents only) ────
                // Model chips come live from model.list (bridge.listModels,
                // triggered in openConfig) — not a hardcoded id list, so a
                // newly-released model shows up here the same way it does in
                // the main chat picker.
                Text {
                    visible: tab.configModelOptions.length > 0
                    text: "MODEL"; color: Theme.textFaint
                    font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                }
                Rectangle {
                    visible: tab.configModelOptions.length > 0
                    Layout.fillWidth: true; height: visible ? _modelCol.implicitHeight + 20 : 0
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    ColumnLayout {
                        id: _modelCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 10

                        // model chips
                        Row {
                            spacing: 8
                            Repeater {
                                model: tab.configModelOptions
                                delegate: Rectangle {
                                    required property string modelData
                                    property string _mid: modelData
                                    height: 28; implicitWidth: _mdLbl.implicitWidth + 18; radius: Theme.radiusXs
                                    color: tab.effectiveConfigModel() === _mid ? Qt.rgba(0.239,0.839,1.0,0.20) : (_mdMa.containsMouse ? Qt.rgba(1,1,1,0.08) : Theme.surfaceStrong)
                                    border.color: tab.effectiveConfigModel() === _mid ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                    Text { id: _mdLbl; anchors.centerIn: parent; text: parent._mid; color: tab.effectiveConfigModel() === parent._mid ? Theme.accent : Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                    MouseArea { id: _mdMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; property string mid: parent._mid; onClicked: tab.setModelConfig(mid, "") }
                                }
                            }
                        }

                        Text { text: "Thinking"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10 }

                        // thinking chips
                        Row {
                            spacing: 8
                            Repeater {
                                model: ["minimal","low","medium","high","xhigh"]
                                delegate: Rectangle {
                                    required property string modelData
                                    property string _th: modelData
                                    height: 26; implicitWidth: _thLbl.implicitWidth + 16; radius: Theme.radiusXs
                                    color: tab.configThinking === _th ? Qt.rgba(0.239,0.839,1.0,0.20) : (_thMa.containsMouse ? Qt.rgba(1,1,1,0.08) : Theme.surfaceStrong)
                                    border.color: tab.configThinking === _th ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                    Text { id: _thLbl; anchors.centerIn: parent; text: parent._th; color: tab.configThinking === parent._th ? Theme.accent : Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                    MouseArea { id: _thMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; property string th: parent._th; onClicked: tab.setModelConfig("", th) }
                                }
                            }
                        }
                    }
                }

                Item { height: 24 }
            }
        }
    }
}
