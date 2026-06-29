import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * NAMED CLONED VOICES — the user's recorded/uploaded reference clips, managed by
 * the Jarvis daemon in ~/.config/jarvis/voices/ (<slug>_ref.<ext> + a voices.json
 * manifest). Mistral clones them ZERO-SHOT per request via `ref_audio`, so a
 * "voice" here is just a reference clip; there is no saved voice_id.
 *
 * Selected like any other voice with voiceId "clone:<slug>" (the seeded default
 * keeps the bare slug "jarvice"). The phone server only READS these clips, to
 * clone them on a call; the daemon owns create / delete / set-default.
 */

export const CLONE_VOICE_PREFIX = "clone:";
const JARVICE = "jarvice";
const CLIP_EXTS = ["mp3", "wav", "opus", "flac", "ogg"];

// Resolved lazily (not a load-time const) so it always honors the current $HOME,
// matching the daemon's QDir::homePath() (and so tests can point it at a tmp dir).
function voicesDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".config", "jarvis", "voices");
}

export type CloneVoice = { id: string; name: string; slug: string };

/** True for the seed "jarvice" or any "clone:<slug>" voiceId. */
export function isCloneVoiceId(voiceId: string | undefined | null): boolean {
  if (typeof voiceId !== "string") return false;
  return voiceId === JARVICE || /^clone:[a-z0-9_-]+$/i.test(voiceId);
}

/** The slug for a clone voiceId ("jarvice" -> "jarvice", "clone:foo" -> "foo"). */
function slugFor(voiceId: string): string {
  return voiceId.startsWith(CLONE_VOICE_PREFIX) ? voiceId.slice(CLONE_VOICE_PREFIX.length) : voiceId;
}

function voiceIdFor(slug: string): string {
  return slug === JARVICE ? JARVICE : `${CLONE_VOICE_PREFIX}${slug}`;
}

/** Find a clip file <slug>_ref.<ext> on disk; undefined if none. */
export function cloneClipPath(voiceId: string): string | undefined {
  const slug = slugFor(voiceId);
  const dir = voicesDir();
  for (const ext of CLIP_EXTS) {
    const p = path.join(dir, `${slug}_ref.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Read a cloned voice's reference clip as base64 for Mistral `ref_audio`.
 * undefined when no clip is on disk (the caller then falls back to a named voice,
 * so TTS never breaks).
 */
export function readCloneRefAudioBase64(voiceId: string): string | undefined {
  const p = cloneClipPath(voiceId);
  if (!p) return undefined;
  try {
    return fs.readFileSync(p).toString("base64");
  } catch {
    return undefined;
  }
}

type Manifest = {
  default?: string;
  voices?: Array<{ id?: string; name?: string; slug?: string }>;
};

/**
 * The user's named cloned voices for the picker. Reads the daemon's voices.json
 * for display names, then scans <slug>_ref.* for any clip the manifest missed
 * (e.g. one dropped in by scripts/jarvice_voice.py). Each id is the voiceId to
 * store in a profile ("jarvice" / "clone:<slug>").
 */
export function listCloneVoices(): CloneVoice[] {
  const dir = voicesDir();
  const byId = new Map<string, CloneVoice>();
  try {
    const raw = fs.readFileSync(path.join(dir, "voices.json"), "utf8");
    const m = JSON.parse(raw) as Manifest;
    for (const v of m.voices ?? []) {
      const slug = (v.slug ?? v.id ?? "").trim();
      if (!slug) continue;
      const id = voiceIdFor(slug);
      byId.set(id, { id, name: v.name?.trim() || slug, slug });
    }
  } catch {
    /* no manifest -> fall back to scanning clips below */
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [...byId.values()];
  }
  for (const fn of entries) {
    const match = /^(.+)_ref\.(mp3|wav|opus|flac|ogg)$/i.exec(fn);
    if (!match) continue;
    const slug = match[1];
    const id = voiceIdFor(slug);
    if (!byId.has(id)) byId.set(id, { id, name: slug === JARVICE ? "Jarvis" : slug, slug });
  }
  return [...byId.values()];
}
