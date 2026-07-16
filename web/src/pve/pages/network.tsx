// Network page — node network interfaces/bridges/bonds/VLANs straight from
// Proxmox's own config (GET /nodes/<node>/network via pve-api.ts, real
// /api2/json — same source of truth as the stock Proxmox web UI's Network
// tab). Self-registers per router.ts's PageDef contract; zero props — pulls
// the node list from pve-api directly (this page doesn't need the daemon/
// chat context at all).
//
// Styling lives in styles.css under the "cx-net-" block (written ahead of
// this file, fully self-namespaced so it can't collide with any other
// page's classes) — node selector, live summary stat chips, a themed
// animated table with skeleton loading, type badges and status pills.

import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"

import * as pve from "../pve-api"
import type { PageDef } from "../router"

const POLL_MS = 8000
const TABLE_COLS = 8
const SKEL_WIDTHS = ["w-70", "w-40", "w-55", "w-60", "w-40", "w-55", "w-40", "w-40"] as const

// --- formatting --------------------------------------------------------------

function fmtAgo(d: Date | null): string {
  if (!d) return "—"
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (s < 3) return "just now"
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

function ifaceGlyph(type: string): string {
  switch (type) {
    case "bridge":
    case "OVSBridge":
      return "▥"
    case "bond":
    case "OVSBond":
      return "⇄"
    case "vlan":
      return "▤"
    case "eth":
      return "◈"
    case "alias":
      return "↳"
    case "OVSPort":
    case "OVSIntPort":
      return "•"
    default:
      return "○"
  }
}

function methodLabel(method?: string): string {
  return method ? method.toUpperCase() : "—"
}

function addressText(f: pve.NetworkInterface): string {
  if (f.cidr) return f.cidr
  if (f.address) return f.netmask ? `${f.address}/${f.netmask}` : f.address
  return "—"
}

function address6Text(f: pve.NetworkInterface): string {
  if (f.cidr6) return f.cidr6
  if (f.address6) return f.netmask6 ? `${f.address6}/${f.netmask6}` : f.address6
  return ""
}

function portsText(f: pve.NetworkInterface): string {
  return f.bridge_ports || f.slaves || "—"
}

// Preserve object references for rows whose visible state hasn't changed
// between polls, so <For>'s reference-keyed reconciliation only replays the
// row-entrance animation for interfaces that are actually new or just
// changed state — not the whole table every 8s.
function mergeIfaces(prev: pve.NetworkInterface[], next: pve.NetworkInterface[]): pve.NetworkInterface[] {
  const byName = new Map(prev.map((f) => [f.iface, f] as const))
  return next.map((f) => {
    const old = byName.get(f.iface)
    if (
      old &&
      old.type === f.type &&
      old.method === f.method &&
      old.active === f.active &&
      old.autostart === f.autostart &&
      old.address === f.address &&
      old.cidr === f.cidr &&
      old.gateway === f.gateway &&
      old.bridge_ports === f.bridge_ports &&
      old.slaves === f.slaves &&
      old.comments === f.comments
    ) {
      return old
    }
    return f
  })
}

const SkeletonRows: Component<{ rows: number }> = (props) => (
  <For each={Array.from({ length: props.rows })}>
    {(_, i) => (
      <tr class="cx-net-skel-row">
        <For each={SKEL_WIDTHS}>
          {(w) => (
            <td>
              <div class={`cx-net-skel-bar ${w}`} style={{ "animation-delay": `${i() * 70}ms` }} />
            </td>
          )}
        </For>
      </tr>
    )}
  </For>
)

// --- page ----------------------------------------------------------------

const NetworkPage: Component = () => {
  const [nodeList, setNodeList] = createSignal<pve.PveNode[]>([])
  const [node, setNode] = createSignal("")
  const [ifaces, setIfaces] = createSignal<pve.NetworkInterface[]>([])
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [lastSync, setLastSync] = createSignal<Date | null>(null)
  const [, setTick] = createSignal(0) // re-renders fmtAgo() every second

  const loadNodes = async () => {
    const r = await pve.nodes()
    if (r.ok) {
      setNodeList(r.data)
      if (!node() && r.data.length) {
        const online = r.data.find((n) => n.status === "online")
        setNode((online ?? r.data[0]).node)
      }
    } else if (!node()) {
      setErr(r.error)
    }
  }

  const loadNetwork = async () => {
    if (!node()) {
      setLoading(false)
      return
    }
    setRefreshing(true)
    const r = await pve.nodeNetwork(node())
    if (r.ok) {
      setErr("")
      const sorted = [...r.data].sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }))
      setIfaces((prev) => mergeIfaces(prev, sorted))
      setLastSync(new Date())
    } else {
      setErr(r.error)
    }
    setLoading(false)
    setRefreshing(false)
  }

  const changeNode = (n: string) => {
    if (n === node()) return
    setNode(n)
    setIfaces([])
    setLoading(true)
    void loadNetwork()
  }

  const manualRefresh = () => {
    if (refreshing()) return
    void loadNetwork()
  }

  onMount(() => {
    void (async () => {
      await loadNodes()
      await loadNetwork()
    })()
    const poll = setInterval(loadNetwork, POLL_MS)
    const clock = setInterval(() => setTick((t) => t + 1), 1000)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(clock)
    })
  })

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return ifaces()
    return ifaces().filter((f) => {
      const hay = [f.iface, f.type, f.method, f.address, f.cidr, f.gateway, f.comments, f.bridge_ports, f.slaves]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  })

  const stats = createMemo(() => {
    const list = ifaces()
    const active = list.filter((f) => !!f.active).length
    const bridges = list.filter((f) => f.type === "bridge" || f.type === "OVSBridge").length
    const autostart = list.filter((f) => !!f.autostart).length
    return { total: list.length, active, bridges, autostart }
  })

  return (
    <div class="cx-page cx-net-page cx-fade-in">
      <div class="cx-net-head">
        <div>
          <h1 class="cx-net-title">Network</h1>
          <p class="cx-net-sub">
            Interfaces, bridges, bonds and VLANs configured on this node — read straight from
            Proxmox's own network config.
          </p>
        </div>
        <div class="cx-net-controls">
          <div class="cx-select-wrap cx-net-node-select">
            <select
              class="cx-select"
              value={node()}
              disabled={nodeList().length === 0}
              onChange={(e) => changeNode(e.currentTarget.value)}
            >
              <Show when={nodeList().length} fallback={<option value="">no nodes</option>}>
                <For each={nodeList()}>{(n) => <option value={n.node}>{n.node}</option>}</For>
              </Show>
            </select>
          </div>
          <button
            type="button"
            class="cx-net-refresh"
            classList={{ spinning: refreshing() }}
            disabled={refreshing()}
            title="Refresh"
            onClick={manualRefresh}
          >
            <span class="cx-net-refresh-icon">⟳</span>
          </button>
        </div>
      </div>

      <Show when={err()}>
        <div class="cx-error-card cx-fade-in">{err()}</div>
      </Show>

      <div class="cx-net-summary">
        <div class="cx-net-stat" style={{ "animation-delay": "0ms" }}>
          <span class="cx-net-stat-value">{stats().total}</span>
          <span class="cx-net-stat-label">Interfaces</span>
        </div>
        <div class="cx-net-stat" style={{ "animation-delay": "50ms" }}>
          <span class="cx-net-stat-value accent-ok">{stats().active}</span>
          <span class="cx-net-stat-label">Active</span>
        </div>
        <div class="cx-net-stat" style={{ "animation-delay": "100ms" }}>
          <span class="cx-net-stat-value">{stats().bridges}</span>
          <span class="cx-net-stat-label">Bridges</span>
        </div>
        <div class="cx-net-stat" style={{ "animation-delay": "150ms" }}>
          <span class="cx-net-stat-value accent-warn">{stats().autostart}</span>
          <span class="cx-net-stat-label">Autostart</span>
        </div>
        <div class="cx-net-sync">
          <span class="cx-net-sync-dot" classList={{ live: !!lastSync() && !err() }} />
          synced {fmtAgo(lastSync())}
        </div>
      </div>

      <div class="cx-net-toolbar">
        <input
          class="cx-input cx-net-search"
          placeholder="Filter interfaces…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      <div class="cx-net-table-wrap">
        <table class="cx-net-table">
          <thead>
            <tr>
              <th>Interface</th>
              <th>Type</th>
              <th>Method</th>
              <th>Address</th>
              <th>Gateway</th>
              <th>Ports / Slaves</th>
              <th>Autostart</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <Show when={!loading()} fallback={<SkeletonRows rows={6} />}>
              <For
                each={filtered()}
                fallback={
                  <tr>
                    <td colSpan={TABLE_COLS}>
                      <div class="cx-empty">
                        {ifaces().length === 0
                          ? `No network interfaces found on ${node() || "this node"}.`
                          : "No interfaces match your filter."}
                      </div>
                    </td>
                  </tr>
                }
              >
                {(f, i) => {
                  const v6 = address6Text(f)
                  return (
                    <tr class="cx-net-row" style={{ "animation-delay": `${Math.min(i(), 14) * 30}ms` }}>
                      <td>
                        <div class="cx-net-iface">
                          <span class="cx-net-iface-icon" data-type={f.type}>
                            {ifaceGlyph(f.type)}
                          </span>
                          <span class="cx-net-iface-name">{f.iface}</span>
                        </div>
                        <Show when={f.comments}>
                          <div class="cx-net-comment">{f.comments}</div>
                        </Show>
                      </td>
                      <td>
                        <span class="cx-net-type-badge" data-type={f.type}>
                          {f.type}
                        </span>
                      </td>
                      <td>
                        <span class="cx-net-method-pill">{methodLabel(f.method)}</span>
                      </td>
                      <td>
                        <div class="cx-net-mono">{addressText(f)}</div>
                        <Show when={v6}>
                          <div class="cx-net-mono">{v6}</div>
                        </Show>
                      </td>
                      <td class="cx-net-mono">{f.gateway || "—"}</td>
                      <td class="cx-net-ports" title={portsText(f)}>
                        {portsText(f)}
                      </td>
                      <td>
                        <span class="cx-net-flag" classList={{ on: !!f.autostart }} title={f.autostart ? "Starts on boot" : "Manual start"}>
                          {f.autostart ? "●" : "○"}
                        </span>
                      </td>
                      <td>
                        <span class="cx-net-status" classList={{ up: !!f.active }}>
                          <span class="cx-net-status-dot" />
                          {f.active ? "Up" : "Down"}
                        </span>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </Show>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default {
  id: "network",
  label: "Network",
  icon: "⇄",
  section: "PROXMOX",
  order: 15,
  component: NetworkPage,
} satisfies PageDef
