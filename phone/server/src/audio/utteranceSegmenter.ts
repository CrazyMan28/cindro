export type UtteranceEvent = "none" | "utterance_start" | "utterance_end";

export interface UtteranceSegmenterOptions {
  /** RMS a frame must exceed to count toward speech onset (hysteresis high). */
  startRms: number;
  /** RMS a frame must fall below to count toward trailing silence (hysteresis low). */
  endRms: number;
  /** Consecutive loud frames required before emitting utterance_start. */
  minSpeechFrames: number;
  /** Consecutive quiet frames required before emitting utterance_end. */
  silenceFramesToEnd: number;
}

/**
 * Turns a stream of per-frame RMS energies into utterance boundaries so a
 * continuous audio feed (Twilio media stream) produces one
 * `audio_start -> chunks -> audio_end` cycle per spoken turn.
 *
 * Direct port of the Android client's VadSegmenter
 * (android/.../audio/VadSegmenter.kt) so both ends segment identically.
 */
export class UtteranceSegmenter {
  private speaking = false;
  private speechRun = 0;
  private silenceRun = 0;

  constructor(private readonly options: UtteranceSegmenterOptions) {}

  /** Feed one frame's RMS energy; returns the boundary it crossed, if any. */
  accept(rms: number): UtteranceEvent {
    if (!this.speaking) {
      this.speechRun = rms > this.options.startRms ? this.speechRun + 1 : 0;
      if (this.speechRun >= this.options.minSpeechFrames) {
        this.speaking = true;
        this.silenceRun = 0;
        return "utterance_start";
      }
      return "none";
    }
    this.silenceRun = rms < this.options.endRms ? this.silenceRun + 1 : 0;
    if (this.silenceRun >= this.options.silenceFramesToEnd) {
      this.speaking = false;
      this.speechRun = 0;
      return "utterance_end";
    }
    return "none";
  }

  /**
   * Force the current turn closed (e.g. the agent started speaking and the
   * mic is being gated). Returns "utterance_end" if a turn was in progress.
   */
  end(): UtteranceEvent {
    const wasSpeaking = this.speaking;
    this.reset();
    return wasSpeaking ? "utterance_end" : "none";
  }

  /** Hard reset to idle without emitting anything. */
  reset(): void {
    this.speaking = false;
    this.speechRun = 0;
    this.silenceRun = 0;
  }
}
