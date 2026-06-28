import type { MessageRow, MessageService } from "../messaging/messageService.js";
import type { TwilioService } from "../twilio/twilioService.js";
import { PSTN_EXTENSION } from "../twilio/twilioBridge.js";

/**
 * Two-way "text your agent" over SMS — the OUTBOUND half.
 *
 * Inbound SMS is routed (in webhooks.ts) to the selected agent as a normal
 * message addressed FROM the PSTN extension (700) into a per-number thread. The
 * agent answers like any text chat, replying back to ext 700 in the SAME thread.
 * This hook — wired into {@link WebSocketHub.notifyNewMessage} so it sees every
 * delivered message — spots those agent replies and texts them back to the
 * original phone number via Twilio.
 *
 * It is deliberately defensive: any failure is swallowed so a bad SMS send can
 * never break in-app message delivery.
 */
export function createOutboundSmsHook(deps: {
  messages: MessageService;
  twilio: TwilioService;
  onSent?: (toNumber: string, messageId: string) => void;
  onError?: (error: unknown, messageId: string) => void;
}): (message: MessageRow) => void {
  const { messages, twilio, onSent, onError } = deps;
  return (message: MessageRow) => {
    try {
      // Only replies headed for the PSTN leg, and never the inbound SMS itself.
      if (message.to_extension !== PSTN_EXTENSION) return;
      if (message.from_extension === PSTN_EXTENSION) return;
      const body = (message.body ?? "").trim();
      if (!body) return;
      // The phone number lives on the inbound message's metadata, in the same
      // thread. If this thread isn't an SMS thread, there's nothing to send.
      const toNumber = resolveSmsNumber(messages, message.thread_id);
      if (!toNumber) return;
      void twilio
        .sendSms({ toNumber, body, messageId: message.id })
        .then(() => onSent?.(toNumber, message.id))
        .catch((error) => onError?.(error, message.id));
    } catch (error) {
      onError?.(error, message.id);
    }
  };
}

/** Find the sender's phone number recorded on the SMS thread's inbound message. */
function resolveSmsNumber(messages: MessageService, threadId: string): string | undefined {
  if (!threadId) return undefined;
  const rows = messages.listMessages({ thread_id: threadId, limit: 100 });
  for (const row of rows) {
    try {
      const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      if (meta.channel === "sms" && typeof meta.from_number === "string" && meta.from_number) {
        return meta.from_number;
      }
    } catch {
      /* ignore malformed metadata */
    }
  }
  return undefined;
}
