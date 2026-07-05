import { expect, test } from "bun:test"

import type { CommandContext } from "../src/commands/registry"
import { CommandRegistry } from "../src/commands/registry"

function makeCtx() {
  const log = {
    navigated: [] as string[],
    sent: [] as string[],
    calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
    notices: [] as string[],
    pickers: [] as string[],
    help: 0,
  }
  const responses = new Map<string, Record<string, unknown>>()
  const ctx: CommandContext = {
    navigate: (p) => log.navigated.push(p),
    sendChat: (t) => log.sent.push(t),
    call: async (method, params = {}) => {
      log.calls.push({ method, params })
      return responses.get(method) ?? {}
    },
    notify: (m) => log.notices.push(m),
    openPicker: (t) => log.pickers.push(t),
    openHelp: () => log.help++,
  }
  return { ctx, log, responses }
}

const MANIFEST_SAMPLE = [
  { name: "sessions", description: "browse sessions", kind: "page", target: "sessions", aliases: ["resume"] },
  { name: "canvas", description: "jump to Canvas", kind: "navigate", target: "canvas" },
  { name: "model", description: "pick the default model", kind: "picker", target: "model" },
  { name: "stage", description: "git add a reviewed file", kind: "verb", verb: "diff.stage" },
  { name: "new", description: "start a fresh chat session", kind: "session" },
  { name: "deploy", description: "run the deploy script", kind: "shell", source: "custom" },
  { name: "standup", description: "daily standup prompt", kind: "prompt", source: "custom" },
]

test("manifest merge + find by alias + local wins collisions", () => {
  const reg = new CommandRegistry()
  reg.registerLocal([
    { name: "new", description: "local new", kind: "session", run: () => {} },
  ])
  reg.mergeManifest(MANIFEST_SAMPLE)

  expect(reg.find("resume")?.name).toBe("sessions")
  expect(reg.find("new")?.source).toBe("local") // manifest did not displace
  expect(reg.find("deploy")?.source).toBe("custom")

  // Re-merging after ui.manifest.changed is idempotent.
  reg.mergeManifest(MANIFEST_SAMPLE)
  expect(reg.all().filter((e) => e.name === "sessions")).toHaveLength(1)
})

test("filter ranks name matches over description matches", () => {
  const reg = new CommandRegistry()
  reg.mergeManifest(MANIFEST_SAMPLE)
  const hits = reg.filter("se").map((e) => e.name)
  expect(hits[0]).toBe("sessions")
  expect(reg.filter("")).toHaveLength(MANIFEST_SAMPLE.length)
  expect(reg.filter("zzzzz")).toHaveLength(0)
})

test("kind-default dispatch: navigate/page/picker/help", async () => {
  const reg = new CommandRegistry()
  reg.mergeManifest(MANIFEST_SAMPLE)
  const { ctx, log } = makeCtx()

  expect(await reg.execute("canvas", "", ctx)).toBe(true)
  expect(await reg.execute("resume", "", ctx)).toBe(true)
  expect(await reg.execute("model", "", ctx)).toBe(true)
  expect(await reg.execute("nosuch", "", ctx)).toBe(false)

  expect(log.navigated).toEqual(["canvas", "sessions"])
  expect(log.pickers).toEqual(["model"])
})

test("verb kind calls the daemon and reports ok/detail", async () => {
  const reg = new CommandRegistry()
  reg.mergeManifest(MANIFEST_SAMPLE)
  const { ctx, log, responses } = makeCtx()
  responses.set("diff.stage", { ok: true, message: "staged" })

  await reg.execute("stage", "src/a.ts", ctx)
  expect(log.calls[0]).toEqual({ method: "diff.stage", params: { args: "src/a.ts" } })
  expect(log.notices[0]).toContain("✓ stage")
  expect(log.notices[0]).toContain("staged")
})

test("custom prompt-kind sends the returned prompt as a chat turn", async () => {
  const reg = new CommandRegistry()
  reg.mergeManifest(MANIFEST_SAMPLE)
  const { ctx, log, responses } = makeCtx()
  responses.set("command.invoke", { prompt: "run the standup: today I..." })

  await reg.execute("standup", "notes", ctx)
  expect(log.calls[0].params).toEqual({ name: "standup", args: "notes" })
  expect(log.sent).toEqual(["run the standup: today I..."])
})

test("custom shell-kind surfaces executed output (and old-daemon degrade)", async () => {
  const reg = new CommandRegistry()
  reg.mergeManifest(MANIFEST_SAMPLE)
  const { ctx, log, responses } = makeCtx()

  responses.set("command.invoke", {
    shell: "deploy.sh",
    executed: true,
    ok: false,
    exit_code: 1,
    output: "boom",
  })
  await reg.execute("deploy", "", ctx)
  expect(log.notices[0]).toContain("✕ /deploy")
  expect(log.notices[0]).toContain("boom")

  responses.set("command.invoke", { shell: "deploy.sh" }) // pre-Phase-0 daemon
  await reg.execute("deploy", "", ctx)
  expect(log.notices[1]).toContain("newer jarvisd")
})

test("local run() closure wins over kind defaults", async () => {
  const reg = new CommandRegistry()
  let ran = ""
  reg.registerLocal([
    {
      name: "stop",
      description: "cancel the turn",
      kind: "session",
      run: (args) => {
        ran = `stop:${args}`
      },
    },
  ])
  const { ctx } = makeCtx()
  await reg.execute("stop", "now", ctx)
  expect(ran).toBe("stop:now")
})
