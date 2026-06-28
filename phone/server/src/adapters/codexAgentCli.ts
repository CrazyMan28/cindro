import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectWs, fetchJson, send } from "./clientUtil.js";

const execFileAsync = promisify(execFile);
const extension = process.env.CODEX_AGENT_EXTENSION ?? "103";
const agentId = process.env.CODEX_AGENT_ID ?? "codex-agent";
const sessionName = process.env.CODEX_TMUX_SESSION ?? "codex-agent-phone";
const token = process.env.AGENT_TOKEN ?? "change-me-agent-token";
const repoPath = process.env.CODEX_REPO_PATH ?? process.cwd();
const task = process.env.CODEX_TASK ?? "Attached Codex CLI session";

await ensureTmuxSession(sessionName, repoPath, "codex");
await fetchJson("/api/agents/register", token, {
  method: "POST",
  body: JSON.stringify({ id: agentId, extension, name: "Codex adapter", adapterType: "codex-cli", capabilities: ["calls", "terminal", "repo-work"], status: "online", currentTask: task })
}).catch((error) => console.error(error.message));

const ws = connectWs(token, extension, "agent");
ws.on("open", () => {
  send(ws, { type: "presence_update", extension, online: true, status: "online", currentTask: task });
  console.log(`Codex adapter online at extension ${extension}; tmux session ${sessionName}`);
});
ws.on("message", async (raw) => {
  const event = JSON.parse(raw.toString()) as Record<string, unknown>;
  if (event.type === "incoming_call") {
    const call = event.call as { id: string; from_extension: string };
    const pane = await capturePane(sessionName);
    send(ws, { type: "call_accept", callId: call.id, extension });
    send(ws, { type: "call_message", callId: call.id, fromExtension: extension, toExtension: call.from_extension, content: `Codex adapter is attached to ${repoPath}.\nRecent session:\n${pane.slice(-1200)}` });
  }
  if (event.type === "call_message") {
    const content = String(event.content ?? "");
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, content, "Enter"]);
  }
});

async function ensureTmuxSession(name: string, cwd: string, command: string) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
  } catch {
    await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, command]);
  }
}

async function capturePane(name: string) {
  try {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", name, "-S", "-200"]);
    return stdout;
  } catch (error) {
    return error instanceof Error ? error.message : "unable to read Codex tmux pane";
  }
}
