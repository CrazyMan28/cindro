import { describe, expect, test, vi } from "vitest";
import twilio from "twilio";
import { loadConfig } from "../config.js";
import { AppDatabase } from "../db/database.js";
import { TwilioService, type TwilioRestApi } from "../twilio/twilioService.js";

const TEST_AUTH_TOKEN = "test-auth-token";

function makeService(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    DATABASE_URL: "file::memory:",
    LOG_LEVEL: "silent",
    MISTRAL_REAL_AUDIO: "false",
    MISTRAL_API_KEY: "",
    TWILIO_ACCOUNT_SID: "ACtest00000000000000000000000000",
    TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
    TWILIO_FROM_NUMBER: "+15550001111",
    TWILIO_PUBLIC_BASE_URL: "https://example.ts.net",
    TWILIO_INBOUND_EXTENSION: "101",
    TWILIO_VALIDATE_SIGNATURES: "true",
    ...overrides
  });
  const db = new AppDatabase("file::memory:");
  const api: TwilioRestApi = {
    createCall: vi.fn(async () => ({ sid: "CA_test_call" })),
    updateCall: vi.fn(async () => ({})),
    createMessage: vi.fn(async () => ({ sid: "SM_test_msg" }))
  };
  const service = new TwilioService(db, config, api);
  return { service, api, db, config };
}

describe("normalizeNumber", () => {
  test("US 10-digit gets +1", () => {
    const { service } = makeService();
    expect(service.normalizeNumber("8449040251")).toBe("+18449040251");
  });

  test("formatting characters are stripped", () => {
    const { service } = makeService();
    expect(service.normalizeNumber("(844) 904-0251")).toBe("+18449040251");
    expect(service.normalizeNumber("1 844 904 0251")).toBe("+18449040251");
  });

  test("E.164 passes through", () => {
    const { service } = makeService();
    expect(service.normalizeNumber("+18449040251")).toBe("+18449040251");
    expect(service.normalizeNumber("+447911123456")).toBe("+447911123456");
  });

  test("garbage throws", () => {
    const { service } = makeService();
    expect(() => service.normalizeNumber("not a number")).toThrow();
    expect(() => service.normalizeNumber("")).toThrow();
    expect(() => service.normalizeNumber("12345")).toThrow();
  });
});

describe("allowlist", () => {
  test("add, list, check, remove round-trip with normalization", () => {
    const { service } = makeService();
    expect(service.isAllowed("+18449040251")).toBe(false);
    service.allowlistAdd("844-904-0251", "Kizek");
    expect(service.isAllowed("+18449040251")).toBe(true);
    expect(service.isAllowed("(844) 904-0251")).toBe(true);
    const list = service.allowlistList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ phone_number: "+18449040251", label: "Kizek" });
    expect(service.allowlistRemove("8449040251")).toBe(true);
    expect(service.isAllowed("+18449040251")).toBe(false);
  });

  test("duplicate add updates instead of duplicating", () => {
    const { service } = makeService();
    service.allowlistAdd("+18449040251", "first");
    service.allowlistAdd("8449040251", "second");
    const list = service.allowlistList();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("second");
  });
});

describe("settings", () => {
  test("inbound extension defaults to config and is settable", () => {
    const { service } = makeService();
    expect(service.getInboundExtension()).toBe("101");
    service.setInboundExtension("103");
    expect(service.getInboundExtension()).toBe("103");
  });

  test("default user number is normalized and auto-allowlisted", () => {
    const { service } = makeService();
    expect(service.getDefaultUserNumber()).toBeUndefined();
    service.setDefaultUserNumber("844 904 0251");
    expect(service.getDefaultUserNumber()).toBe("+18449040251");
    expect(service.isAllowed("+18449040251")).toBe(true);
  });
});

