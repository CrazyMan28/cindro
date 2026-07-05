import { expect, test } from "bun:test"

import {
  advanceReactor,
  initialReactorState,
  paintReactor,
  reactorRows,
  rowRuns,
} from "../src/ui/arc-reactor"

test("grid dimensions follow the char-aspect squash", () => {
  const grid = paintReactor(13, initialReactorState(), false)
  expect(grid.length).toBe(reactorRows(13)) // 13 * 10/18 ≈ 7 rows
  expect(grid[0].length).toBe(13)
  expect(reactorRows(13)).toBe(7)
})

test("hot center stays bright-cyan and bold at all pulse phases", () => {
  for (const pulseMs of [0, 550, 1100, 1650]) {
    const grid = paintReactor(15, { ...initialReactorState(), pulseMs }, false)
    const midRow = grid[Math.trunc(grid.length / 2)]
    const center = midRow[Math.trunc(midRow.length / 2)]
    expect(center.ch).toBe("●")
    expect(center.color).toBe("accentBright")
    expect(center.bold).toBe(true)
  }
})

test("rings actually paint (a healthy fraction of non-space cells)", () => {
  const grid = paintReactor(13, initialReactorState(), false)
  const painted = grid.flat().filter((c) => c.ch !== " ").length
  // 36 ticks + 30 arc samples + triangle + core on a 13x7 grid — well over 20
  // distinct cells must be lit for it to read as the reactor.
  expect(painted).toBeGreaterThan(20)
})

test("thinking layers exactly the orbit dots on top", () => {
  const state = initialReactorState()
  const plain = paintReactor(13, state, false)
  const thinking = paintReactor(13, state, true)
  const flatPlain = plain.flat()
  const flatThinking = thinking.flat()
  const changed = flatThinking.filter(
    (c, i) => c.ch !== flatPlain[i].ch || c.color !== flatPlain[i].color,
  )
  expect(changed.length).toBeGreaterThanOrEqual(1) // some dots may fall off-grid/overlap
  expect(changed.length).toBeLessThanOrEqual(3)
  for (const c of changed) expect(c.color).toBe("accentBright")
})

test("painter is deterministic for a given state", () => {
  const state = { outerDeg: 123, middleDeg: 45, innerDeg: 9, orbitDeg: 200, pulseMs: 700 }
  expect(paintReactor(13, state, true)).toEqual(paintReactor(13, state, true))
})

test("advance honors direction, wrap, and the spinning/thinking gates", () => {
  let s = initialReactorState()
  s = advanceReactor(s, 100, { spinning: true, thinking: true })
  expect(s.outerDeg).toBeGreaterThan(0) // CW
  expect(s.middleDeg).toBeGreaterThan(180) // CCW wraps below 0 → 360-x
  expect(s.orbitDeg).toBeGreaterThan(0)

  const frozen = advanceReactor(s, 100, { spinning: false, thinking: false })
  expect(frozen.outerDeg).toBe(s.outerDeg) // rings frozen
  expect(frozen.orbitDeg).toBe(s.orbitDeg) // no thinking → no orbit
  expect(frozen.pulseMs).toBeGreaterThan(s.pulseMs) // pulse ALWAYS runs

  const wrapped = advanceReactor({ ...s, pulseMs: 2150 }, 100, {
    spinning: true,
    thinking: false,
  })
  expect(wrapped.pulseMs).toBeLessThan(100) // 2200ms period wrap
})

test("rowRuns collapses same-style neighbors", () => {
  const runs = rowRuns([
    { ch: "a", color: "accent" },
    { ch: "b", color: "accent" },
    { ch: " " },
    { ch: " " },
    { ch: "●", color: "accentBright", bold: true },
  ])
  expect(runs).toHaveLength(3)
  expect(runs[0]).toMatchObject({ text: "ab", color: "accent" })
  expect(runs[1].text).toBe("  ")
  expect(runs[2]).toMatchObject({ text: "●", color: "accentBright", bold: true })
})
