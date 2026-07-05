// Computer + Browser page e2e: the co-worker start flow sends the GUI's
// exact session.create params, TAKE OVER is gated behind the amber confirm
// (Yes proceeds, Esc aborts — the legacy TUI fired target:"real" bare),
// approvals answer through the SessionController, and the browser drives
// the engine's /browser/* REST surface (Bun.serve stub) with the
// stale-session guard + selectable snapshot rows the legacy TUI never wired.

import { render } from "./render"
import { afterEach, expect, test } from "bun:test"

import type { AppApi } from "../src/app-context"
import { AppContext } from "../src/app-context"
import { CommandRegistry } from "../src/commands/registry"
import { ControlClient } from "../src/control/client"
import { coworkSessionId, setCoworkSessionId } from "../src/engine"
import { BrowserPage } from "../src/pages/Browser"
import { ComputerPage } from "../src/pages/Computer"
import { MockDaemon } from "./mock-daemon"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let daemon: MockDaemon | undefined
let client: ControlClient | undefined
let stub: EngineStub | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
  daemon?.stop()
  daemon = undefined
  stub?.server.stop(true)
  stub = undefined
  setCoworkSessionId("")
})

// -- engine REST stub (the per-session computer-use engine's /browser/*) ------
interface EngineStub {
  calls: Array<{ path: string; body: Record<string, unknown>; auth: string }>
  server: ReturnType<typeof Bun.serve>
  port: number
}

function startEngineStub(): EngineStub {
  const calls: EngineStub["calls"] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url)
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      calls.push({ path: u.pathname, body, auth: req.headers.get("authorization") ?? "" })
      if (u.pathname === "/browser/snapshot")
        return Response.json({
          url: "https://example.com/",
          title: "Example Domain",
          nodes: [
            { ref: "e1", role: "link", name: "Home" },
            { ref: "e2", role: "button", name: "Sign in" },
          ],
        })
      return Response.json({
        url: "https://example.com/",
        title: "Example Domain",
        can_back: true,
        can_forward: false,
      })
    },
  })
  return { calls, server, port: server.port ?? 0 }
}

// -- boot harness --------------------------------------------------------------
async function boot(which: "computer" | "browser", active: () => boolean = () => true) {
  daemon = new MockDaemon()
  stub = startEngineStub()
  daemon.handlers["settings.get"] = () => ({
    settings: {
      brains: ["codex", "claude"],
      available_brains: { codex: true, claude: false },
      default_brain: "codex",
    },
  })
  daemon.handlers["model.list"] = () => ({ models: ["gpt-5.5", "o4-mini"] })
  daemon.handlers["session.create"] = () => ({ session_id: "sess_cw" })
  daemon.handlers["session.history"] = () => ({ events: [] })
  daemon.handlers["session.cancel"] = () => ({ ok: true })
  daemon.handlers["approval.respond"] = () => ({ ok: true })
  daemon.handlers["agent_desktop.info"] = (p) =>
    p.session_id === "sess_cw"
      ? { up: true, port: stub!.port, bearer: "tkn-123", session_id: p.session_id }
      : {
          __error: {
            code: "no_agent_desktop",
            message: `no nested agent desktop for session: ${String(p.session_id)}`,
          },
        }

  client = new ControlClient(() => daemon!.url, 1000)
  const api: AppApi = {
    client,
    registry: new CommandRegistry(),
    page: () => which,
    navigate: () => {},
    notify: () => {},
    quit: () => {},
  }
  const setup = await render(
    () => (
      <AppContext.Provider value={api}>
        {which === "computer" ? (
          <ComputerPage active={active} />
        ) : (
          <BrowserPage active={active} />
        )}
      </AppContext.Provider>
    ),
    { width: 110, height: 34 },
  )
  await sleep(200)
  await setup.renderOnce()
  return setup
}

// ===== Computer ================================================================

test("computer: 'a' starts a co-worker on the AGENT desktop with the GUI's params", async () => {
  const setup = await boot("computer")
  expect(setup.captureCharFrame()).toContain("no active co-work session")

  await setup.mockInput.pressKey("a")
  await sleep(250)
  const frame = await setup.waitForFrame((f) => f.includes("sess_cw"))
  expect(frame).toContain("agent desktop")
  // Bridge.cpp startCoworker parity: profile+target plus the picked brain/model.
  expect(daemon!.callsFor("session.create")[0]).toEqual({
    profile: "coworker",
    target: "agent",
    brain: "codex",
    model: "gpt-5.5",
  })
  expect(coworkSessionId()).toBe("sess_cw")
  expect(frame).not.toContain("DRIVING REAL SCREEN")
}, 15000)

