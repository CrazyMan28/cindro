import type { AppDatabase } from "../db/database.js";
import type { WebSocketHub } from "../websocket/hub.js";
import type { TwilioService } from "./twilioService.js";
import { PSTN_EXTENSION } from "./twilioBridge.js";
import { RELAY_EXTENSION } from "../relay/relayBridge.js";

/**
 * Pseudo-extensions that represent the caller's leg in a screened call: the
 * Twilio PSTN bridge (700) and the Bluetooth relay bridge (702). Anything else
 * (an agent extension) is the screening agent's voice. Additive — the Twilio
 * path is unchanged: 700 still classifies as the caller.
 */
const CALLER_EXTENSIONS = new Set([PSTN_EXTENSION, RELAY_EXTENSION]);

/** The user's device extension — where popups and live transcript lines go. */
const USER_EXTENSION = "100";
/** How long after a take-over a ring-back from the same caller is loop-guarded. */
const TAKEOVER_RECENT_MS = 10 * 60_000;

export type ScreeningSession = {
  internalCallId: string;
  callSid: string;
  callerNumber: string;
  forwardedFrom?: string;
  /** The caller-leg extension: 700 (Twilio) or 702 (BT relay). Drives take-over/end routing. */
  callerExtension: string;
  seq: number;
  status: "screening" | "taking_over" | "ended";
  startedAt: number;
};

/**
 * AI call screening: an unknown caller is answered by the agent while the
 * user's device shows a live two-sided transcript with take-over/end buttons.
 *
 * Lives next to (not inside) the TwilioBridge: the bridge owns the audio leg,
 * this service owns the user-facing session — popup event, line mirror via the
 * hub's call observer, take-over redirect, and teardown bookkeeping.
 */
export class ScreeningService {
  private readonly sessions = new Map<string, ScreeningSession>();
  private readonly recentTakeovers = new Map<string, number>();
  private bridge?: { markTakeover(callSid: string): boolean };

  constructor(
    private readonly db: AppDatabase,
    private readonly hub: WebSocketHub,
    private readonly twilio: TwilioService
  ) {}

  setBridge(bridge: { markTakeover(callSid: string): boolean }) {
    this.bridge = bridge;
  }

  /** Called by the bridge once the inbound media stream maps to an internal call. */
  start(input: { internalCallId: string; callSid: string; callerNumber: string; forwardedFrom?: string; callerExtension?: string }) {
    const session: ScreeningSession = {
      ...input,
      callerExtension: input.callerExtension ?? PSTN_EXTENSION,
      seq: 0,
      status: "screening",
      startedAt: Date.now()
    };
    this.sessions.set(input.internalCallId, session);
    this.hub.observeCall(input.internalCallId, (event) => this.onCallEvent(input.internalCallId, event));
    this.hub.sendToExtension(USER_EXTENSION, {
      type: "screening_started",
      callId: input.internalCallId,
      callSid: input.callSid,
      callerNumber: input.callerNumber,
      forwardedFrom: input.forwardedFrom ?? null,
      seq: 0
    });
    this.db.event(
      "twilio.screening_started",
      { callSid: input.callSid, callerNumber: input.callerNumber, forwardedFrom: input.forwardedFrom ?? null },
      PSTN_EXTENSION,
      input.internalCallId
    );
  }

  /**
   * Mirror of every event the hub delivers for a screened call. call_message
   * fires exactly once per spoken line on each side (caller STT → agent, and
   * agent reply → ext 700 before TTS), so it is the one event worth relaying.
   */
  private onCallEvent(callId: string, event: Record<string, unknown>) {
    const session = this.sessions.get(callId);
    if (!session) return;
    const type = String(event.type ?? "");
    if (type.startsWith("screening_")) return; // our own mirror — never recurse
    if (type === "call_message") {
      const from = String(event.fromExtension ?? "");
      const text = String(event.content ?? "");
      if (!text) return;
      session.seq += 1;
      this.hub.sendToExtension(USER_EXTENSION, {
        type: "screening_update",
        callId,
        seq: session.seq,
        speaker: CALLER_EXTENSIONS.has(from) ? "caller" : "agent",
        speakerExtension: from,
        text
      });
      return;
    }
    if (["call_end", "call_failed", "call_timeout", "call_reject"].includes(type)) {
      this.finish(callId, session, type);
    }
  }

