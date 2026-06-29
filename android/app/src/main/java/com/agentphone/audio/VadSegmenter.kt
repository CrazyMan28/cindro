package com.agentphone.audio

/** What the segmenter decided about the most recent audio frame. */
enum class VadEvent { NONE, UTTERANCE_START, UTTERANCE_END }

/**
 * Turns a stream of per-frame RMS energies into utterance boundaries so the mic can run
 * continuously (no push-to-talk) while still handing the server one
 * `audio_start → chunks → audio_end` cycle per spoken turn.
 *
 * Pure logic, no Android dependencies, so it is unit-tested directly. The audio capture loop
 * feeds one [accept] per recorder buffer and acts on the returned [VadEvent]. Hysteresis
 * ([startRms] > [endRms]) keeps it from flapping at the threshold.
 */
class VadSegmenter(
    private val startRms: Double,
    private val endRms: Double,
    private val minSpeechFrames: Int,
    private val silenceFramesToEnd: Int,
) {
    private var speaking = false
    private var speechRun = 0
    private var silenceRun = 0

    /** Feed one frame's RMS energy; returns the boundary it crossed, if any. */
    fun accept(rms: Double): VadEvent {
        if (!speaking) {
            speechRun = if (rms > startRms) speechRun + 1 else 0
            if (speechRun >= minSpeechFrames) {
                speaking = true
                silenceRun = 0
                return VadEvent.UTTERANCE_START
            }
            return VadEvent.NONE
        }
        silenceRun = if (rms < endRms) silenceRun + 1 else 0
        if (silenceRun >= silenceFramesToEnd) {
            speaking = false
            speechRun = 0
            return VadEvent.UTTERANCE_END
        }
        return VadEvent.NONE
    }

    /**
     * Force the current turn closed (e.g. the mic is being gated because the agent started
     * speaking, or the user muted). Returns [VadEvent.UTTERANCE_END] if a turn was in
     * progress so the caller can flush an `audio_end`, otherwise [VadEvent.NONE].
     */
    fun end(): VadEvent {
        val wasSpeaking = speaking
        reset()
        return if (wasSpeaking) VadEvent.UTTERANCE_END else VadEvent.NONE
    }

    /** Hard reset to idle without emitting anything (used at capture start). */
    fun reset() {
        speaking = false
        speechRun = 0
        silenceRun = 0
    }
}
