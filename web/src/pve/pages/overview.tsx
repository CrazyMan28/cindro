// Nodes — the datacenter/cluster drill-down page. Complements pages/home.tsx
// (the "Overview" landing page, id "home"), which already surfaces
// cluster-wide AGGREGATE stats (nodes online, guests running, quorum, avg
// CPU, storage) in its hero + the editable widget board below it. This page
// answers the question Home can't: "which PHYSICAL node is under load right
// now" — a live, per-node card grid with animated CPU/mem/disk resource
// rings, guest counts, load average and uptime for every member of the
// cluster (or the single standalone host).
//
// NOTE ON NAMING: the task that produced this file asked for
// `registerPage({id, label:'Overview', section:'PROXMOX', ...})`, but by the
// time this file was written pages/home.tsx (built concurrently by another
// agent in this same worktree) had already claimed id:"home"/label:"Overview"
// for exactly that landing-page role — a second nav entry also labelled
// "Overview" would just be a confusing duplicate. Registering this page as
// id:"nodes"/label:"Nodes" instead keeps the nav unambiguous while still
// delivering every piece of content the task asked for (per-node resource
// rings, guest counts, cluster/quorum status, uptime), just as its own
// distinct, complementary page rather than a collision.
//
// All data comes straight from the real Proxmox REST API via pve-api.ts:
// pve.nodes() for the member list + a first-paint approximation of each
// node's cpu/mem/disk, pve.nodeStatus(node) per online node for the precise
// breakdown (memory/rootfs/loadavg/pveversion), and pve.clusterResources()
// to roll guests up per node. No jarvisd round-trip needed for any of it.
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component, type JSX } from "solid-js"

import * as pve from "../pve-api"
import type { PageDef } from "../router"

const POLL_MS = 6000

type ClusterStatusEntry = {
  type?: string
  quorate?: number | boolean
  name?: string
  nodes?: number
  [key: string]: unknown
}

type NodeRow = {
  node: string
  status: string
  online: boolean
  level?: string
  uptime: number
  cpuPct: number
  cpuCores?: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  loadavg?: [string, string, string]
  pveversion?: string
  guestsRunning: number
  guestsTotal: number
}

// --- formatting --------------------------------------------------------------

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

function fmtPct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
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

