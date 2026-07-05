// Braille canvas rasterizer — turns the widget DSL's vector `canvas` ops
// (circle/ellipse/rect/line/path, fill + stroke) into actual drawn art using
// Unicode braille (each cell packs a 2×4 dot grid, U+2800 + bitmask), so the
// duck the GUI rasterizes shows up as a REAL duck in the terminal instead of
// a list of coordinates. Per-cell one color (braille cells are monochrome),
// so we keep the last color that lit a dot in each cell.
//
// Braille dot → bit map, indexed [dotY 0..3][dotX 0..1]:
//   (0,0)=0x01 (0,1)=0x08
//   (1,0)=0x02 (1,1)=0x10
//   (2,0)=0x04 (2,1)=0x20
//   (3,0)=0x40 (3,1)=0x80

const DOT_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

export interface BrailleRow {
  runs: Array<{ text: string; color?: string }>
}

export class BrailleCanvas {
  // dot resolution
  readonly dotW: number
  readonly dotH: number
  readonly cols: number
  readonly rows: number
  private bits: Uint8Array // one byte per cell
  private color: (string | undefined)[] // one color per cell

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.dotW = this.cols * 2
    this.dotH = this.rows * 4
    this.bits = new Uint8Array(this.cols * this.rows)
    this.color = new Array(this.cols * this.rows).fill(undefined)
  }

  private set(dx: number, dy: number, color?: string): void {
    const x = Math.round(dx)
    const y = Math.round(dy)
    if (x < 0 || y < 0 || x >= this.dotW || y >= this.dotH) return
    const cx = Math.floor(x / 2)
    const cy = Math.floor(y / 4)
    const idx = cy * this.cols + cx
    this.bits[idx] |= DOT_BIT[y % 4][x % 2]
    if (color) this.color[idx] = color
  }

  line(x0: number, y0: number, x1: number, y1: number, color?: string): void {
    // Bresenham on the dot grid.
    let dx0 = Math.round(x0)
    let dy0 = Math.round(y0)
    const dx1 = Math.round(x1)
    const dy1 = Math.round(y1)
    const dx = Math.abs(dx1 - dx0)
    const dy = -Math.abs(dy1 - dy0)
    const sx = dx0 < dx1 ? 1 : -1
    const sy = dy0 < dy1 ? 1 : -1
    let err = dx + dy
    let guard = 0
    while (guard++ < this.dotW * this.dotH + 8) {
      this.set(dx0, dy0, color)
      if (dx0 === dx1 && dy0 === dy1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        dx0 += sx
      }
      if (e2 <= dx) {
        err += dx
        dy0 += sy
      }
    }
  }

  strokeEllipse(cx: number, cy: number, rx: number, ry: number, color?: string): void {
    const steps = Math.max(16, Math.round((rx + ry) * 1.6))
    let px = cx + rx
    let py = cy
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const nx = cx + Math.cos(a) * rx
      const ny = cy + Math.sin(a) * ry
      this.line(px, py, nx, ny, color)
      px = nx
      py = ny
    }
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, color?: string): void {
    for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) {
      const t = ry === 0 ? 0 : 1 - (y * y) / (ry * ry)
      if (t < 0) continue
      const halfW = rx * Math.sqrt(t)
      for (let x = -halfW; x <= halfW; x += 0.5) this.set(cx + x, cy + y, color)
    }
  }

  rect(x: number, y: number, w: number, h: number, color?: string, fill = false): void {
    if (fill) {
      for (let yy = y; yy <= y + h; yy += 0.5)
        for (let xx = x; xx <= x + w; xx += 0.5) this.set(xx, yy, color)
      return
    }
    this.line(x, y, x + w, y, color)
    this.line(x + w, y, x + w, y + h, color)
    this.line(x + w, y + h, x, y + h, color)
    this.line(x, y + h, x, y, color)
  }

  polyline(pts: Array<{ x: number; y: number }>, close: boolean, color?: string): void {
    for (let i = 1; i < pts.length; i++)
      this.line(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, color)
    if (close && pts.length > 2)
      this.line(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y, color)
  }

  toRows(): BrailleRow[] {
    const out: BrailleRow[] = []
    for (let cy = 0; cy < this.rows; cy++) {
      const runs: BrailleRow["runs"] = []
      for (let cx = 0; cx < this.cols; cx++) {
        const idx = cy * this.cols + cx
        const ch = String.fromCharCode(0x2800 + this.bits[idx])
        const color = this.color[idx]
        const last = runs[runs.length - 1]
        if (last && last.color === color) last.text += ch
        else runs.push({ text: ch, color })
      }
      out.push({ runs })
    }
    return out
  }
}

