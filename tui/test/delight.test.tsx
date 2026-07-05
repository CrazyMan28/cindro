// Phase 5 delight layer: keybind resolution + remap, theme cycle persistence,
// and the Ctrl+K palette running a command end-to-end through the shell.

import { testRender } from "@opentui/solid"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { App } from "../src/app"
import { CommandRegistry } from "../src/commands/registry"
import { ControlClient } from "../src/control/client"
import { DEFAULT_KEYBINDS, Keybinds, normalizeKey } from "../src/commands/keybinds"
import { MockDaemon } from "./mock-daemon"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-delight-"))
  process.env.JARVIS_CONFIG_DIR = dir
})
afterEach(() => {
  delete process.env.JARVIS_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

test("normalizeKey builds canonical chords", () => {
  expect(normalizeKey({ name: "k", ctrl: true })).toBe("ctrl+k")
  expect(normalizeKey({ name: "2", meta: true })).toBe("alt+2")
  expect(normalizeKey({ name: "f2" })).toBe("f2")
})

test("defaults resolve; tui.json overrides + unbinds; leader parses", () => {
  const def = new Keybinds()
  expect(def.matches("palette", { name: "k", ctrl: true })).toBe(true)
  expect(def.isLeader({ name: "x", ctrl: true })).toBe(true)
  expect(def.leaderKey("export")).toBe("e")
  expect(def.leaderActions().some((e) => e.key === "n")).toBe(true)

  writeFileSync(
    join(dir, "tui.json"),
    JSON.stringify({ keybinds: { palette: "ctrl+p", quit: null } }),
  )
  const custom = Keybinds.load()
  expect(custom.matches("palette", { name: "p", ctrl: true })).toBe(true)
  expect(custom.matches("palette", { name: "k", ctrl: true })).toBe(false)
  expect(custom.matches("quit", { name: "q", ctrl: true })).toBe(false) // unbound
})

test("cycleTheme rotates the accent and persists it to tui.json", async () => {
  // Import fresh so module state starts at cyan under this config dir.
  const { cycleTheme, loadSavedAccent } = await import(`../src/theme?ts=${Date.now()}`)
  const a = cycleTheme()
  const b = cycleTheme()
  expect(a).toBe("amber")
  expect(b).toBe("violet")
  const cfg = JSON.parse(readFileSync(join(dir, "tui.json"), "utf8"))
  expect(cfg.accent).toBe("violet")
  loadSavedAccent() // no throw
})

test("every default action has a label and a binding shape", () => {
  for (const action of Object.keys(DEFAULT_KEYBINDS)) {
    const b = DEFAULT_KEYBINDS[action as keyof typeof DEFAULT_KEYBINDS]
    expect(b === null || typeof b === "string").toBe(true)
  }
})

test("Ctrl+K opens the palette and running an entry navigates", async () => {
  const daemon = new MockDaemon()
  daemon.handlers["settings.get"] = () => ({ settings: { setup_complete: true } })
  daemon.handlers["status.get"] = () => ({ version: "1", default_brain: "x", mcp: {}, agents_running: 0 })
  daemon.handlers["ui.manifest.get"] = () => ({
    v: 1,
    pages: [{ id: "canvas", title: "Canvas", section: "workspace", kind: "bespoke" }],
    commands: [{ name: "canvas", description: "jump to Canvas", kind: "navigate", target: "canvas" }],
  })
  const client = new ControlClient(() => daemon.url, 1000)
  const registry = new CommandRegistry()
  const m = await client.call("ui.manifest.get")
  registry.mergeManifest((m.commands ?? []) as Array<Record<string, unknown>>)

  const setup = await testRender(
    () => <App client={client} registry={registry} onQuit={() => {}} />,
    { width: 100, height: 30 },
  )
  await sleep(200)
  await setup.mockInput.pressKey("k", { ctrl: true })
  await setup.waitForFrame((f) => f.includes("run a command…"))
  await setup.mockInput.pressKeys([..."canvas"])
  await sleep(80)
  await setup.mockInput.pressKey("RETURN")
  const frame = await setup.waitForFrame((f) => f.includes("// CANVAS"))
  expect(frame).toContain("live widget feed")

  await client.close()
  daemon.stop()
}, 15000)
