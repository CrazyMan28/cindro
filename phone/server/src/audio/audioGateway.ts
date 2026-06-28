import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { CallService } from "../calls/callService.js";
import type { AppDatabase } from "../db/database.js";
import type { MistralClient, TextToSpeechOptions } from "../mistral/client.js";
import { contentTypeForAudio } from "../mistral/stt.js";
import { assertValidWavBuffer, pcm16ToWav } from "./wav.js";
import { VoiceProfileService } from "./voiceProfiles.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { isLocalVoiceId, getLocalVoice } from "../voices/localVoices.js";

type BufferedAudio = {
  callId: string;
  fromExtension: string;
  targetExtension?: string;
  audioFormat: string;
  sampleRate: number;
  channels: number;
  chunks: Buffer[];
};

export type AudioEventSink = {
  sendToExtension(extension: string, event: Record<string, unknown>): void;
  sendToCall(callId: string, event: Record<string, unknown>): void;
  /**
   * Multi-party turn routing (lead policy + voice-command kick) lives on the
   * hub — it owns the speak chains, lead map, and targeted call_end delivery.
   * Optional so lightweight test sinks keep working (fallback: broadcast).
   */
  routeMultiPartyTurn?(input: { callId: string; fromExtension: string; text: string; transcript: unknown; sessionId?: string }): Promise<void> | void;
};

export class AudioGateway {
  private readonly buffers = new Map<string, BufferedAudio>();
  private readonly calls: CallService;
  private readonly voiceProfiles: VoiceProfileService;
  private readonly extensions: ExtensionService;

  constructor(
    private readonly db: AppDatabase,
    private readonly mistral: MistralClient,
    private readonly config: AppConfig,
    private readonly sink?: AudioEventSink
  ) {
    this.calls = new CallService(db);
    this.voiceProfiles = new VoiceProfileService(db);
    this.extensions = new ExtensionService(db);
  }

  startAudio(callId: string, fromExtension: string, audioFormat = "pcm_s16le", sampleRate = 16_000, channels = 1, targetExtension?: string) {
    const key = this.key(callId, fromExtension);
    this.buffers.set(key, { callId, fromExtension, targetExtension, audioFormat, sampleRate, channels, chunks: [] });
    this.sink?.sendToCall(callId, { type: "audio_start", callId, fromExtension, audioFormat, sampleRate, channels });
  }

  appendAudio(callId: string, fromExtension: string, chunk: Buffer) {
    const key = this.key(callId, fromExtension);
    const buffer = this.buffers.get(key);
    if (!buffer) throw new Error("audio_start is required before audio_chunk");
    buffer.chunks.push(chunk);
    this.sink?.sendToCall(callId, { type: "audio_chunk_ack", callId, fromExtension, bytes: chunk.length });
  }

