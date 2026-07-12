// GRAPH — a browser-friendly port of desktop/qml/MemoryGraphPage.qml's
// knowledge-graph browser (jarvis#70): entities (people/projects/topics) and
// memories, auto-extracted/linked server-side, fetched via memory.graph and
// drawn as a node/edge diagram. Per the build brief this is intentionally
// simpler than the QML version's Fruchterman-Reingold force simulation and
// <Canvas> drag/pan: a hand-rolled RADIAL layout (nodes placed at index-keyed
// angles around one or two rings) rendered with plain SVG <line>/<circle> —
// no chart library, no canvas physics. Clicking a node selects it; entity
// nodes fetch their authoritative detail + neighbors via memory.entity.get
// (memory nodes already carry everything the graph fetch gave us, so no
// second round-trip is needed for those). "Re-center" re-queries memory.graph
// rooted at that node, mirroring the QML's double-click-to-recenter gesture.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { ArcReactor } from "../components/ArcReactor"

interface EntityNode {
  id: string
  kind: "entity"
  name: string
  type: string
  scope: string
  projectRef?: string
  created: number
  updated: number
}
interface MemoryNode {
  id: string
  kind: "memory"
  text: string
  tags: string[]
  created: number
  updated?: number
}
type GraphNode = EntityNode | MemoryNode
interface GraphEdge {
  from: string
  to: string
  relation: string
}
type RelatedNode = Record<string, unknown>

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}
function asNumber(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function toGraphNode(raw: unknown): GraphNode | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = asString(r.id)
  if (!id) return null
  if (r.kind === "entity") {
    return {
      id,
      kind: "entity",
      name: asString(r.name),
      type: asString(r.type, "misc"),
      scope: asString(r.scope, "global"),
      projectRef: r.projectRef === undefined ? undefined : asString(r.projectRef),
      created: asNumber(r.created),
      updated: asNumber(r.updated),
    }
  }
  return {
    id,
    kind: "memory",
    text: asString(r.text),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    created: asNumber(r.created),
    updated: r.updated === undefined ? undefined : asNumber(r.updated),
  }
}

function toGraphEdge(raw: unknown): GraphEdge | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const from = asString(r.from)
  const to = asString(r.to)
  if (!from || !to) return null
  return { from, to, relation: asString(r.relation, "relates_to") }
}

function nodeLabel(n: GraphNode): string {
  const raw = n.kind === "entity" ? n.name : n.text
  return raw.length > 24 ? `${raw.slice(0, 23)}…` : raw || "(untitled)"
}
function nodeColor(n: GraphNode): string {
  if (n.kind === "entity") return n.scope === "project" ? "var(--amber)" : "var(--violet)"
  return "var(--accent)"
}
function nodeRadius(n: GraphNode): number {
  return n.kind === "entity" ? 9 : 6
}

interface Pt {
  x: number
  y: number
}

/** Hand-rolled radial layout keyed by node index — NOT a physics simulation.
 * Overview (no root): entities on an inner ring, memories on an outer ring.
 * Rooted subgraph: the root sits centered, everything else on one ring
 * around it. Deterministic given the same node order, so re-renders don't
 * jitter the picture. */
function radialLayout(nodes: GraphNode[], w: number, h: number, rootId: string): Map<string, Pt> {
  const pos = new Map<string, Pt>()
  if (w <= 0 || h <= 0 || nodes.length === 0) return pos
  const cx = w / 2
  const cy = h / 2
  const root = rootId ? nodes.find((n) => n.id === rootId) : undefined
  const others = root ? nodes.filter((n) => n.id !== root.id) : nodes
  if (root) pos.set(root.id, { x: cx, y: cy })

  if (!root) {
    const entities = others.filter((n) => n.kind === "entity")
    const memories = others.filter((n) => n.kind === "memory")
    const rEntity = Math.min(w, h) * 0.24
    const rMemory = Math.min(w, h) * 0.44
    entities.forEach((n, i) => {
      const a = (i / Math.max(1, entities.length)) * Math.PI * 2
      pos.set(n.id, { x: cx + Math.cos(a) * rEntity, y: cy + Math.sin(a) * rEntity })
    })
    memories.forEach((n, i) => {
      const a = (i / Math.max(1, memories.length)) * Math.PI * 2 + 0.35
      pos.set(n.id, { x: cx + Math.cos(a) * rMemory, y: cy + Math.sin(a) * rMemory })
    })
  } else {
    const r = Math.min(w, h) * 0.38
    others.forEach((n, i) => {
      const a = (i / Math.max(1, others.length)) * Math.PI * 2
      pos.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
    })
  }
  return pos
}