  private finish(callId: string, session: ScreeningSession, reason: string) {
    this.sessions.delete(callId);
    this.hub.unobserveCall(callId);
    const outcome = session.status === "taking_over" ? "taken_over" : "ended";
    session.status = "ended";
    session.seq += 1;
    this.hub.sendToExtension(USER_EXTENSION, {
      type: "screening_ended",
      callId,
      seq: session.seq,
      reason,
      outcome
    });
    this.db.event("twilio.screening_ended", { callSid: session.callSid, reason, outcome }, PSTN_EXTENSION, callId);
  }

  /**
   * Hand the call to the user. Channel-aware:
   * - Twilio (700): redirect the Twilio leg via <Dial> to the user's real phone.
   * - BT relay (702): the call is ALREADY on the user's phone — the app routes
   *   audio back to the earpiece locally; here we just end the agent's leg so it
   *   stops talking. No Twilio redirect (there's no Twilio call to redirect).
   */
  async takeOver(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) throw new Error("no active screening session for that call");
    session.status = "taking_over";
    this.recentTakeovers.set(session.callerNumber, Date.now());

    if (session.callerExtension === RELAY_EXTENSION) {
      session.seq += 1;
      this.hub.sendToExtension(USER_EXTENSION, {
        type: "screening_update",
        callId,
        seq: session.seq,
        speaker: "system",
        speakerExtension: "system",
        text: "You're taking the call — handing it to your phone."
      });
      // End the agent leg; the native call continues on the user's phone.
      this.hub.endCall(callId, RELAY_EXTENSION, "user_took_over");
      this.db.event("relay.screening_taken_over", { callId }, USER_EXTENSION, callId);
      return { ok: true, call_id: callId, transport: "relay" };
    }

    const target = this.twilio.getDefaultUserNumber();
    if (!target) throw new Error("no default user number set — run twilio_set_user_number first");
    this.bridge?.markTakeover(session.callSid);
    session.seq += 1;
    this.hub.sendToExtension(USER_EXTENSION, {
      type: "screening_update",
      callId,
      seq: session.seq,
      speaker: "system",
      speakerExtension: "system",
      text: "Connecting you to the caller — your phone will ring."
    });
    await this.twilio.redirectToDial(session.callSid, target);
    this.db.event("twilio.screening_taken_over", { callSid: session.callSid, target }, USER_EXTENSION, callId);
    return { ok: true, call_id: callId, transport: "twilio", ringing: target };
  }

  /** Hang up on the caller. The call_end sink event makes the owning bridge drop its leg. */
  end(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) throw new Error("no active screening session for that call");
    this.hub.endCall(callId, session.callerExtension, "user_ended_screening");
    return { ok: true, call_id: callId };
  }

  /**
   * Loop guard: after a take-over, an unanswered <Dial> can roll back through
   * the user's carrier forwarding and arrive here as a fresh "unknown" call
   * from the same caller. Don't re-screen it — say goodbye instead.
   */
  isRecentTakeoverTarget(callerNumber: string): boolean {
    const timestamp = this.recentTakeovers.get(callerNumber);
    return Boolean(timestamp && Date.now() - timestamp < TAKEOVER_RECENT_MS);
  }

  status() {
    return {
      enabled: this.twilio.getScreeningEnabled(),
      active_sessions: [...this.sessions.values()].map((session) => ({
        call_id: session.internalCallId,
        caller: session.callerNumber,
        forwarded_from: session.forwardedFrom ?? null,
        status: session.status
      }))
    };
  }
}