describe("placeCall", () => {
  test("creates a Twilio call with media-stream TwiML and records it", async () => {
    const { service, api, db } = makeService();
    service.allowlistAdd("+18449040251");
    const result = await service.placeCall({ toNumber: "8449040251", internalCallId: "call_abc" });
    expect(result.callSid).toBe("CA_test_call");
    const params = (api.createCall as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, string>;
    expect(params.to).toBe("+18449040251");
    expect(params.from).toBe("+15550001111");
    expect(params.twiml).toContain("<Connect>");
    expect(params.twiml).toContain("wss://example.ts.net/twilio/media");
    expect(params.twiml).toContain("internalCallId");
    expect(params.twiml).toContain("call_abc");
    expect(params.statusCallback).toBe("https://example.ts.net/twilio/status");
    const row = db.sqlite.prepare("SELECT * FROM twilio_calls WHERE call_sid = ?").get("CA_test_call") as Record<string, unknown>;
    expect(row).toMatchObject({ call_id: "call_abc", direction: "outbound", phone_number: "+18449040251" });
  });

  test("refuses numbers not on the allowlist", async () => {
    const { service, api } = makeService();
    await expect(service.placeCall({ toNumber: "+15559999999", internalCallId: "call_x" })).rejects.toThrow(/allowlist/);
    expect(api.createCall).not.toHaveBeenCalled();
  });

  test("refuses when twilio is not configured", async () => {
    const { service } = makeService({ TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "" });
    await expect(service.placeCall({ toNumber: "+18449040251", internalCallId: "c" })).rejects.toThrow(/twilio_not_configured/);
  });
});

describe("hangup", () => {
  test("completes the call via the REST api", async () => {
    const { service, api } = makeService();
    await service.hangup("CA_test_call");
    expect(api.updateCall).toHaveBeenCalledWith("CA_test_call", { status: "completed" });
  });
});

describe("sendSms", () => {
  test("sends to an allowlisted number and records it", async () => {
    const { service, api, db } = makeService();
    service.allowlistAdd("+18449040251");
    const result = await service.sendSms({ toNumber: "8449040251", body: "build done" });
    expect(result.sid).toBe("SM_test_msg");
    expect(api.createMessage).toHaveBeenCalledWith({ to: "+18449040251", from: "+15550001111", body: "build done" });
    const row = db.sqlite.prepare("SELECT * FROM twilio_sms WHERE sid = ?").get("SM_test_msg") as Record<string, unknown>;
    expect(row).toMatchObject({ direction: "outbound", phone_number: "+18449040251", body: "build done" });
  });

  test("refuses non-allowlisted numbers", async () => {
    const { service, api } = makeService();
    await expect(service.sendSms({ toNumber: "+15559999999", body: "x" })).rejects.toThrow(/allowlist/);
    expect(api.createMessage).not.toHaveBeenCalled();
  });
});

describe("call records", () => {
  test("status updates and stream linking round-trip", async () => {
    const { service } = makeService();
    service.allowlistAdd("+18449040251");
    await service.placeCall({ toNumber: "+18449040251", internalCallId: "call_abc" });
    service.recordCallStatus("CA_test_call", "in-progress");
    service.linkStream("CA_test_call", "MZ_stream_1");
    const row = service.findByCallSid("CA_test_call");
    expect(row).toMatchObject({ status: "in-progress", stream_sid: "MZ_stream_1", call_id: "call_abc" });
  });

  test("inbound calls can be recorded", () => {
    const { service } = makeService();
    service.recordInboundCall("CA_inbound", "+18449040251", "call_in_1");
    expect(service.findByCallSid("CA_inbound")).toMatchObject({
      direction: "inbound",
      phone_number: "+18449040251",
      call_id: "call_in_1"
    });
  });
});

describe("validateWebhook", () => {
  function signedRequest(url: string, params: Record<string, string>) {
    const signature = twilio.getExpectedTwilioSignature(TEST_AUTH_TOKEN, `https://example.ts.net${url}`, params);
    return { headers: { "x-twilio-signature": signature }, body: params, raw: { url } };
  }

  test("accepts a correctly signed request", () => {
    const { service } = makeService();
    const request = signedRequest("/twilio/voice", { CallSid: "CA1", From: "+18449040251" });
    expect(service.validateWebhook(request)).toBe(true);
  });

  test("rejects a bad signature", () => {
    const { service } = makeService();
    const request = {
      headers: { "x-twilio-signature": "bogus" },
      body: { CallSid: "CA1" },
      raw: { url: "/twilio/voice" }
    };
    expect(service.validateWebhook(request)).toBe(false);
  });

  test("rejects a signed request whose params were tampered with", () => {
    const { service } = makeService();
    const request = signedRequest("/twilio/voice", { CallSid: "CA1" });
    (request.body as Record<string, string>).CallSid = "CA2";
    expect(service.validateWebhook(request)).toBe(false);
  });

  test("passes everything when validation is disabled", () => {
    const { service } = makeService({ TWILIO_VALIDATE_SIGNATURES: "false" });
    expect(service.validateWebhook({ headers: {}, body: {}, raw: { url: "/twilio/voice" } })).toBe(true);
  });
});

describe("inbound vs screening agent extensions", () => {
  test("the screening agent is independent of the inbound agent", () => {
    const { service } = makeService({ TWILIO_INBOUND_EXTENSION: "101", TWILIO_SCREENING_EXTENSION: "107" });
    expect(service.getInboundExtension()).toBe("101");
    expect(service.getScreeningAgentExtension()).toBe("107");
  });

  test("screening falls back to the inbound agent when its own ext is unset", () => {
    const { service } = makeService({ TWILIO_INBOUND_EXTENSION: "105", TWILIO_SCREENING_EXTENSION: "" });
    expect(service.getScreeningAgentExtension()).toBe("105");
  });

  test("choosing a screening agent never changes who answers when YOU call in", () => {
    const { service } = makeService({ TWILIO_INBOUND_EXTENSION: "101", TWILIO_SCREENING_EXTENSION: "101" });
    service.setScreeningAgentExtension("107");
    expect(service.getScreeningAgentExtension()).toBe("107");
    expect(service.getInboundExtension()).toBe("101");
  });
});
