package com.agentphone.audio

/**
 * Process-global "the agent is talking right now" gate used to run the call
 * half-duplex: while the agent's TTS plays, the mic capture loop drops frames so
 * the agent's own voice is never recorded and fed back (which is the echo, and
 * what makes the agent answer itself).
 *
 * It is a **counter**, not a flag: a call's TTS can be played by more than one
 * audio instance and back-to-back messages can overlap, so the mic must stay
 * gated until *every* playback has stopped. After the last one stops, a short
 * [HANGOVER_MS] keeps the mic gated to swallow the acoustic tail/reverb before
 * we start listening again.
 *
 * Global because on an incoming call the recorder and the TTS player live in
 * different objects, each with its own [PushToTalkAudio].
 */
object HalfDuplexGate {
    private const val HANGOVER_MS = 600L

    private val lock = Any()
    private var speakers = 0
    private var quietUntil = 0L

    /** Injectable for tests; defaults to wall-clock. */
    @Volatile
    var clock: () -> Long = { System.currentTimeMillis() }

    fun agentStartedSpeaking() {
        synchronized(lock) { speakers += 1 }
    }

    fun agentStoppedSpeaking() {
        synchronized(lock) {
            if (speakers > 0) speakers -= 1
            if (speakers == 0) quietUntil = clock() + HANGOVER_MS
        }
    }

    fun isAgentSpeaking(): Boolean = synchronized(lock) {
        speakers > 0 || clock() < quietUntil
    }

    /** Test-only reset. */
    fun reset() {
        synchronized(lock) {
            speakers = 0
            quietUntil = 0L
        }
    }
}