function fmtAgo(d: Date | null): string {
  if (!d) return "—"
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (s < 3) return "just now"
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

// --- triple resource ring (CPU / Memory / Disk, arc-reactor styled) --------

function ring(size: number, stroke: number, index: number, gap: number) {
  const r = size / 2 - stroke / 2 - 1 - index * (stroke + gap)
  const c = 2 * Math.PI * r
  return { r, c }
}

function ResourceRing(props: { pct: number; r: number; c: number; stroke: number; color: string; cx: number; cy: number }) {
  const pct = () => Math.max(0, Math.min(1, props.pct))
  const dash = () => props.c * pct()
  return (
    <>
      <circle
        class="cx-nodes-ring-track"
        cx={props.cx}
        cy={props.cy}
        r={props.r}
        fill="none"
        stroke="var(--hairline-soft)"
        stroke-width={props.stroke}
      />
      <circle
        class="cx-nodes-ring-fill"
        cx={props.cx}
        cy={props.cy}
        r={props.r}
        fill="none"
        stroke={props.color}
        style={{ color: props.color }}
        stroke-width={props.stroke}
        stroke-linecap="round"
        stroke-dasharray={`${props.c} ${props.c}`}
        stroke-dashoffset={props.c - dash()}
        transform={`rotate(-90 ${props.cx} ${props.cy})`}
      />
    </>
  )
}

function TripleRing(props: { cpu: number; mem: number; disk: number; size?: number }) {
  const size = () => props.size ?? 128
  const stroke = 7
  const gap = 5
  const center = () => size() / 2
  const outer = () => ring(size(), stroke, 0, gap)
  const mid = () => ring(size(), stroke, 1, gap)
  const inner = () => ring(size(), stroke, 2, gap)
  const worst = () => Math.max(props.cpu, props.mem, props.disk)
  const coreColor = () => (worst() > 0.9 ? "var(--danger)" : worst() > 0.75 ? "var(--amber)" : "var(--success)")
  return (
    <div class="cx-nodes-ring" style={{ width: `${size()}px`, height: `${size()}px` }}>
      <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`}>
        <ResourceRing pct={props.cpu} {...outer()} stroke={stroke} color="var(--accent)" cx={center()} cy={center()} />
        <ResourceRing pct={props.mem} {...mid()} stroke={stroke} color="var(--violet)" cx={center()} cy={center()} />
        <ResourceRing pct={props.disk} {...inner()} stroke={stroke} color="var(--amber)" cx={center()} cy={center()} />
      </svg>
      <div class="cx-nodes-ring-core" style={{ "--core-color": coreColor() }} />
    </div>
  )
}

function LegendRow(props: { color: string; label: string; value: string; sub: string }) {
  return (
    <div class="cx-nodes-legend-row">
      <span class="cx-nodes-legend-dot" style={{ background: props.color }} />
      <span class="cx-nodes-legend-label">{props.label}</span>
      <span class="cx-nodes-legend-value">{props.value}</span>
      <span class="cx-nodes-legend-sub">{props.sub}</span>
    </div>
  )
}

// --- node card ---------------------------------------------------------------

function NodeCard(props: { row: NodeRow; index: number }): JSX.Element {
  const r = () => props.row
  const memPct = () => (r().memTotal ? r().memUsed / r().memTotal : 0)
  const diskPct = () => (r().diskTotal ? r().diskUsed / r().diskTotal : 0)
  return (
    <div
      class="cx-nodes-card cx-fade-in"
      classList={{ offline: !r().online }}
      style={{ "animation-delay": `${props.index * 65}ms` }}
    >
      <div class="cx-nodes-card-head">
        <span classList={{ "cx-nodes-dot": true, on: r().online }} />
        <span class="cx-nodes-name">{r().node}</span>
        <Show when={r().level}>
          <span class="cx-pill">{r().level}</span>
        </Show>
        <span classList={{ "cx-nodes-status": true, on: r().online }}>{r().status}</span>
      </div>

      <Show
        when={r().online}
        fallback={
          <div class="cx-nodes-offline">
            <div class="cx-nodes-offline-icon">◇</div>
            <div>No live metrics — node is {r().status}</div>
          </div>
        }
      >
        <div class="cx-nodes-body">
          <TripleRing cpu={r().cpuPct} mem={memPct()} disk={diskPct()} />
          <div class="cx-nodes-legend">
            <LegendRow
              color="var(--accent)"
              label="CPU"
              value={fmtPct(r().cpuPct)}
              sub={r().cpuCores ? `${r().cpuCores} core${r().cpuCores === 1 ? "" : "s"}` : ""}
            />
            <LegendRow
              color="var(--violet)"
              label="Memory"
              value={r().memTotal ? fmtPct(memPct()) : "—"}
              sub={r().memTotal ? `${fmtBytes(r().memUsed)} / ${fmtBytes(r().memTotal)}` : "no data"}
            />
            <LegendRow
              color="var(--amber)"
              label="Disk"
              value={r().diskTotal ? fmtPct(diskPct()) : "—"}
              sub={r().diskTotal ? `${fmtBytes(r().diskUsed)} / ${fmtBytes(r().diskTotal)}` : "no data"}
            />
          </div>
        </div>

        <div class="cx-nodes-stats-row">
          <div class="cx-nodes-stat">
            <span class="k">Uptime</span>
            <span class="v">{fmtUptime(r().uptime)}</span>
          </div>
          <div class="cx-nodes-stat">
            <span class="k">Load</span>
            <span class="v">{r().loadavg ? r().loadavg!.join(" / ") : "—"}</span>
          </div>
          <div class="cx-nodes-stat">
            <span class="k">Guests</span>
            <span class="v">
              {r().guestsRunning}/{r().guestsTotal}
            </span>
          </div>
        </div>
      </Show>
    </div>
  )
}

// --- page ----------------------------------------------------------------

const NodesPage: Component = () => {
  const [baseNodes, setBaseNodes] = createSignal<pve.PveNode[]>([])
  const [statusMap, setStatusMap] = createSignal<Record<string, pve.NodeStatus | null>>({})
  const [resources, setResources] = createSignal<pve.ClusterResource[]>([])
  const [clusterStatus, setClusterStatus] = createSignal<ClusterStatusEntry[]>([])
  const [clusterErr, setClusterErr] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [lastSync, setLastSync] = createSignal<Date | null>(null)
  const [, setTick] = createSignal(0) // re-renders fmtAgo() every second

  const refresh = async () => {
    setRefreshing(true)
    const [n, r, c] = await Promise.all([
      pve.nodes(),
      pve.clusterResources(),
      pve.get<ClusterStatusEntry[]>("/cluster/status"),
    ])
    if (n.ok) setBaseNodes(n.data)
    if (r.ok) setResources(r.data)
    if (c.ok) {
      setClusterStatus(Array.isArray(c.data) ? c.data : [])
      setClusterErr(false)
    } else {
      setClusterStatus([])
      setClusterErr(true)
    }
    setErr(!n.ok ? n.error || "could not reach the Proxmox API" : "")

    const list = n.ok ? n.data : baseNodes()
    const pairs = await Promise.all(
      list.map(async (nd) => {
        if (nd.status !== "online") return [nd.node, null] as const
        const s = await pve.nodeStatus(nd.node)
        return [nd.node, s.ok ? s.data : null] as const
      }),
    )
    const map: Record<string, pve.NodeStatus | null> = {}
    for (const [name, st] of pairs) map[name] = st
    setStatusMap(map)

    setLoading(false)
    setRefreshing(false)
    setLastSync(new Date())
  }

  onMount(() => {
    void refresh()
    const poll = setInterval(refresh, POLL_MS)
    const clock = setInterval(() => setTick((t) => t + 1), 1000)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(clock)
    })
  })

  const guestsByNode = createMemo(() => {
    const map = new Map<string, { running: number; total: number }>()
    for (const g of resources()) {
      if (g.type !== "qemu" && g.type !== "lxc") continue
      const key = g.node || "?"
      const cur = map.get(key) ?? { running: 0, total: 0 }
      cur.total++
      if (g.status === "running") cur.running++
      map.set(key, cur)
    }
    return map
  })

  const clusterMeta = createMemo(() => clusterStatus().find((x) => x.type === "cluster"))
  const standalone = createMemo(() => !clusterMeta())
  const quorate = createMemo(() => Boolean(clusterMeta()?.quorate))
  const clusterName = createMemo(() => {
    const m = clusterMeta()
    const name = m && typeof m.name === "string" ? m.name : ""
    return name || baseNodes()[0]?.node || "Proxmox"
  })
  const quorumLabel = createMemo(() => {
    if (clusterErr()) return "Unknown"
    if (standalone()) return "Standalone"
    return quorate() ? "Quorate" : "Degraded"
  })
  const quorumTone = createMemo<"live" | "bad" | "neutral">(() => {
    if (clusterErr() || standalone()) return "neutral"
    return quorate() ? "live" : "bad"
  })

  const rows = createMemo<NodeRow[]>(() => {
    const gmap = guestsByNode()
    return baseNodes()
      .slice()
      .sort((a, b) => a.node.localeCompare(b.node))
      .map((n) => {
        const st = statusMap()[n.node]
        const online = n.status === "online"
        const memTotal = st?.memory?.total ?? n.maxmem ?? 0
        const memUsed = st?.memory?.used ?? n.mem ?? 0
        const diskTotal = st?.rootfs?.total ?? n.maxdisk ?? 0
        const diskUsed = st?.rootfs?.used ?? n.disk ?? 0
        const cpuPct = st?.cpu ?? n.cpu ?? 0
        const g = gmap.get(n.node) ?? { running: 0, total: 0 }
        return {
          node: n.node,
          status: n.status,
          online,
          level: n.level,
          uptime: st?.uptime ?? n.uptime ?? 0,
          cpuPct,
          cpuCores: st?.cpuinfo?.cpus ?? n.maxcpu,
          memUsed,
          memTotal,
          diskUsed,
          diskTotal,
          loadavg: st?.loadavg,
          pveversion: st?.pveversion,
          guestsRunning: g.running,
          guestsTotal: g.total,
        } satisfies NodeRow
      })
  })

  const totals = createMemo(() => {
    const list = rows()
    const online = list.filter((r) => r.online).length
    const guestsTotal = list.reduce((s, r) => s + r.guestsTotal, 0)
    const guestsRunning = list.reduce((s, r) => s + r.guestsRunning, 0)
    return { nodes: list.length, online, guestsTotal, guestsRunning }
  })

  return (
    <div class="cx-nodes-page cx-fade-in">
      <div class="cx-nodes-head">
        <div class="cx-nodes-head-text">
          <h1 class="cx-nodes-title">Datacenter</h1>
          <div class="cx-nodes-sub">
            <span classList={{ "cx-nodes-quorum": true, [quorumTone()]: true }}>
              <span class="cx-nodes-quorum-dot" />
              {quorumLabel()}
            </span>
            <span class="cx-nodes-sep">·</span>
            <span>{clusterName()}</span>
            <span class="cx-nodes-sep">·</span>
            <span>
              {totals().online}/{totals().nodes} node{totals().nodes === 1 ? "" : "s"} online
            </span>
            <span class="cx-nodes-sep">·</span>
            <span>
              {totals().guestsRunning}/{totals().guestsTotal} guests running
            </span>
            <span class="cx-nodes-sep">·</span>
            <span class="cx-nodes-synced">synced {fmtAgo(lastSync())}</span>
          </div>
        </div>
        <button type="button" class="cx-btn cx-btn-primary" disabled={refreshing()} onClick={refresh}>
          <Show when={!refreshing()} fallback={<span class="cx-spinner" />}>
            ⟳ Refresh
          </Show>
        </button>
      </div>

      <Show when={err()}>
        <div class="cx-error-card cx-fade-in">{err()}</div>
      </Show>

      <div class="cx-nodes-grid">
        <Show
          when={!loading()}
          fallback={
            <For each={[0, 1, 2]}>
              {(i) => <div class="cx-nodes-card cx-skel" style={{ "animation-delay": `${i * 70}ms` }} />}
            </For>
          }
        >
          <Show when={rows().length > 0} fallback={<div class="cx-empty">No nodes found</div>}>
            <For each={rows()}>{(row, i) => <NodeCard row={row} index={i()} />}</For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default {
  id: "nodes",
  label: "Nodes",
  icon: "⬢",
  section: "PROXMOX",
  order: 5,
  component: NodesPage,
} satisfies PageDef
