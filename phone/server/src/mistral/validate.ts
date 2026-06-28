import type { AppConfig } from "../config.js";
import { MistralConfigError } from "./errors.js";
import { likelyAudioModels, listMistralModels } from "./models.js";

export type MistralValidationResult = {
  ok: boolean;
  realAudio: boolean;
  apiKeyConfigured: boolean;
  sttModel: string;
  ttsModel: string;
  likelyAudioModelIds?: string[];
};

export async function validateMistralConfig(
  config: AppConfig["mistral"],
  options: { verifyModels?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<MistralValidationResult> {
  if (!config.realAudio) {
    return {
      ok: true,
      realAudio: false,
      apiKeyConfigured: Boolean(config.apiKey),
      sttModel: config.sttModel,
      ttsModel: config.ttsModel
    };
  }
  if (!config.apiKey || config.apiKey === "replace-me") {
    throw new MistralConfigError("MISTRAL_REAL_AUDIO=true requires MISTRAL_API_KEY. Run ./scripts/setup-mistral.sh.");
  }
  if (!config.sttModel) {
    throw new MistralConfigError("MISTRAL_STT_MODEL is required for real Mistral STT. Run ./scripts/setup-mistral.sh.");
  }
  if (!config.ttsModel) {
    throw new MistralConfigError("MISTRAL_TTS_MODEL is required for real Mistral TTS. Run ./scripts/setup-mistral.sh.");
  }
  if (options.verifyModels) {
    const models = await listMistralModels(config, options.fetchImpl ?? fetch);
    return {
      ok: true,
      realAudio: true,
      apiKeyConfigured: true,
      sttModel: config.sttModel,
      ttsModel: config.ttsModel,
      likelyAudioModelIds: likelyAudioModels(models).map((model) => model.id)
    };
  }
  return {
    ok: true,
    realAudio: true,
    apiKeyConfigured: true,
    sttModel: config.sttModel,
    ttsModel: config.ttsModel
  };
}
