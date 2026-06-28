import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = process.env.AGENT_PHONE_ENV_FILE ?? path.join(repoRoot, ".env");
if (process.env.AGENT_PHONE_SKIP_DOTENV !== "true") {
  dotenv.config({ path: envFile, override: false });
}

const EnvSchema = z.object({
  SERVER_HOST: z.string().default("127.0.0.1").transform((value) => value.trim()),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8799),
  PUBLIC_BASE_URL: z.string().transform((value) => value.trim()).pipe(z.string().url()).optional(),
  DATABASE_URL: z.string().default("file:./agent-phone.sqlite").transform((value) => value.trim()),
  ADMIN_TOKEN: z.string().min(8).default("change-me-admin-token"),
  DEVICE_TOKEN: z.string().min(8).default("change-me-device-token"),
  AGENT_TOKEN: z.string().min(8).default("change-me-agent-token"),
  MISTRAL_API_KEY: z.string().optional().default("").transform((value) => value.trim()),
  MISTRAL_STT_MODEL: z.string().default("").transform((value) => value.trim()),
  MISTRAL_TTS_MODEL: z.string().default("").transform((value) => value.trim()),
  MISTRAL_TTS_VOICE_ID: z.string().optional().default("").transform((value) => value.trim()),
  MISTRAL_REAL_AUDIO: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  MISTRAL_ENABLE_REAL_CALLS: z.string().optional(),
  MISTRAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MISTRAL_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  MISTRAL_AUDIO_FORMAT: z.enum(["pcm", "wav", "mp3", "flac", "opus"]).default("mp3"),
  MISTRAL_STT_LANGUAGE: z.string().default("en").transform((value) => value.trim()),
  MISTRAL_TTS_SAMPLE_RATE: z.coerce.number().int().positive().optional(),
  DEBUG_AUDIO: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  AUDIO_STORE_RAW: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  PRODUCTION_MODE: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  TAILSCALE_ONLY: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  ENABLE_LEGACY_COMMANDS_PULL_NOOP: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  LOG_LEVEL: z.string().default("info"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  AGENT_HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),
  TWILIO_ACCOUNT_SID: z.string().optional().default("").transform((value) => value.trim()),
  TWILIO_AUTH_TOKEN: z.string().optional().default("").transform((value) => value.trim()),
  TWILIO_FROM_NUMBER: z.string().optional().default("").transform((value) => value.trim()),
  TWILIO_PUBLIC_BASE_URL: z
    .string()
    .optional()
    .default("")
    .transform((value) => value.trim().replace(/\/+$/, "")),
  TWILIO_INBOUND_EXTENSION: z.string().default("101").transform((value) => value.trim()),
  // Who screens UNKNOWN callers. Separate from the inbound agent (who answers
  // when YOU dial in) so picking a screener never changes who takes your calls.
  // Unset → falls back to the inbound extension (back-compat).
  TWILIO_SCREENING_EXTENSION: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  TWILIO_VALIDATE_SIGNATURES: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true")
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const parsed = EnvSchema.parse({ ...process.env, ...overrides });
  const publicBaseUrl = parsed.PUBLIC_BASE_URL ?? `http://${parsed.SERVER_HOST}:${parsed.SERVER_PORT}`;
  const realAudio = parsed.MISTRAL_REAL_AUDIO;
  assertProductionSafety(parsed.PRODUCTION_MODE, parsed.ADMIN_TOKEN, parsed.DEVICE_TOKEN, parsed.AGENT_TOKEN);
  return {
    envFile,
    productionMode: parsed.PRODUCTION_MODE,
    server: {
      host: parsed.SERVER_HOST,
      port: parsed.SERVER_PORT,
      publicBaseUrl
    },
    databaseUrl: parsed.DATABASE_URL,
    auth: {
      adminToken: parsed.ADMIN_TOKEN,
      deviceToken: parsed.DEVICE_TOKEN,
      agentToken: parsed.AGENT_TOKEN
    },
    mistral: {
      apiKey: parsed.MISTRAL_API_KEY,
      sttModel: parsed.MISTRAL_STT_MODEL,
      ttsModel: parsed.MISTRAL_TTS_MODEL,
      voiceId: parsed.MISTRAL_TTS_VOICE_ID || undefined,
      realAudio,
      enableRealCalls: realAudio,
      timeoutMs: parsed.MISTRAL_TIMEOUT_MS,
      maxRetries: parsed.MISTRAL_MAX_RETRIES,
      audioFormat: parsed.MISTRAL_AUDIO_FORMAT,
      sttLanguage: parsed.MISTRAL_STT_LANGUAGE,
      ttsSampleRate: parsed.MISTRAL_TTS_SAMPLE_RATE,
      debugAudio: parsed.DEBUG_AUDIO,
      baseUrl: "https://api.mistral.ai/v1"
    },
    audio: {
      storeRaw: parsed.AUDIO_STORE_RAW
    },
    tailscaleOnly: parsed.TAILSCALE_ONLY,
    legacyCommandsPullNoop: parsed.ENABLE_LEGACY_COMMANDS_PULL_NOOP,
    rateLimit: {
      max: parsed.RATE_LIMIT_MAX,
      window: parsed.RATE_LIMIT_WINDOW
    },
    agentHeartbeatTimeoutSeconds: parsed.AGENT_HEARTBEAT_TIMEOUT_SECONDS,
    logLevel: parsed.LOG_LEVEL,
    twilio: {
      accountSid: parsed.TWILIO_ACCOUNT_SID,
      authToken: parsed.TWILIO_AUTH_TOKEN,
      fromNumber: parsed.TWILIO_FROM_NUMBER,
      publicBaseUrl: parsed.TWILIO_PUBLIC_BASE_URL,
      inboundExtension: parsed.TWILIO_INBOUND_EXTENSION,
      screeningExtension: parsed.TWILIO_SCREENING_EXTENSION,
      validateSignatures: parsed.TWILIO_VALIDATE_SIGNATURES,
      enabled: Boolean(
        parsed.TWILIO_ACCOUNT_SID &&
          parsed.TWILIO_AUTH_TOKEN &&
          parsed.TWILIO_FROM_NUMBER &&
          parsed.TWILIO_PUBLIC_BASE_URL
      )
    }
  };
}

