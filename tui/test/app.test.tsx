// App shell smoke test — mounts the REAL <App/> tree against a MockDaemon
// through OpenTUI's test renderer and asserts the painted frame: topbar
// identity, live status.get telemetry (not the GUI's old hardcoded
// mcpCount), the tab strip, and Home's manifest-driven page directory.

import { render } from "./render"
import { afterEach, expect, test } from "bun:test"

import { App } from "../src/app"
import { CommandRegistry } from "../src/commands/registry"
import { ControlClient } from "../src/control/client"
import { MockDaemon } from "./mock-daemon"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let daemon: MockDaemon | undefined
let client: ControlClient | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
  daemon?.stop()
  daemon = undefined
})

test("shell boots: topbar telemetry + tabs + manifest pages render", async () => {
  daemon = new MockDaemon()
  daemon.handlers["status.get"] = () => ({
    version: "9.9.9",
    default_brain: "claude",
    mcp: { total: 4, enabled: 3 },
    agents_running: 2,
    sessions_live: 1,
  })
  daemon.handlers["settings.get"] = () => ({
    settings: { agent_mode: "coworker", user_name: "Issac", setup_complete: true },
  })
  daemon.handlers["ui.manifest.get"] = () => ({
    v: 1,
    pages: [
      { id: "home", title: "Home", section: "workspace", kind: "bespoke" },
      { id: "sessions", title: "Sessions", section: "workspace", kind: "table" },
      { id: "errorlog", title: "Error Log", section: "custom", kind: "log", source: "custom" },
    ],
    commands: [
      { name: "sessions", description: "browse sessions", kind: "page", target: "sessions" },
    ],
  })

  client = new ControlClient(() => daemon!.url, 1000)
  const registry = new CommandRegistry()

  const setup = await render(
    () => <App client={client!} registry={registry} onQuit={() => {}} />,
    { width: 100, height: 30 },
  )

  // Let the client connect and the topbar/home fetches resolve.
  await sleep(600)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()

  expect(frame).toContain("J.A.R.V.I.S")
  expect(frame).toContain("jarvisd v9.9.9")
  expect(frame).toContain("MCP 3/4") // LIVE telemetry, not hardcoded
  expect(frame).toContain("AGENTS 2")
  expect(frame).toContain("mode: coworker")
  expect(frame).toContain("LINK")
  expect(frame).toContain("2:Chat") // tab strip
  expect(frame).toContain("Good") // greeting
  expect(frame).toContain("Issac")
  expect(frame).toContain("// WORKSPACE") // manifest section
  expect(frame).toContain("Error Log") // custom page in the directory
  expect(frame).toContain("✦ custom")
})
