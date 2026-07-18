// LIVE tile renderers for the Home widget grid — fed by pve-api (the direct,
// same-origin Proxmox REST client; see ../pve-api.ts), so tiles update with
// zero LLM round-trips. This file IS the tile-type contract: `Tile`/
// `TileGridPos` describe what WidgetGrid.tsx persists via proxmoxop.layout_*,
// and `TILE_KINDS` is the catalog WidgetGrid's "add tile" palette renders
// from — Cindro creating a tile from chat and a user adding one here both
// produce the exact same {id,type,title,node?,vmid?,grid,content?} shape.
//
// renderTile() dispatches purely on tile.type; an unrecognized type ALWAYS
// renders a friendly placeholder card (never a blank cell — a bad/unknown
// type from an older Cindro build or a hand-edited layout file must not
// break the board).
import {
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type Accessor,
  type JSX,
} from "solid-js"

import {
  clusterResources,
  nodeStatus,
  nodes,
  storageContent,
  storages,
  type ClusterResource,
  type NodeStatus,
  type PveNode,
  type StorageContentItem,
  type StorageSummary,
} from "../pve-api"
import type { CindroClient } from "../cindro-client"
import { WidgetTree } from "./WidgetRenderer"

// --- the tile-type contract -------------------------------------------------

export type TileGridPos = { x: number; y: number; w: number; h: number }

export type Tile = {
  id: string
  type: string
  title?: string
  node?: string
  vmid?: number
  grid: TileGridPos
  content?: unknown
}

export type TileActions = {
  onUpdateContent?: (id: string, content: unknown) => void
  // The daemon RPC bus — only tiles that read operator-local state (the Tasks
  // Kanban) need it; the live Proxmox tiles read pve-api (direct REST) instead.
  client?: CindroClient
}

export type TileKind = {
  type: string
  label: string
  icon: string
  defaultTitle: string
  defaultGrid: TileGridPos
  defaultContent?: unknown
}

export const TILE_KINDS: TileKind[] = [
  { type: "cpu_usage", label: "CPU Usage", icon: "◎", defaultTitle: "CPU", defaultGrid: { x: 0, y: 0, w: 3, h: 3 } },
  { type: "vm_status", label: "VM / CT Status", icon: "▦", defaultTitle: "Guests", defaultGrid: { x: 0, y: 0, w: 5, h: 4 } },
  { type: "node_stats", label: "Node Stats", icon: "≣", defaultTitle: "Node", defaultGrid: { x: 0, y: 0, w: 4, h: 3 } },
  { type: "storage", label: "Storage", icon: "▤", defaultTitle: "Storage", defaultGrid: { x: 0, y: 0, w: 4, h: 3 } },
  { type: "note", label: "Note", icon: "✎", defaultTitle: "Note", defaultGrid: { x: 0, y: 0, w: 3, h: 2 }, defaultContent: "" },
  { type: "cluster_status", label: "Cluster Status", icon: "◈", defaultTitle: "Cluster", defaultGrid: { x: 0, y: 0, w: 4, h: 3 } },
  { type: "recent_backups", label: "Recent Backups", icon: "▧", defaultTitle: "Recent Backups", defaultGrid: { x: 0, y: 0, w: 4, h: 4 } },
  { type: "tasks_board", label: "Tasks Board", icon: "☰", defaultTitle: "Tasks", defaultGrid: { x: 0, y: 0, w: 4, h: 4 } },
  {
    type: "gauge",
    label: "Gauge",
    icon: "◔",
    defaultTitle: "Gauge",
    defaultGrid: { x: 0, y: 0, w: 3, h: 3 },
    defaultContent: { value: 0, max: 1, label: "value" },
  },
  { type: "node_load", label: "Node Load", icon: "≈", defaultTitle: "Load", defaultGrid: { x: 0, y: 0, w: 3, h: 2 } },
]

export function tileKind(type: string): TileKind | undefined {
  return TILE_KINDS.find((k) => k.type === type)
}

