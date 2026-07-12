import QtQuick
import QtQuick.Controls.Basic
import CindroSidebar

// LockGate — the full-bleed unlock overlay drawn ON TOP of the AppShell while the
// desktop is locked (2FA + fingerprint cross-device unlock). It runs the two-
// factor flow against the daemon:
//
//   1) On show, calls bridge.authRequest("desktop") -> the daemon mints a
//      challenge and FCM-pushes the paired phone.
//   2) The phone notification opens an Approve screen, runs BiometricPrompt, and
//      on success calls auth.approve over its authed device WS (possession +
//      biometric). The daemon broadcasts an auth.event -> bridge.authStateChanged.
//   3) We unlock on "approved" (instant via the push; a 2s poll on auth.status is
//      the fallback). A 130s timeout shows "Timed out — Retry".
//
// FAIL-OPEN: if NO phone is paired the daemon answers paired=false + state=
// "approved", so the gate unlocks immediately and the user is never locked out.
Item {
    id: gate
    anchors.fill: parent

    // Emitted when the desktop is unlocked (approved OR fail-open).
    signal unlocked()

    // Where this gate lives — "desktop" or "extension" (tagged on the challenge).
    property string origin: "desktop"

    property string challengeId: ""
    // "starting" | "waiting" | "denied" | "expired" | "timeout"
    property string phase: "starting"
    property bool paired: true
    property bool hasPin: false      // a desktop PIN is set (from settings.get)
    property bool pinError: false    // last PIN attempt was wrong

    function startRequest() {
        gate.phase = "starting"
        gate.challengeId = ""
        bridge.authRequest(gate.origin)
        timeoutTimer.restart()
    }

    Component.onCompleted: { gate.startRequest(); bridge.loadSettings() }

    Connections {
        target: bridge
        function onSettingsLoaded(s) {
            gate.hasPin = (s.has_desktop_pin === true)
        }
        function onPinRejected() {
            gate.pinError = true
            pinShake.restart()
        }
    }

    // Poll auth.status as a fallback to the unsolicited auth.event push. Fast (1s)
    // so a missed broadcast still clears the gate within a second of approval.
    Timer {
        id: pollTimer
        interval: 1000
        repeat: true
        running: gate.phase === "waiting" && gate.challengeId.length > 0
        onTriggered: bridge.authStatus(gate.challengeId)
    }

    // If the control connection drops + comes back while we're waiting, the
    // challenge/broadcast may have been lost — re-request so we never hang.
    Connections {
        target: bridge
        function onConnectedChanged() {
            if (bridge.connected && (gate.phase === "waiting" || gate.phase === "starting"))
                gate.startRequest()
        }
    }

    // Hard timeout: stop waiting after ~130s and offer Retry.
    Timer {
        id: timeoutTimer
        interval: 130000
        repeat: false
        onTriggered: if (gate.phase === "waiting" || gate.phase === "starting")
                         gate.phase = "timeout"
    }

    Connections {
        target: bridge
        function onAuthChallengeStarted(challengeId, state, paired) {
            gate.paired = paired
            // FAIL-OPEN (no phone paired) OR already approved -> unlock now.
            if (!paired || state === "approved") {
                timeoutTimer.stop()
                gate.unlocked()
                return
            }
            gate.challengeId = challengeId
            gate.phase = "waiting"
        }
        function onAuthStateChanged(challengeId, state) {
            // Ignore events for a stale challenge (e.g. after a retry).
            if (challengeId.length > 0 && gate.challengeId.length > 0
                && challengeId !== gate.challengeId)
                return
            if (state === "approved") {
                timeoutTimer.stop()
                gate.unlocked()
            } else if (state === "denied") {
                gate.phase = "denied"
            } else if (state === "expired") {
                gate.phase = "expired"
            }
        }
    }

    // ---- backdrop ----------------------------------------------------------
    Rectangle {
        anchors.fill: parent
        color: Theme.bgDeep
    }
    HudFx {
        anchors.fill: parent
        dense: true
    }

    // Swallow ALL input so nothing underneath is interactable while locked.
    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.AllButtons
        onClicked: function(mouse) { mouse.accepted = true }
    }

    Column {
        anchors.centerIn: parent
        width: Math.min(parent.width - 64, 420)
        spacing: 22

        ArcReactor {
            anchors.horizontalCenter: parent.horizontalCenter
            size: 96
            spinning: true
            thinking: gate.phase === "waiting" || gate.phase === "starting"
            tint: gate.phase === "denied" || gate.phase === "expired"
                      || gate.phase === "timeout" ? Theme.danger : Theme.accent
        }

        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "CINDRO LOCKED"
            color: Theme.accent
            font.family: Theme.fontDisplay
            font.pixelSize: 18
            font.letterSpacing: Theme.trackWide
            font.weight: Font.DemiBold
        }

        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            color: Theme.textMuted
            font.family: Theme.fontSans
            font.pixelSize: 14
            text: {
                if (gate.phase === "starting") return "Requesting unlock…"
                if (gate.phase === "waiting")  return "Approve on your phone — tap the notification and confirm with your fingerprint."
                if (gate.phase === "denied")   return "Sign-in was denied on your phone."
                if (gate.phase === "expired")  return "The unlock request expired."
                if (gate.phase === "timeout")  return "Timed out waiting for approval."
                return ""
            }
        }

        // Retry button (shown once the flow can't proceed without user action).
        Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: gate.phase === "denied" || gate.phase === "expired"
                     || gate.phase === "timeout"
            width: 160
            height: 40
            radius: Theme.radiusSm
            color: retryArea.containsMouse ? Theme.surfaceStrong : Theme.surface
            border.width: 1
            border.color: Theme.accentGlow

            Text {
                anchors.centerIn: parent
                text: "RETRY"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 13
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
            }
            MouseArea {
                id: retryArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: gate.startRequest()
            }
        }

        // ---- PIN fallback (reliable local unlock) --------------------------
        Column {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: gate.hasPin && gate.phase !== "starting"
            spacing: 9
            topPadding: 6

            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: gate.pinError ? "WRONG PIN — TRY AGAIN" : "OR UNLOCK WITH YOUR PIN"
                color: gate.pinError ? Theme.danger : Theme.textFaint
                font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: 1.6
                font.weight: Font.DemiBold
            }
            Rectangle {
                id: pinBox
                anchors.horizontalCenter: parent.horizontalCenter
                width: 220; height: 44; radius: Theme.radiusSm
                color: Theme.surfaceInput
                border.width: 1
                border.color: gate.pinError ? Theme.danger
                              : (pinField.activeFocus ? Theme.accent : Theme.hairlineSoft)
                Behavior on border.color { ColorAnimation { duration: 140 } }
                // shake on wrong PIN
                transform: Translate { id: pinShakeT; x: 0 }
                SequentialAnimation {
                    id: pinShake
                    NumberAnimation { target: pinShakeT; property: "x"; to: -8; duration: 50 }
                    NumberAnimation { target: pinShakeT; property: "x"; to: 8; duration: 50 }
                    NumberAnimation { target: pinShakeT; property: "x"; to: -5; duration: 50 }
                    NumberAnimation { target: pinShakeT; property: "x"; to: 0; duration: 50 }
                }
                TextField {
                    id: pinField
                    anchors.fill: parent
                    anchors.leftMargin: 14; anchors.rightMargin: 64
                    verticalAlignment: TextInput.AlignVCenter
                    echoMode: TextInput.Password
                    inputMethodHints: Qt.ImhDigitsOnly | Qt.ImhSensitiveData
                    placeholderText: "PIN"
                    color: Theme.text
                    font.family: Theme.fontMono; font.pixelSize: 18; font.letterSpacing: 4
                    background: null
                    onTextChanged: gate.pinError = false
                    onAccepted: if (text.length > 0) bridge.verifyPin(gate.challengeId, text)
                    Component.onCompleted: forceActiveFocus()
                }
                // submit
                Rectangle {
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    anchors.rightMargin: 6
                    width: 48; height: 32; radius: Theme.radiusXs
                    color: pinGo.containsMouse ? Theme.accent : Theme.accentDim
                    Text { anchors.centerIn: parent; text: "→"; color: Theme.inkOnAccent; font.pixelSize: 16; font.weight: Font.Bold }
                    MouseArea {
                        id: pinGo; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: if (pinField.text.length > 0) bridge.verifyPin(gate.challengeId, pinField.text)
                    }
                }
            }
        }
    }
}
