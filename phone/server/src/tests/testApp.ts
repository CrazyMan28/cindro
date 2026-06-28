import { vi } from "vitest";
import { loadConfig } from "../config.js";
import { createApp } from "../app.js";
import { ExtensionService } from "../extensions/extensionService.js";
import type { TwilioRestApi } from "../twilio/twilioService.js";

export function makeFakeTwilioApi(): TwilioRestApi {
  let counter = 0;
  return {
    createCall: vi.fn(async () => ({ sid: `CA_test_${++counter}` })),
    updateCall: vi.fn(async () => ({})),
    createMessage: vi.fn(async () => ({ sid: `SM_test_${++counter}` }))
  };
}

export async function makeTestApp(options: { twilioApi?: TwilioRestApi; env?: Record<string, string> } = {}) {
  // Tests should not auto-seed agents from agents.config.json (that file ships
  // with default extensions for 103/104/105/106 which would shift the
  // extension/agent counts asserted by setup.test.ts and others). Point the
  // loader at a non-existent file so it returns an empty registry.
  process.env.AGENTS_CONFIG_PATH = "/tmp/agents-config-does-not-exist-in-tests.json";

  const config = loadConfig({
    DATABASE_URL: "file::memory:",
    ADMIN_TOKEN: "admin-token-test",
    DEVICE_TOKEN: "device-token-test",
    AGENT_TOKEN: "agent-token-test",
    LOG_LEVEL: "silent",
    MISTRAL_REAL_AUDIO: "false",
    MISTRAL_ENABLE_REAL_CALLS: "false",
    MISTRAL_API_KEY: "",
    // Twilio is "configured" with fake credentials so the tools are exercisable,
    // but the REST seam is always a fake — and these overrides also stop real
    // values leaking out of the developer's .env into test runs.
    TWILIO_ACCOUNT_SID: "ACtest00000000000000000000000000",
    TWILIO_AUTH_TOKEN: "test-auth-token",
    TWILIO_FROM_NUMBER: "+15550001111",
    TWILIO_PUBLIC_BASE_URL: "https://example.ts.net",
    TWILIO_INBOUND_EXTENSION: "101",
    // Pin so the developer's .env (which sets a real screener ext) can't leak in
    // and make screening tests dial an extension with no connected test agent.
    TWILIO_SCREENING_EXTENSION: "101",
    TWILIO_VALIDATE_SIGNATURES: "false",
    ...options.env
  });
  const twilioApi = options.twilioApi ?? makeFakeTwilioApi();
  const built = await createApp(config, { twilioApi });
  new ExtensionService(built.services.db).seedDefaults();
  return { ...built, config, twilioApi };
}

export const authHeaders = {
  admin: { authorization: "Bearer admin-token-test" },
  device: { authorization: "Bearer device-token-test" },
  agent: { authorization: "Bearer agent-token-test" }
};
