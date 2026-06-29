import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { validateMistralConfig } from "./validate.js";
import { retryMistral } from "./stt.js";

export type TextToSpeechOptions = {
  voiceId?: string;
  refAudioBase64?: string;
  responseFormat?: "pcm" | "wav" | "mp3" | "flac" | "opus";
  /** Speaking-rate multiplier (1 = normal). Kept for the voice-profile API and
   *  future providers, but NOT sent to Mistral: its /audio/speech rejects `speed`
   *  ("extra_forbidden", HTTP 422), which silently broke every call's audio. */
  speed?: number;
};

export type TextToSpeechResult = {
  audio: Buffer;
  model: string;
  voiceId?: string;
  format: string;
  mock: boolean;
};

export async function textToSpeech(
  config: AppConfig["mistral"],
  text: string,
  options: TextToSpeechOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<TextToSpeechResult> {
  const format = options.responseFormat ?? config.audioFormat;
  const voiceId = options.voiceId ?? config.voiceId;
  if (!config.realAudio) {
    return {
      audio: mockWav(text),
      model: config.ttsModel || "mock-tts",
      voiceId,
      format: "wav",
      mock: true
    };
  }
  await validateMistralConfig(config);
  assertRealVoiceConfig(voiceId, options.refAudioBase64);
  const response = await retryMistral(config, () =>
    fetchImpl(`${config.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.ttsModel,
        input: text,
        voice_id: voiceId,
        ref_audio: options.refAudioBase64,
        response_format: format,
        sample_rate: config.ttsSampleRate,
        stream: false
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    })
  );
  const json = (await response.json()) as { audio_data?: string };
  const audio = Buffer.from(json.audio_data ?? "", "base64");
  if (audio.length === 0) throw new Error("Mistral TTS returned empty audio_data.");
  return { audio, model: config.ttsModel, voiceId, format, mock: false };
}

export async function textToSpeechToFile(
  config: AppConfig["mistral"],
  text: string,
  outputPath: string,
  options: TextToSpeechOptions = {},
  fetchImpl: typeof fetch = fetch
) {
  const result = await textToSpeech(config, text, options, fetchImpl);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, result.audio);
  return { ...result, outputPath, audio: undefined };
}

export async function* textToSpeechStream(
  config: AppConfig["mistral"],
  text: string,
  options: TextToSpeechOptions = {},
  fetchImpl: typeof fetch = fetch
): AsyncIterable<TextToSpeechResult> {
  const format = options.responseFormat ?? config.audioFormat;
  const voiceId = options.voiceId ?? config.voiceId;
  if (!config.realAudio) {
    const audio = mockWav(text);
    yield { audio: audio.subarray(0, Math.ceil(audio.length / 2)), model: config.ttsModel || "mock-tts", voiceId, format: "wav", mock: true };
    yield { audio: audio.subarray(Math.ceil(audio.length / 2)), model: config.ttsModel || "mock-tts", voiceId, format: "wav", mock: true };
    return;
  }
  await validateMistralConfig(config);
  assertRealVoiceConfig(voiceId, options.refAudioBase64);
  const response = await retryMistral(config, () =>
    fetchImpl(`${config.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: config.ttsModel,
        input: text,
        voice_id: voiceId,
        ref_audio: options.refAudioBase64,
        response_format: format,
        sample_rate: config.ttsSampleRate,
        stream: true
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    })
  );
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const events = pending.split("\n\n");
    pending = events.pop() ?? "";
    for (const event of events) {
      const dataLine = event
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice("data:".length).trim();
      if (data === "[DONE]") return;
      const json = JSON.parse(data) as { audio_data?: string };
      if (json.audio_data) {
        yield {
          audio: Buffer.from(json.audio_data, "base64"),
          model: config.ttsModel,
          voiceId,
          format,
          mock: false
        };
      }
    }
  }
}

function assertRealVoiceConfig(voiceId?: string, refAudioBase64?: string) {
  if (!voiceId && !refAudioBase64) {
    throw new Error("Real Mistral TTS requires MISTRAL_TTS_VOICE_ID as a UUID or ref_audio. Run ./scripts/setup-mistral.sh.");
  }
  if (voiceId && !isUuid(voiceId)) {
    throw new Error("MISTRAL_TTS_VOICE_ID must be a UUID from /v1/audio/voices, not a display name like Oliver.");
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mockWav(text: string) {
  const sampleRate = 16_000;
  const seconds = Math.min(2, Math.max(0.35, text.length / 80));
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const tone = Math.sin((i / sampleRate) * Math.PI * 2 * 440) * 0.2;
    buffer.writeInt16LE(Math.floor(tone * 32767), 44 + i * 2);
  }
  return buffer;
}