test("computer: 'w' opens the take-over confirm; Esc aborts with NO session.create", async () => {
  const setup = await boot("computer")
  await setup.mockInput.pressKey("w")
  const frame = await setup.waitForFrame((f) => f.includes("TAKE OVER MY SCREEN"))
  expect(frame).toContain("Yes — drive my real screen")
  expect(frame).toContain("Cancel")
  expect(daemon!.callsFor("session.create").length).toBe(0)

  await setup.mockInput.pressKey("ESCAPE")
  await sleep(150)
  await setup.waitForFrame((f) => !f.includes("Yes — drive my real screen"))
  expect(daemon!.callsFor("session.create").length).toBe(0)
}, 15000)

test("computer: take-over proceeds to session.create target:'real' only on Yes", async () => {
  const setup = await boot("computer")
  await setup.mockInput.pressKey("w")
  await setup.waitForFrame((f) => f.includes("TAKE OVER MY SCREEN"))
  await sleep(200) // clear the confirm's mount-grace window
  await setup.mockInput.pressKey("RETURN") // "Yes — drive my real screen"
  await sleep(250)
  expect(daemon!.callsFor("session.create")[0]).toMatchObject({
    profile: "coworker",
    target: "real",
  })
  const frame = await setup.waitForFrame((f) => f.includes("DRIVING REAL SCREEN"))
  expect(frame).toContain("sess_cw")
}, 15000)

test("computer: approval card docks and y answers allow via approval.respond", async () => {
  const setup = await boot("computer")
  await setup.mockInput.pressKey("a")
  await sleep(250) // session.create + subscribe round-trips
  await setup.waitForFrame((f) => f.includes("sess_cw"))

  await sleep(150)
  daemon!.sessionEvent("sess_cw", {
    kind: "approval",
    approval_id: "ap_1",
    summary: "click Deploy in the agent browser",
    risk: "high",
  })
  await sleep(200)
  await setup.waitForFrame((f) => f.includes("AUTHORIZE"))

  await setup.mockInput.pressKey("y")
  await sleep(200)
  await setup.waitForFrame((f) => f.includes("✓ allow"))
  expect(daemon!.callsFor("approval.respond")[0]).toMatchObject({
    session_id: "sess_cw",
    approval_id: "ap_1",
    decision: "allow",
  })
}, 15000)

test("computer: keys are inert while the page is inactive", async () => {
  const setup = await boot("computer", () => false)
  await setup.mockInput.pressKey("a")
  await setup.mockInput.pressKey("w")
  await sleep(250)
  expect(daemon!.callsFor("session.create").length).toBe(0)
  expect(setup.captureCharFrame()).not.toContain("TAKE OVER MY SCREEN")
}, 15000)

// ===== Browser =================================================================

test("browser: offline state, then snapshot rows render and Enter clicks the selected ref", async () => {
  const setup = await boot("browser")
  expect(setup.captureCharFrame()).toContain("NO LIVE SESSION")

  setCoworkSessionId("sess_cw")
  await sleep(150)
  await setup.mockInput.pressKey("r")
  await sleep(250)
  const frame = await setup.waitForFrame((f) => f.includes("[e1] link: Home"))
  expect(frame).toContain("[e2] button: Sign in")
  expect(frame).toContain("Example Domain")

  await setup.mockInput.pressKey("ARROW_DOWN") // select row 2 (e2)
  await sleep(120)
  await setup.mockInput.pressKey("RETURN")
  await sleep(300)
  const click = stub!.calls.find((c) => c.path === "/browser/click")
  expect(click).toBeDefined()
  expect(click!.body).toEqual({ ref: "e2" })
  expect(click!.auth).toBe("Bearer tkn-123") // per-session engine bearer
}, 15000)

test("browser: g edits the URL and Enter navigates with the https:// auto-prefix", async () => {
  const setup = await boot("browser")
  setCoworkSessionId("sess_cw")
  await sleep(150)

  await setup.mockInput.pressKey("g")
  await sleep(150) // focus lands on the next tick (mount-grace analog)
  await setup.mockInput.pressKeys([..."example.com"])
  await setup.mockInput.pressKey("RETURN")
  await sleep(300)
  const nav = stub!.calls.find((c) => c.path === "/browser/navigate")
  expect(nav).toBeDefined()
  expect(nav!.body).toEqual({ url: "https://example.com" })
  // typed characters must NOT have leaked into page keys (no back/forward)
  expect(stub!.calls.some((c) => c.path === "/browser/back")).toBe(false)
  expect(stub!.calls.some((c) => c.path === "/browser/forward")).toBe(false)
  await setup.waitForFrame((f) => f.includes("Example Domain"))
}, 15000)

test("browser: engine resolution failure is VISIBLE, never silently swallowed", async () => {
  const setup = await boot("browser")
  setCoworkSessionId("sess_gone") // agent_desktop.info fails for this id
  await sleep(150)
  await setup.mockInput.pressKey("r")
  await sleep(250)
  const frame = await setup.waitForFrame((f) => f.includes("no_agent_desktop"))
  expect(frame).toContain("✖")
  expect(stub!.calls.length).toBe(0) // never reached the engine
}, 15000)
