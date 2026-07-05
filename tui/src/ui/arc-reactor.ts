// Arc-reactor painter — the terminal recreation of desktop/qml/ArcReactor.qml
// (36 rim ticks slow-CW with every 3rd longer, 6 arc segments fast-CCW, a
// rotating 3-point triangle frame, a pulsing core with a constant bright hot
// center, and 3 orbiting "thinking" dots). A 1:1 port of the audited
// cli/jarvis_cli/tui/arc_reactor.py trigonometry: same radii fractions, same
// rotation directions, same periods, same two cyans. Pure functions —
// the Solid component just ticks a state and maps cells to <text> spans.

import { motion } from "../theme/tokens"

export const REACTOR_CHAR_ASPECT = 10 / 18

export interface ReactorState {
  outerDeg: number
  middleDeg: number
  innerDeg: number
  orbitDeg: number
  pulseMs: number
}

export const initialReactorState = (): ReactorState => ({
  outerDeg: 0,
  middleDeg: 0,
  innerDeg: 0,
  orbitDeg: 0,
  pulseMs: 0,
})

/** Advance all animation clocks by dtMs (pure — returns a new state). */
export function advanceReactor(
  s: ReactorState,
  dtMs: number,
  opts: { spinning: boolean; thinking: boolean },
): ReactorState {
  const next = { ...s }
  if (opts.spinning) {
    next.outerDeg = (s.outerDeg + (360 * dtMs) / motion.ringSlowMs) % 360
    next.middleDeg = (((s.middleDeg - (360 * dtMs) / motion.ringFastMs) % 360) + 360) % 360
    next.innerDeg = (s.innerDeg + (360 * dtMs) / motion.ringInnerMs) % 360
  }
  // The pulse runs regardless of spinning — QML gates it on `visible` only.
  next.pulseMs = (s.pulseMs + dtMs) % motion.pulseMs
  if (opts.thinking) next.orbitDeg = (s.orbitDeg + (360 * dtMs) / motion.orbitMs) % 360
  return next
}

export interface ReactorCell {
  ch: string
  /** semantic color: "accent" (rings/core) or "accentBright" (hot center + thinking dots) */
  color?: "accent" | "accentBright"
  bold?: boolean
  dim?: boolean
}

export function reactorRows(size: number): number {
  return Math.max(3, Math.round(size * REACTOR_CHAR_ASPECT))
}

/**
 * Pick a box-drawing character whose orientation best matches the on-screen
 * direction — ring ticks/arcs/edges read as radial or tangential strokes
 * instead of undifferentiated dots. dy must already be aspect-corrected.
 */
function dirChar(dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return "•"
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (ady < adx * 0.5) return "━"
  if (adx < ady * 0.5) return "┃"
  return dx * dy > 0 ? "╲" : "╱"
}

