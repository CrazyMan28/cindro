import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { MistralApiError } from "./errors.js";
import { validateMistralConfig } from "./validate.js";
import { assertValidWavBuffer, extractWavPcm } from "../audio/wav.js";

export type SpeechToTextOptions = {
  language?: string;
  format?: string;
  contextBias?: string[];
  realtime?: boolean;
};

export type SpeechToTextResult = {
  text: string;
  model: string;
  language?: string;
  segments?: unknown[];
  usage?: unknown;
  mock: boolean;
};

export async function speechToTextFile(
  config: AppConfig["mistral"],
  filePath: string,
  options: SpeechToTextOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<SpeechToTextResult> {
  const buffer = await fs.readFile(filePath);
  return speechToTextBuffer(config, buffer, { ...options, format: options.format ?? extensionToFormat(filePath) }, fetchImpl);
}

export async function speechToTextBuffer(
  config: AppConfig["mistral"],
  buffer: Buffer,
  options: SpeechToTextOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<SpeechToTextResult> {
  if (!config.realAudio) {
    const transcriptAudio = options.format === "wav" && buffer.length >= 44 ? safeExtractWavPcm(buffer) : buffer;
    return {
      text: mockTranscript(transcriptAudio),
      model: config.sttModel || "mock-stt",
      language: options.language ?? config.sttLanguage,
      segments: [],
      usage: { prompt_audio_bytes: buffer.length },
      mock: true
    };
  }
  await validateMistralConfig(config);
  const form = new FormData();
  form.set("model", config.sttModel);
  form.set("stream", "false");
  form.set("language", options.language ?? config.sttLanguage);
  if (options.contextBias?.length) form.set("context_bias", JSON.stringify(options.contextBias));
  const format = options.format ?? config.audioFormat;
  const audioBuffer = format === "wav" ? validateAndUseWav(buffer) : buffer;
  const arrayBuffer = audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer;
  form.set("file", new Blob([arrayBuffer], { type: contentTypeForAudio(format) }), `agent-phone-stt.${format}`);
  const response = await retryMistral(config, () =>
    fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(config.timeoutMs)
    })
  );
  const json = (await response.json()) as { text?: string; model?: string; language?: string; segments?: unknown[]; usage?: unknown };
  return {
    text: json.text ?? "",
    model: json.model ?? config.sttModel,
    language: json.language,
    segments: json.segments,
    usage: json.usage,
    mock: false
  };
}

export async function* speechToTextRealtime(
  config: AppConfig["mistral"],
  chunks: AsyncIterable<Buffer>,
  options: SpeechToTextOptions = {},
  fetchImpl: typeof fetch = fetch
): AsyncIterable<SpeechToTextResult> {
  const buffers: Buffer[] = [];
  for await (const chunk of chunks) buffers.push(chunk);
  yield await speechToTextBuffer(config, Buffer.concat(buffers), { ...options, realtime: true }, fetchImpl);
}

export async function retryMistral(config: AppConfig["mistral"], producer: () => Promise<Response>): Promise<Response> {
  let last: unknown;
  const attempts = Math.max(1, config.maxRetries + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await producer();
      if (response.ok) return response;
      const body = await response.text().catch(() => "");
      if (!isTemporary(response.status) || attempt === attempts) {
        throw new MistralApiError(`Mistral API error ${response.status}: ${body.slice(0, 500)}`, response.status, body);
      }
    } catch (error) {
      last = error;
      if (attempt === attempts) throw error;
    }
    await delay(300 * attempt);
  }
  throw last instanceof Error ? last : new MistralApiError("Mistral API request failed");
}

function isTemporary(status: number) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

export function contentTypeForAudio(format: string) {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/ogg";
    case "pcm":
    case "pcm_s16le":
      return "audio/L16";
    case "flac":
      return "audio/flac";
    case "wav":
    default:
      return "audio/wav";
  }
}

function extensionToFormat(filePath: string) {
  const ext = path.extname(filePath).replace(".", "").toLowerCase();
  return ext || "wav";
}

function mockTranscript(audioBuffer: Buffer) {
  const printable = audioBuffer.toString("utf8").replace(/[^\x20-\x7e]/g, "").trim();
  if (printable && printable.length <= 240) return printable;
  return `mock transcript for ${audioBuffer.length} bytes of audio`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateAndUseWav(buffer: Buffer) {
  assertValidWavBuffer(buffer);
  return buffer;
}

function safeExtractWavPcm(buffer: Buffer) {
  try {
    return extractWavPcm(buffer);
  } catch {
    return buffer;
  }
}
