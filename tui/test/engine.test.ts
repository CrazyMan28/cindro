import { expect, test } from "bun:test"

import {
  actionVisible,
  columnWidths,
  formatCell,
  substituteParams,
  truncate,
} from "../src/pages/engine/types"

test("substituteParams resolves $field / $input / $toggle and passes literals", () => {
  const row = { id: "s1", name: "ping", enabled: true }
  expect(
    substituteParams(
      { session_id: "$id", name: "$name", enabled: "$toggle", task: "$input", limit: 5 },
      row,
      "do the thing",
    ),
  ).toEqual({
    session_id: "s1",
    name: "ping",
    enabled: false, // toggled off
    task: "do the thing",
    limit: 5,
  })
  expect(substituteParams({ x: "$missing" }, {})).toEqual({ x: "" })
})

test("actionVisible honors when / !when flags", () => {
  expect(actionVisible({ id: "a", label: "A" }, {})).toBe(true)
  expect(actionVisible({ id: "a", label: "A", when: "archived" }, { archived: true })).toBe(true)
  expect(actionVisible({ id: "a", label: "A", when: "archived" }, {})).toBe(false)
  expect(actionVisible({ id: "a", label: "A", when: "!builtin" }, { builtin: true })).toBe(false)
  expect(actionVisible({ id: "a", label: "A", when: "!builtin" }, {})).toBe(true)
})

test("formatCell formats", () => {
  expect(formatCell(true, "flag")).toBe("✓")
  expect(formatCell(false, "flag")).toBe("·")
  expect(formatCell(["a", "b"], "chips")).toBe("#a #b")
  expect(formatCell(Date.now() - 5 * 60000, "reltime")).toBe("5m ago")
  expect(formatCell(Date.now() + 2 * 3600000, "reltime")).toContain("in 2h")
  expect(formatCell(0, "reltime")).toBe("")
  expect(formatCell({ a: 1 })).toBe('{"a":1}')
})

test("columnWidths fits content and clamps into the available width", () => {
  const cols = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ]
  const rows = [{ a: "x".repeat(100), b: "yy" }]
  const widths = columnWidths(cols, rows, 30)
  expect(widths.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(30)
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(4)
})

test("truncate pads or ellipsizes to the exact width", () => {
  expect(truncate("ab", 5)).toBe("ab   ")
  expect(truncate("abcdefgh", 5)).toBe("abcd…")
})
