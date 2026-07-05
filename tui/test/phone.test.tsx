// Phone-hub e2e — PhonePage + CallOverlay mounted against a MockDaemon that
// answers the phone.mcp / phone.http proxy verbs with the SAME response
// shapes as cli/tests/harness.py's _handle_phone_mcp/_handle_phone_http
// (which mirror the daemon's handlePhoneMcp/handlePhoneHttp). Covers the
// four contract scenarios: dial-extension flow, incoming-call banner +
// accept, screening transcript render, and the red-alert confirm step.

import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"

import type { AppApi } from "../src/app-context"
import { AppContext } from "../src/app-context"
import { CommandRegistry } from "../src/commands/registry"
import { ControlClient } from "../src/control/client"
import { CallOverlay } from "../src/phone/CallOverlay"
import { PhonePage } from "../src/phone/PhonePage"
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

interface PhoneState {
  activeCalls: Array<Record<string, unknown>>
  screening: Record<string, unknown>
  transcripts: Record<string, unknown>
  extensions: Array<Record<string, unknown>>
  inbox: Array<Record<string, unknown>>
  threads: Record<string, unknown>
}

function freshState(over: Partial<PhoneState> = {}): PhoneState {
  return {
    activeCalls: [],
    screening: { active: false },
    transcripts: {},
    extensions: [],
    inbox: [],
    threads: {},
    ...over,
  }
}

/** phone.mcp / phone.http stand-ins — same shapes as cli/tests/harness.py. */
function installPhoneHandlers(d: MockDaemon, st: PhoneState) {
  let seq = 0
  d.handlers["phone.mcp"] = (params) => {
    const name = String(params.name)
    const args = (params.arguments ?? {}) as Record<string, unknown>
    switch (name) {
      case "list_active_calls":
        return { tool: name, data: [...st.activeCalls] }
      case "call_extension": {
        seq += 1
        const id = `call${seq}`
        st.activeCalls.push({
          id,
          state: "active",
          from_extension: args.from_extension ?? "",
          to_extension: args.extension ?? "",
          reason: "",
        })
        return { tool: name, data: { call_id: id, id } }
      }
      case "call_user": {
        seq += 1
        const id = `call${seq}`
        st.activeCalls.push({
          id,
          state: "ringing",
          from_extension: "100",
          to_extension: "user",
          reason: args.reason ?? "",
        })
        return { tool: name, data: { call_id: id, id } }
      }
      case "end_call":
        st.activeCalls = st.activeCalls.filter((c) => c.id !== args.call_id)
        return { tool: name, data: { ok: true } }
      case "get_call_transcript":
        return {
          tool: name,
          data: (st.transcripts[String(args.call_id)] ?? { messages: [] }) as Record<
            string,
            unknown
          >,
        }
      case "get_screening_status":
        return { tool: name, data: { ...st.screening } }
      case "list_extensions":
      case "list_agents":
        return { tool: name, data: [...st.extensions] }
      case "twilio_status":
        return {
          tool: name,
          data: {
            configured: true,
            from_number: "+19998887777",
            default_user_number: "+15125550100",
            screening_enabled: false,
          },
        }
      case "twilio_allowlist_list":
        return { tool: name, data: { numbers: [] } }
      case "get_voice_profile":
        return { tool: name, data: {} }
      case "red_alert":
        return { tool: name, data: { ok: true, thread_id: "war1" } }
      case "notify_user":
        return { tool: name, data: { ok: true } }
      case "list_inbox":
        return { tool: name, data: [...st.inbox] }
      case "get_thread_messages":
        return {
          tool: name,
          data: (st.threads[String(args.thread_id)] ?? { messages: [] }) as Record<
            string,
            unknown
          >,
        }
      default:
        return { tool: name, data: {} }
    }
  }
  d.handlers["phone.http"] = (params) => {
    const method = String(params.method ?? "GET").toUpperCase()
    const path = String(params.path ?? "")
    const m = /^\/api\/calls\/([^/]+)\/(accept|reject)$/.exec(path)
    if (m && method === "POST") {
      const [, cid, action] = m
      if (action === "accept") {
        for (const c of st.activeCalls) if (c.id === cid) c.state = "active"
      } else {
        st.activeCalls = st.activeCalls.filter((c) => c.id !== cid)
      }
      return { status: 200, data: { ok: true } }
    }
    if (path === "/health") return { status: 200, data: { ok: true } }
    if (path === "/api/voices") return { status: 200, data: { voices: [] } }
    if (path === "/api/mistral-health")
      return { status: 200, data: { ok: true, voice_key: { ok: true }, chat_key: { ok: true } } }
    if (path === "/api/screening")
      return {
        status: 200,
        data: { enabled: false, transport: "twilio", inbound_extension: "", screening_extension: "" },
      }
    if (path === "/api/sms-agent") return { status: 200, data: { enabled: false, extension: "" } }
    if (path === "/api/calls") return { status: 200, data: { calls: [] } }
    return { status: 200, data: { ok: true } }
  }
}

