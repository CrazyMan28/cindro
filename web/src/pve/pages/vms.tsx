// Virtual Machines — the live QEMU guest table. Talks straight to the real
// Proxmox REST API via pve-api.ts (no jarvisd/proxmoxop.tool round-trip
// needed for either reads or the lifecycle actions below), same pattern as
// pages/nodes.tsx and pages/tasks.tsx:
//   - List: GET /cluster/resources?type=vm (returns qemu+lxc together),
//     filtered client-side to type==="qemu" — one cheap cluster-wide call
//     instead of iterating every node's /qemu endpoint.
//   - Row actions (Start/Stop/Reboot/Shutdown): POST
//     /nodes/<node>/qemu/<vmid>/status/<action> via pve.create(), each gated
//     behind a small animated confirm dialog (built on the shared
//     cx-modal-* primitives from vm-create.tsx's wizard, at a smaller width).
//   - Details drawer: slides in from the right, backed by qemuConfig() (+
//     qemuStatus() for the live numbers) — shows the curated hardware/boot
//     summary plus every other raw config key (disks, net0, ...) so it's
//     still useful to an admin who wants the exact wire config.
//   - "Create VM" opens the multi-step wizard already built at ./vm-create
//     (VmCreateModal) as a modal; it talks to the same REST API directly and
//     doesn't need anything from this file beyond open/onClose/onCreated.
// Self-registers per router.ts's PageDef contract; zero props — everything
// is local state + a 5s poll, exactly like its sibling pages.

import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"

import * as pve from "../pve-api"
import type { PageDef } from "../router"
import { VmCreateModal } from "./vm-create"

const POLL_MS = 5000

type VmStatus = "running" | "stopped" | "paused" | string

type VmRow = {
  vmid: number
  name: string
  node: string
  status: VmStatus
  cpuPct: number
  maxcpu?: number
  mem: number
  maxmem: number
  uptime: number
  tags?: string
}

type ActionKind = "start" | "shutdown" | "reboot" | "stop"
type StatFilter = "all" | "running" | "stopped"

// --- formatting --------------------------------------------------------------