// Cindro (and older/hand-edited layouts) sometimes emit descriptive type names
// that predate this catalog — e.g. it asked for "vm_list"/"cluster_status"/
// "tasks_board" before those existed. Map the known synonyms onto a real
// renderer so a board written from chat never shows the "unsupported tile"
// placeholder. Keep this in sync with the catalog documented in proxmox-mcp's
// proxmox_dashboard_layout_set docstring (the model reads that to pick types).
const TILE_ALIASES: Record<string, string> = {
  vm_list: "vm_status",
  vms: "vm_status",
  guests: "vm_status",
  guest_list: "vm_status",
  storage_overview: "storage",
  storage_usage: "storage",
  storages: "storage",
  node_resources: "node_stats",
  node_status: "node_stats",
  node: "node_stats",
  cpu: "cpu_usage",
  cpu_load: "cpu_usage",
  cluster: "cluster_status",
  quorum: "cluster_status",
  backups: "recent_backups",
  recent_backup: "recent_backups",
  tasks: "tasks_board",
  task_board: "tasks_board",
  kanban: "tasks_board",
  load: "node_load",
  loadavg: "node_load",
  system_load: "node_load",
  sysload: "node_load",
}

/** Resolve a stored tile.type to a renderer key, following the alias table.
 * Stored layouts are left untouched — only the dispatch is aliased. */
export function canonicalTileType(type: string): string {
  return TILE_ALIASES[type] ?? type
}

// --- tiny local polling signal (no Client needed — pve-api is direct REST) -

function usePoll<T>(fetchFn: () => Promise<T>, initial: T, intervalMs: number): [Accessor<T>, () => void] {
  const [value, setValue] = createSignal<T>(initial)
  let alive = true
  let inFlight = false
  const tick = async () => {
    if (inFlight || (typeof document !== "undefined" && document.hidden)) return
    inFlight = true
    try {
      const v = await fetchFn()
      if (alive) setValue(() => v)
    } finally {
      inFlight = false
    }
  }
  void tick()
  const timer = setInterval(tick, intervalMs)
  onCleanup(() => {
    alive = false
    clearInterval(timer)
  })
  return [value, () => void tick()]
}

function useNodeList(): Accessor<PveNode[]> {
  const [list] = usePoll<PveNode[]>(
    async () => {
      const r = await nodes()
      return r.ok ? r.data : []
    },
    [],
    20000,
  )
  return list
}

// --- formatting --------------------------------------------------------------

function fmtPct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function fmtUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtAgo(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return ""
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSec)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function backupLabel(b: StorageContentItem): string {
  if (b.vmid) return `#${b.vmid}`
  const vol = String(b.volid || "")
  const slash = vol.lastIndexOf("/")
  return (slash >= 0 ? vol.slice(slash + 1) : vol) || "backup"
}

// --- shared chrome -------------------------------------------------------

function TileFrame(props: { title: string; live?: boolean; children: JSX.Element }) {
  return (
    <div class="cx-tile-body">
      <div class="cx-tile-head">
        <span class="cx-tile-title">{props.title}</span>
        <Show when={props.live}>
          <span class="cx-tile-live" />
        </Show>
      </div>
      <div class="cx-tile-content">{props.children}</div>
    </div>
  )
}

/** An arc-reactor-styled animated ring gauge — SVG stroke-dashoffset eased
 * via CSS transition (see widgets.css's .cx-ring-fill), colour ramps
 * accent → amber → danger as the value climbs toward 100%. */
