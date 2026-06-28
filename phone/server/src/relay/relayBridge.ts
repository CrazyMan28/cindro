import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { CallService } from "../calls/callService.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { resamplePcm16, rmsOfPcm16Frame } from "../audio/g711.js";
import { UtteranceSegmenter } from "../audio/utteranceSegmenter.js";
import { extractWavPcm, assertValidWavBuffer } from "../audio/wav.js";
import type { WebSocketHub } from "../websocket/hub.js";
import type { TwilioService } from "../twilio/twilioService.js";

/**
 * The static pseudo-extension that represents the user's real telephone as it
 * arrives over the Bluetooth relay. Mirrors ext 700 (Twilio PSTN) but carries
 * PCM16 audio rather than mu-law, and is fed by the relay device's WebSocket.
 */
export const RELAY_EXTENSION = "702";

/** The internal STT pipeline expects 16kHz PCM16 (same as the Android mic). */
const PIPELINE_SAMPLE_RATE = 16_000;
/** Relay clients default to mic-rate PCM16 mono unless they declare otherwise. */
const DEFAULT_RELAY_SAMPLE_RATE = 16_000;

// VAD tuning at 16kHz, 20ms (320-byte) frames — same thresholds the Twilio
// bridge uses, since the segmenter operates on per-frame RMS regardless of rate.
const VAD_START_RMS = 600;
const VAD_END_RMS = 300;
const VAD_MIN_SPEECH_FRAMES = 4; // 80ms sustained speech opens a turn
const VAD_SILENCE_FRAMES_TO_END = 35; // 700ms trailing silence closes the turn
const PRE_ROLL_FRAMES = 15; // 300ms of audio replayed so the first syllable isn't clipped
const MAX_UTTERANCE_MS = 15_000;
/** ~20ms of 16kHz PCM16 mono = 160 samples = 320 bytes. */
const FRAME_BYTES_16K = 320;

const TERMINAL_CALL_STATES = new Set(["ended", "rejected", "timeout", "failed", "missed"]);

type RelaySession = {
  ws: WebSocket;
  internalCallId: string;
  peerExtension: string;
  sampleRate: number;
  screening?: boolean;
  /** Set when the user takes over: teardown must NOT end the internal call. */
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
 * Bridges a Bluetooth relay device's bidirectional media stream (PCM16 mono
 * over WebSocket) into the internal call pipeline. Registers as the hub's
 * "local sink" for ext 702, so TTS/transcripts/call-state events flow exactly
 * as they do for the app and the Twilio PSTN bridge — every existing call tool
 * works unchanged. A near-clone of TwilioBridge that swaps mu-law/8k transport
 * for PCM16/configurable-rate and a JSON control protocol from the relay client.
 */