function fmtPct(v: number): string {
  return `${Math.round(Math.max(0, v) * 100)}%`
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

function fmtMemCfg(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return "—"
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} GiB` : `${n} MiB`
}

function displayName(vm: { name?: string; vmid: number }): string {
  return vm.name && vm.name.trim() ? vm.name : `VM ${vm.vmid}`
}

// --- lifecycle actions ---------------------------------------------------

const ACTION_META: Record<
  ActionKind,
  { label: string; verbing: string; icon: string; tone: "success" | "warn" | "danger"; copy: (name: string, node: string) => string }
> = {
  start: {
    label: "Start",
    verbing: "Starting",
    icon: "▶",
    tone: "success",
    copy: (name, node) => `Power on ${name} on node ${node}.`,
  },
  shutdown: {
    label: "Shutdown",
    verbing: "Shutting down",
    icon: "⏻",
    tone: "warn",
    copy: (name) => `Send an ACPI shutdown to ${name} — the guest OS should power off gracefully.`,
  },
  reboot: {
    label: "Reboot",
    verbing: "Rebooting",
    icon: "↻",
    tone: "warn",
    copy: (name) => `Reboot ${name}. Any unsaved state inside the guest will be lost.`,
  },
  stop: {
    label: "Force stop",
    verbing: "Stopping",
    icon: "■",
    tone: "danger",
    copy: (name) => `Hard power off ${name} — like pulling the plug. Prefer Shutdown when the guest is responsive.`,
  },
}

function actionsFor(status: VmStatus): ActionKind[] {
  return status === "running" ? ["shutdown", "reboot", "stop"] : ["start"]
}

// Known QemuConfig keys shown in their own curated rows in the drawer — every
// other key (disks, net0, ide2, ...) is dumped generically below them.
const KNOWN_CONFIG_KEYS = new Set([
  "vmid", "name", "cores", "sockets", "cpu", "memory", "balloon",
  "ostype", "boot", "onboot", "agent", "digest", "meta", "vmgenid",
])

// --- confirm dialog ------------------------------------------------------

const ConfirmDialog: Component<{
  name: string
  node: string
  action: ActionKind
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}> = (props) => {
  const meta = () => ACTION_META[props.action]
  return (
    <div
      class="cx-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !props.busy) props.onCancel()
      }}
    >
      <div class="cx-modal cx-modal-sm" role="alertdialog" aria-modal="true" aria-label={`${meta().label} ${props.name}`}>
        <div class="cx-modal-head">
          <div class="cx-modal-head-text">
            <div class="cx-modal-title">{meta().label} VM</div>
            <div class="cx-modal-sub">{props.name} · node {props.node}</div>
          </div>
          <button type="button" class="cx-modal-close" disabled={props.busy} onClick={props.onCancel} aria-label="Cancel">✕</button>
        </div>
        <div class="cx-modal-body">
          <p class="cx-vms-confirm-copy">{meta().copy(props.name, props.node)}</p>
          <Show when={props.error}>
            <div class="cx-error-card">{props.error}</div>
          </Show>
        </div>
        <div class="cx-modal-foot">
          <button type="button" class="cx-btn cx-btn-ghost" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
          <div class="cx-modal-foot-spacer" />
          <button
            type="button"
            class={`cx-btn cx-btn-${meta().tone}`}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            <Show when={props.busy}><span class="cx-spinner" /></Show>
            {props.busy ? `${meta().verbing}…` : `${meta().icon} ${meta().label}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- status pill -----------------------------------------------------------

const StatusPill: Component<{ status: VmStatus }> = (props) => (
  <span class="cx-vms-status" classList={{ [props.status]: true }}>
    <span class="cx-vms-status-dot" />
    {props.status}
  </span>
)

// --- animated usage meter ----------------------------------------------------

const Meter: Component<{ pct: number }> = (props) => {
  const tone = () => (props.pct > 0.9 ? "tone-bad" : props.pct > 0.75 ? "tone-warn" : "")
  return (
    <div class="cx-vms-meter">
      <div class="cx-vms-meter-track">
        <div class={`cx-vms-meter-fill ${tone()}`} style={{ width: `${Math.min(100, Math.round(props.pct * 100))}%` }} />
      </div>
      <span class="cx-vms-meter-value">{fmtPct(props.pct)}</span>
    </div>
  )
}

// --- page ----------------------------------------------------------------

const VmsPage: Component = () => {
  const [rows, setRows] = createSignal<VmRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [lastSync, setLastSync] = createSignal<Date | null>(null)
  const [, setTick] = createSignal(0) // re-renders fmtAgo() every second

  const [search, setSearch] = createSignal("")
  const [statusFilter, setStatusFilter] = createSignal<StatFilter>("all")

  const [showCreate, setShowCreate] = createSignal(false)

  // pending confirm for a row/drawer action
  const [confirm, setConfirm] = createSignal<{ vmid: number; node: string; name: string; action: ActionKind } | null>(null)
  const [acting, setActing] = createSignal(false)
  const [actionErr, setActionErr] = createSignal("")

  // details drawer
  const [drawerId, setDrawerId] = createSignal<{ vmid: number; node: string } | null>(null)
  const [drawerConfig, setDrawerConfig] = createSignal<pve.QemuConfig | null>(null)
  const [drawerStatus, setDrawerStatus] = createSignal<pve.QemuStatus | null>(null)
  const [drawerLoading, setDrawerLoading] = createSignal(false)
  const [drawerErr, setDrawerErr] = createSignal("")
  const [drawerClosing, setDrawerClosing] = createSignal(false)

  const refresh = async (background = false) => {
    if (background) setRefreshing(true)
    const r = await pve.get<pve.ClusterResource[]>("/cluster/resources", { type: "vm" })
    if (r.ok) {
      const list: VmRow[] = r.data
        .filter((x) => x.type === "qemu")
        .map((x) => ({
          vmid: x.vmid ?? 0,
          name: x.name ?? "",
          node: x.node ?? "",
          status: (x.status as VmStatus) ?? "unknown",
          cpuPct: x.cpu ?? 0,
          maxcpu: x.maxcpu,
          mem: x.mem ?? 0,
          maxmem: x.maxmem ?? 0,
          uptime: x.uptime ?? 0,
          tags: x.tags,
        }))
        .sort((a, b) => a.vmid - b.vmid)
      setRows(list)
      setErr("")
    } else {
      setErr(r.error || "could not reach the Proxmox API")
    }
    setLoading(false)
    setRefreshing(false)
    setLastSync(new Date())
  }

  onMount(() => {
    void refresh()
    const poll = setInterval(() => void refresh(true), POLL_MS)
    const clock = setInterval(() => setTick((t) => t + 1), 1000)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(clock)
    })
  })

  const filteredRows = createMemo(() => {
    const q = search().trim().toLowerCase()
    const sf = statusFilter()
    return rows().filter((r) => {
      if (sf === "running" && r.status !== "running") return false
      if (sf === "stopped" && r.status === "running") return false
      if (!q) return true
      return (
        String(r.vmid).includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.node.toLowerCase().includes(q) ||
        (r.tags ?? "").toLowerCase().includes(q)
      )
    })
  })

  const totals = createMemo(() => {
    const list = rows()
    const running = list.filter((r) => r.status === "running").length
    return { all: list.length, running, stopped: list.length - running }
  })

  // --- lifecycle actions ---------------------------------------------------

  function requestAction(vm: { vmid: number; node: string; name: string }, action: ActionKind) {
    setActionErr("")
    setConfirm({ vmid: vm.vmid, node: vm.node, name: displayName(vm), action })
  }

  async function runAction() {
    const c = confirm()
    if (!c || acting()) return
    setActing(true)
    setActionErr("")
    const r = await pve.create(`/nodes/${encodeURIComponent(c.node)}/qemu/${c.vmid}/status/${c.action}`, {})
    setActing(false)
    if (!r.ok) {
      setActionErr(`${ACTION_META[c.action].label} failed: ${r.error}`)
      return
    }
    setConfirm(null)
    void refresh(true)
    const d = drawerId()
    if (d && d.vmid === c.vmid && d.node === c.node) void loadDrawer(d)
  }

  // --- details drawer --------------------------------------------------------

  const drawerRow = createMemo<VmRow | null>(() => {
    const d = drawerId()
    if (!d) return null
    return rows().find((r) => r.vmid === d.vmid && r.node === d.node) ?? null
  })

  async function loadDrawer(id: { vmid: number; node: string }) {
    setDrawerLoading(true)
    setDrawerErr("")
    const [c, s] = await Promise.all([pve.qemuConfig(id.node, id.vmid), pve.qemuStatus(id.node, id.vmid)])
    setDrawerLoading(false)
    if (c.ok) setDrawerConfig(c.data)
    else {
      setDrawerConfig(null)
      setDrawerErr(c.error)
    }
    if (s.ok) setDrawerStatus(s.data)
    else setDrawerStatus(null)
  }

  function openDrawer(vm: VmRow) {
    const id = { vmid: vm.vmid, node: vm.node }
    setDrawerId(id)
    setDrawerConfig(null)
    setDrawerStatus(null)
    void loadDrawer(id)
  }

  function closeDrawer() {
    if (drawerClosing()) return
    setDrawerClosing(true)
    setTimeout(() => {
      setDrawerClosing(false)
      setDrawerId(null)
    }, 180)
  }

  const otherConfigEntries = createMemo<Array<[string, string]>>(() => {
    const cfg = drawerConfig()
    if (!cfg) return []
    return Object.entries(cfg)
      .filter(([k, v]) => !KNOWN_CONFIG_KEYS.has(k) && v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0]))
  })

  return (
    <div class="cx-page cx-vms-page cx-fade-in">
      <div class="cx-page-head">
        <div>
          <h1 class="cx-page-title">Virtual Machines</h1>
          <p class="cx-page-sub">Live QEMU guests across the cluster · synced {fmtAgo(lastSync())}</p>
        </div>
        <div class="cx-inline">
          <button type="button" class="cx-btn cx-btn-sm" onClick={() => void refresh(true)}>
            <span class="cx-refresh-glyph" classList={{ spinning: refreshing() }}>⟳</span>&nbsp;Refresh
          </button>
          <button type="button" class="cx-btn cx-btn-primary" onClick={() => setShowCreate(true)}>
            + Create VM
          </button>
        </div>
      </div>

      <Show when={err()}>
        <div class="cx-error-card cx-fade-in">{err()}</div>
      </Show>

      <div class="cx-vms-summary">
        <div class="cx-vms-stat">
          <span class="cx-vms-stat-value">{totals().all}</span>
          <span class="cx-vms-stat-label">Guests</span>
        </div>
        <div class="cx-vms-stat">
          <span class="cx-vms-stat-value tone-ok">{totals().running}</span>
          <span class="cx-vms-stat-label">Running</span>
        </div>
        <div class="cx-vms-stat">
          <span class="cx-vms-stat-value tone-faint">{totals().stopped}</span>
          <span class="cx-vms-stat-label">Stopped</span>
        </div>
      </div>

      <div class="cx-vms-toolbar">
        <input
          class="cx-input cx-vms-search"
          placeholder="Search name, VMID, node, tag…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <div class="cx-vms-filters">
          <For each={[["all", "All"], ["running", "Running"], ["stopped", "Stopped"]] as Array<[StatFilter, string]>}>
            {([key, label]) => (
              <button
                type="button"
                class="cx-vms-filter"
                classList={{ active: statusFilter() === key }}
                onClick={() => setStatusFilter(key)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="cx-vms-table-wrap">
        <table class="cx-table cx-vms-table">
          <thead>
            <tr>
              <th>VMID</th>
              <th>Name</th>
              <th>Node</th>
              <th>Status</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Uptime</th>
              <th style={{ "text-align": "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <Show
              when={!loading()}
              fallback={
                <For each={[0, 1, 2, 3, 4]}>
                  {() => (
                    <tr class="cx-skel-row">
                      <td colspan={8}><div class="cx-skel cx-skel-bar" style={{ width: "100%" }} /></td>
                    </tr>
                  )}
                </For>
              }
            >
              <Show
                when={filteredRows().length > 0}
                fallback={
                  <tr>
                    <td colspan={8}>
                      <div class="cx-empty cx-vms-empty-cell">
                        {rows().length === 0 ? "No virtual machines found on this cluster." : "No VMs match your search/filter."}
                      </div>
                    </td>
                  </tr>
                }
              >
                <For each={filteredRows()}>
                  {(vm) => {
                    const memPct = () => (vm.maxmem ? vm.mem / vm.maxmem : 0)
                    return (
                      <tr
                        class="cx-vms-row"
                        tabIndex={0}
                        onClick={() => openDrawer(vm)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            openDrawer(vm)
                          }
                        }}
                      >
                        <td><span class="cx-vms-id">{vm.vmid}</span></td>
                        <td>
                          <div class="cx-vms-name-cell">
                            <span class="cx-vms-name">{displayName(vm)}</span>
                            <Show when={vm.tags}>
                              <div class="cx-vms-tags">
                                <For each={(vm.tags ?? "").split(";").filter(Boolean)}>
                                  {(t) => <span class="cx-vms-tag">{t}</span>}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </td>
                        <td><span class="cx-vms-node">{vm.node}</span></td>
                        <td><StatusPill status={vm.status} /></td>
                        <td>
                          <Show when={vm.status === "running"} fallback="—">
                            <Meter pct={vm.cpuPct} />
                          </Show>
                        </td>
                        <td>
                          <Show when={vm.status === "running" && vm.maxmem > 0} fallback="—">
                            <Meter pct={memPct()} />
                          </Show>
                        </td>
                        <td>{vm.status === "running" ? fmtUptime(vm.uptime) : "—"}</td>
                        <td>
                          <div class="cx-vms-row-actions" onClick={(e) => e.stopPropagation()}>
                            <For each={actionsFor(vm.status)}>
                              {(a) => (
                                <button
                                  type="button"
                                  class={`cx-btn cx-btn-sm cx-btn-${ACTION_META[a].tone}`}
                                  onClick={() => requestAction(vm, a)}
                                >
                                  <span class="cx-vms-btn-icon">{ACTION_META[a].icon}</span>
                                  {ACTION_META[a].label}
                                </button>
                              )}
                            </For>
                          </div>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </tbody>
        </table>
      </div>

      <Show when={confirm()}>
        <ConfirmDialog
          name={confirm()!.name}
          node={confirm()!.node}
          action={confirm()!.action}
          busy={acting()}
          error={actionErr()}
          onCancel={() => {
            if (!acting()) {
              setConfirm(null)
              setActionErr("")
            }
          }}
          onConfirm={runAction}
        />
      </Show>

      <Show when={drawerId()}>
        <div class="cx-vms-drawer-backdrop" classList={{ closing: drawerClosing() }} onClick={closeDrawer} />
        <div class="cx-vms-drawer" classList={{ closing: drawerClosing() }} role="dialog" aria-modal="true" aria-label="VM details">
          <div class="cx-modal-head">
            <div class="cx-modal-head-text">
              <div class="cx-modal-title">{drawerRow() ? displayName(drawerRow()!) : `VM ${drawerId()?.vmid}`}</div>
              <div class="cx-modal-sub">#{drawerId()?.vmid} on {drawerId()?.node}</div>
            </div>
            <button type="button" class="cx-modal-close" onClick={closeDrawer} aria-label="Close">✕</button>
          </div>
          <div class="cx-modal-body">
            <Show when={drawerRow()}>
              {(row) => (
                <div class="cx-vms-drawer-actions">
                  <For each={actionsFor(row().status)}>
                    {(a) => (
                      <button
                        type="button"
                        class={`cx-btn cx-btn-sm cx-btn-${ACTION_META[a].tone}`}
                        onClick={() => requestAction(row(), a)}
                      >
                        <span class="cx-vms-btn-icon">{ACTION_META[a].icon}</span>
                        {ACTION_META[a].label}
                      </button>
                    )}
                  </For>
                  <button type="button" class="cx-btn cx-btn-sm cx-btn-ghost" onClick={() => void loadDrawer(drawerId()!)}>
                    ⟳ Refresh
                  </button>
                </div>
              )}
            </Show>

            <Show when={drawerErr()}>
              <div class="cx-error-card" style={{ "margin-bottom": "14px" }}>{drawerErr()}</div>
            </Show>

            <Show
              when={!drawerLoading()}
              fallback={
                <div class="cx-vms-drawer-loading">
                  <div class="cx-skel cx-skel-line" />
                  <div class="cx-skel cx-skel-line" />
                  <div class="cx-skel cx-skel-block" />
                </div>
              }
            >
              <Show when={drawerConfig()}>
                {(cfg) => (
                  <div class="cx-vms-drawer-body">
                    <div class="cx-review-section-label">Overview</div>
                    <dl class="cx-review-list">
                      <div class="cx-review-row"><dt>Node</dt><dd>{drawerId()?.node}</dd></div>
                      <div class="cx-review-row"><dt>VMID</dt><dd>{drawerId()?.vmid}</dd></div>
                      <div class="cx-review-row"><dt>Status</dt><dd>{drawerStatus()?.status ?? drawerRow()?.status ?? "—"}</dd></div>
                      <div class="cx-review-row">
                        <dt>Uptime</dt>
                        <dd>{drawerStatus()?.status === "running" ? fmtUptime(drawerStatus()?.uptime ?? 0) : "—"}</dd>
                      </div>
                    </dl>

                    <div class="cx-review-section-label">Hardware</div>
                    <dl class="cx-review-list">
                      <div class="cx-review-row">
                        <dt>CPU</dt>
                        <dd>{cfg().sockets ?? "—"} × {cfg().cores ?? "—"} ({String(cfg().cpu ?? "default")})</dd>
                      </div>
                      <div class="cx-review-row"><dt>Memory</dt><dd>{fmtMemCfg(cfg().memory)}</dd></div>
                      <Show when={(cfg() as Record<string, unknown>).balloon != null}>
                        <div class="cx-review-row"><dt>Balloon</dt><dd>{fmtMemCfg((cfg() as Record<string, unknown>).balloon)}</dd></div>
                      </Show>
                    </dl>

                    <div class="cx-review-section-label">Boot &amp; Agent</div>
                    <dl class="cx-review-list">
                      <div class="cx-review-row"><dt>OS type</dt><dd>{cfg().ostype ?? "—"}</dd></div>
                      <div class="cx-review-row"><dt>Boot order</dt><dd>{cfg().boot ?? "—"}</dd></div>
                      <div class="cx-review-row"><dt>Start at boot</dt><dd>{Number(cfg().onboot) === 1 ? "yes" : "no"}</dd></div>
                      <div class="cx-review-row"><dt>Guest agent</dt><dd>{cfg().agent ? "enabled" : "disabled"}</dd></div>
                    </dl>

                    <Show when={otherConfigEntries().length > 0}>
                      <div class="cx-review-section-label">Devices &amp; other config</div>
                      <dl class="cx-review-list">
                        <For each={otherConfigEntries()}>
                          {([k, v]) => <div class="cx-review-row"><dt>{k}</dt><dd>{v}</dd></div>}
                        </For>
                      </dl>
                    </Show>
                  </div>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </Show>

      <VmCreateModal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        onCreated={() => void refresh(true)}
      />
    </div>
  )
}

export default {
  id: "vms",
  label: "Virtual Machines",
  icon: "▣",
  section: "PROXMOX",
  order: 10,
  component: VmsPage,
} satisfies PageDef
