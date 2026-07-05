// Pages-engine e2e: the manifest drives real screens — /sessions opens the
// generic TablePage overlay filled from session.list, Escape closes it,
// custom pages appear as live tabs, and a widget DSL spec renders inline in
// chat with its interactive parts.

import { afterEach, expect, test } from "bun:test"

import { render } from "./render"
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

const MANIFEST = {
  v: 1,
  pages: [
    {
      id: "sessions",
      title: "Sessions",
      section: "workspace",
      kind: "table",
      data: { list: { verb: "session.list", result_key: "sessions" } },
      columns: [
        { key: "title", label: "Title" },
        { key: "state", label: "State" },
        { key: "updated", label: "Updated", format: "reltime" },
      ],
      row_actions: [
        {
          id: "delete",
          label: "Delete",
          kind: "verb",
          verb: "session.delete",
          params: { session_id: "$id" },
          confirm: true,
        },
      ],
    },
    {
      id: "buildlog",
      title: "Build Log",
      section: "custom",
      kind: "markdown",
      source: "custom",
      config: { text: "# build ok\neverything green" },
      order: 0,
    },
  ],
  commands: [
    { name: "sessions", description: "browse sessions", kind: "page", target: "sessions" },
  ],
}

async function boot() {
  daemon = new MockDaemon()
  daemon.handlers["settings.get"] = () => ({ settings: { agent_mode: "coworker", setup_complete: true } })
  daemon.handlers["status.get"] = () => ({ version: "1", default_brain: "claude", mcp: {}, agents_running: 0 })
  daemon.handlers["session.create"] = () => ({ session_id: "sess_test" })
  daemon.handlers["session.send"] = () => ({ ok: true })
  daemon.handlers["ui.manifest.get"] = () => MANIFEST
  daemon.handlers["session.list"] = () => ({
    sessions: [
      { id: "s1", title: "fix the tui", state: "idle", updated: Date.now() - 60000 },
      { id: "s2", title: "phone wave", state: "running", updated: Date.now() },
    ],
  })

  client = new ControlClient(() => daemon!.url, 1000)
  const registry = new CommandRegistry()
  const m = await client.call("ui.manifest.get")
  registry.mergeManifest((m.commands ?? []) as Array<Record<string, unknown>>)

  const setup = await render(
    () => <App client={client!} registry={registry} onQuit={() => {}} />,
    { width: 110, height: 34 },
  )
  await sleep(200)
  await setup.renderOnce()
  return setup
}

test("custom manifest pages appear as live tabs and render", async () => {
  const setup = await boot()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("✦Build Log")
}, 15000)

test("/sessions opens the generic TablePage overlay with daemon rows; Esc closes", async () => {
  const setup = await boot()
  // chat tab → /sessions via the popup's typed-name path
  await setup.mockInput.pressKey("2", { meta: true })
  await sleep(120)
  await setup.mockInput.pressKeys([..."/sessions"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("// SESSIONS"))
  await sleep(200) // rows land one ws roundtrip after the header paints
  const frame = await setup.waitForFrame((f) => f.includes("fix the tui"))
  expect(frame).toContain("phone wave")
  expect(frame).toContain("1m ago")
  expect(daemon!.callsFor("session.list").length).toBeGreaterThanOrEqual(1)

  await setup.mockInput.pressKey("ESCAPE")
  await sleep(150)
  await setup.waitForFrame((f) => !f.includes("// SESSIONS"))
}, 15000)

test("row action menu: Enter opens actions, confirm step guards delete", async () => {
  const setup = await boot()
  daemon!.handlers["session.delete"] = () => ({ ok: true })
  await setup.mockInput.pressKey("2", { meta: true })
  await sleep(120)
  await setup.mockInput.pressKeys([..."/sessions"])
  await setup.mockInput.pressKey("RETURN")
  await sleep(200)
  await setup.waitForFrame((f) => f.includes("fix the tui"))

  await setup.mockInput.pressKey("RETURN") // action menu for row 0
  await setup.waitForFrame((f) => f.includes("ACTIONS"))
  await sleep(200) // clear the picker's mount-grace window
  await setup.mockInput.pressKey("RETURN") // pick "Delete" → confirm step
  await setup.waitForFrame((f) => f.includes("CONFIRM: Delete?"))
  await sleep(200)
  await setup.mockInput.pressKey("RETURN") // "Yes"
  await sleep(250)
  expect(daemon!.callsFor("session.delete")[0]).toEqual({ session_id: "s1" })
}, 15000)

test("widget DSL renders inline in chat (text/progress/badge/button)", async () => {
  const setup = await boot()
  await setup.mockInput.pressKey("2", { meta: true })
  await sleep(120)
  await setup.mockInput.pressKeys([..."hi"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("❯ hi"))

  // The chat widget item is session-scoped, so the session must exist before
  // the broadcast — session.send only fires AFTER session.create resolves,
  // so waiting for it guarantees sessionId() is set (avoids a load race).
  await setup.waitFor(() => daemon!.callsFor("session.send").length > 0)
  await sleep(120)
  const widget = {
    session_id: "sess_test",
    title: "deploy status",
    spec: {
      type: "column",
      children: [
        { type: "text", text: "deploy pipeline", bold: true },
        { type: "progress", value: 0.5 },
        { type: "badge", text: "LIVE" },
        { type: "button", text: "redeploy", action: { send: "redeploy now" } },
        { type: "button", text: "evil", action: { eval: "rm -rf /" } },
      ],
    },
  }
  // Re-broadcast each pass (idempotent: the store updates by id) so a
  // broadcast that raced the subscription can't leave the test hung, and
  // drive explicit render passes since the push doesn't always auto-schedule
  // a repaint under suite load. The content is always correct once it lands.
  let frame = ""
  for (let i = 0; i < 80 && !frame.includes("deploy pipeline"); i++) {
    daemon!.broadcast("widget.render", widget)
    await sleep(25)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
  }
  expect(frame).toContain("◆ CANVAS · deploy status")
  expect(frame).toContain("50%")
  expect(frame).toContain("LIVE")
  expect(frame).toContain("redeploy")
}, 15000)
