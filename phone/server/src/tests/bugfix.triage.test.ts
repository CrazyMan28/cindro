import { describe, expect, it } from "vitest";
import { AppDatabase } from "../db/database.js";
import { MessageService } from "../messaging/messageService.js";
import { validateAgentsConfig } from "../agents/agentsConfig.js";

function freshDb(): AppDatabase {
  return new AppDatabase("file::memory:");
}

function makeMessage(messages: MessageService, overrides: Record<string, unknown> = {}) {
  return messages.createMessage({
    from_extension: "101",
    to_extension: "100",
    from_type: "agent",
    to_type: "device",
    title: "Approve deploy?",
    body: "Ship build 42 to prod?",
    priority: "urgent",
    requires_response: true,
    response_options: ["approve", "deny"],
    metadata: {},
    ...overrides
  } as Parameters<MessageService["createMessage"]>[0]);
}

describe("issue #16 — duplicate replies are rejected", () => {
  it("a second reply to an already-replied message returns undefined and creates no extra row", () => {
    const db = freshDb();
    const messages = new MessageService(db);
    const msg = makeMessage(messages);

    const first = messages.replyToMessage(msg.id, { selected_option: "approve" });
    expect(first).toBeDefined();
    expect(first?.original.status).toBe("replied");

    const second = messages.replyToMessage(msg.id, { selected_option: "deny" });
    expect(second).toBeUndefined();

    // Exactly one reply row exists in the thread (original + one reply = 2 total).
    const inThread = messages.listMessages({ thread_id: msg.thread_id });
    const replies = inThread.filter((m) => db.parseJson<Record<string, unknown>>(m.metadata, {}).kind === "reply");
    expect(replies).toHaveLength(1);
    // The first reply's content survived — it was NOT overwritten by the second.
    expect(messages.getMessage(msg.id)?.selected_option).toBe("approve");
    db.close();
  });
});

describe("issue #14 — message expiration is enforced", () => {
  it("rejects a reply to a message whose deadline has passed", () => {
    const db = freshDb();
    const messages = new MessageService(db);
    const past = new Date(Date.now() - 60_000).toISOString();
    const msg = makeMessage(messages, { expires_at: past });

    const reply = messages.replyToMessage(msg.id, { selected_option: "approve" });
    expect(reply).toBeUndefined();
    // The read path flipped it to expired.
    expect(messages.getMessage(msg.id)?.status).toBe("expired");
    db.close();
  });

  it("still accepts a reply before the deadline", () => {
    const db = freshDb();
    const messages = new MessageService(db);
    const future = new Date(Date.now() + 600_000).toISOString();
    const msg = makeMessage(messages, { expires_at: future });

    const reply = messages.replyToMessage(msg.id, { selected_option: "approve" });
    expect(reply).toBeDefined();
    db.close();
  });

  it("expireDueMessages bulk-marks past-deadline messages and leaves fresh ones", () => {
    const db = freshDb();
    const messages = new MessageService(db);
    const stale = makeMessage(messages, { expires_at: new Date(Date.now() - 1_000).toISOString() });
    const fresh = makeMessage(messages, { expires_at: new Date(Date.now() + 600_000).toISOString() });
    const noDeadline = makeMessage(messages);

    const count = messages.expireDueMessages();
    expect(count).toBe(1);
    expect(messages.getMessage(stale.id)?.status).toBe("expired");
    expect(messages.getMessage(fresh.id)?.status).not.toBe("expired");
    expect(messages.getMessage(noDeadline.id)?.status).not.toBe("expired");
    db.close();
  });
});

describe("deleted threads stay deleted (tombstones)", () => {
  it("a late message carrying a deleted thread_id is rejected, not resurrected", () => {
    const db = freshDb();
    const messages = new MessageService(db);
    const msg = makeMessage(messages);
    const threadId = msg.thread_id;

    expect(messages.deleteThread(threadId)).toBe(true);
    expect(messages.isThreadDeleted(threadId)).toBe(true);

    // The late agent reply that used to re-create the conversation.
    expect(() => makeMessage(messages, { thread_id: threadId })).toThrow(/deleted/);
    expect(messages.getThread(threadId)).toBeUndefined();

    // A genuinely NEW conversation still works fine.
    const fresh = makeMessage(messages);
    expect(fresh.thread_id).not.toBe(threadId);
    db.close();
  });
});

describe("issue #18 — agent config validation surfaces problems at startup", () => {
  it("flags a stdio agent with no command as an error", () => {
    const problems = validateAgentsConfig({
      version: 1,
      agents: [
        {
          extension: "201",
          agentId: "broken",
          name: "Broken",
          adapterType: "codex-cli",
          mode: "stdio",
          command: null,
          args: [],
          enabled: true,
          timeoutSeconds: 15,
          memoryTags: ["agent-phone"],
          systemPrompt: "",
          capabilities: ["calls"]
        }
      ]
    });
    expect(problems.some((p) => p.severity === "error" && /requires a "command"/.test(p.message))).toBe(true);
  });

  it("flags a duplicate extension and an unknown adapterType label", () => {
    const base = {
      mode: "stub" as const,
      command: null,
      args: [],
      enabled: true,
      timeoutSeconds: 10,
      memoryTags: ["agent-phone"],
      systemPrompt: "",
      capabilities: ["calls"]
    };
    const problems = validateAgentsConfig({
      version: 1,
      agents: [
        { ...base, extension: "300", agentId: "a", name: "A", adapterType: "stub-echo" },
        { ...base, extension: "300", agentId: "b", name: "B", adapterType: "totally-made-up" }
      ]
    });
    expect(problems.some((p) => p.severity === "error" && /already used/.test(p.message))).toBe(true);
    expect(problems.some((p) => p.severity === "warn" && /not a known label/.test(p.message))).toBe(true);
  });

  it("passes a well-formed stdio agent", () => {
    const problems = validateAgentsConfig({
      version: 1,
      agents: [
        {
          extension: "101",
          agentId: "codex-agent",
          name: "Codex",
          adapterType: "codex-cli",
          mode: "stdio",
          command: "node",
          args: ["bridge.mjs"],
          enabled: true,
          timeoutSeconds: 30,
          memoryTags: ["agent-phone"],
          systemPrompt: "",
          capabilities: ["calls"]
        }
      ]
    });
    expect(problems.filter((p) => p.severity === "error")).toHaveLength(0);
  });
});
