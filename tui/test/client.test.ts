// ControlClient contract tests — including regression coverage for the two
// structural defects the Python client shipped with: the single-slot
// broadcast dispatcher (only ONE pane app-wide could hear push events) and
// keystroke-swallowing focus bugs downstream of it.

import { afterEach, expect, test } from "bun:test"

import { AsyncQueue, ControlClient, ControlError } from "../src/control/client"
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

function connectPair(): { daemon: MockDaemon; client: ControlClient } {
  daemon = new MockDaemon()
  client = new ControlClient(() => daemon!.url, 1000)
  return { daemon, client }
}

test("call resolves the daemon's result", async () => {
  const { daemon, client } = connectPair()
  daemon.handlers["settings.get"] = () => ({ settings: { agent_mode: "coworker" } })
  const res = await client.call("settings.get")
  expect((res.settings as Record<string, unknown>).agent_mode).toBe("coworker")
})

test("failure frames raise ControlError with the code", async () => {
  const { client } = connectPair()
  daemon!.handlers["nope.verb"] = () => ({
    __error: { code: "unknown_method", message: "unknown ops method" },
  })
  expect(client.call("nope.verb")).rejects.toThrow(ControlError)
  try {
    await client.call("nope.verb")
  } catch (e) {
    expect((e as ControlError).code).toBe("unknown_method")
  }
})

test("call times out when the daemon never replies", async () => {
  const { daemon, client } = connectPair()
  daemon.handlers["slow.verb"] = () => undefined // never reply
  await expect(client.call("slow.verb", {}, 300)).rejects.toThrow(/timed out/)
})

test("broadcast bus is MULTI-subscriber (the old single-slot landmine)", async () => {
  const { daemon, client } = connectPair()
  await client.call("ping") // ensure connected

  const canvas: string[] = []
  const phone: string[] = []
  const all: string[] = []
  client.on("widget.", (ev) => canvas.push(ev))
  const offPhone = client.on("phone.event", (ev) => phone.push(ev))
  client.on("*", (ev) => all.push(ev))

  daemon.broadcast("widget.render", { id: "w1" })
  daemon.broadcast("phone.event", {})
  daemon.broadcast("tui.layout.changed", { pages: [] })
  await sleep(100)

  // BOTH prefix subscribers heard their events — no clobbering.
  expect(canvas).toEqual(["widget.render"])
  expect(phone).toEqual(["phone.event"])
  expect(all).toEqual(["widget.render", "phone.event", "tui.layout.changed"])

  offPhone()
  daemon.broadcast("phone.event", {})
  await sleep(100)
  expect(phone).toEqual(["phone.event"]) // unsubscribed — no second entry
})

test("one throwing subscriber never breaks the bus for the others", async () => {
  const { daemon, client } = connectPair()
  await client.call("ping")
  const heard: string[] = []
  client.on("*", () => {
    throw new Error("bad subscriber")
  })
  client.on("*", (ev) => heard.push(ev))
  daemon.broadcast("auth.event", {})
  await sleep(100)
  expect(heard).toEqual(["auth.event"])
})

test("session-scoping defense: only subscribed sessions get events", async () => {
  const { daemon, client } = connectPair()
  const q = await client.subscribe("sess_a")

  daemon.sessionEvent("sess_a", { kind: "text", text: "hello" })
  daemon.sessionEvent("sess_OTHER", { kind: "text", text: "leak!" })
  daemon.sessionEvent("sess_a", { kind: "done" })

  const first = await q.shift(1000)
  const second = await q.shift(1000)
  expect(first).toEqual({ kind: "text", text: "hello" })
  expect(second).toEqual({ kind: "done" })
  expect(q.size).toBe(0) // sess_OTHER's event was dropped, not queued anywhere
  expect(client.queueFor("sess_OTHER")).toBeUndefined()
})

test("subscribe sends the FULL sorted session set; unsubscribe re-sends it", async () => {
  const { daemon, client } = connectPair()
  await client.subscribe("sess_b")
  await client.subscribe("sess_a")
  await client.unsubscribe("sess_b")

  // Each session.subscribe frame is authoritative, and the connect
  // supervisor may legitimately send a duplicate of the current set — so
  // assert set-progression, not exact frame counts.
  const subs = daemon.callsFor("session.subscribe")
  expect(subs[0]).toEqual({ session_ids: ["sess_b"] })
  expect(subs).toContainEqual({ session_ids: ["sess_a", "sess_b"] })
  expect(subs[subs.length - 1]).toEqual({ session_ids: ["sess_a"] })
})

test("reconnect re-sends the subscription set and fails in-flight calls", async () => {
  daemon = new MockDaemon()
  const port = daemon.port
  client = new ControlClient(() => `ws://127.0.0.1:${port}/control/ws`, 1000)

  await client.subscribe("sess_x")
  daemon.handlers["slow.verb"] = () => undefined
  const inflight = client.call("slow.verb", {}, 10000)

  daemon.stop() // connection drops with a call pending
  await expect(inflight).rejects.toThrow(/connection lost|closed/)

  await sleep(300)
  daemon = new MockDaemon(port) // daemon comes back on the same port
  // Backoff starts at 500ms — well within this wait.
  await sleep(2500)

  const subs = daemon.callsFor("session.subscribe")
  expect(subs.length).toBeGreaterThanOrEqual(1)
  expect(subs[0]).toEqual({ session_ids: ["sess_x"] })
  expect(client.connected).toBe(true)
}, 10000)

test("AsyncQueue shift timeout returns undefined without losing later items", async () => {
  const q = new AsyncQueue<number>()
  expect(await q.shift(50)).toBeUndefined()
  q.push(7)
  expect(await q.shift(50)).toBe(7)
})
