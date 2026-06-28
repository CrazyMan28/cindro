import type { ExtensionInput } from "../extensions/extensionService.js";

export const DEMO_EXTENSIONS: ExtensionInput[] = [
  {
    extension: "100",
    ownerType: "device",
    ownerId: "android-user",
    name: "Android/User device",
    permissions: { canReceiveAgentCalls: true, canDialAgents: true },
    allowedCallers: [],
    metadata: { role: "primary-user-device" }
  },
  {
    extension: "101",
    ownerType: "agent",
    ownerId: "codex-agent",
    name: "Codex",
    permissions: { canCallUser: true, needsApprovalForDangerousCommands: true },
    allowedCallers: [],
    metadata: { adapter: "codex-cli" }
  },
  {
    extension: "103",
    ownerType: "agent",
    ownerId: "copilot-agent",
    name: "Copilot",
    permissions: { canCallUser: true, needsApprovalForDangerousCommands: true },
    allowedCallers: [],
    metadata: { adapter: "copilot-cli" }
  },
  {
    extension: "104",
    ownerType: "agent",
    ownerId: "fake-echo-agent",
    name: "Echo (built-in test)",
    permissions: { canCallUser: true },
    allowedCallers: [],
    metadata: { adapter: "stub-echo" }
  },
  {
    extension: "700",
    ownerType: "device",
    ownerId: "twilio-pstn",
    name: "Phone (PSTN)",
    permissions: { canReceiveAgentCalls: true, canDialAgents: true },
    allowedCallers: [],
    metadata: { channel: "pstn" }
  },
  {
    extension: "702",
    ownerType: "device",
    ownerId: "bt-relay",
    name: "Phone (BT Relay)",
    permissions: { canReceiveAgentCalls: true, canDialAgents: true },
    allowedCallers: [],
    metadata: { channel: "pstn" }
  },
  {
    extension: "900",
    ownerType: "group",
    ownerId: "emergency-broadcast",
    name: "Emergency / All Agents",
    permissions: { broadcast: true },
    allowedCallers: ["100"],
    metadata: { role: "emergency-group" }
  }
];

export const DEMO_AGENTS = [
  {
    id: "codex-agent",
    extension: "101",
    name: "Codex",
    adapterType: "codex-cli",
    permissions: { needsApprovalForDangerousCommands: true },
    capabilities: ["calls", "terminal", "repo-work"],
    status: "offline",
    currentTask: "Primary phone agent (auto-spawn on dial)"
  },
  {
    id: "copilot-agent",
    extension: "103",
    name: "Copilot",
    adapterType: "copilot-cli",
    permissions: { needsApprovalForDangerousCommands: true },
    capabilities: ["calls", "terminal", "repo-work"],
    status: "offline",
    currentTask: "Attach to Copilot CLI session"
  },
  {
    id: "fake-echo-agent",
    extension: "104",
    name: "Echo (built-in test)",
    adapterType: "stub-echo",
    permissions: {},
    capabilities: ["calls", "test"],
    status: "offline",
    currentTask: "Echo responder"
  }
];