function RingGauge(props: { value: number; size?: number; sub?: string; color?: string }) {
  const size = () => props.size ?? 100
  const stroke = () => Math.max(5, size() * 0.09)
  const r = () => (size() - stroke()) / 2
  const c = () => 2 * Math.PI * r()
  const pct = () => Math.max(0, Math.min(1, props.value))
  const dash = () => c() * pct()
  const color = () => props.color ?? (pct() > 0.9 ? "var(--danger)" : pct() > 0.75 ? "var(--amber)" : "var(--accent)")
  return (
    <div class="cx-ring" style={{ width: `${size()}px`, height: `${size()}px` }}>
      <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`}>
        <circle
          class="cx-ring-track"
          cx={size() / 2}
          cy={size() / 2}
          r={r()}
          fill="none"
          stroke="var(--hairline-soft)"
          stroke-width={stroke()}
        />
        <circle
          class="cx-ring-fill"
          cx={size() / 2}
          cy={size() / 2}
          r={r()}
          fill="none"
          stroke={color()}
          stroke-width={stroke()}
          stroke-linecap="round"
          stroke-dasharray={`${c()} ${c()}`}
          stroke-dashoffset={c() - dash()}
          transform={`rotate(-90 ${size() / 2} ${size() / 2})`}
        />
      </svg>
      <div class="cx-ring-label">
        <div class="cx-ring-value">{Math.round(pct() * 100)}%</div>
        <Show when={props.sub}>
          <div class="cx-ring-sub">{props.sub}</div>
        </Show>
      </div>
    </div>
  )
}

// --- live tiles --------------------------------------------------------------

function CpuUsageTile(props: { tile: Tile }) {
  const allNodes = useNodeList()
  const nodeName = () => props.tile.node || allNodes()[0]?.node || ""
  const [status, refresh] = usePoll<NodeStatus | null>(
    async () => {
      const n = nodeName()
      if (!n) return null
      const r = await nodeStatus(n)
      return r.ok ? r.data : null
    },
    null,
    4000,
  )
  createEffect(() => {
    nodeName()
    refresh()
  })
  return (
    <TileFrame title={props.tile.title || "CPU Usage"} live>
      <div class="cx-tile-center">
        <RingGauge value={status()?.cpu ?? 0} sub={nodeName() || "no node"} />
      </div>
    </TileFrame>
  )
}

function VmStatusTile(props: { tile: Tile }) {
  const [guests] = usePoll<ClusterResource[]>(
    async () => {
      const r = await clusterResources()
      if (!r.ok) return []
      return r.data.filter((x) => x.type === "qemu" || x.type === "lxc")
    },
    [],
    5000,
  )
  const scoped = () => {
    const g = guests()
    const filtered = props.tile.node ? g.filter((x) => x.node === props.tile.node) : g
    return [...filtered].sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0))
  }
  const running = () => scoped().filter((g) => g.status === "running").length
  return (
    <TileFrame title={props.tile.title || "VM / CT Status"} live>
      <Show
        when={scoped().length > 0}
        fallback={
          <div class="cx-tile-empty">
            <div class="cx-tile-empty-icon">▦</div>
            <div class="cx-tile-empty-text">No guests found</div>
          </div>
        }
      >
        <div class="cx-tile-sub">
          {running()} / {scoped().length} running
        </div>
        <div class="cx-guest-grid">
          <For each={scoped().slice(0, 60)}>
            {(g) => (
              <div class="cx-guest-row">
                <span classList={{ "cx-guest-dot": true, on: g.status === "running" }} />
                <span class="cx-guest-name">{g.name || `#${g.vmid}`}</span>
                <span class="cx-guest-meta">
                  {g.vmid} · {g.type}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </TileFrame>
  )
}

function NodeStatsTile(props: { tile: Tile }) {
  const allNodes = useNodeList()
  const nodeName = () => props.tile.node || allNodes()[0]?.node || ""
  const [status, refresh] = usePoll<NodeStatus | null>(
    async () => {
      const n = nodeName()
      if (!n) return null
      const r = await nodeStatus(n)
      return r.ok ? r.data : null
    },
    null,
    5000,
  )
  createEffect(() => {
    nodeName()
    refresh()
  })
  const mem = () => status()?.memory
  const load = () => status()?.loadavg
  return (
    <TileFrame title={props.tile.title || nodeName() || "Node Stats"} live>
      <div class="cx-tile-sub">{nodeName() || "no node"}</div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">Uptime</span>
        <span class="cx-stat-v">{fmtUptime(status()?.uptime ?? 0)}</span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">CPU</span>
        <span class="cx-stat-v">{fmtPct(status()?.cpu ?? 0)}</span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">Memory</span>
        <span class="cx-stat-v">
          {mem()?.total ? `${fmtBytes(mem()!.used ?? 0)} / ${fmtBytes(mem()!.total ?? 0)}` : "—"}
        </span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">Load</span>
        <span class="cx-stat-v">{load() ? load()!.join(" / ") : "—"}</span>
      </div>
    </TileFrame>
  )
}