export function safeConfigForLog(config: AppConfig) {
  return {
    envFile: config.envFile,
    productionMode: config.productionMode,
    server: config.server,
    databaseUrl: config.databaseUrl,
    tailscaleOnly: config.tailscaleOnly,
    mistral: {
      realAudio: config.mistral.realAudio,
      sttModel: config.mistral.sttModel || "(not set)",
      ttsModel: config.mistral.ttsModel || "(not set)",
      voiceConfigured: Boolean(config.mistral.voiceId),
      apiKeyConfigured: Boolean(config.mistral.apiKey && config.mistral.apiKey !== "replace-me"),
      timeoutMs: config.mistral.timeoutMs,
      maxRetries: config.mistral.maxRetries,
      audioFormat: config.mistral.audioFormat,
      sttLanguage: config.mistral.sttLanguage,
      debugAudio: config.mistral.debugAudio
    },
    rateLimit: config.rateLimit,
    agentHeartbeatTimeoutSeconds: config.agentHeartbeatTimeoutSeconds,
    twilio: {
      enabled: config.twilio.enabled,
      fromNumber: config.twilio.fromNumber || "(not set)",
      publicBaseUrl: config.twilio.publicBaseUrl || "(not set)",
      inboundExtension: config.twilio.inboundExtension,
      validateSignatures: config.twilio.validateSignatures,
      accountSidConfigured: Boolean(config.twilio.accountSid),
      authTokenConfigured: Boolean(config.twilio.authToken)
    }
  };
}

function assertProductionSafety(production: boolean, adminToken: string, deviceToken: string, agentToken: string) {
  if (!production) return;
  const defaults = new Set(["change-me-admin-token", "change-me-device-token", "change-me-agent-token"]);
  const weak = [
    ["ADMIN_TOKEN", adminToken],
    ["DEVICE_TOKEN", deviceToken],
    ["AGENT_TOKEN", agentToken]
  ].filter(([, token]) => defaults.has(token) || token.length < 32);
  if (weak.length > 0) {
    throw new Error(
      `PRODUCTION_MODE=true requires strong non-default tokens for: ${weak.map(([name]) => name).join(", ")}. Run ./scripts/rotate-tokens.sh.`
    );
  }
}
