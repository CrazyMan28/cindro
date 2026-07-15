// Containers — every LXC container across the cluster, aggregated live from
// the REAL Proxmox REST API via pve-api.ts (pve.nodes() + pve.lxcList(node)
// per online node, Promise.all'd), with power actions posted straight to
// POST /nodes/<node>/lxc/<vmid>/status/<action> — no Cindro/daemon round-trip
// for either the read or the mutation. Same column shape / interaction feel
// as the Virtual Machines page, just Proxmox-native instead of chat-gated.
//
// Rows live in a keyed (by vmid — Proxmox enforces cluster-wide unique VMIDs,
// so it's a safe id even across nodes) createStore + reconcile() rather than
// a plain signal: that keeps each <tr>'s DOM/identity stable poll-to-poll (no
// re-mount, no replayed entrance animation) while still updating individual
// fields (cpu/mem/uptime/status) with fine-grained reactivity — a container
// that's genuinely new to the cluster still gets its own fresh entrance.
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

import * as pve from "../pve-api"
import type { LxcSummary } from "../pve-api"
import type { PageDef } from "../router"

const POLL_MS = 6000

type Row = LxcSummary & { node: string }
type StatusFilter = "all" | "running" | "stopped"
type ActionKey = "start" | "shutdown" | "stop" | "reboot"
type Tone = "ok" | "warn" | "bad"

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

function usageTone(pct: number): Tone {
  return pct > 0.9 ? "bad" : pct > 0.75 ? "warn" : "ok"
}

// --- animated inline usage bar -----------------------------------------------

function UsageBar(props: { pct: number; sub: string }) {
  const pct = () => Math.max(0, Math.min(1, props.pct))
  return (
    <div class="cx-lxc-usage">
      <div class="cx-lxc-usage-head">
        <span class="cx-lxc-usage-value">{fmtPct(pct())}</span>
      </div>
      <div class="cx-lxc-bar">
        <div class={`cx-lxc-bar-fill tone-${usageTone(pct())}`} style={{ width: `${pct() * 100}%` }} />
      </div>
      <div class="cx-lxc-usage-sub">{props.sub}</div>
    </div>
  )
}

// --- skeleton loading rows ----------------------------------------------------

const COLS = 9
const SKEL_WIDTHS = ["30%", "45%", "70%", "40%", "55%", "80%", "80%", "35%", "60%"]

const SkeletonRows: Component<{ rows: number }> = (props) => (
  <For each={Array.from({ length: props.rows })}>
    {(_, i) => (
      <tr class="cx-skel-row">
        <For each={SKEL_WIDTHS}>
          {(w) => (
            <td>
              <div class="cx-skel-bar" style={{ width: w, "animation-delay": `${i() * 70}ms` }} />
            </td>
          )}
        </For>
      </tr>
    )}
  </For>
)

// --- page ----------------------------------------------------------------