function NodeLoadTile(props: { tile: Tile }) {
  const allNodes = useNodeList()
  const nodeName = () => props.tile.node || allNodes()[0]?.node || ""
  const [status, refresh] = usePoll<NodeStatus | null>(
    async () => {
      const n = nodeName()
      if (!n) return null
      const r = await nodeStatus(n)
      return r.ok ? r.data : null
    },
    null,
    5000,
  )
  createEffect(() => {
    nodeName()
    refresh()
  })
  const load = () => status()?.loadavg
  return (
    <TileFrame title={props.tile.title || "Load"} live>
      <div class="cx-tile-sub">{nodeName() || "no node"}</div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">1 min</span>
        <span class="cx-stat-v">{load()?.[0] ?? "—"}</span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">5 min</span>
        <span class="cx-stat-v">{load()?.[1] ?? "—"}</span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">15 min</span>
        <span class="cx-stat-v">{load()?.[2] ?? "—"}</span>
      </div>
    </TileFrame>
  )
}

function StorageTile(props: { tile: Tile }) {
  const allNodes = useNodeList()
  const nodeName = () => props.tile.node || allNodes()[0]?.node || ""
  const [list, refresh] = usePoll<StorageSummary[]>(
    async () => {
      const n = nodeName()
      if (!n) return []
      const r = await storages(n)
      return r.ok ? r.data : []
    },
    [],
    8000,
  )
  createEffect(() => {
    nodeName()
    refresh()
  })
  const rows = () => list().filter((s) => (s.total ?? 0) > 0).slice(0, 6)
  // Dogfood the ported DSL renderer for the bars themselves — a "storage"
  // tile is really just a small generated widget spec.
  const spec = () => ({
    type: "column",
    gap: 10,
    children: rows().map((s) => ({
      type: "column",
      gap: 3,
      children: [
        {
          type: "row",
          gap: 6,
          children: [
            { type: "text", text: s.storage, size: 12, grow: true },
            { type: "text", text: `${fmtBytes(s.used ?? 0)} / ${fmtBytes(s.total ?? 0)}`, size: 10, color: "var(--text-faint)" },
          ],
        },
        { type: "progress", value: s.total ? (s.used ?? 0) / s.total : 0 },
      ],
    })),
  })
  return (
    <TileFrame title={props.tile.title || "Storage"} live>
      <div class="cx-tile-sub">{nodeName() || "no node"}</div>
      <Show
        when={rows().length > 0}
        fallback={
          <div class="cx-tile-empty">
            <div class="cx-tile-empty-icon">▤</div>
            <div class="cx-tile-empty-text">No storage found</div>
          </div>
        }
      >
        <WidgetTree spec={spec()} />
      </Show>
    </TileFrame>
  )
}

function NoteTile(props: { tile: Tile; onUpdateContent?: (id: string, content: unknown) => void }) {
  const initial = () => {
    const c = props.tile.content
    if (typeof c === "string") return c
    if (c && typeof c === "object" && typeof (c as any).text === "string") return (c as any).text as string
    return ""
  }
  const [text, setText] = createSignal(initial())
  const [saved, setSaved] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const onInput = (v: string) => {
    setText(v)
    setSaved(false)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      props.onUpdateContent?.(props.tile.id, v)
      setSaved(true)
      setTimeout(() => setSaved(false), 1400)
    }, 700)
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return (
    <TileFrame title={props.tile.title || "Note"}>
      <div style={{ position: "relative", flex: "1", display: "flex" }}>
        <textarea
          class="cx-note-input"
          placeholder="Write a note…"
          value={text()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
        <div classList={{ "cx-note-saved": true, show: saved() }}>saved</div>
      </div>
    </TileFrame>
  )
}

