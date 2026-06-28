import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectWs, fetchJson, send } from "./clientUtil.js";

const execFileAsync = promisify(execFile);
const extension = process.env.COPILOT_AGENT_EXTENSION ?? "104";
const agentId = process.env.COPILOT_AGENT_ID ?? "copilot-agent";
const sessionName = process.env.COPILOT_TMUX_SESSION ?? "copilot-agent-phone";
const token = process.env.AGENT_TOKEN ?? "change-me-agent-token";
const repoPath = process.env.COPILOT_REPO_PATH ?? process.cwd();
const command = process.env.COPILOT_COMMAND ?? "gh copilot suggest";

await ensureTmuxSession(sessionName, repoPath, command);
await fetchJson("/api/agents/register", token, {
  method: "POST",
  body: JSON.stringify({ id: agentId, extension, name: "Copilot CLI adapter", adapterType: "copilot-cli", capabilities: ["calls", "terminal", "repo-work"], status: "online", currentTask: `Attached command: ${command}` })
}).catch((error) => console.error(error.message));

const ws = connectWs(token, extension, "agent");
ws.on("open", () => {
  send(ws, { type: "presence_update", extension, online: true, status: "online", currentTask: `Attached command: ${command}` });
  console.log(`Copilot adapter online at extension ${extension}; tmux session ${sessionName}`);
});
ws.on("message", async (raw) => {
  const event = JSON.parse(raw.toString()) as Record<string, unknown>;
  if (event.type === "incoming_call") {
    const call = event.call as { id: string; from_extension: string };
    const pane = await capturePane(sessionName);
    send(ws, { type: "call_accept", callId: call.id, extension });
    send(ws, { type: "call_message", callId: call.id, fromExtension: extension, toExtension: call.from_extension, content: `Copilot adapter is attached to ${repoPath}.\nRecent session:\n${pane.slice(-1200)}` });
  }
  if (event.type === "call_message") {
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, String(event.content ?? ""), "Enter"]);
  }
});

async function ensureTmuxSession(name: string, cwd: string, startCommand: string) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
  } catch {
    await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, startCommand]);
  }
}

async function capturePane(name: string) {
  try {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", name, "-S", "-200"]);
    return stdout;
  } catch (error) {
    return error instanceof Error ? error.message : "unable to read Copilot tmux pane";
  }
}
