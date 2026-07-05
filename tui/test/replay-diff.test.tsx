// Replay + DiffReview e2e (frame-based): the replay page loads a session's
// history through the picker, rebuilds the transcript per seek (including
// widget-kind events the GUI skips), and the diff-review panel renders stat
// chips + 30-line truncation and drives the REAL diff.* verbs — with the
// destructive revert gated behind a confirm picker.

import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"

import type { AppApi } from "../src/app-context"
import { AppContext } from "../src/app-context"
import { DiffReview } from "../src/chat/DiffReview"
import { CommandRegistry } from "../src/commands/registry"
import { ControlClient } from "../src/control/client"
import { ReplayPage } from "../src/pages/Replay"
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

function makeApi(c: ControlClient): AppApi {
  return {
    client: c,
    registry: new CommandRegistry(),
    page: () => "replay",
    navigate: () => {},
    notify: () => {},
    quit: () => {},
  }
}

// ---- Replay ----------------------------------------------------------------

async function bootReplay(history: Array<Record<string, unknown>>) {
  daemon = new MockDaemon()
  daemon.handlers["session.list"] = () => ({
    sessions: [{ id: "s1", title: "alpha run", state: "idle" }],
  })
  daemon.handlers["session.history"] = (p) => ({
    session: { id: p.session_id, title: "alpha run" },
    events: history.map((ev, i) => ({ seq: i + 1, ts: i, ev })),
  })
  client = new ControlClient(() => daemon!.url, 1000)
  const setup = await testRender(
    () => (
      <AppContext.Provider value={makeApi(client!)}>
        <ReplayPage active={() => true} />
      </AppContext.Provider>
    ),
    { width: 100, height: 34 },
  )
  await sleep(200)
  await setup.renderOnce()
  return setup
}

test("replay: picker loads history fully played out; j/k stepping changes visible events", async () => {
  const setup = await bootReplay([
    { kind: "message", role: "user", text: "hello world" },
    { kind: "message", role: "assistant", text: "General Kenobi" },
    { kind: "tool_call", name: "shellprobe", args: "ls" },
    { kind: "tool_result", ok: true, output: "alpha.txt beta.txt" },
  ])

  // Session picker on entry, over the NO SESSION LOADED empty state.
  const first = await setup.waitForFrame((f) => f.includes("alpha run"))
  expect(first).toContain("NO SESSION LOADED")
  await sleep(200) // clear the picker's 150ms mount-grace
  await setup.mockInput.pressKey("RETURN")

  // History lands fully played out (GUI parity: scrub back to rewind).
  const loaded = await setup.waitForFrame(
    (f) => f.includes("General Kenobi") && f.includes("4 / 4"),
  )
  expect(loaded).toContain("❯ hello world")
  expect(loaded).toContain("shellprobe")
  expect(loaded).toContain("alpha.txt") // tool_result folded into the card
  expect(daemon!.callsFor("session.history")[0]).toMatchObject({ session_id: "s1" })

  // j steps back: the tool_result unfolds away, readout tracks the cursor.
  await setup.mockInput.pressKey("j")
  await sleep(150)
  const at3 = await setup.waitForFrame((f) => f.includes("3 / 4"))
  expect(at3).not.toContain("alpha.txt")
  expect(at3).toContain("shellprobe") // the tool_call itself is still there

  await setup.mockInput.pressKey("j")
  await sleep(150)
  const at2 = await setup.waitForFrame((f) => f.includes("2 / 4"))
  expect(at2).not.toContain("shellprobe")
  expect(at2).toContain("General Kenobi")

  // k steps forward again.
  await setup.mockInput.pressKey("k")
  await sleep(150)
  const back3 = await setup.waitForFrame((f) => f.includes("3 / 4"))
  expect(back3).toContain("shellprobe")
}, 15000)

test("replay: widget-kind history events render through the controller and scrub away", async () => {
  const setup = await bootReplay([
    { kind: "message", role: "user", text: "show me the deploy" },
    {
      kind: "widget",
      title: "deploy status",
      spec: {
        type: "column",
        children: [{ type: "text", text: "deploy pipeline green" }],
      },
    },
  ])

  await setup.waitForFrame((f) => f.includes("alpha run"))
  await sleep(200)
  await setup.mockInput.pressKey("RETURN")

  // The GUI's replay skips widget events — ours renders them like live chat.
  const loaded = await setup.waitForFrame((f) => f.includes("deploy pipeline green"))
  expect(loaded).toContain("◆ CANVAS · deploy status")
  expect(loaded).toContain("2 / 2")

  // Scrubbing back before the widget removes it from the rebuilt transcript.
  await setup.mockInput.pressKey("j")
  await sleep(150)
  const at1 = await setup.waitForFrame((f) => f.includes("1 / 2"))
  expect(at1).not.toContain("deploy pipeline green")
  expect(at1).toContain("show me the deploy")
}, 15000)

