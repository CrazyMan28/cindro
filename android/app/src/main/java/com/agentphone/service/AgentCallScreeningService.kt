package com.agentphone.service

import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import androidx.annotation.RequiresApi
import com.agentphone.state.AgentPhonePreferences
import com.agentphone.state.ScreeningStore

/**
 * Bound by the system (ROLE_CALL_SCREENING) for every incoming NATIVE cell
 * call. Android gives apps no access to the call's audio and only ~5s to
 * respond here, so this service does exactly two things:
 *
 * 1. Responds "allow" immediately — the native ringer proceeds untouched.
 * 2. Shows the "Let my agent take this call?" offer notification. Tapping it
 *    declines the native call (TelecomManager.endCall) so the carrier's
 *    conditional call forwarding sends the caller to the Twilio number, where
 *    the agent answers and the live screening session begins.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class AgentCallScreeningService : CallScreeningService() {
    override fun onScreenCall(callDetails: Call.Details) {
        // Never block/silence anything here — the user decides via the offer.
        respondToCall(callDetails, CallResponse.Builder().build())
        if (callDetails.callDirection != Call.Details.DIRECTION_INCOMING) return
        val number = callDetails.handle?.schemeSpecificPart.orEmpty()
        if (number.isBlank()) return
        // The take-over <Dial> rings THIS phone — don't offer to screen our own bridge call.
        if (ScreeningStore.isTakeoverRingExpected()) return
        AgentPhonePreferences.recordReconnectReason(this, "native ring from $number — screening offer shown")
        AgentPhoneNotifications.showScreeningOffer(this, number)
    }
}