export function paintReactor(
  size: number,
  state: ReactorState,
  thinking: boolean,
): ReactorCell[][] {
  const cols = Math.max(5, Math.trunc(size))
  const rows = reactorRows(cols)
  const grid: ReactorCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ch: " " }) as ReactorCell),
  )

  const cx = (cols - 1) / 2
  const cy = (rows - 1) / 2
  const r = Math.max(1, cols / 2 - 1) // QML: r = min(w,h)/2 - 1
  const aspect = REACTOR_CHAR_ASPECT

  const plot = (realX: number, realY: number, cell: ReactorCell): void => {
    const col = Math.round(cx + realX)
    const row = Math.round(cy + realY * aspect)
    if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row][col] = cell
  }

  // ---- outer ring: 36 rim ticks, every 3rd longer, slow CW ---------------
  const outerRot = (state.outerDeg * Math.PI) / 180
  const ticks = 36
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2 + outerRot
    const long = i % 3 === 0
    const r0 = r * (long ? 0.8 : 0.88)
    const r1 = r * 0.96
    const ch = dirChar(Math.cos(a), Math.sin(a) * aspect) // radial stroke
    const steps = long ? 2 : 1
    for (let s = 0; s <= steps; s++) {
      const rr = r0 + ((r1 - r0) * s) / steps
      plot(Math.cos(a) * rr, Math.sin(a) * rr, {
        ch,
        color: "accent",
        dim: !long,
      })
    }
  }

  // ---- middle ring: 6 arc segments, radius 0.66r, fast CCW ---------------
  const middleRot = (state.middleDeg * Math.PI) / 180
  const segs = 6
  const segStep = (Math.PI * 2) / segs
  const rMid = r * 0.66
  const samples = 4
  for (let i = 0; i < segs; i++) {
    const a0 = i * segStep + 0.18 + middleRot
    const a1 = a0 + segStep - 0.55
    for (let s = 0; s <= samples; s++) {
      const a = a0 + ((a1 - a0) * s) / samples
      const ch = dirChar(-Math.sin(a), Math.cos(a) * aspect) // tangential
      plot(Math.cos(a) * rMid, Math.sin(a) * rMid, { ch, color: "accent", bold: true })
    }
  }

  // ---- inner triangle frame: radius 0.42r, slow CW ------------------------
  const innerRot = (state.innerDeg * Math.PI) / 180
  const rIn = r * 0.42
  const verts: Array<[number, number]> = []
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2 + innerRot
    verts.push([Math.cos(a) * rIn, Math.sin(a) * rIn])
  }
  for (let i = 0; i < 3; i++) {
    const [x0, y0] = verts[i]
    const [x1, y1] = verts[(i + 1) % 3]
    const edgeDx = x1 - x0
    const edgeDy = (y1 - y0) * aspect
    const ch = dirChar(edgeDx, edgeDy)
    const length = Math.hypot(edgeDx, edgeDy)
    const steps = Math.max(2, Math.trunc(length * 1.5))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      plot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, { ch, color: "accent" })
    }
  }

  // ---- core: filled pulsing disc + smaller constant hot center -----------
  // QML's 0.82->1.12->0.82 InOutSine over PULSE_MS collapses to a cosine.
  const t = state.pulseMs / motion.pulseMs
  const scale = 0.97 - 0.15 * Math.cos(2 * Math.PI * t)
  const coreRBase = cols * 0.15 // QML: coreWrap width*0.5 = size*0.15
  const coreR = coreRBase * scale
  const hotR = coreRBase * 0.5 // hot dot is size*0.075, NOT scaled
  const coreBold = scale >= 0.97
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const realDx = col - cx
      const realDy = (row - cy) / aspect
      const dist = Math.hypot(realDx, realDy)
      if (dist <= hotR) grid[row][col] = { ch: "●", color: "accentBright", bold: true }
      else if (dist <= coreR) grid[row][col] = { ch: "●", color: "accent", bold: coreBold }
    }
  }

  // ---- thinking: 3 dots orbiting the whole reactor, on top ---------------
  if (thinking) {
    const orbitR = cols * 0.52
    for (let i = 0; i < 3; i++) {
      const theta = state.orbitDeg + i * 120
      const a = ((theta - 90) * Math.PI) / 180 // 0 == straight up, like QML
      plot(Math.cos(a) * orbitR, Math.sin(a) * orbitR, {
        ch: "•",
        color: "accentBright",
        bold: true,
      })
    }
  }

  return grid
}

/**
 * Collapse one painted row into runs of identical style — so the component
 * emits one <text> span per run instead of one per cell.
 */
export interface ReactorRun {
  text: string
  color?: "accent" | "accentBright"
  bold?: boolean
  dim?: boolean
}

export function rowRuns(row: ReactorCell[]): ReactorRun[] {
  const runs: ReactorRun[] = []
  for (const cell of row) {
    const last = runs[runs.length - 1]
    if (
      last &&
      last.color === cell.color &&
      Boolean(last.bold) === Boolean(cell.bold) &&
      Boolean(last.dim) === Boolean(cell.dim)
    ) {
      last.text += cell.ch
    } else {
      runs.push({ text: cell.ch, color: cell.color, bold: cell.bold, dim: cell.dim })
    }
  }
  return runs
}
