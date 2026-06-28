import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { CallService } from "../calls/callService.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { mulawDecode, mulawEncode, resamplePcm16, rmsOfPcm16Frame } from "../audio/g711.js";
import { UtteranceSegmenter } from "../audio/utteranceSegmenter.js";
import { extractWavPcm, assertValidWavBuffer } from "../audio/wav.js";
import type { WebSocketHub } from "../websocket/hub.js";
import type { TwilioService } from "./twilioService.js";

/** The static pseudo-extension that represents the user's real telephone. */
export const PSTN_EXTENSION = "700";

/** Twilio media streams are always 8kHz mono mu-law, 20ms (160-byte) frames. */
const TWILIO_SAMPLE_RATE = 8000;
/** The internal STT pipeline expects 16kHz PCM16 (same as the Android mic). */
const PIPELINE_SAMPLE_RATE = 16_000;

// Telephone-audio VAD tuning (PCM16 RMS at 8kHz, 20ms frames):
const VAD_START_RMS = 600;
const VAD_END_RMS = 300;
const VAD_MIN_SPEECH_FRAMES = 4; // 80ms sustained speech to open a turn
const VAD_SILENCE_FRAMES_TO_END = 35; // 700ms trailing silence closes the turn
const PRE_ROLL_FRAMES = 15; // 300ms of audio replayed so the first syllable isn't clipped
const MAX_UTTERANCE_MS = 15_000;
/** If Twilio never opens the media stream / call never goes active. */
const SESSION_ANSWER_TIMEOUT_MS = 60_000;

const TERMINAL_CALL_STATES = new Set(["ended", "rejected", "timeout", "failed", "missed"]);

type MediaSession = {
  ws: WebSocket;
  streamSid: string;
  callSid: string;
  internalCallId: string;
  peerExtension: string;
  direction: "inbound" | "outbound";
  screening?: boolean;
  /** Set when the user takes over: teardown must NOT hang up the caller's leg. */
  takeoverInProgress?: boolean;
  segmenter: UtteranceSegmenter;
  preRoll: Buffer[];
  inUtterance: boolean;
  micGated: boolean;
  awaitingMark?: string;
  ttsBuffers: Map<string, Buffer[]>;
  maxUtteranceTimer?: NodeJS.Timeout;
  ingestChain: Promise<unknown>;
  closed: boolean;
};

/**
 * Bridges Twilio bidirectional media streams (8kHz mu-law over WebSocket) into
 * the internal call pipeline. Registers as the hub's "local sink" for ext 700,
 * so TTS/transcripts/call-state events flow exactly as they do for the app —
 * every existing call tool works unchanged on a real phone call.
 */
