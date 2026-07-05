import { expect, test } from "bun:test"

import { BrailleCanvas, rasterizeCanvas } from "../src/widgets/braille"

const painted = (rows: { runs: { text: string }[] }[]) =>
  rows
    .flatMap((r) => r.runs.map((run) => run.text))
    .join("")
    .split("")
    .filter((ch) => ch !== "⠀").length // non-blank braille cells

test("BrailleCanvas lights the expected dot count for a line", () => {
  const c = new BrailleCanvas(10, 4)
  c.line(0, 0, 19, 0) // top dot-row across the full width
  const rows = c.toRows()
  expect(rows).toHaveLength(4)
  expect(painted(rows)).toBeGreaterThan(0)
})

test("filled ellipse fills more cells than a stroked one", () => {
  const fill = new BrailleCanvas(20, 12)
  fill.fillEllipse(20, 24, 18, 18, "#fff")
  const stroke = new BrailleCanvas(20, 12)
  stroke.strokeEllipse(20, 24, 18, 18, "#fff")
  expect(painted(fill.toRows())).toBeGreaterThan(painted(stroke.toRows()))
})

test("rasterizeCanvas draws the duck (circles + path) as real braille art", () => {
  // The exact shape from the failing screenshot.
  const duck = {
    type: "canvas",
    w: 160,
    h: 110,
    ops: [
      { op: "circle", x: 80, y: 95, r: 48, fill: "#FFD54A" },
      { op: "circle", x: 120, y: 55, r: 24, fill: "#FFD54A" },
      { op: "path", points: [{ x: 140, y: 55 }, { x: 160, y: 50 }, { x: 140, y: 62 }], close: true, fill: "#FF8C00" },
      { op: "circle", x: 126, y: 50, r: 4, fill: "#111" },
    ],
  }
  const rows = rasterizeCanvas(duck, { defaultColor: "#3DD6FF" })
  // A duck should light up a LOT of cells, not print 4 lines of coordinates.
  expect(painted(rows)).toBeGreaterThan(60)
  // Fits inside a sane bound.
  expect(rows.length).toBeLessThanOrEqual(24)
})

test("empty ops → empty rows (caller shows the empty-state)", () => {
  const rows = rasterizeCanvas({ type: "canvas", ops: [] }, { defaultColor: "#fff" })
  expect(painted(rows)).toBe(0)
})
