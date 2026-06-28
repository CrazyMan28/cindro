import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { AgentsConfigFileSchema, loadAgentsConfig, summarizeAgent } from "../agents/agentsConfig.js";
import { AgentRegistry } from "../agents/agentRegistry.js";
import { AgentRunner } from "../agents/agentRunner.js";
import { loadConfig } from "../config.js";
import { AppDatabase } from "../db/database.js";

describe("agents config", () => {
  it("validates a well-formed config", () => {
    const file = {
      version: 1,
      agents: [
        {
          extension: "999",
          agentId: "test-agent",
          name: "Test",
          adapterType: "stub",
          mode: "stub",
          command: null,
          enabled: true,
          timeoutSeconds: 5,
          memoryTags: ["agent-phone", "test"],
          systemPrompt: "",
          capabilities: ["calls"]
        }
      ]
    };
    const parsed = AgentsConfigFileSchema.parse(file);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]?.extension).toBe("999");
  });

  it("ships a usable default config covering 103/104/105/106", () => {
    // The shipped repo config should parse and include the four named agents
    // the user expects.
    const file = loadAgentsConfig();
    expect(file.version).toBe(1);
    const exts = file.agents.map((a) => a.extension);
    for (const required of ["103", "104", "105", "106"]) {
      expect(exts).toContain(required);
    }
  });

  it("summarizes an agent into one line", () => {
    const agent = {
      extension: "201",
      agentId: "x",
      name: "X",
      adapterType: "stub",
      mode: "stub" as const,
      command: null,
      args: [],
      cwd: null,
      enabled: true,
      timeoutSeconds: 5,
      memoryTags: [],
      systemPrompt: "",
      capabilities: []
    };
    const line = summarizeAgent(agent);
    expect(line).toMatch(/201 X \[stub\]/);
  });
});

describe("agent registry + runner", () => {
  let tmpDir: string;
  let configPath: string;
  let db: AppDatabase;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-phone-test-"));
    configPath = path.join(tmpDir, "agents.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            extension: "991",
            agentId: "stub-test-agent",
            name: "Stub Test",
            adapterType: "stub",
            mode: "stub",
            command: null,
            enabled: true,
            timeoutSeconds: 5,
            memoryTags: ["agent-phone", "test"],
            systemPrompt: "",
            capabilities: ["calls"]
          },
          {
            extension: "992",
            agentId: "broken-test-agent",
            name: "Broken",
            adapterType: "stdio",
            mode: "stdio",
            command: "/definitely/does/not/exist/please",
            args: [],
            enabled: true,
            timeoutSeconds: 2,
            memoryTags: ["agent-phone"],
            systemPrompt: "",
            capabilities: ["calls"]
          }
        ]
      })
    );
    process.env.AGENTS_CONFIG_PATH = configPath;
    db = new AppDatabase("file::memory:");
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("seeds extensions for every configured agent", () => {
    const registry = new AgentRegistry(loadAgentsConfig(configPath));
    registry.seed(db);
    const row = db.sqlite.prepare("SELECT * FROM extensions WHERE extension = ?").get("991") as { name?: string } | undefined;
    expect(row?.name).toBe("Stub Test");
  });

  it("lookups by extension", () => {
    const registry = new AgentRegistry(loadAgentsConfig(configPath));
    expect(registry.lookup("991")?.name).toBe("Stub Test");
    expect(registry.lookup("404")).toBeUndefined();
  });

  it("reports an actionable error when the agent command does not exist", async () => {
    const registry = new AgentRegistry(loadAgentsConfig(configPath));
    const config = loadConfig({
      DATABASE_URL: "file::memory:",
      ADMIN_TOKEN: "admin-token-test",
      DEVICE_TOKEN: "device-token-test",
      AGENT_TOKEN: "agent-token-test",
      LOG_LEVEL: "silent",
      MISTRAL_REAL_AUDIO: "false"
    });
    // Pretend the extension never reports online so we exercise the timeout
    // branch even if the child process accidentally starts.
    const runner = new AgentRunner(registry, config, () => false);
    const result = await runner.ensureRunning("992");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/(did not come online|exited)/);
    runner.killAll();
  });

  it("returns ok when the extension is already reported online", async () => {
    const registry = new AgentRegistry(loadAgentsConfig(configPath));
    const config = loadConfig({
      DATABASE_URL: "file::memory:",
      ADMIN_TOKEN: "admin-token-test",
      DEVICE_TOKEN: "device-token-test",
      AGENT_TOKEN: "agent-token-test",
      LOG_LEVEL: "silent",
      MISTRAL_REAL_AUDIO: "false"
    });
    const runner = new AgentRunner(registry, config, () => true);
    const result = await runner.ensureRunning("991");
    expect(result.ok).toBe(true);
  });

  it("rejects extensions that are not in the registry", async () => {
    const registry = new AgentRegistry(loadAgentsConfig(configPath));
    const config = loadConfig({
      DATABASE_URL: "file::memory:",
      ADMIN_TOKEN: "admin-token-test",
      DEVICE_TOKEN: "device-token-test",
      AGENT_TOKEN: "agent-token-test",
      LOG_LEVEL: "silent",
      MISTRAL_REAL_AUDIO: "false"
    });
    const runner = new AgentRunner(registry, config, () => false);
    const result = await runner.ensureRunning("404");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a configured agent/);
  });
});
