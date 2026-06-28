import type { AppConfig } from "../config.js";
import { MistralApiError } from "./errors.js";

export type MistralModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  capabilities?: Record<string, unknown>;
};

export async function listMistralModels(config: AppConfig["mistral"], fetchImpl: typeof fetch = fetch): Promise<MistralModel[]> {
  const response = await fetchImpl(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) {
    throw new MistralApiError(`Mistral models request failed with ${response.status}`, response.status, await response.text().catch(() => ""));
  }
  const json = (await response.json()) as { data?: MistralModel[] };
  return json.data ?? [];
}

export function likelyAudioModels(models: MistralModel[]) {
  return models.filter((model) => /voxtral|audio|speech|transcrib|tts/i.test(model.id));
}
