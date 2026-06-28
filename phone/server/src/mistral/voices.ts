import type { AppConfig } from "../config.js";

export type VoiceOption = { id: string | null; name: string };

/**
 * Fallback catalog when the live voice list can't be fetched (mock audio mode,
 * no API key, or the endpoint is unavailable). "Default" (id: null) clears the
 * per-extension override so the global MISTRAL_TTS_VOICE_ID applies.
 */
function fallbackVoices(config: AppConfig["mistral"]): VoiceOption[] {
  const list: VoiceOption[] = [{ id: null, name: "Default" }];
  if (config.voiceId) list.push({ id: config.voiceId, name: "Server default voice" });
  return list;
}

let cached: VoiceOption[] | null = null;

/**
 * Voice catalog for the per-agent voice picker. Proxies Mistral's
 * GET /v1/audio/voices (ids there are the UUIDs the TTS API requires), cached
 * in-memory for the process lifetime; falls back to a minimal list on any
 * failure so the picker always renders.
 */
export async function listVoices(config: AppConfig["mistral"], fetchImpl: typeof fetch = fetch): Promise<VoiceOption[]> {
  if (cached) return cached;
  if (!config.realAudio || !config.apiKey) return fallbackVoices(config);
  try {
    // limit=100: the endpoint paginates (default page size 10) — without it the
    // picker only saw the first page of the 30-voice preset catalog.
    const response = await fetchImpl(`${config.baseUrl}/audio/voices?limit=100`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }
    });
    if (!response.ok) return fallbackVoices(config);
    const payload = (await response.json()) as unknown;
    // Mistral's GET /v1/audio/voices returns { items: [{id, name, ...}], page, ... }
    // (verified against docs.mistral.ai). data/voices kept as fallbacks.
    const rows: unknown[] = Array.isArray((payload as { items?: unknown[] })?.items)
      ? (payload as { items: unknown[] }).items
      : Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { data?: unknown[] })?.data)
          ? (payload as { data: unknown[] }).data
          : Array.isArray((payload as { voices?: unknown[] })?.voices)
            ? (payload as { voices: unknown[] }).voices
            : [];
    const voices = rows
      .map((row) => {
        const v = row as Record<string, unknown>;
        return {
          id: String(v.id ?? v.voice_id ?? ""),
          name: String(v.name ?? v.display_name ?? v.id ?? "")
        };
      })
      .filter((v) => v.id);
    if (voices.length === 0) return fallbackVoices(config);
    cached = [{ id: null, name: "Default" }, ...voices];
    return cached;
  } catch {
    return fallbackVoices(config);
  }
}

/** Test-only: drop the in-memory catalog cache. */
export function clearVoiceCache(): void {
  cached = null;
}

const sampleCache = new Map<string, { bytes: Buffer; contentType: string }>();

/**
 * Preview audio for a voice (Mistral GET /v1/audio/voices/{id}/sample),
 * cached in-memory — samples are static and the picker may preview many.
 * Returns null when unavailable (mock mode, no key, unknown voice).
 */
export async function fetchVoiceSample(
  config: AppConfig["mistral"],
  voiceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const hit = sampleCache.get(voiceId);
  if (hit) return hit;
  if (!config.realAudio || !config.apiKey) return null;
  try {
    const response = await fetchImpl(`${config.baseUrl}/audio/voices/${encodeURIComponent(voiceId)}/sample`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return null;
    const entry = { bytes, contentType: response.headers.get("content-type") ?? "audio/mpeg" };
    sampleCache.set(voiceId, entry);
    return entry;
  } catch {
    return null;
  }
}
