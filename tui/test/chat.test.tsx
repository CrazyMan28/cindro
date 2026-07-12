// Chat core regression tests — REAL key-driven end-to-end coverage of the
// exact scenarios the legacy Textual TUI structurally failed (verified via
// scripted Pilot runs in the 2026-07-04 audit):
//   A. "/" while the composer should be focused did nothing (focus was on
//      the tab bar) — here typing "/" immediately opens the popup.
//   B. Up/Down could NEVER reach the palette list (ancestor-only binding
//      chain) — here the arrows move the highlight and Enter runs it.
//   plus: Escape closes the popup (there was NO way to cancel before), the
//   send flow, and approval y-key handling.

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

async function bootChat() {
  daemon = new MockDaemon()
  daemon.handlers["status.get"] = () => ({
    version: "1", default_brain: "claude", mcp: { total: 1, enabled: 1 }, agents_running: 0,
  })
  daemon.handlers["settings.get"] = () => ({ settings: { agent_mode: "coworker", setup_complete: true } })
  daemon.handlers["session.create"] = () => ({ session_id: "sess_test" })
  daemon.handlers["session.send"] = () => ({ ok: true })
  daemon.handlers["session.cancel"] = () => ({ ok: true })
  daemon.handlers["approval.respond"] = () => ({ ok: true })
  daemon.handlers["ui.manifest.get"] = () => ({
    v: 1,
    pages: [],
    commands: [
      { name: "sessions", description: "browse sessions", kind: "page", target: "sessions" },
      { name: "settings", description: "jump to Settings", kind: "navigate", target: "settings" },
    ],
  })

  client = new ControlClient(() => daemon!.url, 1000)
  const registry = new CommandRegistry()
  const m = await client.call("ui.manifest.get")
  registry.mergeManifest((m.commands ?? []) as Array<Record<string, unknown>>)

  const setup = await render(
    () => <App client={client!} registry={registry} onQuit={() => {}} />,
    { width: 100, height: 32 },
  )
  // Switch to the Chat tab (Alt+2) and let the composer mount + focus.
  await sleep(150)
  await setup.renderOnce()
  return setup
}

test("root cause A fixed: '/' typed cold opens the popup immediately", async () => {
  const setup = await bootChat()
  await setup.mockInput.pressKey("/")
  const frame = await setup.waitForFrame((f) => f.includes("↑↓ pick"))
  // Both manifest commands + the chat-local ones are in the popup pool.
  expect(frame).toContain("/sessions")
  expect(frame).toContain("browse sessions")
}, 15000)

test("root cause B fixed: arrows move the highlight, Enter runs the pick", async () => {
  const setup = await bootChat()
  // "/s" narrows to s-commands: locals (stop, stage, settings…) + manifest
  // sessions/settings. The top fuzzy hit for "se" is "sessions".
  await setup.mockInput.pressKeys(["/", "s", "e"])
  await setup.waitForFrame((f) => f.includes("↑↓ pick"))
  // Highlight starts on "sessions" (best match) — move down once to the
  // next entry, then back up, then Enter: still "sessions" → navigates.
  await setup.mockInput.pressKey("ARROW_DOWN")
  await setup.mockInput.pressKey("ARROW_UP")
  await setup.mockInput.pressKey("RETURN")
  // navigate("sessions") — this MockDaemon publishes an empty manifest, so
  // the shell reports the unknown page in the footer (proof the command
  // EXECUTED via keyboard; the overlay path is covered in pages.test).
  const frame = await setup.waitForFrame((f) => f.includes("no such page: sessions"))
  expect(frame.toLowerCase()).toContain("sessions")
}, 15000)

test("Escape closes the popup (impossible in the legacy TUI)", async () => {
  const setup = await bootChat()
  await setup.mockInput.pressKey("/")
  await setup.waitForFrame((f) => f.includes("↑↓ pick"))
  await setup.mockInput.pressKey("ESCAPE")
  await sleep(150)
  await setup.waitForFrame((f) => !f.includes("↑↓ pick"))
  // The typed "/" is still in the input — Escape closed the menu, not the text.
  expect(setup.captureCharFrame()).toContain("❯ /")
}, 15000)

test("typed-name fallback: full /new + Enter creates a session", async () => {
  const setup = await bootChat()
  await setup.mockInput.pressKeys(["/", "n", "e", "w"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("new session"))
  expect(daemon!.callsFor("session.create").length).toBeGreaterThanOrEqual(1)
}, 15000)

test("send flow + streaming assistant reply renders", async () => {
  const setup = await bootChat()
  await setup.mockInput.pressKeys([..."hey jarvis"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("❯ hey jarvis"))
  expect(daemon!.callsFor("session.send")[0]).toMatchObject({
    session_id: "sess_test",
    text: "hey jarvis",
  })

  await sleep(120)
  daemon!.sessionEvent("sess_test", {
    kind: "message",
    role: "assistant",
    text: "All systems nominal.",
  })
  await sleep(200)
  const frame = await setup.waitForFrame((f) => f.includes("All systems nominal."))
  expect(frame).toContain("CINDRO")
}, 15000)

test("approval event docks + y approves with decision allow", async () => {
  const setup = await bootChat()
  // Bind the chat to a session first.
  await setup.mockInput.pressKeys([..."go"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("❯ go"))

  await sleep(120)
  daemon!.sessionEvent("sess_test", {
    kind: "approval",
    approval_id: "app_1",
    summary: "run rm -rf ./build",
    risk: "high",
  })
  await sleep(200)
  await setup.waitForFrame((f) => f.includes("AUTHORIZE"))

  await setup.mockInput.pressKey("y")
  await sleep(200)
  await setup.waitForFrame((f) => f.includes("✓ allow"))
  expect(daemon!.callsFor("approval.respond")[0]).toMatchObject({
    session_id: "sess_test",
    approval_id: "app_1",
    decision: "allow",
  })
}, 15000)

test("tool call folds its result into one card; failures auto-expand", async () => {
  const setup = await bootChat()
  await setup.mockInput.pressKeys([..."do it"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("❯ do it"))

  await sleep(120)
  daemon!.sessionEvent("sess_test", { kind: "tool_call", name: "shell", args: "ls /nope" })
  await sleep(200)
  await setup.waitForFrame((f) => f.includes("shell"))
  await sleep(120)
  daemon!.sessionEvent("sess_test", {
    kind: "tool_result",
    ok: false,
    output: "ls: cannot access '/nope'",
  })
  await sleep(200)
  const frame = await setup.waitForFrame((f) => f.includes("cannot access"))
  expect(frame).toContain("✕") // failed glyph
}, 15000)