function makeApi(): AppApi {
  return {
    client: client!,
    registry: new CommandRegistry(),
    page: () => "phone",
    navigate: () => {},
    notify: () => {},
    quit: () => {},
  }
}

async function bootPage(over: Partial<PhoneState> = {}) {
  daemon = new MockDaemon()
  const st = freshState(over)
  installPhoneHandlers(daemon, st)
  client = new ControlClient(() => daemon!.url, 1000)
  const api = makeApi()
  const setup = await testRender(
    () => (
      <AppContext.Provider value={api}>
        <PhonePage active={() => true} />
      </AppContext.Provider>
    ),
    { width: 120, height: 36 },
  )
  await sleep(400) // connect + quick-start poll
  await setup.renderOnce()
  return { setup, st }
}

const mcpCalls = (name: string) =>
  daemon!.callsFor("phone.mcp").filter((p) => p.name === name)
const httpCalls = () => daemon!.callsFor("phone.http")

// ---------------------------------------------------------------------------
// 1. dial extension flow
// ---------------------------------------------------------------------------

test("CALLS: free-text numeric dial → call_extension from ext 100", async () => {
  const { setup } = await bootPage()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("PHONE HUB")
  expect(frame).toContain("1:101") // quick-dial chips

  await setup.mockInput.pressKey("d")
  await sleep(150)
  await setup.mockInput.pressKeys([..."101"])
  await setup.mockInput.pressKey("RETURN")
  await sleep(300)

  expect(mcpCalls("call_extension")[0]).toEqual({
    name: "call_extension",
    arguments: { from_extension: "100", extension: "101" },
  })
  const after = await setup.waitForFrame((f) => f.includes("Connected to 101"))
  expect(after).toContain("[active]") // the placed call lands in the list
}, 15000)

test("CALLS: free-text non-numeric dial → call_user with reason", async () => {
  const { setup } = await bootPage()
  await setup.mockInput.pressKey("d")
  await sleep(150)
  await setup.mockInput.pressKeys([..."need you in the lab"])
  await setup.mockInput.pressKey("RETURN")
  await sleep(300)

  expect(mcpCalls("call_user")[0]).toEqual({
    name: "call_user",
    arguments: { reason: "need you in the lab" },
  })
  await setup.waitForFrame((f) => f.includes("In-app call placed"))
}, 15000)

test("CALLS: quick-dial chip key 2 dials extension 102", async () => {
  const { setup } = await bootPage()
  await setup.mockInput.pressKey("2")
  await sleep(300)
  expect(mcpCalls("call_extension")[0]).toEqual({
    name: "call_extension",
    arguments: { from_extension: "100", extension: "102" },
  })
  await setup.waitForFrame((f) => f.includes("Connected to 102"))
}, 15000)

// ---------------------------------------------------------------------------
// 2. incoming call banner + accept (CallOverlay)
// ---------------------------------------------------------------------------

test("CallOverlay: ringing banner + A accepts via POST /api/calls/:id/accept", async () => {
  daemon = new MockDaemon()
  const st = freshState({
    activeCalls: [
      {
        id: "call9",
        state: "ringing",
        from_extension: "555",
        to_extension: "100",
        reason: "incoming approval",
        urgency: "high",
      },
    ],
  })
  installPhoneHandlers(daemon, st)
  client = new ControlClient(() => daemon!.url, 1000)
  const api = makeApi()
  const setup = await testRender(
    () => (
      <AppContext.Provider value={api}>
        <CallOverlay />
      </AppContext.Provider>
    ),
    { width: 120, height: 20 },
  )
  await sleep(400)
  const frame = await setup.waitForFrame((f) => f.includes("INCOMING CALL"))
  expect(frame).toContain("ext 555 → 100")
  expect(frame).toContain("incoming approval")
  expect(frame).toContain("[HIGH]") // urgency badge
  expect(frame).toContain("A accept · R reject")

  await setup.mockInput.pressKey("a")
  await sleep(300)
  expect(httpCalls()).toContainEqual({
    method: "POST",
    path: "/api/calls/call9/accept",
    body: { extension: "100" },
  })
  // Accept flips the harness call to active — banner follows on the re-poll.
  await setup.waitForFrame((f) => f.includes("ACTIVE CALL"))
}, 15000)

test("CallOverlay: R rejects with the QML body and clears the banner", async () => {
  daemon = new MockDaemon()
  const st = freshState({
    activeCalls: [
      { id: "call5", state: "ringing", from_extension: "555", to_extension: "100", reason: "spam?" },
    ],
  })
  installPhoneHandlers(daemon, st)
  client = new ControlClient(() => daemon!.url, 1000)
  const api = makeApi()
  const setup = await testRender(
    () => (
      <AppContext.Provider value={api}>
        <CallOverlay />
      </AppContext.Provider>
    ),
    { width: 120, height: 20 },
  )
  await sleep(400)
  await setup.waitForFrame((f) => f.includes("INCOMING CALL"))

  await setup.mockInput.pressKey("r")
  await sleep(300)
  expect(httpCalls()).toContainEqual({
    method: "POST",
    path: "/api/calls/call5/reject",
    body: { extension: "100", reason: "rejected_by_user" },
  })
  await setup.waitForFrame((f) => !f.includes("INCOMING CALL"))
}, 15000)

