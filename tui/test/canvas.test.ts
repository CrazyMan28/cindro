// CanvasStore + saved-widget library unit tests: GUI CanvasPage parity rules
// (newest-on-top, cap 20, update-by-id, string-spec parsing) and the pinned
// Home-widgets round-trip in an isolated JARVIS_DATA_DIR.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ControlClient } from "../src/control/client"
import {
  CanvasStore,
  loadLibrary,
  pinnedWidgets,
  saveLibrary,
  saveToLibrary,
} from "../src/widgets/store"

const fakeClient = {
  on: () => () => {},
  call: async () => ({}),
} as unknown as ControlClient

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-tui-test-"))
  process.env.JARVIS_DATA_DIR = dir
})
afterEach(() => {
  delete process.env.JARVIS_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

test("canvas feed: newest-on-top, update-by-id, cap 20, remove, clear", () => {
  const store = new CanvasStore(fakeClient)
  for (let i = 0; i < 25; i++)
    store.onEvent("widget.render", { id: `w${i}`, title: `t${i}`, spec: { type: "text" } })
  expect(store.items()).toHaveLength(20) // capped
  expect(store.items()[0].id).toBe("w24") // newest first
  expect(store.items().at(-1)?.id).toBe("w5") // oldest beyond cap dropped

  store.onEvent("widget.render", { id: "w24", title: "updated", spec: { type: "text" } })
  expect(store.items()[0].title).toBe("updated")
  expect(store.items().filter((i) => i.id === "w24")).toHaveLength(1) // no dupe

  store.onEvent("widget.remove", { id: "w24" })
  expect(store.items().some((i) => i.id === "w24")).toBe(false)

  store.onEvent("widget.clear", {})
  expect(store.items()).toHaveLength(0)
})

test("string specs parse (the widgets.jsonl bus sends JSON strings)", () => {
  const store = new CanvasStore(fakeClient)
  store.onEvent("widget.render", {
    id: "s",
    title: "str",
    spec: JSON.stringify({ type: "badge", text: "OK" }),
  })
  expect(store.items()[0].spec).toEqual({ type: "badge", text: "OK" })
})

test("library round-trip + pin ordering + unknown-field preservation", () => {
  saveLibrary(
    [{ id: "a", name: "Alpha", spec: { type: "text", text: "a" } }],
    { schema_version: 2 }, // a top-level key another tool owns
  )
  saveToLibrary({ id: "b", title: "Beta", spec: { type: "text", text: "b" }, at: 0 })

  const { widgets, raw } = loadLibrary()
  expect(widgets.map((w) => w.id).sort()).toEqual(["a", "b"])
  expect(raw.schema_version).toBe(2) // preserved through saveToLibrary

  saveLibrary(
    widgets.map((w) =>
      w.id === "b" ? { ...w, pinned: true, pin_order: 1 } : { ...w, pinned: true, pin_order: 2 },
    ),
    raw,
  )
  expect(pinnedWidgets().map((w) => w.id)).toEqual(["b", "a"]) // pin_order respected

  const unpinned = loadLibrary().widgets.map((w) =>
    w.id === "a" ? { ...w, pinned: false } : w,
  )
  saveLibrary(unpinned, raw)
  expect(pinnedWidgets().map((w) => w.id)).toEqual(["b"])
})