// ---- DiffReview -------------------------------------------------------------

const ALPHA_PATCH = [
  "--- a/src/alpha.ts",
  "+++ b/src/alpha.ts",
  "@@ -1,3 +1,4 @@",
  " context line",
  "-old line",
  "+new line",
  "+another line",
].join("\n")

// 40 added lines → 30 shown + "… 10 more lines"
const BETA_PATCH = Array.from({ length: 40 }, (_, i) => `+beta-${i}`).join("\n")

const FILES = [
  { path: "src/alpha.ts", patch: ALPHA_PATCH },
  { path: "src/beta.ts", patch: BETA_PATCH },
]

async function bootDiff(active?: () => boolean) {
  daemon = new MockDaemon()
  daemon.handlers["diff.stage"] = () => ({ ok: true, message: "staged" })
  daemon.handlers["diff.commit"] = () => ({ ok: true, message: "committed 2 files" })
  daemon.handlers["diff.revert"] = () => ({ ok: true })
  client = new ControlClient(() => daemon!.url, 1000)
  const setup = await testRender(
    () => (
      <AppContext.Provider value={makeApi(client!)}>
        <DiffReview files={FILES} sessionId="sess_diff" active={active} />
      </AppContext.Provider>
    ),
    { width: 100, height: 56 },
  )
  await sleep(150)
  await setup.renderOnce()
  return setup
}

test("diffreview: stat chips + 30-line truncation; s stages the selected file; ↓ retargets", async () => {
  const setup = await bootDiff()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("src/alpha.ts")
  expect(frame).toContain("+2")
  expect(frame).toContain("-1")
  expect(frame).toContain("… 10 more lines") // beta capped at 30 lines
  expect(frame).toContain("s stage · c commit · o open PR · v revert")

  // s targets the SELECTED card (alpha, index 0) with the real param shape.
  await setup.mockInput.pressKey("s")
  await sleep(250)
  expect(daemon!.callsFor("diff.stage")[0]).toEqual({
    path: "src/alpha.ts",
    session_id: "sess_diff",
  })
  await setup.waitForFrame((f) => f.includes("✓ stage  staged"))

  // ↓ moves the target to beta; s again stages beta.
  await setup.mockInput.pressKey("ARROW_DOWN")
  await sleep(120)
  await setup.mockInput.pressKey("s")
  await sleep(250)
  expect(daemon!.callsFor("diff.stage")[1]).toEqual({
    path: "src/beta.ts",
    session_id: "sess_diff",
  })
}, 15000)

test("diffreview: v gates revert behind a confirm picker before calling diff.revert", async () => {
  const setup = await bootDiff()
  await setup.mockInput.pressKey("v")
  await sleep(150)
  const confirm = await setup.waitForFrame((f) => f.includes("CONFIRM: revert src/alpha.ts?"))
  expect(confirm).toContain("Yes — discard local changes")
  expect(daemon!.callsFor("diff.revert").length).toBe(0) // nothing until confirmed

  await sleep(200) // clear the picker's mount-grace window
  await setup.mockInput.pressKey("RETURN") // "Yes" is the highlighted first row
  await sleep(250)
  expect(daemon!.callsFor("diff.revert")[0]).toEqual({
    path: "src/alpha.ts",
    session_id: "sess_diff",
  })
}, 15000)

test("diffreview: c prompts for an optional message then fires diff.commit", async () => {
  const setup = await bootDiff()
  await setup.mockInput.pressKey("c")
  await sleep(150)
  await setup.waitForFrame((f) => f.includes("commit message (optional)"))
  await setup.mockInput.pressKeys([..."fix: tidy"])
  await setup.mockInput.pressKey("RETURN")
  await sleep(250)
  expect(daemon!.callsFor("diff.commit")[0]).toEqual({
    message: "fix: tidy",
    session_id: "sess_diff",
  })
  await setup.waitForFrame((f) => f.includes("✓ commit  committed 2 files"))
}, 15000)

test("diffreview: inactive panel ignores action keys", async () => {
  const setup = await bootDiff(() => false)
  await setup.mockInput.pressKey("s")
  await setup.mockInput.pressKey("v")
  await sleep(250)
  expect(daemon!.callsFor("diff.stage").length).toBe(0)
  expect(daemon!.callsFor("diff.revert").length).toBe(0)
  expect(setup.captureCharFrame()).not.toContain("CONFIRM")
}, 15000)
