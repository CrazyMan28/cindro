// Startup-gates + voice-mode e2e coverage:
//   LockGate    — fail-open when auth.request errors, and the PIN fallback
//                 path (settings.get's has_desktop_pin) calling auth.verify_pin.
//   SetupWizard — Finish sends exactly ONE settings.set patch (with
//                 setup_complete:true) and never re-sends an already-set
//                 Mistral key; a settings.get that already reports
//                 setup_complete skips the wizard outright.
//   VoicePage   — the orb renders, push-to-talk drives voice.stt/session.*/
//                 voice.tts with the exact param shapes, and the whimsical
//                 60+-phrase pool cycles while a reply is in flight. A fake
//                 process spawner stands in for arecord/aplay — this suite
//                 never touches real audio hardware.

import { writeFileSync } from "node:fs"

import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"

import type { AppApi } from "../src/app-context"
import { AppContext } from "../src/app-context"
import { CommandRegistry } from "../src/commands/registry"
import { ControlClient } from "../src/control/client"
import { LockGate } from "../src/gates/LockGate"
import { SetupWizard } from "../src/gates/SetupWizard"
import { THINKING_PHRASES, VoicePage } from "../src/pages/Voice"
import { setSpawnImpl } from "../src/voice/audio"
import { CanvasStore } from "../src/widgets/store"
import { MockDaemon } from "./mock-daemon"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let daemon: MockDaemon | undefined
let client: ControlClient | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
  daemon?.stop()
  daemon = undefined
  setSpawnImpl(null) // restore the real Bun.spawn-backed implementation
})

function makeApi(): AppApi {
  return {
    client: client!,
    registry: new CommandRegistry(),
    page: () => "voice",
    navigate: () => {},
    notify: () => {},
    quit: () => {},
  }
}

async function mount(node: () => unknown, size = { width: 100, height: 32 }) {
  const setup = await testRender(
    () => <AppContext.Provider value={makeApi()}>{node() as never}</AppContext.Provider>,
    size,
  )
  await sleep(150)
  await setup.renderOnce()
  return setup
}

// ===== LockGate =================================================================

test("LockGate fails open when auth.request errors — onDone fires", async () => {
  daemon = new MockDaemon()
  daemon.handlers["auth.request"] = () => ({
    __error: { code: "unknown_method", message: "no auth.* on this daemon" },
  })
  client = new ControlClient(() => daemon!.url, 1000)

  let done = false
  await mount(() => <LockGate onDone={() => (done = true)} />)
  await sleep(150)
  expect(done).toBe(true)
}, 15000)

test("LockGate fails open when no phone is paired", async () => {
  daemon = new MockDaemon()
  daemon.handlers["auth.request"] = () => ({ paired: false })
  client = new ControlClient(() => daemon!.url, 1000)

  let done = false
  await mount(() => <LockGate onDone={() => (done = true)} />)
  await sleep(150)
  expect(done).toBe(true)
}, 15000)

test("LockGate PIN path: has_desktop_pin true — typing a PIN calls auth.verify_pin", async () => {
  daemon = new MockDaemon()
  daemon.handlers["auth.request"] = () => ({ paired: true, state: "pending", challenge_id: "c1" })
  daemon.handlers["settings.get"] = () => ({ settings: { has_desktop_pin: true } })
  daemon.handlers["auth.verify_pin"] = () => ({ state: "approved" })
  client = new ControlClient(() => daemon!.url, 1000)

  let done = false
  const setup = await mount(() => <LockGate onDone={() => (done = true)} />)
  await setup.waitForFrame((f) => f.includes("OR UNLOCK WITH YOUR PIN"))
  await sleep(80) // let the pin field's focus() microtask land

  await setup.mockInput.pressKeys([..."1234"])
  await setup.mockInput.pressKey("RETURN")
  await sleep(150)

  expect(daemon!.callsFor("auth.verify_pin")[0]).toEqual({ challenge_id: "c1", pin: "1234" })
  expect(done).toBe(true)
}, 15000)

test("LockGate wrong PIN shows an error and never dismisses", async () => {
  daemon = new MockDaemon()
  daemon.handlers["auth.request"] = () => ({ paired: true, state: "pending", challenge_id: "c1" })
  daemon.handlers["settings.get"] = () => ({ settings: { has_desktop_pin: true } })
  daemon.handlers["auth.verify_pin"] = () => ({ state: "denied" })
  client = new ControlClient(() => daemon!.url, 1000)

  let done = false
  const setup = await mount(() => <LockGate onDone={() => (done = true)} />)
  await setup.waitForFrame((f) => f.includes("OR UNLOCK WITH YOUR PIN"))
  await sleep(80)

  await setup.mockInput.pressKeys([..."0000"])
  await setup.mockInput.pressKey("RETURN")
  await setup.waitForFrame((f) => f.includes("WRONG PIN"))
  expect(done).toBe(false)
}, 15000)

// ===== SetupWizard ================================================================

