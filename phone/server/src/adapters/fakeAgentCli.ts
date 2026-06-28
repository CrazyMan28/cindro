import { connectWs, fetchJson, send, sleep } from "./clientUtil.js";

const extension = process.env.FAKE_AGENT_EXTENSION ?? "101";
const agentId = process.env.FAKE_AGENT_ID ?? "fake-agent";
const agentToken = process.env.AGENT_TOKEN ?? "change-me-agent-token";

await fetchJson("/api/agents/register", agentToken, {
  method: "POST",
  body: JSON.stringify({
    id: agentId,
    extension,
    name: "Fake agent",
    adapterType: "fake-agent",
    capabilities: ["mcp", "calls", "demo"],
    status: "online",
    currentTask: "Waiting for calls"
  })
}).catch((error) => console.error(error.message));

const ws = connectWs(agentToken, extension, "agent");
ws.on("open", () => {
  send(ws, { type: "presence_update", extension, online: true, status: "online", currentTask: "Waiting for calls" });
  console.log(`fake agent online at extension ${extension}`);
});

ws.on("message", (raw) => {
  const event = JSON.parse(raw.toString()) as Record<string, unknown>;
  console.log("[fake-agent]", event.type);
  if (event.type === "call_end") return;
  if (event.type === "approval_request") {
    console.log(JSON.stringify(event.approval ?? event, null, 2));
  }
  if (event.type === "incoming_call") {
    const call = event.call as { id: string; from_extension: string };
    send(ws, { type: "call_accept", callId: call.id, extension });
    send(ws, {
      type: "call_message",
      callId: call.id,
      fromExtension: extension,
      toExtension: call.from_extension,
      content: "Fake agent answered. I can hear text and push-to-talk audio through the VM."
    });
  }
  if (event.type === "call_message" && typeof event.callId === "string") {
    send(ws, {
      type: "call_message",
      callId: event.callId,
      fromExtension: extension,
      toExtension: event.fromExtension,
      content: `Fake agent received: ${String(event.content ?? "")}`
    });
  }
  if (event.type === "transcript_final" && typeof event.callId === "string") {
    send(ws, {
      type: "call_message",
      callId: event.callId,
      fromExtension: extension,
      toExtension: event.fromExtension,
      content: `I transcribed you as: ${String(event.text ?? "")}`
    });
  }
});

if (process.argv.includes("--call-user")) {
  await sleep(1000);
  const result = await fetchJson("/mcp", agentToken, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "call-user",
      method: "tools/call",
      params: {
        name: "call_user",
        arguments: { from_extension: extension, reason: "Fake agent requested a user approval demo", urgency: "normal" }
      }
    })
  });
  console.log(JSON.stringify(result, null, 2));
}
