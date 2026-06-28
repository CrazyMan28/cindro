import twilio from "twilio";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";

/**
 * Thin seam over the Twilio REST client so tests inject a fake and the SDK is
 * only instantiated when real credentials exist.
 */
export type TwilioRestApi = {
  createCall(params: Record<string, unknown>): Promise<{ sid: string }>;
  updateCall(sid: string, params: Record<string, unknown>): Promise<unknown>;
  createMessage(params: Record<string, unknown>): Promise<{ sid: string }>;
};

export type AllowlistRow = {
  id: string;
  phone_number: string;
  label: string | null;
  created_by: string | null;
  created_at: string;
};

export type TwilioCallRow = {
  id: string;
  call_id: string;
  call_sid: string;
  stream_sid: string | null;
  direction: "inbound" | "outbound";
  phone_number: string;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookRequestLike = {
  headers: Record<string, unknown>;
  body?: unknown;
  raw: { url?: string };
};

const SETTING_INBOUND_EXTENSION = "inbound_agent_extension";
const SETTING_SCREENING_AGENT_EXTENSION = "screening_agent_extension";
const SETTING_DEFAULT_USER_NUMBER = "default_user_number";
const SETTING_SCREENING_ENABLED = "screening_enabled";
const SETTING_SCREENING_TRANSPORT = "screening_transport";
const SETTING_SMS_AGENT_ENABLED = "sms_agent_enabled";
const SETTING_SMS_AGENT_EXTENSION = "sms_agent_extension";

/** Which path screened calls take: "twilio" (forward, anywhere) or "relay" (Bluetooth puck). */
export type ScreeningTransport = "twilio" | "relay";

export class TwilioService {
  private api?: TwilioRestApi;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    api?: TwilioRestApi
  ) {
    this.api = api;
  }

  get enabled(): boolean {
    return this.config.twilio.enabled;
  }

  /**
   * Normalize a phone number to E.164. Bare 10-digit (or 1-prefixed 11-digit)
   * numbers are treated as US/Canada; anything else must already carry a +.
   */
  normalizeNumber(raw: string): string {
    const trimmed = String(raw ?? "").trim();
    const hasPlus = trimmed.startsWith("+");
    const digits = trimmed.replace(/[^0-9]/g, "");
    if (hasPlus) {
      if (digits.length < 8 || digits.length > 15) throw new Error(`invalid phone number: ${raw}`);
      return `+${digits}`;
    }
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    throw new Error(`invalid phone number: ${raw} (use E.164, e.g. +15551234567)`);
  }

  // ---- allowlist -----------------------------------------------------------

  allowlistAdd(rawNumber: string, label?: string, createdBy?: string): AllowlistRow {
    const phoneNumber = this.normalizeNumber(rawNumber);
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO phone_allowlist (id, phone_number, label, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(phone_number) DO UPDATE SET label = excluded.label, created_by = excluded.created_by`
      )
      .run(this.db.id("pal"), phoneNumber, label ?? null, createdBy ?? null, now);
    return this.db.sqlite.prepare("SELECT * FROM phone_allowlist WHERE phone_number = ?").get(phoneNumber) as AllowlistRow;
  }

  allowlistRemove(rawNumber: string): boolean {
    const phoneNumber = this.normalizeNumber(rawNumber);
    return this.db.sqlite.prepare("DELETE FROM phone_allowlist WHERE phone_number = ?").run(phoneNumber).changes > 0;
  }

  allowlistList(): AllowlistRow[] {
    return this.db.sqlite.prepare("SELECT * FROM phone_allowlist ORDER BY created_at").all() as AllowlistRow[];
  }

  isAllowed(rawNumber: string): boolean {
    let phoneNumber: string;
    try {
      phoneNumber = this.normalizeNumber(rawNumber);
    } catch {
      return false;
    }
    return Boolean(this.db.sqlite.prepare("SELECT 1 FROM phone_allowlist WHERE phone_number = ?").get(phoneNumber));
  }

  // ---- settings ------------------------------------------------------------

  private getSetting(key: string): string | undefined {
    const row = this.db.sqlite.prepare("SELECT value FROM twilio_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setSetting(key: string, value: string) {
    this.db.sqlite
      .prepare(
        `INSERT INTO twilio_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, this.db.now());
  }

  getInboundExtension(): string {
    return this.getSetting(SETTING_INBOUND_EXTENSION) ?? this.config.twilio.inboundExtension;
  }

  setInboundExtension(extension: string) {
    this.setSetting(SETTING_INBOUND_EXTENSION, extension);
  }

  /**
   * Which agent SCREENS unknown callers — deliberately separate from the inbound
   * agent (who answers when YOU dial in), so choosing a screener never changes
   * who takes your own calls. Falls back to the inbound extension when unset.
   */
  getScreeningAgentExtension(): string {
    return (
      this.getSetting(SETTING_SCREENING_AGENT_EXTENSION) ??
      this.config.twilio.screeningExtension ??
      this.getInboundExtension()
    );
  }

  setScreeningAgentExtension(extension: string) {
    this.setSetting(SETTING_SCREENING_AGENT_EXTENSION, extension);
  }

  getDefaultUserNumber(): string | undefined {
    return this.getSetting(SETTING_DEFAULT_USER_NUMBER);
  }

  /** Sets the user's real phone number and allowlists it in the same step. */
  setDefaultUserNumber(rawNumber: string): string {
    const phoneNumber = this.normalizeNumber(rawNumber);
    this.setSetting(SETTING_DEFAULT_USER_NUMBER, phoneNumber);
    this.allowlistAdd(phoneNumber, "default user number");
    return phoneNumber;
  }

  /** Call screening for unknown callers. Default OFF: unknown callers are rejected. */
  getScreeningEnabled(): boolean {
    return this.getSetting(SETTING_SCREENING_ENABLED) === "true";
  }

  setScreeningEnabled(enabled: boolean) {
    this.setSetting(SETTING_SCREENING_ENABLED, enabled ? "true" : "false");
  }

  /** Active screening transport: "twilio" (default, anywhere) or "relay" (Bluetooth puck). */
  getScreeningTransport(): ScreeningTransport {
    return this.getSetting(SETTING_SCREENING_TRANSPORT) === "relay" ? "relay" : "twilio";
  }

  setScreeningTransport(transport: ScreeningTransport) {
    this.setSetting(SETTING_SCREENING_TRANSPORT, transport === "relay" ? "relay" : "twilio");
  }

  /**
   * Two-way "text your agent" over SMS. Default OFF: an inbound SMS just mirrors
   * into the user's inbox (legacy behaviour). When ON, an inbound SMS is routed
   * to the selected agent and the agent's reply is texted back to the sender.
   */
  getSmsAgentEnabled(): boolean {
    return this.getSetting(SETTING_SMS_AGENT_ENABLED) === "true";
  }

  setSmsAgentEnabled(enabled: boolean) {
    this.setSetting(SETTING_SMS_AGENT_ENABLED, enabled ? "true" : "false");
  }

  /** Which agent answers inbound SMS. Defaults to the call-screening inbound agent. */
  getSmsAgentExtension(): string {
    return this.getSetting(SETTING_SMS_AGENT_EXTENSION) ?? this.getInboundExtension();
  }

  setSmsAgentExtension(extension: string) {
    this.setSetting(SETTING_SMS_AGENT_EXTENSION, extension);
  }

  // ---- calls ---------------------------------------------------------------

  /**
   * Start an outbound PSTN call whose audio is bridged over a Twilio media
   * stream to this server. Resolves once Twilio accepts the call request.
   */
  async placeCall(input: { toNumber: string; internalCallId: string }): Promise<{ callSid: string; toNumber: string }> {
    this.assertConfigured();
    const toNumber = this.normalizeNumber(input.toNumber);
    if (!this.isAllowed(toNumber)) {
      throw new Error(`${toNumber} is not on the phone allowlist — add it with twilio_allowlist_add first`);
    }
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({ url: `${this.wssBaseUrl()}/twilio/media` });
    stream.parameter({ name: "internalCallId", value: input.internalCallId });
    stream.parameter({ name: "direction", value: "outbound" });
    const result = await this.restApi().createCall({
      to: toNumber,
      from: this.config.twilio.fromNumber,
      twiml: response.toString(),
      statusCallback: `${this.config.twilio.publicBaseUrl}/twilio/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: 45
    });
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO twilio_calls (id, call_id, call_sid, direction, phone_number, status, created_at, updated_at)
         VALUES (?, ?, ?, 'outbound', ?, 'initiated', ?, ?)`
      )
      .run(this.db.id("twc"), input.internalCallId, result.sid, toNumber, now, now);
    return { callSid: result.sid, toNumber };
  }

  recordInboundCall(callSid: string, fromNumber: string, internalCallId: string) {
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO twilio_calls (id, call_id, call_sid, direction, phone_number, status, created_at, updated_at)
         VALUES (?, ?, ?, 'inbound', ?, 'in-progress', ?, ?)
         ON CONFLICT(call_sid) DO UPDATE SET call_id = excluded.call_id, updated_at = excluded.updated_at`
      )
      .run(this.db.id("twc"), internalCallId, callSid, fromNumber, now, now);
  }

  recordCallStatus(callSid: string, status: string, error?: string) {
    this.db.sqlite
      .prepare("UPDATE twilio_calls SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE call_sid = ?")
      .run(status, error ?? null, this.db.now(), callSid);
  }

  linkStream(callSid: string, streamSid: string) {
    this.db.sqlite
      .prepare("UPDATE twilio_calls SET stream_sid = ?, updated_at = ? WHERE call_sid = ?")
      .run(streamSid, this.db.now(), callSid);
  }

  findByCallSid(callSid: string): TwilioCallRow | undefined {
    return this.db.sqlite.prepare("SELECT * FROM twilio_calls WHERE call_sid = ?").get(callSid) as TwilioCallRow | undefined;
  }

  findByInternalCallId(callId: string): TwilioCallRow | undefined {
    return this.db.sqlite
      .prepare("SELECT * FROM twilio_calls WHERE call_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(callId) as TwilioCallRow | undefined;
  }

  async hangup(callSid: string): Promise<void> {
    this.assertConfigured();
    await this.restApi().updateCall(callSid, { status: "completed" });
  }

  /**
   * Replace a LIVE call's TwiML with a <Dial> to the user's real phone — the
   * screening take-over. Twilio bridges the caller to the dialed number; the
   * media stream (agent leg) receives `stop` and ends.
   */
  async redirectToDial(callSid: string, toNumber: string): Promise<void> {
    this.assertConfigured();
    const normalized = this.normalizeNumber(toNumber);
    const response = new twilio.twiml.VoiceResponse();
    response.say("One moment.");
    const dial = response.dial({
      answerOnBridge: true,
      // Under the typical 20-25s carrier no-reply timer so an unanswered
      // take-over can't loop back through call forwarding.
      timeout: 15,
      callerId: this.config.twilio.fromNumber,
      action: `${this.config.twilio.publicBaseUrl}/twilio/takeover-status`,
      method: "POST"
    });
    dial.number(normalized);
    await this.restApi().updateCall(callSid, { twiml: response.toString() });
  }

  // ---- sms -----------------------------------------------------------------

  async sendSms(input: { toNumber: string; body: string; messageId?: string }): Promise<{ sid: string; toNumber: string }> {
    this.assertConfigured();
    const toNumber = this.normalizeNumber(input.toNumber);
    if (!this.isAllowed(toNumber)) {
      throw new Error(`${toNumber} is not on the phone allowlist — add it with twilio_allowlist_add first`);
    }
    const result = await this.restApi().createMessage({
      to: toNumber,
      from: this.config.twilio.fromNumber,
      body: input.body
    });
    this.db.sqlite
      .prepare(
        `INSERT INTO twilio_sms (id, sid, direction, phone_number, body, status, message_id, created_at)
         VALUES (?, ?, 'outbound', ?, ?, 'sent', ?, ?)`
      )
      .run(this.db.id("sms"), result.sid, toNumber, input.body, input.messageId ?? null, this.db.now());
    return { sid: result.sid, toNumber };
  }

  recordInboundSms(sid: string, fromNumber: string, body: string, messageId?: string) {
    this.db.sqlite
      .prepare(
        `INSERT INTO twilio_sms (id, sid, direction, phone_number, body, status, message_id, created_at)
         VALUES (?, ?, 'inbound', ?, ?, 'received', ?, ?)`
      )
      .run(this.db.id("sms"), sid, fromNumber, body, messageId ?? null, this.db.now());
  }

  // ---- webhooks ------------------------------------------------------------

  /**
   * Validate X-Twilio-Signature against the PUBLIC url (funnel hostname), not
   * the local Host header — Twilio signed what it sent to the public URL.
   */
  validateWebhook(request: WebhookRequestLike): boolean {
    if (!this.config.twilio.validateSignatures) return true;
    const signature = String(request.headers["x-twilio-signature"] ?? "");
    if (!signature || !this.config.twilio.authToken) return false;
    const url = `${this.config.twilio.publicBaseUrl}${request.raw.url ?? ""}`;
    const params = (request.body ?? {}) as Record<string, string>;
    return twilio.validateRequest(this.config.twilio.authToken, signature, url, params);
  }

  /** Redacted config + runtime summary for the twilio_status tool / boot log. */
  summary() {
    return {
      configured: this.enabled,
      from_number: this.config.twilio.fromNumber || null,
      public_base_url: this.config.twilio.publicBaseUrl || null,
      validate_signatures: this.config.twilio.validateSignatures,
      inbound_extension: this.getInboundExtension(),
      screening_extension: this.getScreeningAgentExtension(),
      default_user_number: this.getDefaultUserNumber() ?? null,
      allowlist_count: this.allowlistList().length,
      screening_enabled: this.getScreeningEnabled(),
      sms_agent_enabled: this.getSmsAgentEnabled(),
      sms_agent_extension: this.getSmsAgentExtension()
    };
  }

  // ---- internals -----------------------------------------------------------

  private assertConfigured() {
    if (!this.enabled) {
      throw new Error(
        "twilio_not_configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and TWILIO_PUBLIC_BASE_URL in .env"
      );
    }
  }

  private wssBaseUrl(): string {
    return this.config.twilio.publicBaseUrl.replace(/^http/, "ws");
  }

  private restApi(): TwilioRestApi {
    if (!this.api) {
      const client = twilio(this.config.twilio.accountSid, this.config.twilio.authToken);
      this.api = {
        createCall: (params) => client.calls.create(params as unknown as Parameters<typeof client.calls.create>[0]),
        updateCall: (sid, params) => client.calls(sid).update(params as unknown as Parameters<ReturnType<typeof client.calls>["update"]>[0]),
        createMessage: (params) => client.messages.create(params as unknown as Parameters<typeof client.messages.create>[0])
      };
    }
    return this.api;
  }
}