function GaugeTile(props: { tile: Tile }) {
  const content = () => (props.tile.content && typeof props.tile.content === "object" ? (props.tile.content as Record<string, unknown>) : {})
  // Finite-guard both: an operator/hand-edited layout can set a non-numeric
  // value (e.g. {"value":"high"}), and Number("high")/1 = NaN would render
  // "NaN%" and a broken SVG arc.
  const value = () => { const v = Number(content().value ?? 0); return Number.isFinite(v) ? v : 0 }
  const max = () => { const m = Number(content().max ?? 1); return Number.isFinite(m) && m !== 0 ? m : 1 }
  const label = () => (typeof content().label === "string" ? (content().label as string) : props.tile.title || "value")
  const color = () => (typeof content().color === "string" ? (content().color as string) : undefined)
  return (
    <TileFrame title={props.tile.title || "Gauge"}>
      <div class="cx-tile-center">
        <RingGauge value={value() / max()} sub={label()} color={color()} />
      </div>
    </TileFrame>
  )
}

type ClusterSnapshot = { nodesOnline: number; nodesTotal: number; running: number; guests: number; ha: boolean }

function ClusterStatusTile(props: { tile: Tile }) {
  const [data] = usePoll<ClusterSnapshot | null>(
    async () => {
      const [n, r] = await Promise.all([nodes(), clusterResources()])
      const nodeList = n.ok ? n.data : []
      const guests = (r.ok ? r.data : []).filter((x) => x.type === "qemu" || x.type === "lxc")
      return {
        nodesOnline: nodeList.filter((x) => x.status === "online").length,
        nodesTotal: nodeList.length,
        running: guests.filter((x) => x.status === "running").length,
        guests: guests.length,
        ha: nodeList.length > 1,
      }
    },
    null,
    6000,
  )
  // Only claim "healthy" once we actually have a reading with nodes — an
  // unreachable cluster (no data / zero nodes) must NOT show reassuring green.
  const health = (): { label: string; color: string } => {
    const d = data()
    if (!d || d.nodesTotal === 0) return { label: "—", color: "var(--text-faint)" }
    return d.nodesOnline === d.nodesTotal
      ? { label: "healthy", color: "var(--success)" }
      : { label: "degraded", color: "var(--danger)" }
  }
  return (
    <TileFrame title={props.tile.title || "Cluster"} live>
      <div class="cx-stat-row">
        <span class="cx-stat-k">Nodes</span>
        <span class="cx-stat-v">{data() ? `${data()!.nodesOnline} / ${data()!.nodesTotal} online` : "—"}</span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">Guests</span>
        <span class="cx-stat-v">{data() ? `${data()!.running} / ${data()!.guests} running` : "—"}</span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">Mode</span>
        <span class="cx-stat-v">{data() ? (data()!.ha ? "cluster" : "standalone") : "—"}</span>
      </div>
      <div class="cx-stat-row">
        <span class="cx-stat-k">Health</span>
        <span class="cx-stat-v" style={{ color: health().color }}>{health().label}</span>
      </div>
    </TileFrame>
  )
}

