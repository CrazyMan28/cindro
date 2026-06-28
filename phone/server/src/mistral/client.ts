import type { AppConfig } from "../config.js";
import type { SpeechToTextOptions } from "./stt.js";
import { speechToTextBuffer, speechToTextFile, speechToTextRealtime } from "./stt.js";
import type { TextToSpeechOptions } from "./tts.js";
import { textToSpeech, textToSpeechStream, textToSpeechToFile } from "./tts.js";
import { listVoices } from "./voices.js";
import { validateMistralConfig } from "./validate.js";

export type { SpeechToTextOptions, SpeechToTextResult } from "./stt.js";
export type { TextToSpeechOptions, TextToSpeechResult } from "./tts.js";
export type { VoiceOption } from "./voices.js";

export class MistralClient {
  constructor(
    private readonly config: AppConfig["mistral"],
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  validate(options: { verifyModels?: boolean } = {}) {
    return validateMistralConfig(this.config, { ...options, fetchImpl: this.fetchImpl });
  }

  speechToTextFile(filePath: string, options: SpeechToTextOptions = {}) {
    return speechToTextFile(this.config, filePath, options, this.fetchImpl);
  }

  speechToTextBuffer(audioBuffer: Buffer, options: SpeechToTextOptions = {}) {
    return speechToTextBuffer(this.config, audioBuffer, options, this.fetchImpl);
  }

  speechToTextOffline(audioBuffer: Buffer, options: SpeechToTextOptions = {}) {
    return this.speechToTextBuffer(audioBuffer, options);
  }

  speechToTextRealtime(chunks: AsyncIterable<Buffer>, options: SpeechToTextOptions = {}) {
    return speechToTextRealtime(this.config, chunks, options, this.fetchImpl);
  }

  textToSpeech(text: string, options: TextToSpeechOptions = {}) {
    return textToSpeech(this.config, text, options, this.fetchImpl);
  }

  textToSpeechToFile(text: string, outputPath: string, options: TextToSpeechOptions = {}) {
    return textToSpeechToFile(this.config, text, outputPath, options, this.fetchImpl);
  }

  textToSpeechStream(text: string, options: TextToSpeechOptions = {}) {
    return textToSpeechStream(this.config, text, options, this.fetchImpl);
  }

  listVoices() {
    return listVoices(this.config, this.fetchImpl);
  }
}