type Op = Record<string, unknown>
const num = (v: unknown, d = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const strc = (v: unknown): string | undefined => {
  const s = v === undefined || v === null ? "" : String(v)
  return s.startsWith("#") ? s : undefined
}

/** Compute a fit: source coord bounds → the target dot grid, preserving
 * aspect and centering. Returns a mapper (sx,sy)→(dx,dy). */
function fitTransform(
  ops: Op[],
  declaredW: number,
  declaredH: number,
  dotW: number,
  dotH: number,
): (x: number, y: number) => [number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const acc = (x: number, y: number, pad = 0) => {
    minX = Math.min(minX, x - pad)
    minY = Math.min(minY, y - pad)
    maxX = Math.max(maxX, x + pad)
    maxY = Math.max(maxY, y + pad)
  }
  for (const op of ops) {
    const k = String(op.op ?? "")
    if (k === "circle") acc(num(op.x), num(op.y), num(op.r))
    else if (k === "ellipse") {
      acc(num(op.x), num(op.y), Math.max(num(op.rx), num(op.ry)))
    } else if (k === "rect") {
      acc(num(op.x), num(op.y))
      acc(num(op.x) + num(op.w), num(op.y) + num(op.h))
    } else if (k === "line") {
      acc(num(op.x1), num(op.y1))
      acc(num(op.x2), num(op.y2))
    } else if (k === "path") {
      for (const p of (op.points ?? []) as Op[]) acc(num(p.x), num(p.y))
    }
  }
  if (declaredW > 0 && declaredH > 0) {
    minX = Math.min(minX, 0)
    minY = Math.min(minY, 0)
    maxX = Math.max(maxX, declaredW)
    maxY = Math.max(maxY, declaredH)
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 1
    maxY = 1
  }
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const scale = Math.min((dotW - 1) / spanX, (dotH - 1) / spanY)
  const offX = (dotW - 1 - spanX * scale) / 2
  const offY = (dotH - 1 - spanY * scale) / 2
  return (x, y) => [(x - minX) * scale + offX, (y - minY) * scale + offY]
}

export interface RasterOpts {
  cols?: number
  rows?: number
  defaultColor: string
}

/**
 * Rasterize a widget `canvas` node's ops into braille rows. `canvas` node
 * shape: { type:"canvas", w?, h?, ops:[{op, ...}], color? }.
 */
export function rasterizeCanvas(node: Record<string, unknown>, opts: RasterOpts): BrailleRow[] {
  const ops = ((node.ops ?? []) as Op[]).filter(Boolean)
  const cols = Math.max(8, Math.min(60, opts.cols ?? 40))
  const rows = Math.max(4, Math.min(24, opts.rows ?? Math.round(cols * 0.45)))
  const canvas = new BrailleCanvas(cols, rows)
  const T = fitTransform(ops, num(node.w), num(node.h), canvas.dotW, canvas.dotH)
  const base = strc(node.color) ?? opts.defaultColor

  for (const op of ops) {
    const k = String(op.op ?? "")
    const color = strc(op.color) ?? strc(op.stroke) ?? strc(op.fill) ?? base
    const filled = Boolean(op.fill) && op.fill !== false
    if (k === "circle" || k === "ellipse") {
      const rx = k === "circle" ? num(op.r) : num(op.rx)
      const ry = k === "circle" ? num(op.r) : num(op.ry)
      const [cx, cy] = T(num(op.x), num(op.y))
      // scale radius by the transform's x-scale (uniform)
      const [ex] = T(num(op.x) + rx, num(op.y))
      const [, ey] = T(num(op.x), num(op.y) + ry)
      const drx = Math.abs(ex - cx)
      const dry = Math.abs(ey - cy)
      if (filled) canvas.fillEllipse(cx, cy, drx, dry, color)
      else canvas.strokeEllipse(cx, cy, drx, dry, color)
    } else if (k === "rect") {
      const [x0, y0] = T(num(op.x), num(op.y))
      const [x1, y1] = T(num(op.x) + num(op.w), num(op.y) + num(op.h))
      canvas.rect(x0, y0, x1 - x0, y1 - y0, color, filled)
    } else if (k === "line") {
      const [x0, y0] = T(num(op.x1), num(op.y1))
      const [x1, y1] = T(num(op.x2), num(op.y2))
      canvas.line(x0, y0, x1, y1, color)
    } else if (k === "path") {
      const pts = ((op.points ?? []) as Op[]).map((p) => {
        const [x, y] = T(num(p.x), num(p.y))
        return { x, y }
      })
      canvas.polyline(pts, Boolean(op.close), color)
    }
  }
  return canvas.toRows()
}
