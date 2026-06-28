import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { MistralClient } from "../mistral/client.js";

describe("Mistral client", () => {
  it("uses mock STT/TTS only when explicitly configured for tests", async () => {
    const config = loadConfig({
      MISTRAL_REAL_AUDIO: "false",
      MISTRAL_ENABLE_REAL_CALLS: "false",
      MISTRAL_API_KEY: "",
      ADMIN_TOKEN: "admin-token-test",
      DEVICE_TOKEN: "device-token-test",
      AGENT_TOKEN: "agent-token-test"
    });
    const client = new MistralClient(config.mistral);
    const stt = await client.speechToTextOffline(Buffer.from("hello by voice"), { format: "wav" });
    expect(stt).toEqual(expect.objectContaining({ text: "hello by voice", mock: true }));
    const tts = await client.textToSpeech("hello", { responseFormat: "wav" });
    expect(tts.audio.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("throws a useful error when real calls are enabled without a key", async () => {
    const config = loadConfig({
      MISTRAL_REAL_AUDIO: "true",
      MISTRAL_ENABLE_REAL_CALLS: "true",
      MISTRAL_API_KEY: "replace-me",
      ADMIN_TOKEN: "admin-token-test",
      DEVICE_TOKEN: "device-token-test",
      AGENT_TOKEN: "agent-token-test"
    });
    const client = new MistralClient(config.mistral);
    await expect(client.textToSpeech("hello")).rejects.toThrow(/MISTRAL_API_KEY/);
  });
});
