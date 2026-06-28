import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../config.js";

/**
 * ON-DEVICE voice models (e.g. the Jarvis Piper model from Hugging Face).
 * The LAPTOP only STORES and SERVES these files — synthesis runs entirely on
 * the PHONE (sherpa-onnx). A local voice is selected like any other voice
 * (voiceId "local:<name>"), and the call pipeline sends the phone a
 * `tts_local` event with the text instead of streaming Mistral audio.
 */

export type LocalVoice = {
  /** voiceId as used in profiles: "local:jarvis" */
  id: string;
  name: string;
  dir: string;
  sampleRate: number;
  files: { model: string; config: string; tokens: string };
  /** Bundled preview clip (the model's own sample) — present when it ships one. */
  samplePath?: string;
};

export const LOCAL_VOICE_PREFIX = "local:";

const VOICES_DIR = path.join(repoRoot, "server", "data", "local-voices");

const DISPLAY_NAMES: Record<string, string> = {
  jarvis: "Jarvis (on-device)"
};

export function isLocalVoiceId(voiceId: string | undefined | null): boolean {
  return typeof voiceId === "string" && /^local:[a-z0-9_-]+$/i.test(voiceId);
}

/** Scan data/local-voices for complete model dirs. */
export function listLocalVoices(): LocalVoice[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(VOICES_DIR);
  } catch {
    return [];
  }
  const voices: LocalVoice[] = [];
  for (const entry of entries) {
    const dir = path.join(VOICES_DIR, entry);
    const model = path.join(dir, "model.onnx");
    const config = path.join(dir, "config.json");
    const tokens = path.join(dir, "tokens.txt");
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      if (![model, config, tokens].every((f) => fs.existsSync(f))) continue;
      let sampleRate = 22050;
      try {
        const parsed = JSON.parse(fs.readFileSync(config, "utf8")) as { audio?: { sample_rate?: number } };
        sampleRate = parsed.audio?.sample_rate ?? 22050;
      } catch { /* keep default */ }
      const sample = path.join(dir, "sample.mp3");
      voices.push({
        id: `${LOCAL_VOICE_PREFIX}${entry}`,
        name: DISPLAY_NAMES[entry] ?? `${entry} (on-device)`,
        dir,
        sampleRate,
        files: { model, config, tokens },
        samplePath: fs.existsSync(sample) ? sample : undefined
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  return voices;
}

export function getLocalVoice(idOrName: string): LocalVoice | undefined {
  const name = idOrName.startsWith(LOCAL_VOICE_PREFIX) ? idOrName.slice(LOCAL_VOICE_PREFIX.length) : idOrName;
  return listLocalVoices().find((v) => v.id === `${LOCAL_VOICE_PREFIX}${name}`);
}

export function espeakDataZipPath(): string | null {
  const p = path.join(VOICES_DIR, "espeak-ng-data.zip");
  return fs.existsSync(p) ? p : null;
}
