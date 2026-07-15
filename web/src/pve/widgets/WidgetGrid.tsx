// The Home widget grid: a REAL draggable + resizable CSS-grid board. Tiles
// (see ./tiles.tsx for the {id,type,title,node?,vmid?,grid,content?} shape
// and the TILE_KINDS catalog) live in a Solid store, dragged by their header
// and resized from a bottom-right handle via Pointer Events, and persist to
// proxmoxop.layout_get/layout_set on the co-located jarvisd — see
// docs/PROXMOX_DASHBOARD.md's "Contract A verbs" table and
// daemon/src/ControlServer.cpp's handleProxmoxOpLayout{Get,Set}. Cindro
// writes the SAME file when it reshapes the board from chat
// (proxmox_dashboard_layout_get/set in proxmox-mcp/proxmox_mcp/tools_
// operator.py) and broadcasts "proxmoxop.layout" on every write, so a board
// open in the browser refreshes live when the operator (or another tab)
// edits it.
import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"

import type { CindroClient } from "../cindro-client"
import { renderTile, TILE_KINDS, type Tile, type TileGridPos, type TileKind } from "./tiles"

export type { Tile, TileGridPos, TileKind } from "./tiles"
export { TILE_KINDS } from "./tiles"

// Grid geometry — kept as JS constants (not just CSS) so the pointer-drag
// math (px delta -> cell delta) can never drift from what's on screen; the
// board's inline style sets the matching --cx-cols/--cx-cell/--cx-gap vars.
const COLS = 12
const CELL = 84
const GAP = 12
const STEP = CELL + GAP // px per grid cell including the gap

function genId(): string {
  return `t_${Math.random().toString(36).slice(2, 9)}`
}

function rectOverlap(a: TileGridPos, b: TileGridPos): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** First free (x,y) for a w×h tile, scanning row-major so new tiles land
 * top-left-most — simple, no masonry packing, but always collision-free
 * against the CURRENT layout. */
function findFreeSpot(existing: Tile[], w: number, h: number, cols: number): { x: number; y: number } {
  const cw = Math.max(1, Math.min(w, cols))
  for (let y = 0; y < 500; y++) {
    for (let x = 0; x <= cols - cw; x++) {
      const candidate = { x, y, w: cw, h }
      if (!existing.some((t) => rectOverlap(t.grid, candidate))) return { x, y }
    }
  }
  return { x: 0, y: 0 }
}

function normalizeTile(raw: unknown, fallbackY: number): Tile {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const g = (r.grid && typeof r.grid === "object" ? r.grid : {}) as Record<string, unknown>
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)
  // Clamp inside the COLS-wide grid, so an operator- or hand-written layout with
  // e.g. {x:15,w:6} doesn't push a tile off the visible board (CSS grid would
  // otherwise auto-add columns and hide it).
  const w = Math.min(COLS, Math.max(1, n(g.w, 3)))
  const x = Math.min(COLS - w, Math.max(0, n(g.x, 0)))
  return {
    id: typeof r.id === "string" && r.id ? r.id : genId(),
    type: typeof r.type === "string" && r.type ? r.type : "note",
    title: typeof r.title === "string" ? r.title : undefined,
    node: typeof r.node === "string" ? r.node : undefined,
    vmid: typeof r.vmid === "number" ? r.vmid : undefined,
    grid: {
      x,
      y: Math.max(0, n(g.y, fallbackY)),
      w,
      h: Math.max(1, n(g.h, 3)),
    },
    content: r.content,
  }
}

// --- one tile's drag + resize chrome ---------------------------------------

