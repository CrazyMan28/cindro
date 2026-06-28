import type { FastifyInstance } from "fastify";
import twilioSdk from "twilio";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import type { WebSocketHub } from "../websocket/hub.js";
import type { TwilioService } from "./twilioService.js";
import type { TwilioBridge } from "./twilioBridge.js";
import type { ScreeningService } from "./screeningService.js";
import { PSTN_EXTENSION } from "./twilioBridge.js";

const REJECT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/**
 * Public webhook surface for Twilio. These three routes are the ONLY paths
 * exposed to the internet (via `tailscale funnel --set-path /twilio`), so every
 * handler validates X-Twilio-Signature before trusting anything in the body.
 */
export function registerTwilioRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase,
  twilio: TwilioService,
  bridge: TwilioBridge,
  wsHub: WebSocketHub,
  screening?: ScreeningService
) {
  const audit = (action: string, target: string, success: boolean, metadata: Record<string, unknown>) => {
    try {
      db.sqlite
        .prepare("INSERT INTO audit_logs (id, actor, action, target, success, metadata, created_at) VALUES (?, 'twilio', ?, ?, ?, ?, ?)")
        .run(db.id("audit"), action, target, success ? 1 : 0, db.json(metadata), db.now());
    } catch { /* auditing must never break call handling */ }
  };

  // Inbound voice call: user dialed the Twilio number. Answer fast (<15s Twilio
  // webhook deadline) with TwiML that opens the media stream; the agent dial
  // happens when the stream's `start` frame arrives at the bridge.
  app.post("/twilio/voice", async (request, reply) => {
    if (!twilio.validateWebhook(request)) {
      audit("twilio.voice", "signature", false, { ip: request.ip });
      return reply.code(403).send("invalid signature");
    }
    const body = (request.body ?? {}) as Record<string, string>;
    const from = body.From ?? "";
    const callSid = body.CallSid ?? "";
    reply.type("text/xml");
    const allowlisted = Boolean(from) && twilio.isAllowed(from);
    if (!allowlisted) {
      // Unknown caller. With screening enabled, the agent answers on the user's
      // behalf and the device shows a live transcript; otherwise reject as before.
      const screeningEnabled = Boolean(from) && Boolean(screening) && twilio.getScreeningEnabled();
      if (!screeningEnabled) {
        audit("twilio.voice", from || "(unknown)", false, { callSid, reason: "not_allowlisted" });
        db.event("twilio.inbound_rejected", { from, callSid }, PSTN_EXTENSION);
        return reply.send(REJECT_TWIML);
      }
      // Carrier-dependent: set when the call rolled over via call forwarding.
      const forwardedFrom = body.ForwardedFrom || body.CalledVia || undefined;
      // Loop guard: an unanswered take-over <Dial> can forward back here from
      // the user's own number — don't re-screen the same caller in a loop.
      const forwardedFromUser = (() => {
        if (!forwardedFrom) return false;
        try {
          return twilio.normalizeNumber(forwardedFrom) === twilio.getDefaultUserNumber();
        } catch {
          return false;
        }
      })();
      if (forwardedFromUser && screening!.isRecentTakeoverTarget(from)) {
        audit("twilio.voice", from, false, { callSid, reason: "takeover_ringback_loop" });
        const loopResponse = new twilioSdk.twiml.VoiceResponse();
        loopResponse.say("He could not be reached. Please try again later. Goodbye.");
        loopResponse.hangup();
        return reply.send(loopResponse.toString());
      }
      bridge.expectInbound(callSid, from, { screening: true, forwardedFrom });
      audit("twilio.voice", from, true, { callSid, screening: true, forwardedFrom: forwardedFrom ?? null });
      const screeningResponse = new twilioSdk.twiml.VoiceResponse();
      screeningResponse.say("Please hold.");
      const screeningConnect = screeningResponse.connect();
      const screeningStream = screeningConnect.stream({ url: `${config.twilio.publicBaseUrl.replace(/^http/, "ws")}/twilio/media` });
      screeningStream.parameter({ name: "direction", value: "inbound" });
      return reply.send(screeningResponse.toString());
    }
    bridge.expectInbound(callSid, from);
    audit("twilio.voice", from, true, { callSid });
    const response = new twilioSdk.twiml.VoiceResponse();
    response.say("Connecting you to your agent.");
    const connect = response.connect();
    const stream = connect.stream({ url: `${config.twilio.publicBaseUrl.replace(/^http/, "ws")}/twilio/media` });
    stream.parameter({ name: "direction", value: "inbound" });
    return reply.send(response.toString());
  });

  // <Dial action> callback for screening take-overs: ends the caller's leg
  // cleanly whatever happened to the dial attempt (and stops forwarding loops).
  app.post("/twilio/takeover-status", async (request, reply) => {
    if (!twilio.validateWebhook(request)) {
      audit("twilio.takeover_status", "signature", false, { ip: request.ip });
      return reply.code(403).send("invalid signature");
    }
    const body = (request.body ?? {}) as Record<string, string>;
    const dialStatus = body.DialCallStatus ?? "";
    audit("twilio.takeover_status", body.CallSid ?? "", true, { dialStatus });
    reply.type("text/xml");
    const response = new twilioSdk.twiml.VoiceResponse();
    if (["no-answer", "busy", "failed", "canceled"].includes(dialStatus)) {
      response.say("Sorry, he is unavailable right now. Please try again later. Goodbye.");
    }
    response.hangup();
    return reply.send(response.toString());
  });

  // Call status lifecycle (ringing / answered / completed / no-answer / ...).
  app.post("/twilio/status", async (request, reply) => {
    if (!twilio.validateWebhook(request)) {
      audit("twilio.status", "signature", false, { ip: request.ip });
      return reply.code(403).send("invalid signature");
    }
    const body = (request.body ?? {}) as Record<string, string>;
    bridge.handleTwilioStatus(body.CallSid ?? "", body.CallStatus ?? "", body.ErrorCode);
    return reply.send({ ok: true });
  });

  // Inbound SMS. Default: mirror into the in-app inbox as a message from ext 700.
  // When the "text your agent" feature is ON, route the text to the selected
  // agent instead (into a per-number thread); the agent's reply is texted back
  // by the outbound SMS hook wired into the hub. See src/sms/smsAgent.ts.
  app.post("/twilio/sms", async (request, reply) => {
    if (!twilio.validateWebhook(request)) {
      audit("twilio.sms", "signature", false, { ip: request.ip });
      return reply.code(403).send("invalid signature");
    }
    const body = (request.body ?? {}) as Record<string, string>;
    const from = body.From ?? "";
    reply.type("text/xml");
    if (!from || !twilio.isAllowed(from)) {
      audit("twilio.sms", from || "(unknown)", false, { reason: "not_allowlisted" });
      return reply.send(EMPTY_TWIML);
    }
    const smsAgentEnabled = twilio.getSmsAgentEnabled();
    const agentExt = twilio.getSmsAgentExtension();
    const message = wsHub.messages.createMessage({
      from_extension: PSTN_EXTENSION,
      to_extension: smsAgentEnabled ? agentExt : "100",
      from_type: "system",
      to_type: smsAgentEnabled ? "agent" : "device",
      title: `SMS from ${from}`,
      body: body.Body ?? "",
      // Stable per-number thread so the conversation (and the agent's context)
      // stays coherent across texts, and the outbound hook can recover the number.
      subject: `SMS ${from}`,
      priority: "normal",
      requires_response: false,
      response_options: [],
      metadata: { channel: "sms", from_number: from, sms_sid: body.MessageSid ?? null }
    });
    if (smsAgentEnabled) void wsHub.ensureAgentOnline(agentExt);
    wsHub.notifyNewMessage(message);
    twilio.recordInboundSms(body.MessageSid ?? "", from, body.Body ?? "", message.id);
    audit("twilio.sms", from, true, { messageId: message.id, routed_to: smsAgentEnabled ? agentExt : "100" });
    return reply.send(EMPTY_TWIML);
  });
}