function RecentBackupsTile(props: { tile: Tile }) {
  const allNodes = useNodeList()
  const nodeName = () => props.tile.node || allNodes()[0]?.node || ""
  const [rows, refresh] = usePoll<StorageContentItem[]>(
    async () => {
      const n = nodeName()
      if (!n) return []
      const s = await storages(n)
      if (!s.ok) return []
      // Only storages that actually hold backups; cap the fan-out at 3 so a host
      // with many stores doesn't spray a dozen content reads every 15s.
      const backupStores = s.data.filter((x) => (x.content ?? "").includes("backup")).slice(0, 3)
      const chunks = await Promise.all(
        backupStores.map((st) => storageContent(n, st.storage, "backup").then((r) => (r.ok ? r.data : []))),
      )
      const all = chunks.flat()
      all.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0))
      return all.slice(0, 8)
    },
    [],
    15000,
  )
  createEffect(() => {
    nodeName()
    refresh()
  })
  return (
    <TileFrame title={props.tile.title || "Recent Backups"} live>
      <Show
        when={rows().length > 0}
        fallback={
          <div class="cx-tile-empty">
            <div class="cx-tile-empty-icon">▧</div>
            <div class="cx-tile-empty-text">No backups found</div>
          </div>
        }
      >
        <div class="cx-guest-grid">
          <For each={rows()}>
            {(b) => (
              <div class="cx-guest-row">
                <span class="cx-guest-name">{backupLabel(b)}</span>
                <span class="cx-guest-meta">
                  {fmtAgo(b.ctime ?? 0)}
                  {b.size ? ` · ${fmtBytes(b.size)}` : ""}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </TileFrame>
  )
}

type BoardTask = { status?: string; title?: string }

function TasksBoardTile(props: { tile: Tile; client?: CindroClient }) {
  const [tasks] = usePoll<BoardTask[]>(
    async () => {
      const c = props.client
      if (!c) return []
      try {
        const r = await c.call<{ tasks?: BoardTask[] }>("proxmoxop.tasks_list")
        return Array.isArray(r?.tasks) ? r.tasks : []
      } catch {
        return []
      }
    },
    [],
    8000,
  )
  const st = (t: BoardTask) => t.status || "todo"
  const count = (s: string) => tasks().filter((t) => st(t) === s).length
  const open = () => tasks().filter((t) => st(t) !== "done").slice(0, 5)
  return (
    <TileFrame title={props.tile.title || "Tasks"}>
      <div class="cx-tile-tasks-counts">
        <div class="cx-tile-tasks-count">
          <span class="v">{count("todo")}</span>
          <span class="k">To do</span>
        </div>
        <div class="cx-tile-tasks-count">
          <span class="v">{count("doing")}</span>
          <span class="k">Doing</span>
        </div>
        <div class="cx-tile-tasks-count">
          <span class="v">{count("done")}</span>
          <span class="k">Done</span>
        </div>
      </div>
      <Show
        when={tasks().length > 0}
        fallback={<div class="cx-tile-sub">No tasks yet — ask Cindro to add one.</div>}
      >
        <div class="cx-guest-grid">
          <For each={open()}>
            {(t) => (
              <div class="cx-guest-row">
                <span classList={{ "cx-guest-dot": true, on: st(t) === "doing" }} />
                <span class="cx-guest-name">{t.title || "untitled"}</span>
                <span class="cx-guest-meta">{st(t)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </TileFrame>
  )
}

function UnknownTile(props: { tile: Tile }) {
  return (
    <TileFrame title={props.tile.title || props.tile.type || "Widget"}>
      <div class="cx-tile-empty">
        <div class="cx-tile-empty-icon">◇</div>
        <div class="cx-tile-empty-text">Unsupported tile type &ldquo;{props.tile.type || "?"}&rdquo;</div>
      </div>
    </TileFrame>
  )
}

// --- dispatch ------------------------------------------------------------

export function TileBody(props: { tile: Tile; actions?: TileActions }) {
  const kind = () => canonicalTileType(props.tile.type)
  return (
    <Switch fallback={<UnknownTile tile={props.tile} />}>
      <Match when={kind() === "cpu_usage"}>
        <CpuUsageTile tile={props.tile} />
      </Match>
      <Match when={kind() === "vm_status"}>
        <VmStatusTile tile={props.tile} />
      </Match>
      <Match when={kind() === "node_stats"}>
        <NodeStatsTile tile={props.tile} />
      </Match>
      <Match when={kind() === "node_load"}>
        <NodeLoadTile tile={props.tile} />
      </Match>
      <Match when={kind() === "storage"}>
        <StorageTile tile={props.tile} />
      </Match>
      <Match when={kind() === "cluster_status"}>
        <ClusterStatusTile tile={props.tile} />
      </Match>
      <Match when={kind() === "recent_backups"}>
        <RecentBackupsTile tile={props.tile} />
      </Match>
      <Match when={kind() === "tasks_board"}>
        <TasksBoardTile tile={props.tile} client={props.actions?.client} />
      </Match>
      <Match when={kind() === "note"}>
        <NoteTile tile={props.tile} onUpdateContent={props.actions?.onUpdateContent} />
      </Match>
      <Match when={kind() === "gauge"}>
        <GaugeTile tile={props.tile} />
      </Match>
    </Switch>
  )
}

/** dispatches by tile.type; an unrecognized type shows a friendly
 * placeholder — never a blank cell. */
export function renderTile(tile: Tile, actions?: TileActions): JSX.Element {
  return <TileBody tile={tile} actions={actions} />
}
