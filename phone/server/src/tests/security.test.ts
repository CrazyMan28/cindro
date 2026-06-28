import { describe, expect, it } from "vitest";
import { inspectDangerousCommand } from "../security/dangerousCommands.js";

describe("dangerous command policy", () => {
  it("detects dangerous commands that require approval", () => {
    expect(inspectDangerousCommand("sudo systemctl restart ssh").dangerous).toBe(true);
    expect(inspectDangerousCommand("git push origin main --force").dangerous).toBe(true);
    expect(inspectDangerousCommand("tailscale funnel 8787").dangerous).toBe(true);
  });

  it("allows routine commands", () => {
    expect(inspectDangerousCommand("npm test").dangerous).toBe(false);
  });
});
