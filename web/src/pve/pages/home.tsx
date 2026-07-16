// Overview — the landing page. Talks straight to the real Proxmox REST API
// via pve-api.ts (no proxmoxop.tool round-trip needed for read-only cluster
// stats), then hands off to the WORKING widget board (WidgetGrid): the tiles
// Cindro creates from chat, and the ones a user drags/resizes/adds/removes
// here by hand, are the exact same persisted layout (proxmoxop.layout_get/
// set) — this page owns none of that state, it just renders the board.
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"

import { ArcReactor } from "../../components/ArcReactor"
import * as pve from "../pve-api"
import { usePve } from "../pve-context"
import type { PageDef } from "../router"
import { WidgetGrid } from "../widgets/WidgetGrid"

const REFRESH_MS = 10000

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

function fmtAgo(d: Date | null): string {
  if (!d) return "—"
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (s < 3) return "just now"
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

type Tone = "ok" | "warn" | "bad" | "neutral"
type StatCard = { key: string; icon: string; label: string; value: string; sub: string; tone: Tone }

const HomePage: Component = () => {
  const { client, navigate } = usePve()

  const [nodesList, setNodesList] = createSignal<pve.PveNode[]>([])
  const [resources, setResources] = createSignal<pve.ClusterResource[]>([])
  const [clusterStatus, setClusterStatus] = createSignal<Record<string, unknown>[]>([])
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
      pve.get<Record<string, unknown>[]>("/cluster/status"),
    ])
    if (n.ok) setNodesList(n.data)
    if (r.ok) setResources(r.data)
    if (c.ok) setClusterStatus(Array.isArray(c.data) ? c.data : [])
    setErr(!n.ok && !r.ok ? n.error || r.error || "could not reach the Proxmox API" : "")
    setLoading(false)
    setRefreshing(false)
    setLastSync(new Date())
  }

  onMount(() => {
    void refresh()
    const poll = setInterval(refresh, REFRESH_MS)
    const clock = setInterval(() => setTick((t) => t + 1), 1000)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(clock)
    })
  })

  const guests = createMemo(() => resources().filter((x) => x.type === "qemu" || x.type === "lxc"))
  const running = createMemo(() => guests().filter((g) => g.status === "running").length)
  const onlineNodes = createMemo(() => nodesList().filter((n) => n.status === "online").length)
  const clusterMeta = createMemo(() => clusterStatus().find((x) => x.type === "cluster"))
  const standalone = createMemo(() => !clusterMeta())
  const quorate = createMemo(() => Boolean(clusterMeta()?.quorate))
  const clusterName = createMemo(() => {
    const m = clusterMeta()
    const name = m && typeof m.name === "string" ? m.name : ""
    return name || nodesList()[0]?.node || "Proxmox"
  })
  const avgCpu = createMemo(() => {
    const list = nodesList().filter((n) => n.status === "online" && typeof n.cpu === "number")
    if (!list.length) return 0
    return list.reduce((s, n) => s + (n.cpu ?? 0), 0) / list.length
  })
  // Cluster/resources reports one "storage" entry per node a shared storage is
  // active on — dedupe by storage id so a shared datastore isn't counted N
  // times in the aggregate.
  const storageAgg = createMemo(() => {
    const seen = new Set<string>()
    let used = 0
    let total = 0
    for (const r of resources()) {
      if (r.type !== "storage") continue
      const key = String((r as Record<string, unknown>).storage ?? r.id)
      if (seen.has(key)) continue
      seen.add(key)
      used += r.disk ?? 0
      total += r.maxdisk ?? 0
    }
    return { used, total }
  })

  const stats = createMemo<StatCard[]>(() => {
    const nAll = nodesList().length
    const nOn = onlineNodes()
    const gAll = guests()
    const st = storageAgg()
    return [
      {
        key: "nodes",
        icon: "◈",
        label: "Nodes",
        value: `${nOn}/${nAll}`,
        sub: nAll === 0 ? "no data" : nOn === nAll ? "all online" : `${nAll - nOn} offline`,
        tone: nAll > 0 && nOn < nAll ? "bad" : "ok",
      },
      {
        key: "guests",
        icon: "▦",
        label: "Guests",
        value: `${running()}/${gAll.length}`,
        sub: `${gAll.filter((g) => g.type === "qemu").length} VM · ${gAll.filter((g) => g.type === "lxc").length} CT`,
        tone: "neutral",
      },
      {
        key: "cluster",
        icon: "◎",
        label: standalone() ? "Mode" : "Quorum",
        value: standalone() ? "Standalone" : quorate() ? "Quorate" : "Degraded",
        sub: standalone() ? "single node" : clusterName(),
        tone: standalone() ? "neutral" : quorate() ? "ok" : "bad",
      },
      {
        key: "cpu",
        icon: "⚡",
        label: "Avg CPU",
        value: nOn ? fmtPct(avgCpu()) : "—",
        sub: nOn ? `${nOn} node${nOn === 1 ? "" : "s"} sampled` : "no data",
        tone: avgCpu() > 0.85 ? "bad" : avgCpu() > 0.6 ? "warn" : "ok",
      },
      {
        key: "storage",
        icon: "▤",
        label: "Storage",
        value: st.total ? fmtPct(st.used / st.total) : "—",
        sub: st.total ? `${fmtBytes(st.used)} / ${fmtBytes(st.total)}` : "no data",
        tone: st.total && st.used / st.total > 0.85 ? "bad" : "neutral",
      },
    ]
  })

  return (
    <div class="cx-home">
      <section class="cx-home-hero cx-fade-in">
        <div class="cx-home-hero-mark">
          <ArcReactor size={54} />
        </div>
        <div class="cx-home-hero-text">
          <div class="cx-home-hero-eyebrow">Proxmox Cluster</div>
          <h1 class="cx-home-hero-title">{clusterName()}</h1>
          <div class="cx-home-hero-sub">
            <span classList={{ "cx-home-quorum": true, live: !standalone() && quorate() }}>
              <span class="cx-home-quorum-dot" />
              {standalone() ? "Standalone" : quorate() ? "Quorate" : "Degraded"}
            </span>
            <span class="cx-home-hero-sep">·</span>
            <span>
              {onlineNodes()}/{nodesList().length} node{nodesList().length === 1 ? "" : "s"} online
            </span>
            <span class="cx-home-hero-sep">·</span>
            <span class="cx-home-hero-synced">synced {fmtAgo(lastSync())}</span>
          </div>
        </div>
        <div class="cx-home-hero-actions">
          <button type="button" class="cx-btn cx-btn-ghost" onClick={() => navigate("chat")}>
            Open Cindro
          </button>
          <button type="button" class="cx-btn cx-btn-primary" disabled={refreshing()} onClick={refresh}>
            <Show when={!refreshing()} fallback={<span class="cx-spinner" />}>
              ⟳ Refresh
            </Show>
          </button>
        </div>
      </section>

      <Show when={err()}>
        <div class="cx-error-card cx-fade-in">{err()}</div>
      </Show>

      <div class="cx-home-stats">
        <Show
          when={!loading()}
          fallback={
            <For each={[0, 1, 2, 3, 4]}>
              {(i) => <div class="cx-home-stat cx-skel" style={{ "animation-delay": `${i * 60}ms` }} />}
            </For>
          }
        >
          <For each={stats()}>
            {(s, i) => (
              <div
                class="cx-home-stat cx-fade-in"
                classList={{ [`tone-${s.tone}`]: true }}
                style={{ "animation-delay": `${i() * 55}ms` }}
              >
                <div class="cx-home-stat-icon">{s.icon}</div>
                <div class="cx-home-stat-body">
                  <div class="cx-home-stat-label">{s.label}</div>
                  <div class="cx-home-stat-value">{s.value}</div>
                  <div class="cx-home-stat-sub">{s.sub}</div>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="cx-home-board cx-fade-in">
        <div class="cx-home-board-head">
          <h2 class="cx-home-section-title">Live Board</h2>
          <p class="cx-home-board-hint">
            Ask Cindro in chat to add, move, or resize tiles — or drag them yourself by their header.
          </p>
        </div>
        <WidgetGrid client={client} />
      </div>
    </div>
  )
}

export default {
  id: "home",
  label: "Overview",
  icon: "◈",
  section: "PROXMOX",
  order: 0,
  component: HomePage,
} satisfies PageDef