const CANVAS_HEIGHT = 480

function MemoryGraph() {
  const app = useApp()

  const [nodes, setNodes] = createSignal<GraphNode[]>([])
  const [edges, setEdges] = createSignal<GraphEdge[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const [rootId, setRootId] = createSignal("")
  const [selectedId, setSelectedId] = createSignal("")
  const [hoveredId, setHoveredId] = createSignal("")
  const [entityDetail, setEntityDetail] = createSignal<{ node: EntityNode; related: RelatedNode[] } | null>(null)
  const [detailBusy, setDetailBusy] = createSignal(false)

  const [width, setWidth] = createSignal(600)
  let wrap: HTMLDivElement | undefined
  let ro: ResizeObserver | undefined

  let alive = true
  onCleanup(() => {
    alive = false
    ro?.disconnect()
  })

  const refresh = async (root = rootId()) => {
    setLoading(true)
    try {
      const res = await app.client.call("memory.graph", { root, depth: 2 }, 15000)
      if (!alive) return
      const ns = ((res.nodes ?? []) as unknown[]).map(toGraphNode).filter((n): n is GraphNode => n !== null)
      const es = ((res.edges ?? []) as unknown[]).map(toGraphEdge).filter((e): e is GraphEdge => e !== null)
      setNodes(ns)
      setEdges(es)
      // A previously-selected node may have dropped out of the subgraph
      // (e.g. after re-centering elsewhere) — clear stale selection.
      if (selectedId() && !ns.some((n) => n.id === selectedId())) {
        setSelectedId("")
        setEntityDetail(null)
      }
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
    if (wrap) {
      setWidth(wrap.clientWidth || 600)
      ro = new ResizeObserver((entries) => {
        for (const e of entries) setWidth(Math.max(240, e.contentRect.width))
      })
      ro.observe(wrap)
    }
    const timer = setInterval(() => void refresh(), 30000)
    onCleanup(() => clearInterval(timer))
  })

  const positions = createMemo(() => radialLayout(nodes(), width(), CANVAS_HEIGHT, rootId()))

  const selectedNode = createMemo<GraphNode | undefined>(() => nodes().find((n) => n.id === selectedId()))

  // Neighbors of the selected node derived from the edges we already have —
  // used for a memory node's "Linked" line without any extra round-trip.
  const localLinked = createMemo<GraphNode[]>(() => {
    const id = selectedId()
    if (!id) return []
    const ids = new Set<string>()
    for (const e of edges()) {
      if (e.from === id) ids.add(e.to)
      else if (e.to === id) ids.add(e.from)
    }
    return nodes().filter((n) => ids.has(n.id))
  })

  const selectNode = async (id: string) => {
    setSelectedId(id)
    setEntityDetail(null)
    const n = nodes().find((x) => x.id === id)
    if (n && n.kind === "entity") {
      setDetailBusy(true)
      try {
        const res = await app.client.call("memory.entity.get", { id }, 15000)
        // A faster later selectNode(otherId) call can resolve first — only
        // apply this response if the user is still looking at this node.
        if (!alive || selectedId() !== id) return
        const entity = toGraphNode({ ...res, kind: "entity" })
        if (entity && entity.kind === "entity") {
          setEntityDetail({ node: entity, related: (res.related ?? []) as RelatedNode[] })
        }
      } catch (e) {
        if (alive && selectedId() === id) app.notify(`Could not load entity: ${String(e)}`, "error")
      } finally {
        if (alive && selectedId() === id) setDetailBusy(false)
      }
    }
  }

  const recenter = (id: string) => {
    setRootId(id)
    setSelectedId("")
    setEntityDetail(null)
    void refresh(id)
  }
  const backToOverview = () => {
    setRootId("")
    setSelectedId("")
    setEntityDetail(null)
    void refresh("")
  }

  const relatedLabel = createMemo(() => {
    const detail = entityDetail()
    if (!detail) return ""
    return detail.related
      .map((r) => (typeof r.name === "string" ? r.name : typeof r.text === "string" ? r.text.slice(0, 30) : ""))
      .filter((s) => s.length > 0)
      .join(", ")
  })

  return (
    <div class="jw-graph-page">
      <style>{`
        .jw-graph-page { display: flex; flex-direction: column; gap: 16px; max-width: 1000px; }
        .jw-graph-header { display: flex; align-items: center; gap: 16px; }
        .jw-graph-header-sub { color: var(--text-muted); font-size: 12px; max-width: 560px; line-height: 1.35; }
        .jw-graph-toolbar { display: flex; align-items: center; gap: 10px; }
        .jw-graph-toolbar-info { flex: 1; color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .jw-graph-btn {
          all: unset; cursor: pointer; padding: 7px 14px; border-radius: 999px;
          border: 1px solid var(--hairline-soft); background: var(--surface); color: var(--accent);
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          transition: border-color var(--dur-fast) ease, transform var(--dur-fast) ease, box-shadow var(--dur-fast) ease;
          white-space: nowrap;
        }
        .jw-graph-btn:hover { border-color: var(--accent-dim); transform: translateY(-1px); box-shadow: 0 3px 12px -4px var(--accent-glow); }
        .jw-graph-canvas-wrap {
          width: 100%; height: ${CANVAS_HEIGHT}px; border-radius: var(--radius);
          background: var(--panel-soft); border: 1px solid var(--hairline-soft); overflow: hidden;
          position: relative;
        }
        .jw-graph-svg { display: block; width: 100%; height: 100%; }
        .jw-graph-node { cursor: pointer; }
        .jw-graph-node-label { font-family: var(--font-mono); font-size: 10px; fill: var(--text-faint); text-anchor: middle; pointer-events: none; }
        .jw-graph-node-label.active { fill: var(--text); font-weight: 600; }
        .jw-graph-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 46px 20px; text-align: center; }
        .jw-graph-empty-title { font-family: var(--font-display); color: var(--accent-bright); font-size: 14px; letter-spacing: var(--track-mid); }
        .jw-graph-empty-sub { color: var(--text-faint); font-size: 12px; max-width: 380px; line-height: 1.4; }
        .jw-graph-detail { display: flex; flex-direction: column; gap: 8px; }
        .jw-graph-detail-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .jw-graph-detail-title { color: var(--text); font-size: 13px; }
        .jw-graph-detail-kind { color: var(--violet); font-family: var(--font-mono); font-size: 10px; }
        .jw-graph-detail-linked { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
        .jw-graph-tag {
          display: inline-block; padding: 2px 8px; border-radius: 999px;
          border: 1px solid rgba(61,214,255,0.35); color: var(--accent);
          font-family: var(--font-mono); font-size: 10px;
        }
      `}</style>

      <div class="jw-graph-header card">
        <ArcReactor size={44} tint="var(--violet)" />
        <div>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "18px" }}>
            KNOWLEDGE GRAPH
          </div>
          <div class="jw-graph-header-sub">
            Entities and relationships auto-extracted from memory. Click a node to inspect it, then
            re-center to explore its neighborhood.
          </div>
        </div>
      </div>

      <div class="jw-graph-toolbar">
        <div class="jw-graph-toolbar-info">
          {rootId()
            ? `Rooted at: ${selectedNode() ? nodeLabel(selectedNode()!) : rootId()}`
            : `${nodes().length} nodes · ${edges().length} links`}
        </div>
        <Show when={rootId()}>
          <button type="button" class="jw-graph-btn" onClick={backToOverview}>
            Overview
          </button>
        </Show>
        <button type="button" class="jw-graph-btn" onClick={() => void refresh()}>
          {loading() ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading() && nodes().length === 0}>
        <div class="jw-graph-empty">
          <ArcReactor size={84} tint="var(--violet)" />
          <div class="jw-graph-empty-title">GRAPH EMPTY</div>
          <div class="jw-graph-empty-sub">
            As you save memories, Orin auto-extracts people, projects, and topics and links them here.
          </div>
        </div>
      </Show>

      <Show when={nodes().length > 0}>
        <div class="jw-graph-canvas-wrap" ref={wrap}>
          <svg
            class="jw-graph-svg"
            viewBox={`0 0 ${width()} ${CANVAS_HEIGHT}`}
            onClick={() => {
              setSelectedId("")
              setEntityDetail(null)
            }}
          >
            <For each={edges()}>
              {(e) => {
                const pa = () => positions().get(e.from)
                const pb = () => positions().get(e.to)
                return (
                  <Show when={pa() && pb()}>
                    <g>
                      <line
                        x1={pa()!.x}
                        y1={pa()!.y}
                        x2={pb()!.x}
                        y2={pb()!.y}
                        stroke="var(--accent)"
                        stroke-width="3.5"
                        stroke-opacity="0.10"
                        stroke-linecap="round"
                      />
                      <line
                        x1={pa()!.x}
                        y1={pa()!.y}
                        x2={pb()!.x}
                        y2={pb()!.y}
                        stroke="var(--hairline)"
                        stroke-width="1"
                        stroke-linecap="round"
                      />
                    </g>
                  </Show>
                )
              }}
            </For>

            <For each={nodes()}>
              {(n) => {
                const p = () => positions().get(n.id)
                const isSelected = () => n.id === selectedId()
                const isHovered = () => n.id === hoveredId()
                const r = nodeRadius(n)
                return (
                  <Show when={p()}>
                    <g
                      class="jw-graph-node"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void selectNode(n.id)
                      }}
                      onDblClick={(ev) => {
                        ev.stopPropagation()
                        recenter(n.id)
                      }}
                      onMouseEnter={() => setHoveredId(n.id)}
                      onMouseLeave={() => setHoveredId((h) => (h === n.id ? "" : h))}
                    >
                      <circle
                        cx={p()!.x}
                        cy={p()!.y}
                        r={r + (isSelected() || isHovered() ? 8 : 5)}
                        fill={nodeColor(n)}
                        fill-opacity={isSelected() ? 0.28 : isHovered() ? 0.22 : 0.14}
                      />
                      <circle
                        cx={p()!.x}
                        cy={p()!.y}
                        r={isSelected() ? r + 2 : r}
                        fill="var(--surface-strong)"
                        stroke={nodeColor(n)}
                        stroke-width={isSelected() ? 2.5 : isHovered() ? 2 : 1.5}
                      />
                      <text
                        x={p()!.x}
                        y={p()!.y + r + 13}
                        class={`jw-graph-node-label${isSelected() || isHovered() ? " active" : ""}`}
                      >
                        {nodeLabel(n)}
                      </text>
                    </g>
                  </Show>
                )
              }}
            </For>
          </svg>
        </div>
      </Show>

      <Show when={selectedNode()}>
        {(n) => (
          <div class="card jw-graph-detail">
            <div class="jw-graph-detail-row">
              <span class="jw-graph-detail-title">{nodeLabel(n())}</span>
              <Show when={n().kind === "entity"}>
                <span class="jw-graph-detail-kind">
                  [{(n() as EntityNode).type}
                  {(n() as EntityNode).scope === "project" ? " · project" : ""}]
                </span>
              </Show>
            </div>
            <Show when={n().kind === "memory"}>
              <div class="jw-graph-detail-row">
                <For each={(n() as MemoryNode).tags}>{(t) => <span class="jw-graph-tag">#{t}</span>}</For>
              </div>
            </Show>
            <Show when={detailBusy()}>
              <div class="jw-graph-detail-linked">Loading entity detail…</div>
            </Show>
            <Show when={n().kind === "entity" && entityDetail() && relatedLabel().length > 0}>
              <div class="jw-graph-detail-linked">Linked: {relatedLabel()}</div>
            </Show>
            <Show when={n().kind === "memory" && localLinked().length > 0}>
              <div class="jw-graph-detail-linked">
                Linked: {localLinked().map((ln) => nodeLabel(ln)).join(", ")}
              </div>
            </Show>
            <div>
              <button type="button" class="jw-graph-btn" onClick={() => recenter(n().id)}>
                Re-center here
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

const page: PageDef = { id: "memorygraph", label: "GRAPH", section: "MIND", order: 5, component: MemoryGraph }
export default page