export class TwilioBridge {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly calls: CallService;
  private readonly extensions: ExtensionService;
  private log?: FastifyInstance["log"];
  private sinkRegistered = false;
  private readonly byInternalCallId = new Map<string, MediaSession>();
  private readonly byCallSid = new Map<string, MediaSession>();
  /** Outbound calls placed but whose media stream hasn't connected yet. */
  private readonly pendingOutbound = new Map<string, { internalCallId: string; toNumber: string }>();
  /** Inbound calls greenlit by the /twilio/voice webhook, awaiting their stream. */
  private readonly pendingInbound = new Map<
    string,
    { fromNumber: string; expiresAt: number; screening?: boolean; forwardedFrom?: string }
  >();
  private screening?: {
    start(input: { internalCallId: string; callSid: string; callerNumber: string; forwardedFrom?: string }): void;
  };

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: WebSocketHub,
    private readonly twilio: TwilioService
  ) {
    this.calls = new CallService(db);
    this.extensions = new ExtensionService(db);
  }

  attach(app: FastifyInstance) {
    this.log = app.log;
    app.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/twilio/media") return; // the hub's listener owns /ws
      this.wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws));
    });
  }

  close() {
    for (const session of this.byCallSid.values()) {
      try { session.ws.close(); } catch { /* already gone */ }
    }
    this.wss.close();
  }

  /**
   * Make ext 700 online/sinkable BEFORE calls.dial() so the dial rings instead
   * of going straight to "missed". Call this before dialing an outbound PSTN call.
   */
  prepareOutbound() {
    this.ensureSink();
  }

  /** Map an outbound Twilio call SID to its internal call so the stream `start` can find it. */
  expectOutbound(internalCallId: string, callSid: string, toNumber: string) {
    this.pendingOutbound.set(callSid, { internalCallId, toNumber });
    this.ensureSink();
    // Safety: if the media stream never arrives (webhook/funnel down, call never
    // answered and no status callback), don't leave ext 700 pinned online forever.
    setTimeout(() => {
      if (this.pendingOutbound.delete(callSid)) this.maybeReleaseSink();
    }, SESSION_ANSWER_TIMEOUT_MS).unref?.();
  }

  /** Greenlight an inbound call (signature-validated webhook) for its media stream. */
  expectInbound(callSid: string, fromNumber: string, opts: { screening?: boolean; forwardedFrom?: string } = {}) {
    this.pendingInbound.set(callSid, {
      fromNumber,
      expiresAt: Date.now() + SESSION_ANSWER_TIMEOUT_MS,
      screening: opts.screening,
      forwardedFrom: opts.forwardedFrom
    });
    setTimeout(() => {
      if (this.pendingInbound.delete(callSid)) this.maybeReleaseSink();
    }, SESSION_ANSWER_TIMEOUT_MS).unref?.();
  }

  setScreening(screening: { start(input: { internalCallId: string; callSid: string; callerNumber: string; forwardedFrom?: string }): void }) {
    this.screening = screening;
  }

  /** Flag a live session so its teardown leaves the caller's Twilio leg alive. */
  markTakeover(callSid: string): boolean {
    const session = this.byCallSid.get(callSid);
    if (!session) return false;
    session.takeoverInProgress = true;
    return true;
  }

  /** Status callback from Twilio (/twilio/status) — sync internal call state. */
  handleTwilioStatus(callSid: string, status: string, errorCode?: string) {
    this.twilio.recordCallStatus(callSid, status, errorCode);
    const session = this.byCallSid.get(callSid);
    const internalCallId = session?.internalCallId ?? this.twilio.findByCallSid(callSid)?.call_id ?? this.pendingOutbound.get(callSid)?.internalCallId;
    if (["no-answer", "busy", "failed", "canceled", "completed"].includes(status)) {
      this.pendingOutbound.delete(callSid);
      this.pendingInbound.delete(callSid);
      this.maybeReleaseSink();
    }
    if (!internalCallId) return;
    const call = this.calls.get(internalCallId);
    if (!call || TERMINAL_CALL_STATES.has(call.state)) return;
    if (status === "no-answer") {
      this.hub.timeoutCall(internalCallId, "pstn_no_answer");
    } else if (["busy", "failed", "canceled"].includes(status)) {
      this.hub.failCall(internalCallId, `pstn_${status}`);
    } else if (status === "completed") {
      this.hub.endCall(internalCallId, PSTN_EXTENSION, "pstn_hangup");
    }
    // The resulting call_end/call_failed/call_timeout event reaches the session
    // through the sink and closes the media socket.
  }

  status() {
    return {
      sink_registered: this.sinkRegistered,
      active_sessions: this.byCallSid.size,
      pending_outbound: this.pendingOutbound.size,
      pending_inbound: this.pendingInbound.size
    };
  }

  // ---- media socket lifecycle ----------------------------------------------

  private handleConnection(ws: WebSocket) {
    let session: MediaSession | undefined;
    ws.on("message", (data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (event.event) {
        case "connected":
          break;
        case "start":
          void this.startSession(ws, event as never).then((started) => {
            session = started;
            if (!started) {
              try { ws.close(); } catch { /* noop */ }
            }
          });
          break;
        case "media":
          if (session) this.onMedia(session, event as { media?: { payload?: string } });
          break;
        case "mark":
          if (session) this.onMark(session, (event as { mark?: { name?: string } }).mark?.name);
          break;
        case "stop":
          if (session) this.teardown(session, "pstn_stream_stopped");
          break;
      }
    });
    ws.on("close", () => {
      if (session) this.teardown(session, "pstn_disconnected");
    });
    ws.on("error", () => {
      if (session) this.teardown(session, "pstn_socket_error");
    });
  }

  private async startSession(
    ws: WebSocket,
    event: { start?: { streamSid?: string; callSid?: string; customParameters?: Record<string, string> } }
  ): Promise<MediaSession | undefined> {
    const start = event.start ?? {};
    const streamSid = start.streamSid ?? "";
    const callSid = start.callSid ?? "";
    const params = start.customParameters ?? {};
    if (!streamSid || !callSid) return undefined;

    const outboundCallId = params.internalCallId ?? this.pendingOutbound.get(callSid)?.internalCallId ?? this.twilio.findByCallSid(callSid)?.call_id;
    const inbound = this.pendingInbound.get(callSid);

    let internalCallId: string;
    let peerExtension: string;
    let direction: "inbound" | "outbound";
    let isScreening = false;

    if (params.direction !== "inbound" && outboundCallId) {
      // Outbound: the MCP tool already created the internal call (agent → 700).
      direction = "outbound";
      internalCallId = outboundCallId;
      const call = this.calls.get(internalCallId);
      if (!call) {
        this.log?.warn({ callSid, internalCallId }, "twilio stream for unknown internal call — closing");
        return undefined;
      }
      peerExtension = call.from_extension;
      this.pendingOutbound.delete(callSid);
      this.ensureSink();
      this.twilio.linkStream(callSid, streamSid);
      this.twilio.recordCallStatus(callSid, "in-progress");
      try {
        this.hub.acceptCall(internalCallId, PSTN_EXTENSION); // unblocks the waiting MCP tool
      } catch (error) {
        this.log?.warn({ callSid, error: error instanceof Error ? error.message : "accept_failed" }, "twilio stream accept failed");
        return undefined;
      }
    } else if (inbound) {
      // Inbound: the user dialed the Twilio number; ring the registered agent.
      direction = "inbound";
      this.pendingInbound.delete(callSid);
      // Unknown callers go to the SCREENING agent; a known/allowlisted caller
      // (you dialing in) goes to your inbound agent — two separate settings.
      const agentExtension = inbound.screening
        ? this.twilio.getScreeningAgentExtension()
        : this.twilio.getInboundExtension();
      this.ensureSink();
      try {
        await this.hub.ensureAgentOnline(agentExtension);
        // The DB online flag can lag the live socket (same race the hub guards
        // against in its dial handler) — sync it so dial() rings instead of missing.
        if (this.hub.hasLiveConnection(agentExtension) && this.extensions.get(agentExtension)?.online !== 1) {
          this.extensions.setPresence(agentExtension, true);
        }
        const reason = inbound.screening
          ? `SCREENING unknown caller ${inbound.fromNumber}${inbound.forwardedFrom ? ` (forwarded from ${inbound.forwardedFrom})` : ""}: ` +
            "answer politely on Kizek's behalf, find out who is calling and why, and take a message. " +
            "Do not share personal information or make commitments. Kizek is watching live and may take over."
          : `PSTN call from ${inbound.fromNumber}`;
        const call = this.calls.dial({
          fromExtension: PSTN_EXTENSION,
          toExtension: agentExtension,
          reason,
          urgency: "normal"
        });
        this.hub.notifyIncomingCall(call); // universalAgent auto-accepts + greets
        internalCallId = call.id;
        peerExtension = agentExtension;
        this.twilio.recordInboundCall(callSid, inbound.fromNumber, call.id);
        this.twilio.linkStream(callSid, streamSid);
        if (inbound.screening) {
          isScreening = true;
          this.screening?.start({
            internalCallId: call.id,
            callSid,
            callerNumber: inbound.fromNumber,
            forwardedFrom: inbound.forwardedFrom
          });
        }
        // If the agent never answers, don't hold the caller in silence forever.
        void this.hub.waitForCallState(call.id, ["active", "rejected", "ended", "failed", "timeout"], 45_000).then((answer) => {
          if (answer.state === "active") return;
          const current = this.calls.get(call.id);
          if (current && !TERMINAL_CALL_STATES.has(current.state)) this.hub.timeoutCall(call.id, "agent_no_answer");
        });
      } catch (error) {
        this.log?.error({ callSid, error: error instanceof Error ? error.message : "inbound_dial_failed" }, "inbound twilio call could not reach an agent");
        void this.twilio.hangup(callSid).catch(() => undefined);
        return undefined;
      }
    } else {
      this.log?.warn({ callSid, streamSid }, "unsolicited twilio media stream — closing");
      return undefined;
    }

    const session: MediaSession = {
      ws,
      streamSid,
      callSid,
      internalCallId,
      peerExtension,
      direction,
      screening: isScreening,
      segmenter: new UtteranceSegmenter({
        startRms: VAD_START_RMS,
        endRms: VAD_END_RMS,
        minSpeechFrames: VAD_MIN_SPEECH_FRAMES,
        silenceFramesToEnd: VAD_SILENCE_FRAMES_TO_END
      }),
      preRoll: [],
      inUtterance: false,
      micGated: false,
      ttsBuffers: new Map(),
      ingestChain: Promise.resolve(),
      closed: false
    };
    this.byInternalCallId.set(internalCallId, session);
    this.byCallSid.set(callSid, session);
    this.log?.info({ callSid, streamSid, internalCallId, direction }, "twilio media stream connected");
    return session;
  }

  // ---- caller audio -> STT pipeline ----------------------------------------

  private onMedia(session: MediaSession, event: { media?: { payload?: string } }) {
    if (session.closed) return;
    const payload = event.media?.payload;
    if (!payload) return;
    if (session.micGated) return; // half-duplex: drop caller audio while the agent speaks
    const pcm8k = mulawDecode(Buffer.from(payload, "base64"));
    session.preRoll.push(pcm8k);
    if (session.preRoll.length > PRE_ROLL_FRAMES) session.preRoll.shift();
    const vadEvent = session.segmenter.accept(rmsOfPcm16Frame(pcm8k));
    if (!session.inUtterance && vadEvent === "utterance_start") {
      session.inUtterance = true;
      this.chainIngest(session, () => {
        this.hub.ingestAudioStart(session.internalCallId, PSTN_EXTENSION, "pcm_s16le", PIPELINE_SAMPLE_RATE, 1, session.peerExtension);
        // Replay the pre-roll (which includes this frame) so onset isn't clipped.
        for (const frame of session.preRoll) {
          this.hub.ingestAudioChunk(session.internalCallId, PSTN_EXTENSION, resamplePcm16(frame, TWILIO_SAMPLE_RATE, PIPELINE_SAMPLE_RATE));
        }
      });
      session.maxUtteranceTimer = setTimeout(() => this.finishUtterance(session), MAX_UTTERANCE_MS);
      session.maxUtteranceTimer.unref?.();
      return;
    }
    if (session.inUtterance) {
      if (vadEvent === "utterance_end") {
        this.finishUtterance(session);
        return;
      }
      this.chainIngest(session, () => {
        this.hub.ingestAudioChunk(session.internalCallId, PSTN_EXTENSION, resamplePcm16(pcm8k, TWILIO_SAMPLE_RATE, PIPELINE_SAMPLE_RATE));
      });
    }
  }

  private finishUtterance(session: MediaSession) {
    if (!session.inUtterance) return;
    session.inUtterance = false;
    session.segmenter.reset();
    if (session.maxUtteranceTimer) clearTimeout(session.maxUtteranceTimer);
    session.maxUtteranceTimer = undefined;
    this.chainIngest(session, () => this.hub.ingestAudioEnd(session.internalCallId, PSTN_EXTENSION));
  }

  /** Serialize start/chunk/end calls per session so turns can't interleave. */
  private chainIngest(session: MediaSession, step: () => unknown) {
    session.ingestChain = session.ingestChain
      .then(() => step())
      .catch((error) => {
        this.log?.warn(
          { callSid: session.callSid, error: error instanceof Error ? error.message : "ingest_failed" },
          "twilio audio ingest step failed"
        );
      });
  }

  // ---- hub events -> caller audio (the local sink) --------------------------

  private ensureSink() {
    if (this.sinkRegistered) return;
    this.hub.registerLocalSink(PSTN_EXTENSION, (event) => this.onSinkEvent(event));
    this.sinkRegistered = true;
  }

  private maybeReleaseSink() {
    if (!this.sinkRegistered) return;
    if (this.byCallSid.size > 0 || this.pendingOutbound.size > 0 || this.pendingInbound.size > 0) return;
    this.hub.unregisterLocalSink(PSTN_EXTENSION);
    this.sinkRegistered = false;
  }

  private onSinkEvent(event: Record<string, unknown>) {
    // call_end / call_accept / dial_result carry the call OBJECT, not a callId field.
    const callId =
      typeof event.callId === "string"
        ? event.callId
        : typeof (event.call as { id?: string } | undefined)?.id === "string"
          ? (event.call as { id: string }).id
          : undefined;
    const session = callId ? this.byInternalCallId.get(callId) : undefined;
    if (!session || session.closed) return;
    const type = event.type;
    if (type === "tts_start") {
      const messageId = String(event.messageId ?? "");
      session.ttsBuffers.set(messageId, []);
      // Gate the mic for the agent's turn; close out any half-spoken user turn first.
      this.finishUtterance(session);
      session.micGated = true;
    } else if (type === "tts_chunk") {
      const messageId = String(event.messageId ?? "");
      const chunks = session.ttsBuffers.get(messageId);
      if (chunks && typeof event.audioBase64 === "string") chunks.push(Buffer.from(event.audioBase64, "base64"));
    } else if (type === "tts_end") {
      const messageId = String(event.messageId ?? "");
      const chunks = session.ttsBuffers.get(messageId);
      session.ttsBuffers.delete(messageId);
      if (chunks) this.playTts(session, messageId, Buffer.concat(chunks));
    } else if (type === "tts_local") {
      // Should be impossible: the gateway swaps local voices for PSTN targets.
      this.log?.error({ callId }, "tts_local reached the PSTN bridge — caller will hear silence for this utterance");
      session.micGated = false;
    } else if (type === "audio_error") {
      session.micGated = false;
    } else if (type === "call_end" || type === "call_failed" || type === "call_timeout" || type === "call_reject") {
      this.hangupAndClose(session);
    }
  }

  private playTts(session: MediaSession, messageId: string, audio: Buffer) {
    if (session.closed || session.ws.readyState !== WebSocket.OPEN) return;
    try {
      assertValidWavBuffer(audio);
      const sampleRate = audio.readUInt32LE(24);
      const pcm = extractWavPcm(audio);
      const pcm8k = resamplePcm16(pcm, sampleRate, TWILIO_SAMPLE_RATE);
      const mulaw = mulawEncode(pcm8k);
      // 20ms mu-law frames (160 bytes); Twilio buffers and plays at line rate.
      for (let offset = 0; offset < mulaw.length; offset += 160) {
        session.ws.send(
          JSON.stringify({
            event: "media",
            streamSid: session.streamSid,
            media: { payload: mulaw.subarray(offset, Math.min(offset + 160, mulaw.length)).toString("base64") }
          })
        );
      }
      session.awaitingMark = messageId;
      session.ws.send(JSON.stringify({ event: "mark", streamSid: session.streamSid, mark: { name: messageId } }));
    } catch (error) {
      this.log?.warn(
        { callSid: session.callSid, messageId, error: error instanceof Error ? error.message : "tts_transcode_failed" },
        "failed to transcode TTS for the PSTN caller"
      );
      session.micGated = false;
    }
  }

  private onMark(session: MediaSession, name?: string) {
    if (!name || session.awaitingMark !== name) return;
    // Twilio finished playing the agent's utterance — reopen the mic.
    session.awaitingMark = undefined;
    session.micGated = false;
    session.segmenter.reset();
    session.preRoll.length = 0;
  }

  // ---- teardown --------------------------------------------------------------

  /** Internal call ended (agent hung up / failure) — terminate the Twilio leg. */
  private hangupAndClose(session: MediaSession) {
    if (session.closed) return;
    try {
      session.ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
    } catch { /* socket already dying */ }
    void this.twilio.hangup(session.callSid).catch(() => undefined);
    this.teardown(session, undefined);
    try { session.ws.close(); } catch { /* noop */ }
  }

  /** Media socket gone (caller hung up / network) — end the internal call if needed. */
  private teardown(session: MediaSession, endReason: string | undefined) {
    if (session.closed) return;
    session.closed = true;
    if (session.maxUtteranceTimer) clearTimeout(session.maxUtteranceTimer);
    this.byInternalCallId.delete(session.internalCallId);
    this.byCallSid.delete(session.callSid);
    // Take-over: Twilio replaced the TwiML with <Dial> to the user, which stops
    // the media stream. The CALLER'S LEG IS STILL LIVE — a REST hangup here
    // would drop them mid-handoff.
    const effectiveReason = session.takeoverInProgress && endReason ? "user_took_over" : endReason;
    if (effectiveReason) {
      const call = this.calls.get(session.internalCallId);
      if (call && !TERMINAL_CALL_STATES.has(call.state)) {
        try {
          this.hub.endCall(session.internalCallId, PSTN_EXTENSION, effectiveReason);
        } catch (error) {
          this.log?.warn(
            { callSid: session.callSid, error: error instanceof Error ? error.message : "end_failed" },
            "failed to end internal call on twilio teardown"
          );
        }
      }
      if (!session.takeoverInProgress) {
        void this.twilio.hangup(session.callSid).catch(() => undefined);
      }
    }
    this.maybeReleaseSink();
    this.log?.info({ callSid: session.callSid, internalCallId: session.internalCallId, endReason }, "twilio media session closed");
  }
}