const LxcPage: Component = () => {
  const [rows, setRows] = createStore<Row[]>([])
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [lastSync, setLastSync] = createSignal<Date | null>(null)
  const [, setTick] = createSignal(0) // re-renders fmtAgo() every second

  const [query, setQuery] = createSignal("")
  const [statusFilter, setStatusFilter] = createSignal<StatusFilter>("all")

  // Row-scoped async UI state — keyed by vmid, so it survives the store's
  // reconcile()'d row identity untouched.
  const [busy, setBusy] = createSignal<Record<number, ActionKey>>({})
  const [rowErr, setRowErr] = createSignal<Record<number, string>>({})

  const refresh = async () => {
    setRefreshing(true)
    const n = await pve.nodes()
    if (!n.ok) {
      setErr(n.error || "could not reach the Proxmox API")
      setLoading(false)
      setRefreshing(false)
      setLastSync(new Date())
      return
    }
    const online = n.data.filter((x) => x.status === "online")
    const results = await Promise.all(
      online.map(async (nd) => ({ node: nd.node, r: await pve.lxcList(nd.node) })),
    )
    const missed: string[] = []
    const list: Row[] = []
    for (const { node, r } of results) {
      if (r.ok) list.push(...r.data.map((c) => ({ ...c, node })))
      else missed.push(node)
    }
    list.sort((a, b) => a.vmid - b.vmid)
    setRows(reconcile(list, { key: "vmid" }))
    setErr(missed.length ? `Could not reach ${missed.join(", ")} — containers there are hidden until it responds.` : "")
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

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    return rows.filter((c) => {
      if (statusFilter() === "running" && c.status !== "running") return false
      if (statusFilter() === "stopped" && c.status === "running") return false
      if (!q) return true
      return (
        String(c.vmid).includes(q) ||
        (c.name ?? "").toLowerCase().includes(q) ||
        c.node.toLowerCase().includes(q) ||
        (c.tags ?? "").toLowerCase().includes(q)
      )
    })
  })

  const counts = createMemo(() => {
    const running = rows.filter((c) => c.status === "running").length
    return { all: rows.length, running, stopped: rows.length - running }
  })

  const FILTERS: Array<{ key: StatusFilter; label: string }> = [
    { key: "all", label: "All" },
    { key: "running", label: "Running" },
    { key: "stopped", label: "Stopped" },
  ]

  async function act(c: Row, action: ActionKey) {
    if (busy()[c.vmid]) return
    if (
      action === "stop" &&
      !window.confirm(`Force-stop CT ${c.vmid} (${c.name ?? "unnamed"})?\n\nThis is a hard power-off, not a graceful shutdown.`)
    ) {
      return
    }
    setBusy((b) => ({ ...b, [c.vmid]: action }))
    setRowErr((e) => {
      const next = { ...e }
      delete next[c.vmid]
      return next
    })
    const r = await pve.create(`/nodes/${encodeURIComponent(c.node)}/lxc/${c.vmid}/status/${action}`, {})
    if (!r.ok) {
      setRowErr((e) => ({ ...e, [c.vmid]: r.error }))
    } else if (action === "start") {
      setRows((row) => row.vmid === c.vmid, "status", "running")
    } else if (action === "stop" || action === "shutdown") {
      setRows((row) => row.vmid === c.vmid, "status", "stopped")
    }
    setBusy((b) => {
      const next = { ...b }
      delete next[c.vmid]
      return next
    })
    void refresh()
  }

  return (
    <div class="cx-page cx-lxc-page cx-fade-in">
      <div class="cx-page-head">
        <div>
          <h1 class="cx-page-title">Containers</h1>
          <p class="cx-page-sub">
            Every LXC container on the cluster, live from Proxmox. Start, reboot, shut down or
            force-stop directly — no approval round-trip.
          </p>
        </div>
        <button
          type="button"
          class="cx-btn cx-btn-ghost cx-btn-sm"
          onClick={() => {
            if (rows.length === 0) setLoading(true)
            void refresh()
          }}
        >
          <span class="cx-refresh-glyph" classList={{ spinning: refreshing() }}>⟳</span>
          Refresh
        </button>
      </div>

      <Show when={err()}>
        <div class="cx-error-card cx-fade-in">{err()}</div>
      </Show>

      <div class="cx-lxc-toolbar">
        <div class="cx-lxc-search">
          <span class="cx-lxc-search-icon">⌕</span>
          <input
            class="cx-input"
            placeholder="Search VMID, name, node, tag…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div class="cx-lxc-filters">
          <For each={FILTERS}>
            {(f) => (
              <button
                type="button"
                class="cx-lxc-filter"
                classList={{ active: statusFilter() === f.key }}
                onClick={() => setStatusFilter(f.key)}
              >
                {f.label}
                <span class="cx-lxc-filter-count">{counts()[f.key]}</span>
              </button>
            )}
          </For>
        </div>
        <div class="cx-lxc-synced">synced {fmtAgo(lastSync())}</div>
      </div>

      <div class="cx-card cx-card-flat cx-table-wrap">
        <table class="cx-table cx-lxc-table">
          <thead>
            <tr>
              <th></th>
              <th>VMID</th>
              <th>Name</th>
              <th>Node</th>
              <th>Status</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Uptime</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <Show when={!loading()} fallback={<SkeletonRows rows={5} />}>
              <For
                each={filtered()}
                fallback={
                  <tr>
                    <td colSpan={COLS}>
                      <div class="cx-empty">
                        {rows.length === 0 ? "No containers found on this cluster." : "No containers match your search."}
                      </div>
                    </td>
                  </tr>
                }
              >
                {(c, i) => {
                  const running = () => c.status === "running"
                  const cpuPct = () => (running() ? Math.max(0, Math.min(1, c.cpu ?? 0)) : 0)
                  const memPct = () => (c.maxmem ? (c.mem ?? 0) / c.maxmem : 0)
                  const isBusy = () => !!busy()[c.vmid]
                  const tags = () => (c.tags ?? "").split(/[,;]/).map((t) => t.trim()).filter(Boolean)
                  return (
                    <tr class="cx-item" style={{ "animation-delay": `${Math.min(i(), 14) * 25}ms` }}>
                      <td class="cx-lxc-glyph">▧</td>
                      <td class="cx-lxc-vmid">{c.vmid}</td>
                      <td>
                        <div class="cx-lxc-name">{c.name || `ct-${c.vmid}`}</div>
                        <Show when={c.template || tags().length > 0}>
                          <div class="cx-lxc-tags">
                            <Show when={c.template}><span class="cx-lxc-tag">template</span></Show>
                            <For each={tags()}>{(t) => <span class="cx-lxc-tag">{t}</span>}</For>
                          </div>
                        </Show>
                      </td>
                      <td>{c.node}</td>
                      <td>
                        <span class={`cx-pill ${running() ? "cx-pill-ok" : ""}`}>
                          <Show when={running()}><span class="cx-pill-dot" /></Show>
                          {c.status}
                        </span>
                      </td>
                      <td>
                        <Show when={running()} fallback={<span class="cx-lxc-dash">—</span>}>
                          <UsageBar pct={cpuPct()} sub={c.cpus ?? c.maxcpu ? `${c.cpus ?? c.maxcpu} vCPU` : ""} />
                        </Show>
                      </td>
                      <td>
                        <Show when={c.maxmem} fallback={<span class="cx-lxc-dash">—</span>}>
                          <UsageBar pct={memPct()} sub={`${fmtBytes(c.mem ?? 0)} / ${fmtBytes(c.maxmem ?? 0)}`} />
                        </Show>
                      </td>
                      <td>{running() ? fmtUptime(c.uptime ?? 0) : "—"}</td>
                      <td class="cx-lxc-actions">
                        <Show when={!c.template} fallback={<span class="cx-lxc-dash">—</span>}>
                          <Show
                            when={running()}
                            fallback={
                              <button
                                type="button"
                                class="cx-btn cx-btn-sm cx-btn-ok"
                                disabled={isBusy()}
                                onClick={() => act(c, "start")}
                              >
                                <Show when={busy()[c.vmid] !== "start"} fallback={<span class="cx-spinner" />}>Start</Show>
                              </button>
                            }
                          >
                            <button
                              type="button"
                              class="cx-btn cx-btn-sm cx-btn-ghost"
                              disabled={isBusy()}
                              onClick={() => act(c, "reboot")}
                            >
                              <Show when={busy()[c.vmid] !== "reboot"} fallback={<span class="cx-spinner" />}>Reboot</Show>
                            </button>
                            <button
                              type="button"
                              class="cx-btn cx-btn-sm cx-btn-warn"
                              disabled={isBusy()}
                              onClick={() => act(c, "shutdown")}
                            >
                              <Show when={busy()[c.vmid] !== "shutdown"} fallback={<span class="cx-spinner" />}>Shutdown</Show>
                            </button>
                            <button
                              type="button"
                              class="cx-btn cx-btn-sm cx-btn-danger"
                              disabled={isBusy()}
                              onClick={() => act(c, "stop")}
                            >
                              <Show when={busy()[c.vmid] !== "stop"} fallback={<span class="cx-spinner" />}>Stop</Show>
                            </button>
                          </Show>
                        </Show>
                        <Show when={rowErr()[c.vmid]}>
                          <div class="cx-lxc-row-err">{rowErr()[c.vmid]}</div>
                        </Show>
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
  id: "lxc",
  label: "Containers",
  icon: "▩",
  section: "PROXMOX",
  order: 15,
  component: LxcPage,
} satisfies PageDef