function TileWrap(props: {
  tile: Tile
  removing: boolean
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onRemove: (id: string) => void
  onInteractingChange: (v: boolean) => void
  children: JSX.Element
}) {
  const [dragT, setDragT] = createSignal<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = createSignal(false)
  const [snapping, setSnapping] = createSignal(false)
  const [resizeSize, setResizeSize] = createSignal<{ w: number; h: number } | null>(null)
  const [resizing, setResizing] = createSignal(false)

  // Drag: track the pointer freely (no CSS transition — feels direct), then
  // on release animate a `transform` snap to the nearest cell (transitions
  // ARE reliably interpolated for transform, unlike grid-column/grid-row —
  // see widgets.css's .snapping rule) before committing the real grid
  // position, so there's no visible jump between "snap" and "commit".
  const onWrapPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (!target.closest(".cx-tile-head")) return
    if (target.closest(".cx-tile-remove")) return
    const el = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    let lastDx = 0
    let lastDy = 0
    el.setPointerCapture(e.pointerId)
    props.onInteractingChange(true)
    setDragging(true)

    const move = (ev: PointerEvent) => {
      lastDx = ev.clientX - startX
      lastDy = ev.clientY - startY
      setDragT({ x: lastDx, y: lastDy })
    }
    const up = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
      const cellsX = Math.round(lastDx / STEP)
      const cellsY = Math.round(lastDy / STEP)
      const nx = Math.max(0, Math.min(COLS - props.tile.grid.w, props.tile.grid.x + cellsX))
      const ny = Math.max(0, props.tile.grid.y + cellsY)
      setSnapping(true)
      setDragT({ x: (nx - props.tile.grid.x) * STEP, y: (ny - props.tile.grid.y) * STEP })
      setTimeout(() => {
        setDragging(false)
        setSnapping(false)
        setDragT(null)
        props.onInteractingChange(false)
        if (nx !== props.tile.grid.x || ny !== props.tile.grid.y) props.onMove(props.tile.id, nx, ny)
      }, 190)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
  }

  // Resize: track the pointer as an explicit px width/height OVERRIDE on the
  // wrap (width/height DO animate natively, unlike grid spans), then on
  // release transition to the snapped px size before committing new w/h.
  const onResizePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    const baseW = props.tile.grid.w * CELL + (props.tile.grid.w - 1) * GAP
    const baseH = props.tile.grid.h * CELL + (props.tile.grid.h - 1) * GAP
    let lastW = baseW
    let lastH = baseH
    el.setPointerCapture(e.pointerId)
    props.onInteractingChange(true)
    setResizing(true)

    const move = (ev: PointerEvent) => {
      lastW = Math.max(CELL, baseW + (ev.clientX - startX))
      lastH = Math.max(CELL, baseH + (ev.clientY - startY))
      setResizeSize({ w: lastW, h: lastH })
    }
    const up = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
      const cellsW = Math.max(1, Math.min(COLS - props.tile.grid.x, Math.round((lastW + GAP) / STEP)))
      const cellsH = Math.max(1, Math.round((lastH + GAP) / STEP))
      setResizeSize({ w: cellsW * CELL + (cellsW - 1) * GAP, h: cellsH * CELL + (cellsH - 1) * GAP })
      setTimeout(() => {
        setResizing(false)
        setResizeSize(null)
        props.onInteractingChange(false)
        if (cellsW !== props.tile.grid.w || cellsH !== props.tile.grid.h) props.onResize(props.tile.id, cellsW, cellsH)
      }, 190)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
  }

  const style = (): JSX.CSSProperties => {
    const g = props.tile.grid
    const s: Record<string, string> = {
      "grid-column": `${g.x + 1} / span ${g.w}`,
      "grid-row": `${g.y + 1} / span ${g.h}`,
    }
    const t = dragT()
    if (t) s.transform = `translate(${t.x}px, ${t.y}px)`
    const rs = resizeSize()
    if (rs) {
      s.width = `${rs.w}px`
      s.height = `${rs.h}px`
    }
    return s as JSX.CSSProperties
  }

  return (
    <div
      class="cx-tile-wrap"
      classList={{ dragging: dragging(), snapping: snapping(), resizing: resizing(), removing: props.removing }}
      style={style()}
      onPointerDown={onWrapPointerDown}
    >
      {props.children}
      <button
        type="button"
        class="cx-tile-remove"
        title="Remove tile"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => props.onRemove(props.tile.id)}
      >
        ✕
      </button>
      <div class="cx-resize-handle" onPointerDown={onResizePointerDown} title="Drag to resize" />
    </div>
  )
}

// --- the board ---------------------------------------------------------------

