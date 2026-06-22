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
    property string defaultBrain: "codex"
    property string defaultModel: ""
    property bool glow: true
    property bool compact: false
    property bool dirty: false
    property bool saving: false

    function load() { bridge.loadSettings() }
    Component.onCompleted: if (bridge.connected) load()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.load() }
        function onSettingsLoaded(s) {
            page.keysSet = s.api_keys_set !== undefined ? s.api_keys_set : ({})
            page.modelsByBrain = s.models_by_brain !== undefined ? s.models_by_brain : ({})
            page.defaultBrain = s.default_brain !== undefined ? s.default_brain : "codex"
            page.defaultModel = s.default_model !== undefined ? s.default_model : ""
            if (s.theme !== undefined) {
                page.glow = s.theme.glow !== undefined ? s.theme.glow : true
                page.compact = s.theme.compact !== undefined ? s.theme.compact : false
            }
            page.pendingKeys = ({})
            page.dirty = false
            brainCombo.syncFromState()
            modelCombo.syncFromState()
        }
        function onSettingsSaved() {
            page.saving = false
            page.pendingKeys = ({})
            page.dirty = false
            // re-pull so api_keys_set badges flip to "saved"
            page.load()
        }
    }

    function currentModels() {
        var m = page.modelsByBrain[page.defaultBrain]
        return (m && m.length) ? m : [page.defaultModel].filter(function(x){return x && x.length})
    }

    function save() {
        page.saving = true
        var patch = {
            "default_brain": page.defaultBrain,
            "default_model": page.defaultModel,
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

            Item { Layout.preferredHeight: 6 }
        }
    }
}
