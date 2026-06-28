import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { speechToTextFile } from "./stt.js";
import { textToSpeechToFile } from "./tts.js";
import { validateMistralConfig } from "./validate.js";

export type RealMistralSmokeResult = {
  ok: boolean;
  ttsOutputPath: string;
  ttsBytes: number;
  transcript: string;
  sttModel: string;
  ttsModel: string;
};

export async function runRealMistralSmokeTest(config: AppConfig["mistral"], outputDir = "tmp"): Promise<RealMistralSmokeResult> {
  await validateMistralConfig(config);
  await fs.mkdir(outputDir, { recursive: true });
  const format = config.audioFormat === "pcm" ? "wav" : config.audioFormat;
  const ttsOutputPath = path.join(outputDir, `mistral-tts-test.${format}`);
  const tts = await textToSpeechToFile(
    config,
    "Agent Phone real Mistral smoke test. This audio verifies text to speech and speech to text.",
    ttsOutputPath,
    { responseFormat: format }
  );
  const stt = await speechToTextFile(config, ttsOutputPath, { format, language: config.sttLanguage });
  const stat = await fs.stat(ttsOutputPath);
  return {
    ok: true,
    ttsOutputPath,
    ttsBytes: stat.size,
    transcript: stt.text,
    sttModel: stt.model,
    ttsModel: tts.model
  };
}