export const WidgetGrid: Component<{ client: CindroClient }> = (props) => {
  const [tiles, setTiles] = createStore<Tile[]>([])
  const [loading, setLoading] = createSignal(true)
  const [removingIds, setRemovingIds] = createSignal<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = createSignal(false)
  let menuRef: HTMLDivElement | undefined
  let btnRef: HTMLButtonElement | undefined
  // Guards against a "proxmoxop.layout" broadcast (fired by our OWN save,
  // among others) clobbering an in-progress drag/resize with a stale refetch.
  let interacting = false

  const load = async () => {
    try {
      const r = await props.client.call<any>("proxmoxop.layout_get")
      const list = Array.isArray(r?.tiles) ? r.tiles : []
      setTiles(list.map((t: unknown, i: number) => normalizeTile(t, i * 3)))
    } catch {
      /* keep whatever's already on screen */
    } finally {
      setLoading(false)
    }
  }

  const persist = async () => {
    try {
      await props.client.call("proxmoxop.layout_set", { tiles: tiles.map((t) => ({ ...t })) })
    } catch {
      /* best-effort — a later successful save (ours or Cindro's) reconciles */
    }
  }

  onMount(() => {
    void load()
    const offLayout = props.client.on("proxmoxop.layout", () => {
      if (!interacting) void load()
    })
    const onDocPointer = (e: PointerEvent) => {
      if (!menuOpen()) return
      const t = e.target as Node
      if (menuRef?.contains(t) || btnRef?.contains(t)) return
      setMenuOpen(false)
    }
    document.addEventListener("pointerdown", onDocPointer)
    onCleanup(() => {
      offLayout()
      document.removeEventListener("pointerdown", onDocPointer)
    })
  })

  const moveTile = (id: string, x: number, y: number) => {
    setTiles((t) => t.id === id, "grid", (g) => ({ ...g, x, y }))
    void persist()
  }
  const resizeTile = (id: string, w: number, h: number) => {
    setTiles((t) => t.id === id, "grid", (g) => ({ ...g, w, h }))
    void persist()
  }
  const updateContent = (id: string, content: unknown) => {
    setTiles((t) => t.id === id, "content", content)
    void persist()
  }
  const removeTile = (id: string) => {
    setRemovingIds((s) => new Set(s).add(id))
    setTimeout(() => {
      setTiles((list) => list.filter((t) => t.id !== id))
      setRemovingIds((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
      void persist()
    }, 200)
  }
  const addTile = (kind: TileKind) => {
    const pos = findFreeSpot([...tiles], kind.defaultGrid.w, kind.defaultGrid.h, COLS)
    const t: Tile = {
      id: genId(),
      type: kind.type,
      title: kind.defaultTitle,
      grid: { x: pos.x, y: pos.y, w: kind.defaultGrid.w, h: kind.defaultGrid.h },
      content: kind.defaultContent,
    }
    setTiles((list) => [...list, t])
    setMenuOpen(false)
    void persist()
  }

  const boardStyle = (): JSX.CSSProperties =>
    ({
      "--cx-cols": String(COLS),
      "--cx-cell": `${CELL}px`,
      "--cx-gap": `${GAP}px`,
    }) as unknown as JSX.CSSProperties

  return (
    <div class="cx-widgetgrid">
      <div class="cx-board-toolbar">
        <button ref={btnRef} type="button" class="cx-add-btn" onClick={() => setMenuOpen((v) => !v)}>
          + Add Widget
        </button>
        <Show when={menuOpen()}>
          <div ref={menuRef} class="cx-add-menu">
            <For each={TILE_KINDS}>
              {(k) => (
                <button type="button" class="cx-add-item" onClick={() => addTile(k)}>
                  <span class="cx-add-item-icon">{k.icon}</span>
                  {k.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="cx-board-scroll">
        <Show when={loading()}>
          <div class="cx-board-empty">Loading board…</div>
        </Show>
        <Show when={!loading() && tiles.length === 0}>
          <div class="cx-board-empty">
            <div>No widgets yet.</div>
            <div>Add one above, or ask Cindro in chat to build you a board.</div>
          </div>
        </Show>
        <Show when={tiles.length > 0}>
          <div class="cx-board" style={boardStyle()}>
            <For each={tiles}>
              {(tile) => (
                <TileWrap
                  tile={tile}
                  removing={removingIds().has(tile.id)}
                  onMove={moveTile}
                  onResize={resizeTile}
                  onRemove={removeTile}
                  onInteractingChange={(v) => {
                    interacting = v
                  }}
                >
                  {renderTile(tile, { onUpdateContent: updateContent })}
                </TileWrap>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