  async endAudio(callId: string, fromExtension: string) {
    const key = this.key(callId, fromExtension);
    const buffer = this.buffers.get(key);
    if (!buffer) throw new Error("audio_start is required before audio_end");
    this.buffers.delete(key);
    const pcmAudio = Buffer.concat(buffer.chunks);
    const wavAudio = buffer.audioFormat === "wav" ? pcmAudio : pcm16ToWav(pcmAudio, { sampleRate: buffer.sampleRate, channels: buffer.channels });
    try {
      if (buffer.audioFormat === "wav") {
        assertValidWavBuffer(wavAudio);
      }
      await this.persistDebugWav(callId, wavAudio);
      this.calls.addAudioTrack(callId, fromExtension, "inbound", "wav", wavAudio.length, {
        rawStored: false,
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
        audioFormat: buffer.audioFormat
      });
      const stt = await this.mistral.speechToTextOffline(wavAudio, { format: "wav" });
      const transcript = this.calls.addTranscript(callId, fromExtension, stt.text, true, undefined, {
        model: stt.model,
        language: stt.language,
        mock: stt.mock,
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
        audioFormat: buffer.audioFormat
      });
      const call = this.calls.get(callId);
      // Multi-party call (911 war room OR a user-picked conference): the call
      // targets a GROUP extension. Checked via owner_type — NOT participant
      // count — so a conference whittled down to one agent still routes through
      // the hub (otherwise "kick <last agent>" would arrive as a normal turn).
      // Routing — lead-listens-first policy and voice kick commands — is the
      // hub's job; it decides who actually receives the turn.
      const joined = this.calls.joinedParticipantExtensions(callId);
      const isGroupCall = call ? this.extensions.get(call.to_extension)?.owner_type === "group" : false;
      if (isGroupCall || joined.length > 2) {
        if (this.sink?.routeMultiPartyTurn) {
          await this.sink.routeMultiPartyTurn({ callId, fromExtension, text: stt.text, transcript, sessionId: call?.session_id ?? undefined });
        } else {
          // No router installed (bare test sink): broadcast to all other participants.
          for (const target of joined.filter((e) => e !== fromExtension)) {
            this.calls.addMessage(callId, call?.session_id ?? undefined, fromExtension, target, "user", stt.text, { source: "stt" });
            this.sink?.sendToExtension(target, { type: "transcript_final", callId, fromExtension, text: stt.text, transcript });
            this.sink?.sendToExtension(target, { type: "call_message", callId, fromExtension, toExtension: target, content: stt.text, source: "stt" });
          }
        }
      } else {
        const target = buffer.targetExtension ?? (call?.from_extension === fromExtension ? call?.to_extension : call?.from_extension);
        if (target) {
          this.calls.addMessage(callId, call?.session_id ?? undefined, fromExtension, target, "user", stt.text, { source: "stt" });
          this.sink?.sendToExtension(target, { type: "transcript_final", callId, fromExtension, text: stt.text, transcript });
          this.sink?.sendToExtension(target, { type: "call_message", callId, fromExtension, toExtension: target, content: stt.text, source: "stt" });
        }
      }
      this.sink?.sendToCall(callId, { type: "audio_end", callId, fromExtension, bytes: wavAudio.length, audioFormat: "wav", sampleRate: buffer.sampleRate, channels: buffer.channels });
      return { ok: true as const, transcript, stt };
    } catch (error) {
      const message = error instanceof Error ? error.message : "audio_stt_failed";
      // Multi-party calls must SURVIVE one bad turn: a transient STT failure on
      // a single speaker used to fail the whole shared call — ending a 911 war
      // room for every participant. Scope the error to the speaker and keep the
      // call alive; only genuine 1:1 calls fail outright.
      const current = this.calls.get(callId);
      const isGroupCall = current ? this.extensions.get(current.to_extension)?.owner_type === "group" : false;
      const multiParty = isGroupCall || this.calls.joinedParticipantExtensions(callId).length > 2;
      if (multiParty && current && !["ended", "rejected", "timeout", "failed", "missed"].includes(current.state)) {
        this.sink?.sendToExtension(fromExtension, {
          type: "audio_error",
          callId,
          fromExtension,
          code: "audio_stt_failed",
          message,
          audioFormat: "wav",
          sampleRate: buffer.sampleRate,
          channels: buffer.channels,
          call: current
        });
        return { ok: false as const, code: "audio_stt_failed", error: message, call: current };
      }
      const call = this.calls.fail(callId, message);
      this.sink?.sendToCall(callId, {
        type: "audio_error",
        callId,
        fromExtension,
        code: "audio_stt_failed",
        message,
        audioFormat: "wav",
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
        call
      });
      this.sink?.sendToCall(callId, { type: "call_failed", call, code: "audio_stt_failed", message });
      return { ok: false as const, code: "audio_stt_failed", error: message, call };
    }
  }