test("SetupWizard finish sends ONE settings.set patch and never re-sends an already-set Mistral key", async () => {
  daemon = new MockDaemon()
  daemon.handlers["settings.get"] = () => ({
    settings: {
      setup_complete: false,
      assistant_name: "Jarvis",
      user_name: "",
      available_brains: { claude: true },
      api_keys_set: { mistral: true },
      tts_voice: "ember",
      permission_level: "medium",
      auto_update: true,
    },
  })
  daemon.handlers["voice.list_voices"] = () => ({ voices: [{ id: "ember", label: "Ember" }] })
  daemon.handlers["settings.set"] = () => ({ ok: true })
  client = new ControlClient(() => daemon!.url, 1000)

  let done = false
  const setup = await mount(() => <SetupWizard onDone={() => (done = true)} />)
  await setup.waitForFrame((f) => f.includes("FIRST-TIME SETUP"))
  await sleep(200) // let the concurrent settings.get/voice.list_voices land

  await setup.mockInput.pressKey("TAB") // Welcome -> Voice
  await sleep(120)
  await setup.mockInput.pressKey("TAB") // Voice -> Brain
  await sleep(120)
  await setup.mockInput.pressKey("TAB") // Brain -> Permissions (mistral field hidden — key already set)
  await sleep(120)
  await setup.mockInput.pressKey("TAB") // Permissions -> Finish
  await sleep(200)

  expect(done).toBe(true)
  expect(daemon!.callsFor("settings.set").length).toBe(1)
  const patch = daemon!.callsFor("settings.set")[0].patch as Record<string, unknown>
  expect(patch).toEqual({
    setup_complete: true,
    assistant_name: "Jarvis",
    user_name: "",
    tts_voice: "ember",
    permission_level: "medium",
    auto_update: true,
  })
  expect("api_keys" in patch).toBe(false)
}, 15000)

test("SetupWizard skips immediately when settings already report setup_complete", async () => {
  daemon = new MockDaemon()
  daemon.handlers["settings.get"] = () => ({ settings: { setup_complete: true } })
  daemon.handlers["voice.list_voices"] = () => ({ voices: [] })
  client = new ControlClient(() => daemon!.url, 1000)

  let done = false
  await mount(() => <SetupWizard onDone={() => (done = true)} />)
  await sleep(200)
  expect(done).toBe(true)
  expect(daemon!.callsFor("settings.set").length).toBe(0)
}, 15000)

// ===== VoicePage =================================================================

test("thinking-phrase pool has 60+ distinct original entries", () => {
  expect(THINKING_PHRASES.length).toBeGreaterThanOrEqual(60)
  expect(new Set(THINKING_PHRASES).size).toBe(THINKING_PHRASES.length)
})

test("VoicePage renders the orb and cycles a thinking phrase across the record→stt→session round trip", async () => {
  daemon = new MockDaemon()
  daemon.handlers["voice.stt"] = () => ({ text: "hello jarvis" })
  daemon.handlers["session.create"] = () => ({ session_id: "sess_v" })
  daemon.handlers["session.send"] = () => ({ ok: true })
  daemon.handlers["voice.tts"] = () => ({ audio_b64: "" }) // skip real playback
  client = new ControlClient(() => daemon!.url, 1000)

  // Fake process spawner — the recorder never shells out to real arecord;
  // it just fabricates the WAV file recordWav() expects to read back.
  setSpawnImpl((cmd) => {
    if (cmd[0] === "arecord") {
      const file = cmd[cmd.length - 1]
      writeFileSync(file, Buffer.from("RIFFfake-wav-bytes"))
    }
    return { exited: Promise.resolve(0), kill: () => {} }
  })

  const setup = await mount(() => <VoicePage active={() => true} />)
  expect(setup.captureCharFrame()).toContain("READY — press space to talk")

  await setup.mockInput.pressKey(" ") // start recording
  await setup.waitForFrame((f) => f.includes("LISTENING"))

  await setup.mockInput.pressKey(" ") // stop + send
  await sleep(250) // recordWav resolves + voice.stt + session.create/send round trip
  const frame = await setup.waitForFrame((f) =>
    THINKING_PHRASES.some((p) => f.includes(p.toUpperCase())),
  )
  expect(frame).toContain('"hello jarvis"') // heard transcript
  expect(daemon!.callsFor("voice.stt")[0]).toMatchObject({ mime: "audio/wav" })
  expect(daemon!.callsFor("session.send")[0]).toMatchObject({
    session_id: "sess_v",
    text: "hello jarvis",
  })

  // Unblock the turn: thinking -> speaking -> idle.
  daemon!.sessionEvent("sess_v", { kind: "message", role: "assistant", text: "General Kenobi" })
  await sleep(250)
  await setup.waitForFrame((f) => f.includes("General Kenobi"))
}, 15000)

test("VoicePage docks the newest 3 CanvasStore widgets beside the orb when a store is passed", async () => {
  daemon = new MockDaemon()
  client = new ControlClient(() => daemon!.url, 1000)
  const store = new CanvasStore(client)
  for (let i = 0; i < 5; i++) {
    store.inject({ id: `w${i}`, title: `Widget ${i}`, spec: { type: "text", text: `hello ${i}` } })
  }

  const setup = await mount(() => <VoicePage active={() => true} store={store} />)
  await sleep(150)
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Widget 4") // newest first
  expect(frame).toContain("Widget 3")
  expect(frame).toContain("Widget 2")
  expect(frame).not.toContain("Widget 0")
  store.dispose()
}, 15000)