export class RelayBridge {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly calls: CallService;
  private readonly extensions: ExtensionService;
  private log?: FastifyInstance["log"];
  private sinkRegistered = false;
  private readonly byInternalCallId = new Map<string, RelaySession>();
  private readonly sessions = new Set<RelaySession>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: WebSocketHub,
    private readonly screening: {
      start(input: { internalCallId: string; callSid: string; callerNumber: string; forwardedFrom?: string; callerExtension?: string }): void;
    },
    private readonly twilio: TwilioService
  ) {
    this.calls = new CallService(db);
    this.extensions = new ExtensionService(db);
  }

  attach(app: FastifyInstance) {
    this.log = app.log;
    app.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/relay/media") return; // only own /relay/media; leave /ws and /twilio/media alone
      this.wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws));
    });
  }

  close() {
    for (const session of this.sessions) {
      try { session.ws.close(); } catch { /* already gone */ }
    }
    this.wss.close();
  }

  status() {
    return {
      sink_registered: this.sinkRegistered,
      active_sessions: this.sessions.size
    };
  }

  // ---- media socket lifecycle ----------------------------------------------

  private handleConnection(ws: WebSocket) {
    let session: RelaySession | undefined;
    ws.on("message", (data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (event.kind) {
        case "start_call":
          if (session) break; // one call per socket
          void this.startSession(ws, event as never).then((started) => {
            session = started;
            if (!started) {
              try { ws.close(); } catch { /* noop */ }
            }
          });
          break;
        case "media":
          if (session) this.onMedia(session, event as { pcmBase64?: string });
          break;
        case "media_end":
          if (session) this.finishUtterance(session);
          break;
        case "mark":
          if (session) this.onMark(session, (event as { name?: string }).name);
          break;
        case "takeover":
          if (session) session.takeoverInProgress = true;
          break;
        case "end":
          if (session) this.requestEnd(session, "relay_ended");
          break;
      }
    });
    ws.on("close", () => {
      if (session) this.teardown(session, "relay_disconnected");
    });
    ws.on("error", () => {
      if (session) this.teardown(session, "relay_socket_error");
    });
  }

  private async startSession(
    ws: WebSocket,
    event: { callerNumber?: string; forwardedFrom?: string; screening?: boolean; sampleRate?: number }
  ): Promise<RelaySession | undefined> {
    const callerNumber = event.callerNumber || "unknown";
    const forwardedFrom = event.forwardedFrom;
    const isScreening = Boolean(event.screening);
    const sampleRate = typeof event.sampleRate === "number" && event.sampleRate > 0 ? event.sampleRate : DEFAULT_RELAY_SAMPLE_RATE;
    // A relayed native call the agent takes is a screening session, so it uses
    // the SCREENING agent (separate from the inbound agent who answers when YOU
    // dial the Twilio number). Shared with the Twilio screening path.
    const agentExtension = isScreening
      ? this.twilio.getScreeningAgentExtension()
      : this.twilio.getInboundExtension();
    const relaySessionId = this.db.id("relay");

    this.ensureSink();
    try {
      await this.hub.ensureAgentOnline(agentExtension);
      // The DB online flag can lag the live socket (same race the hub guards
      // against in its dial handler) — sync it so dial() rings instead of missing.
      if (this.hub.hasLiveConnection(agentExtension) && this.extensions.get(agentExtension)?.online !== 1) {
        this.extensions.setPresence(agentExtension, true);
      }
      const reason = isScreening
        ? `SCREENING relay call from ${callerNumber}${forwardedFrom ? ` (forwarded from ${forwardedFrom})` : ""}: ` +
          "answer politely on Kizek's behalf, find out who is calling and why, and take a message. " +
          "Do not share personal information or make commitments. Kizek is watching live and may take over."
        : `Relay call from ${callerNumber}`;
      const call = this.calls.dial({
        fromExtension: RELAY_EXTENSION,
        toExtension: agentExtension,
        reason,
        urgency: "normal"
      });
      this.hub.notifyIncomingCall(call); // universalAgent auto-accepts + greets

      if (isScreening) {
        this.screening.start({
          internalCallId: call.id,
          callSid: relaySessionId,
          callerNumber,
          forwardedFrom,
          callerExtension: RELAY_EXTENSION
        });
      }

      // If the agent never answers, don't hold the caller in silence forever.
      void this.hub.waitForCallState(call.id, ["active", "rejected", "ended", "failed", "timeout"], 45_000).then((answer) => {
        if (answer.state === "active") return;
        const current = this.calls.get(call.id);
        if (current && !TERMINAL_CALL_STATES.has(current.state)) this.hub.timeoutCall(call.id, "agent_no_answer");
      });

      const session: RelaySession = {
        ws,
        internalCallId: call.id,
        peerExtension: agentExtension,
        sampleRate,
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
      this.byInternalCallId.set(call.id, session);
      this.sessions.add(session);
      this.log?.info({ internalCallId: call.id, callerNumber, screening: isScreening, sampleRate }, "relay media stream connected");
      return session;
    } catch (error) {
      this.log?.error(
        { callerNumber, error: error instanceof Error ? error.message : "relay_dial_failed" },
        "inbound relay call could not reach an agent"
      );
      this.maybeReleaseSink();
      return undefined;
    }
  }

  // ---- relay audio -> STT pipeline -----------------------------------------

  private onMedia(session: RelaySession, event: { pcmBase64?: string }) {
    if (session.closed) return;
    const payload = event.pcmBase64;
    if (!payload) return;
    if (session.micGated) return; // half-duplex: drop relay audio while the agent speaks
    const decoded = Buffer.from(payload, "base64");
    const frame: Buffer =
      session.sampleRate !== PIPELINE_SAMPLE_RATE ? resamplePcm16(decoded, session.sampleRate, PIPELINE_SAMPLE_RATE) : decoded;
    session.preRoll.push(frame);
    if (session.preRoll.length > PRE_ROLL_FRAMES) session.preRoll.shift();
    const vadEvent = session.segmenter.accept(rmsOfPcm16Frame(frame));
    if (!session.inUtterance && vadEvent === "utterance_start") {
      session.inUtterance = true;
      this.chainIngest(session, () => {
        this.hub.ingestAudioStart(session.internalCallId, RELAY_EXTENSION, "pcm_s16le", PIPELINE_SAMPLE_RATE, 1, session.peerExtension);
        // Replay the pre-roll (already at 16k) so onset isn't clipped.
        for (const buffered of session.preRoll) {
          this.hub.ingestAudioChunk(session.internalCallId, RELAY_EXTENSION, buffered);
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
        this.hub.ingestAudioChunk(session.internalCallId, RELAY_EXTENSION, frame);
      });
    }
  }

  private finishUtterance(session: RelaySession) {
    if (!session.inUtterance) return;
    session.inUtterance = false;
    session.segmenter.reset();
    if (session.maxUtteranceTimer) clearTimeout(session.maxUtteranceTimer);
    session.maxUtteranceTimer = undefined;
    this.chainIngest(session, () => this.hub.ingestAudioEnd(session.internalCallId, RELAY_EXTENSION));
  }

  /** Serialize start/chunk/end calls per session so turns can't interleave. */
  private chainIngest(session: RelaySession, step: () => unknown) {
    session.ingestChain = session.ingestChain
      .then(() => step())
      .catch((error) => {
        this.log?.warn(
          { internalCallId: session.internalCallId, error: error instanceof Error ? error.message : "ingest_failed" },
          "relay audio ingest step failed"
        );
      });
  }

  // ---- hub events -> relay audio (the local sink) ---------------------------

  private ensureSink() {
    if (this.sinkRegistered) return;
    this.hub.registerLocalSink(RELAY_EXTENSION, (event) => this.onSinkEvent(event));
    this.sinkRegistered = true;
  }

  private maybeReleaseSink() {
    if (!this.sinkRegistered) return;
    if (this.sessions.size > 0) return;
    this.hub.unregisterLocalSink(RELAY_EXTENSION);
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
      // Should be impossible: the gateway swaps local voices for pstn-channel targets.
      this.log?.error({ callId }, "tts_local reached the relay bridge — caller will hear silence for this utterance");
      session.micGated = false;
    } else if (type === "audio_error") {
      session.micGated = false;
    } else if (type === "call_end" || type === "call_failed" || type === "call_timeout" || type === "call_reject") {
      this.endAndClose(session);
    }
  }

  private playTts(session: RelaySession, messageId: string, audio: Buffer) {
    if (session.closed || session.ws.readyState !== WebSocket.OPEN) return;
    try {
      assertValidWavBuffer(audio);
      const sampleRate = audio.readUInt32LE(24);
      const pcm = extractWavPcm(audio);
      const outPcm = resamplePcm16(pcm, sampleRate, session.sampleRate);
      // ~20ms PCM16 mono frames at the relay's rate; the relay buffers and plays
      // at line rate. Bytes per frame = (sampleRate / 50) samples * 2 bytes.
      const frameBytes = Math.max(2, Math.round(session.sampleRate / 50) * 2);
      for (let offset = 0; offset < outPcm.length; offset += frameBytes) {
        const slice = outPcm.subarray(offset, Math.min(offset + frameBytes, outPcm.length));
        session.ws.send(JSON.stringify({ kind: "media", pcmBase64: slice.toString("base64") }));
      }
      session.awaitingMark = messageId;
      session.ws.send(JSON.stringify({ kind: "mark", name: messageId }));
    } catch (error) {
      this.log?.warn(
        { internalCallId: session.internalCallId, messageId, error: error instanceof Error ? error.message : "tts_transcode_failed" },
        "failed to transcode TTS for the relay caller"
      );
      session.micGated = false;
    }
  }

  private onMark(session: RelaySession, name?: string) {
    if (!name || session.awaitingMark !== name) return;
    // The relay finished playing the agent's utterance — reopen the mic.
    session.awaitingMark = undefined;
    session.micGated = false;
    session.segmenter.reset();
    session.preRoll.length = 0;
  }

  // ---- teardown --------------------------------------------------------------

  /** Internal call ended (agent hung up / failure) — tell the relay and close. */
  private endAndClose(session: RelaySession) {
    if (session.closed) return;
    try {
      session.ws.send(JSON.stringify({ kind: "end" }));
    } catch { /* socket already dying */ }
    this.teardown(session, undefined);
    try { session.ws.close(); } catch { /* noop */ }
  }

  /** A relay `{kind:"end"}` control message — end the internal call. */
  private requestEnd(session: RelaySession, reason: string) {
    if (session.closed) return;
    const call = this.calls.get(session.internalCallId);
    if (call && !TERMINAL_CALL_STATES.has(call.state)) {
      try {
        this.hub.endCall(session.internalCallId, RELAY_EXTENSION, reason);
      } catch (error) {
        this.log?.warn(
          { internalCallId: session.internalCallId, error: error instanceof Error ? error.message : "end_failed" },
          "failed to end internal call on relay end"
        );
      }
    }
    // The resulting call_end sink event closes the session via endAndClose.
  }

  /** Relay socket gone (caller hung up / network) — end the internal call if needed. */
  private teardown(session: RelaySession, endReason: string | undefined) {
    if (session.closed) return;
    session.closed = true;
    if (session.maxUtteranceTimer) clearTimeout(session.maxUtteranceTimer);
    this.byInternalCallId.delete(session.internalCallId);
    this.sessions.delete(session);
    // Take-over: the user grabbed the call on their phone. The caller's leg is
    // still live elsewhere — ending the internal call here would drop the handoff.
    const effectiveReason = session.takeoverInProgress && endReason ? undefined : endReason;
    if (effectiveReason) {
      const call = this.calls.get(session.internalCallId);
      if (call && !TERMINAL_CALL_STATES.has(call.state)) {
        try {
          this.hub.endCall(session.internalCallId, RELAY_EXTENSION, effectiveReason);
        } catch (error) {
          this.log?.warn(
            { internalCallId: session.internalCallId, error: error instanceof Error ? error.message : "end_failed" },
            "failed to end internal call on relay teardown"
          );
        }
      }
    }
    this.maybeReleaseSink();
    this.log?.info({ internalCallId: session.internalCallId, endReason }, "relay media session closed");
  }
}
