import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectWs, fetchJson, send } from "./clientUtil.js";
import { inspectDangerousCommand } from "../security/dangerousCommands.js";

const execFileAsync = promisify(execFile);
const extension = process.env.TMUX_AGENT_EXTENSION ?? "102";
const agentId = process.env.TMUX_AGENT_ID ?? "tmux-agent";
const sessionName = process.env.TMUX_SESSION ?? "agent-phone";
const token = process.env.AGENT_TOKEN ?? "change-me-agent-token";

await ensureTmuxSession(sessionName);
await fetchJson("/api/agents/register", token, {
  method: "POST",
  body: JSON.stringify({
    id: agentId,
    extension,
    name: `Tmux agent (${sessionName})`,
    adapterType: "tmux-agent",
    capabilities: ["calls", "terminal", "repo-work"],
    status: "online",
    currentTask: `Attached to tmux:${sessionName}`
  })
}).catch((error) => console.error(error.message));

const ws = connectWs(token, extension, "agent");
ws.on("open", () => {
  send(ws, { type: "presence_update", extension, online: true, status: "online", currentTask: `Attached to tmux:${sessionName}` });
  console.log(`tmux agent online at extension ${extension}, session ${sessionName}`);
});
ws.on("message", async (raw) => {
  const event = JSON.parse(raw.toString()) as Record<string, unknown>;
  if (event.type === "incoming_call") {
    const call = event.call as { id: string; from_extension: string };
    const pane = await capturePane(sessionName);
    send(ws, { type: "call_accept", callId: call.id, extension });
    send(ws, { type: "call_message", callId: call.id, fromExtension: extension, toExtension: call.from_extension, content: `Tmux session ${sessionName} is attached. Recent output:\n${pane.slice(-1200)}` });
  }
  if (event.type === "terminal_input") {
    const input = String(event.input ?? "");
    const danger = inspectDangerousCommand(input);
    if (danger.dangerous) {
      send(ws, { type: "error", code: "dangerous_command_blocked", reasons: danger.reasons });
      return;
    }
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, input, "Enter"]);
  }
  if (event.type === "call_message" && typeof event.content === "string") {
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, String(event.content), "Enter"]);
  }
});

async function ensureTmuxSession(name: string) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
  } catch {
    await execFileAsync("tmux", ["new-session", "-d", "-s", name, "bash"]);
  }
}

async function capturePane(name: string) {
  try {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", name, "-S", "-200"]);
    return stdout;
  } catch (error) {
    return error instanceof Error ? error.message : "unable to read tmux pane";
  }
}
