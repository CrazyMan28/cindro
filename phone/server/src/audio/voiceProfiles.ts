import type { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";

/**
 * Per-extension voice profile (feature: "different voices for different
 * extensions / people, and how fast they talk"). Stored in the extension's
 * `metadata.voice` so every agent/person can sound distinct on a call. A profile
 * is optional — when absent, synthesis falls back to the global config voice.
 */
export type VoiceProfile = {
  /** Mistral voice UUID (from /v1/audio/voices). */
  voiceId?: string;
  /** Speaking-rate multiplier (1 = normal, >1 faster, <1 slower). */
  speed?: number;
  /** Friendly preset name for display (e.g. "Jarvis", "Oliver"). */
  name?: string;
};

export type VoiceProfilePatch = {
  voiceId?: string | null;
  speed?: number | null;
  name?: string | null;
};

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
/** Mistral TTS only accepts voice UUIDs (same check as mistral/tts.ts isUuid). */
export const VOICE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class VoiceProfileService {
  private readonly extensions: ExtensionService;

  constructor(private readonly db: AppDatabase) {
    this.extensions = new ExtensionService(db);
  }

  /** Resolve the stored profile for an extension (empty object if none). */
  get(extension: string): VoiceProfile {
    const row = this.extensions.get(extension);
    if (!row) return {};
    const metadata = this.db.parseJson<Record<string, unknown>>(row.metadata, {});
    const voice = (metadata.voice ?? {}) as Record<string, unknown>;
    const profile: VoiceProfile = {};
    if (typeof voice.voiceId === "string" && voice.voiceId) profile.voiceId = voice.voiceId;
    if (typeof voice.speed === "number" && Number.isFinite(voice.speed)) profile.speed = voice.speed;
    if (typeof voice.name === "string" && voice.name) profile.name = voice.name;
    return profile;
  }

  /**
   * Merge a patch into an extension's voice profile. Passing `null` for a field
   * clears it. Returns the resulting profile, or undefined if the extension is
   * unknown.
   */
  set(extension: string, patch: VoiceProfilePatch): VoiceProfile | undefined {
    const row = this.extensions.get(extension);
    if (!row) return undefined;
    const metadata = this.db.parseJson<Record<string, unknown>>(row.metadata, {});
    const current = (metadata.voice ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current };

    if (patch.voiceId !== undefined) {
      if (patch.voiceId === null || patch.voiceId === "") delete next.voiceId;
      else if (/^local:[a-z0-9_-]+$/i.test(patch.voiceId)) next.voiceId = patch.voiceId; // on-device model
      else if (!VOICE_UUID_RE.test(patch.voiceId)) {
        // Reject at SET time — a malformed id persisted here would make every
        // subsequent TTS call from this extension fail (tts_synthesis_failed),
        // silently bricking voice calls until someone clears the profile.
        throw Object.assign(
          new Error("voiceId must be a Mistral voice UUID (pick one from GET /api/voices), not a display name"),
          { statusCode: 400 }
        );
      } else next.voiceId = patch.voiceId;
    }
    if (patch.speed !== undefined) {
      if (patch.speed === null) delete next.speed;
      else next.speed = clampSpeed(patch.speed);
    }
    if (patch.name !== undefined) {
      if (patch.name === null || patch.name === "") delete next.name;
      else next.name = patch.name;
    }

    this.extensions.update(extension, { metadata: { ...metadata, voice: next } });
    return this.get(extension);
  }
}

export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}
