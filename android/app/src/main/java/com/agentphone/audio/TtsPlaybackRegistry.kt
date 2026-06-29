package com.agentphone.audio

/**
 * Process-global claim on "which audio instance plays this CALL's TTS".
 *
 * The server fans a call's TTS out to every connection an extension holds, and
 * the phone keeps multiple sockets on ext 100 (the in-app socket, the
 * foreground-service socket, sometimes a call activity). Without this, two
 * [PushToTalkAudio] instances play the same audio a few milliseconds apart —
 * the agent sounds like it's talking over itself.
 *
 * Claims are per-CALL and owner-aware: the first instance to see any tts_start
 * for a call owns ALL of that call's utterances, so they flow through one
 * serial playback queue. (Per-message claims could split a call's messages
 * across two instances, whose independent queues would then overlap — the
 * war-room talk-over bug, relocated.)
 */
object TtsPlaybackRegistry {
    private val claimed = HashMap<String, Any>()

    /**
     * Re-entrant per-owner claim: true when [owner] now (or already) holds
     * [key]; false only when a DIFFERENT owner holds it.
     */
    @Synchronized
    fun claim(key: String, owner: Any): Boolean {
        val existing = claimed[key]
        if (existing == null) {
            claimed[key] = owner
            return true
        }
        return existing === owner
    }

    @Synchronized
    fun release(key: String) {
        claimed.remove(key)
    }

    /** Free every claim for a call (keys are "callId" or "callId:messageId"). */
    @Synchronized
    fun releaseForCall(callId: String) {
        claimed.keys.removeAll { it == callId || it.startsWith("$callId:") }
    }

    /**
     * Free every claim held by [owner]. Call when an audio instance is torn
     * down so a surviving instance can take over its calls.
     */
    @Synchronized
    fun releaseOwnedBy(owner: Any) {
        claimed.entries.removeAll { it.value === owner }
    }

    /** Test-only reset. */
    @Synchronized
    fun clearAll() {
        claimed.clear()
    }
}