// ---------------------------------------------------------------------------
// 3. screening transcript render
// ---------------------------------------------------------------------------

test("SCREENING: caller info + live transcript bubbles render", async () => {
  const { setup } = await bootPage({
    screening: {
      active: true,
      caller_number: "+15551234567",
      caller_name: "Alex",
      agent_extension: "900",
      transcript: [
        { speaker: "caller", text: "Is this a sales call?" },
        { speaker: "agent", text: "No, checking on your order." },
      ],
    },
  })
  for (let i = 0; i < 5; i++) {
    await setup.mockInput.pressKey("]")
    await sleep(120)
  }
  const frame = await setup.waitForFrame((f) => f.includes("Alex"))
  expect(frame).toContain("Screening in progress")
  expect(frame).toContain("+15551234567")
  expect(frame).toContain("ext 900")
  expect(frame).toContain("Is this a sales call?")
  expect(frame).toContain("checking on your order")
  expect(mcpCalls("get_screening_status").length).toBeGreaterThanOrEqual(1)
}, 15000)

// ---------------------------------------------------------------------------
// 4. red alert behind a confirm step
// ---------------------------------------------------------------------------

test("HUD: red alert asks to confirm, then fires red_alert with the message", async () => {
  const { setup } = await bootPage()
  for (let i = 0; i < 3; i++) {
    await setup.mockInput.pressKey("]")
    await sleep(120)
  }
  await setup.waitForFrame((f) => f.includes("OPS HUD"))

  await setup.mockInput.pressKey("a")
  await sleep(150)
  await setup.mockInput.pressKeys([..."core breach"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("CONFIRM RED ALERT"))
  expect(mcpCalls("red_alert").length).toBe(0) // nothing fired before confirm

  await sleep(200) // clear the picker's mount-grace window
  await setup.mockInput.pressKey("RETURN") // "Yes — broadcast"
  await sleep(300)
  expect(mcpCalls("red_alert")[0]).toEqual({
    name: "red_alert",
    arguments: { message: "core breach" },
  })
  await setup.waitForFrame((f) => f.includes("Alert broadcast"))
}, 15000)

// ---------------------------------------------------------------------------
// bonus: inbox thread open (mark-read) + quiz-option reply by number key
// ---------------------------------------------------------------------------

test("INBOX: opening a thread marks it read; number key answers the quiz option", async () => {
  const { setup } = await bootPage({
    inbox: [
      {
        thread_id: "t1",
        subject: "Approval needed",
        preview: "Deploy to prod?",
        priority: "urgent",
        unread_count: 1,
        created_at: "2026-07-04T12:34:56",
        related_extension: "101",
      },
    ],
    threads: {
      t1: {
        messages: [
          {
            id: "m1",
            from_extension: "101",
            message: "Deploy to prod?",
            response_options: ["approve", "deny"],
            status: "delivered",
          },
        ],
      },
    },
  })
  await setup.mockInput.pressKey("]")
  await sleep(120)
  await setup.mockInput.pressKey("]")
  await sleep(200)
  const list = await setup.waitForFrame((f) => f.includes("Approval needed"))
  expect(list).toContain("[1]") // unread badge

  await setup.mockInput.pressKey("RETURN")
  await sleep(250)
  const thread = await setup.waitForFrame((f) => f.includes("Deploy to prod?"))
  expect(thread).toContain("1:APPROVE")
  expect(thread).toContain("2:DENY")
  expect(httpCalls()).toContainEqual({ method: "POST", path: "/api/messages/m1/read", body: {} })

  await setup.mockInput.pressKey("1")
  await sleep(300)
  expect(httpCalls()).toContainEqual({
    method: "POST",
    path: "/api/messages/m1/reply",
    body: { selected_option: "approve" },
  })
}, 15000)

// ---------------------------------------------------------------------------
// failure surfacing — no silent catch
// ---------------------------------------------------------------------------

test("CALLS: a daemon error reply surfaces as visible text", async () => {
  const { setup } = await bootPage()
  daemon!.handlers["phone.mcp"] = (params) => {
    const name = String(params.name)
    if (name === "call_extension")
      return { tool: name, error: { code: "phone_not_configured", message: "no phone.env" } }
    return { tool: name, data: [] }
  }
  await setup.mockInput.pressKey("d")
  await sleep(150)
  await setup.mockInput.pressKeys([..."101"])
  await setup.mockInput.pressKey("RETURN")
  const frame = await setup.waitForFrame((f) => f.includes("Error: no phone.env"))
  expect(frame).toContain("Error: no phone.env")
}, 15000)
