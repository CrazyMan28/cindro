package com.agentphone.state

import android.os.Handler
import android.os.Looper

data class ScreeningLine(val seq: Int, val speaker: String, val text: String)

data class ScreeningSessionUi(
    val callId: String,
    val callerNumber: String,
    val forwardedFrom: String?,
    /** "active" | "taken_over" | "ended" */
    val status: String
)

/**
 * Shared state for a live call-screening session (the agent talking to an
 * unknown caller while the user watches). Fed by BOTH device sockets (in-app +
 * foreground service) — every event arrives twice, so lines dedup by the
 * server-issued seq. Pattern mirrors OutgoingCallBridge/InAppMessageStore.
 */
object ScreeningStore {
    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var session: ScreeningSessionUi? = null
    private val lines = mutableListOf<ScreeningLine>()
    private val seenSeq = mutableSetOf<Int>()
    private var listeners = listOf<() -> Unit>()

    /**
     * Set when the user taps Take over: Twilio is about to ring this phone to
     * bridge the caller in. While the window is open, the native-ring screening
     * offer is suppressed so the user isn't prompted to screen their own take-over.
     */
    @Volatile private var takeoverRingExpectedUntil: Long = 0

    fun start(callId: String, callerNumber: String, forwardedFrom: String?) {
        synchronized(lock) {
            if (session?.callId == callId) return
            session = ScreeningSessionUi(callId, callerNumber, forwardedFrom, "active")
            lines.clear()
            seenSeq.clear()
        }
        notifyListeners()
    }

    fun append(callId: String?, seq: Int, speaker: String, text: String) {
        if (callId == null || speaker.isBlank() || text.isBlank() || seq < 0) return
        synchronized(lock) {
            val current = session ?: return
            if (current.callId != callId) return
            if (!seenSeq.add(seq)) return // duplicate from the second device socket
            lines.add(ScreeningLine(seq, speaker, text))
            lines.sortBy { it.seq }
            if (lines.size > 200) lines.subList(0, lines.size - 200).clear()
        }
        notifyListeners()
    }

    fun end(callId: String?, outcome: String) {
        synchronized(lock) {
            val current = session ?: return
            if (callId != null && current.callId != callId) return
            session = current.copy(status = if (outcome == "taken_over") "taken_over" else "ended")
        }
        notifyListeners()
    }

    fun markTakingOver() {
        takeoverRingExpectedUntil = System.currentTimeMillis() + 90_000
    }

    /** True while a take-over ring-back is expected (suppresses the screening offer). */
    fun isTakeoverRingExpected(): Boolean = System.currentTimeMillis() < takeoverRingExpectedUntil

    fun current(): Pair<ScreeningSessionUi?, List<ScreeningLine>> = synchronized(lock) {
        session to lines.toList()
    }

    fun clear() {
        synchronized(lock) {
            session = null
            lines.clear()
            seenSeq.clear()
        }
        notifyListeners()
    }

    fun subscribe(listener: () -> Unit): () -> Unit {
        synchronized(lock) { listeners = listeners + listener }
        return {
            synchronized(lock) { listeners = listeners - listener }
        }
    }

    private fun notifyListeners() {
        val snapshot = synchronized(lock) { listeners }
        mainHandler.post { snapshot.forEach { it() } }
    }
}
