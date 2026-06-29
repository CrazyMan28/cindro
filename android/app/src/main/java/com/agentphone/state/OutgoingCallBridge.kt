package com.agentphone.state

import android.os.Handler
import android.os.Looper

/**
 * Thin in-process bridge so OutgoingCallActivity can observe live call state
 * (ringing → accepted → ended) without owning its own WebSocket. MainActivity
 * (and the foreground service) push events here as they arrive; the activity
 * subscribes/unsubscribes around its lifecycle.
 *
 * This is the same pattern InAppMessageStore uses for inbox updates.
 */
object OutgoingCallBridge {

    sealed class State {
        /** Dial sent, no callId assigned by the server yet. */
        data class Dialing(val toExtension: String) : State()
        data class Ringing(val callId: String, val toExtension: String) : State()
        data class Active(val callId: String) : State()
        data class Ended(val callId: String?, val reason: String?) : State()
        data class Failed(val callId: String?, val reason: String?) : State()
    }

    interface Listener {
        fun onStateChanged(state: State)
        fun onTranscriptAppended(line: String)
    }

    private val listeners: MutableList<Listener> = mutableListOf()
    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var lastState: State? = null

    /**
     * The current outgoing call's id once the server assigns one. Lets the
     * activity send audio/end for a call that started before dial_result
     * arrived (the screen launches optimistically on dial).
     */
    @Volatile
    var currentCallId: String? = null
        private set

    /**
     * Audio + end actions, registered by AppViewModel. OutgoingCallActivity is a
     * separate activity and must NOT open its own WebSocket — these route the
     * mic and hang-up through the same live connection that placed the call
     * (the foreground service runs a different connection that is usually not
     * even started for an app-initiated outgoing call).
     */
    @Volatile
    var onAudioStart: (() -> Boolean)? = null
    @Volatile
    var onAudioStop: (() -> Unit)? = null
    @Volatile
    var onMuteChanged: ((Boolean) -> Unit)? = null
    @Volatile
    var onEndCall: (() -> Unit)? = null

    @Synchronized
    fun subscribe(listener: Listener) {
        listeners.add(listener)
        lastState?.let { snapshot -> main.post { listener.onStateChanged(snapshot) } }
    }

    @Synchronized
    fun unsubscribe(listener: Listener) {
        listeners.remove(listener)
    }

    @Synchronized
    fun publishState(state: State) {
        lastState = state
        when (state) {
            is State.Ringing -> currentCallId = state.callId
            is State.Active -> currentCallId = state.callId
            is State.Dialing -> currentCallId = null
            else -> { /* keep last known id for Ended/Failed handlers */ }
        }
        val snapshot = listeners.toList()
        main.post {
            snapshot.forEach { it.onStateChanged(state) }
        }
    }

    @Synchronized
    fun publishTranscript(line: String) {
        val snapshot = listeners.toList()
        main.post {
            snapshot.forEach { it.onTranscriptAppended(line) }
        }
    }

    @Synchronized
    fun reset() {
        lastState = null
        currentCallId = null
    }
}