  async synthesizeForCall(callId: string, fromExtension: string, toExtension: string, text: string, options: TextToSpeechOptions = {}) {
    const call = this.calls.get(callId);
    // Apply the speaking extension's voice profile (voice + rate) unless the
    // caller already pinned a voice/speed in `options`. This is what makes each
    // agent/person sound distinct on a call.
    const profile = this.voiceProfiles.get(fromExtension);
    const effectiveOptions: TextToSpeechOptions = {
      ...options,
      voiceId: options.voiceId ?? profile.voiceId,
      speed: options.speed ?? profile.speed
    };
    options = effectiveOptions;
    // PSTN target (Twilio bridge on ext 700): there is no phone-side TTS engine
    // on a real telephone, so on-device voices (local:*) must fall back to the
    // server Mistral voice, and the output must be self-describing WAV so the
    // bridge can transcode it to 8kHz mulaw.
    if (this.extensionChannel(toExtension) === "pstn") {
      options = {
        ...options,
        responseFormat: "wav",
        voiceId: isLocalVoiceId(options.voiceId) ? this.config.mistral.voiceId : options.voiceId
      };
    }
    // ON-DEVICE voice (e.g. local:jarvis): the LAPTOP must not run synthesis —
    // persist the message and hand the TEXT to the phone, which runs the Piper
    // model locally (sherpa-onnx) and plays through the same serial TTS queue.
    if (isLocalVoiceId(options.voiceId)) {
      const local = getLocalVoice(options.voiceId!);
      const message = this.calls.addMessage(callId, call?.session_id ?? undefined, fromExtension, toExtension, "assistant", text, { source: "agent", localVoice: options.voiceId }) as { id: string };
      this.sink?.sendToExtension(toExtension, {
        type: "tts_local",
        callId,
        fromExtension,
        messageId: message.id,
        voiceId: options.voiceId,
        sampleRate: local?.sampleRate ?? 22050,
        speed: options.speed ?? 1,
        text
      });
      return { messageId: message.id, bytes: 0, format: "local" };
    }
    const message = this.calls.addMessage(callId, call?.session_id ?? undefined, fromExtension, toExtension, "assistant", text, { source: "agent" }) as { id: string };
    let format: string = this.config.mistral.realAudio
      ? options.responseFormat ?? this.config.mistral.audioFormat ?? "mp3"
      : "wav";
    let model = "unknown";
    let voiceId: string | undefined;
    let totalBytes = 0;
    const mimeTypeForFormat = (audioFormat: string) => contentTypeForAudio(audioFormat);
    this.sink?.sendToExtension(toExtension, {
      type: "tts_start",
      callId,
      fromExtension,
      messageId: message.id,
      text,
      audioFormat: format,
      mimeType: mimeTypeForFormat(format)
    });
    try {
      for await (const chunk of this.mistral.textToSpeechStream(text, options)) {
        totalBytes += chunk.audio.length;
        format = chunk.format;
        model = chunk.model;
        voiceId = chunk.voiceId;
        this.sink?.sendToExtension(toExtension, {
          type: "tts_chunk",
          callId,
          fromExtension,
          messageId: message.id,
          format: chunk.format,
          audioFormat: chunk.format,
          mimeType: mimeTypeForFormat(chunk.format),
          audioBase64: chunk.audio.toString("base64")
        });
      }
    } catch (error) {
      // Tag the failure with the utterance id so the caller can tell the phone
      // to drop ONLY this message's dangling buffer — a call-scoped clear would
      // cut off other (successfully synthesized) utterances still playing.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { ttsMessageId: message.id });
    }
    this.calls.addAudioTrack(callId, toExtension, "outbound", format, totalBytes, { text });
    this.calls.addTtsOutput(callId, message.id, text, model, voiceId, format, totalBytes);
    this.sink?.sendToExtension(toExtension, {
      type: "tts_end",
      callId,
      fromExtension,
      messageId: message.id,
      bytes: totalBytes,
      format,
      audioFormat: format,
      mimeType: mimeTypeForFormat(format)
    });
    return { messageId: message.id, bytes: totalBytes, format };
  }

  async transcribeBuffer(
    callId: string,
    fromExtension: string,
    audio: Buffer,
    audioFormat = "pcm_s16le",
    sampleRate = 16_000,
    channels = 1
  ) {
    const wavAudio = audioFormat === "wav" ? audio : pcm16ToWav(audio, { sampleRate, channels });
    if (audioFormat === "wav") assertValidWavBuffer(wavAudio);
    await this.persistDebugWav(callId, wavAudio);
    this.calls.addAudioTrack(callId, fromExtension, "inbound", "wav", wavAudio.length, {
      rawStored: false,
      route: "http",
      sampleRate,
      channels,
      audioFormat
    });
    const stt = await this.mistral.speechToTextOffline(wavAudio, { format: "wav" });
    const transcript = this.calls.addTranscript(callId, fromExtension, stt.text, true, undefined, {
      model: stt.model,
      mock: stt.mock,
      sampleRate,
      channels,
      audioFormat
    });
    return { transcript, stt };
  }

  async ttsBuffer(text: string, options: TextToSpeechOptions = {}) {
    return this.mistral.textToSpeech(text, options);
  }

  private key(callId: string, extension: string) {
    return `${callId}:${extension}`;
  }

  private extensionChannel(extension: string): string | undefined {
    const raw = this.extensions.get(extension)?.metadata;
    if (!raw) return undefined;
    try {
      const metadata = typeof raw === "string" ? JSON.parse(raw) : raw;
      return typeof metadata?.channel === "string" ? metadata.channel : undefined;
    } catch {
      return undefined;
    }
  }

  private async persistDebugWav(callId: string, wavAudio: Buffer) {
    if (!this.config.mistral.debugAudio) return;
    const outputPath = path.join(process.cwd(), "tmp", "calls", callId, "user-input.wav");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, wavAudio);
  }
}
