// Backups & Snapshots — two live views over the REAL Proxmox REST API
// (pve-api.ts, same-origin /api2/json, no jarvisd round-trip needed):
//
//   1. Backup Archives — vzdump images sitting on any storage that advertises
//      "backup" content (pve.storageContent(node, storage, "backup")),
//      scoped by a node/storage picker exactly like pages/tasks.tsx's task
//      log. Rows are annotated with the owning guest's name (via a single
//      pve.clusterResources() lookup) and can be deleted.
//   2. Snapshots — a per-guest timeline (pve.snapshots(node, vmid) for QEMU;
//      the identically-shaped /nodes/<node>/lxc/<vmid>/snapshot for LXC,
//      reached with pve-api's generic get/create/del verbs since pve-api.ts
//      only ships a typed helper for the QEMU path) with create / rollback /
//      delete actions, all of which return a Proxmox task UPID that's polled
//      to completion so the UI reflects when the background job actually
//      finishes, not just when it was queued.
//
// Self-registers per router.ts's PageDef contract; zero props (no usePve()
// needed — everything here is pure Proxmox REST, not a Cindro/daemon call).
// No user-facing "Jarvis" anywhere.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Component,
} from "solid-js"

import * as pve from "../pve-api"
import type { PageDef } from "../router"

const enc = encodeURIComponent
const POLL_MS = 15000
const SNAP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/

// --- shared guest shape (QEMU + LXC, whichever pve.clusterResources() sees) -

type GuestType = "qemu" | "lxc"

type Guest = {
  key: string
  vmid: number
  name: string
  node: string
  type: GuestType
  status?: string
  template: boolean
}

function guestKey(g: { type: GuestType; node: string; vmid: number }): string {
  return `${g.type}:${g.node}:${g.vmid}`
}

function guestBase(g: Guest): string {
  return `/nodes/${enc(g.node)}/${g.type}/${enc(g.vmid)}`
}

// --- formatting ----------------------------------------------------------

function fmtBytes(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function fmtDate(epochSec: number | undefined): string {
  if (!epochSec) return "—"
  return new Date(epochSec * 1000).toLocaleString()
}

function fmtAgo(epochSec: number | undefined, nowSec: number): string {
  if (!epochSec) return "—"
  const diff = Math.max(0, nowSec - epochSec)
  if (diff < 8) return "just now"
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return new Date(epochSec * 1000).toLocaleDateString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isUpid(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("UPID:")
}

// Poll a Proxmox background task to completion. Every mutating call this
// page makes (snapshot create/rollback/delete, backup delete) queues an
// async job and returns its UPID immediately — refreshing the list right
// away would just show stale state, so callers await this before refetching.
async function pollTask(node: string, upid: string): Promise<{ ok: boolean; error?: string }> {
  // 10 min: a snapshot-with-RAM or a large vzdump/rollback legitimately takes
  // minutes; the old 2-min cap reported success as a red "timed out" error.
  const deadline = Date.now() + 600000
  while (Date.now() < deadline) {
    const r = await pve.get<{ status?: string; exitstatus?: string }>(
      `/nodes/${enc(node)}/tasks/${enc(upid)}/status`,
    )
    if (!r.ok) return { ok: false, error: r.error }
    if (r.data.status === "stopped") {
      const exit = r.data.exitstatus ?? ""
      const up = exit.toUpperCase()
      // "OK" and "WARNINGS: N" both mean the task actually completed (vzdump and
      // snapshots routinely finish with warnings) — only other statuses failed.
      return up.startsWith("OK") || up.startsWith("WARNING")
        ? { ok: true }
        : { ok: false, error: exit || "task failed" }
    }
    await sleep(1200)
  }
  return { ok: false, error: "timed out waiting for the task to finish" }
}

// --- ephemeral action toasts ----------------------------------------------

type Toast = { id: number; label: string; state: "pending" | "ok" | "error"; detail?: string }

// --- backup archive rows ---------------------------------------------------

type BackupRow = pve.StorageContentItem & { storageName: string; node: string }

function mergeBackups(prev: BackupRow[], next: BackupRow[]): BackupRow[] {
  const byId = new Map(prev.map((r) => [r.volid, r] as const))
  return next.map((r) => {
    const old = byId.get(r.volid)
    if (old && old.notes === r.notes && old.size === r.size) return old
    return r
  })
}

function mergeSnaps(prev: pve.SnapshotSummary[], next: pve.SnapshotSummary[]): pve.SnapshotSummary[] {
  const byName = new Map(prev.map((s) => [s.name, s] as const))
  return next.map((s) => {
    const old = byName.get(s.name)
    if (old && old.description === s.description && old.parent === s.parent) return old
    return s
  })
}

// --- component --------------------------------------------------------------

const BackupsPage: Component = () => {
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000))

  // --- nodes / guest directory (shared by both sections) ---
  const [nodeList, setNodeList] = createSignal<pve.PveNode[]>([])
  const [guestNameByVmid, setGuestNameByVmid] = createSignal<Map<number, string>>(new Map())
  const [guests, setGuests] = createSignal<Guest[]>([])

  async function loadDirectory() {
    const [n, r] = await Promise.all([pve.nodes(), pve.clusterResources()])
    if (n.ok) {
      setNodeList(n.data)
      if (!bkNode() && n.data.length) {
        const online = n.data.find((x) => x.status === "online") ?? n.data[0]
        setBkNode(online.node)
      }
    }
    if (r.ok) {
      const names = new Map<number, string>()
      const list: Guest[] = []
      for (const g of r.data) {
        if (g.type !== "qemu" && g.type !== "lxc") continue
        if (g.vmid == null) continue
        const name = g.name || `#${g.vmid}`
        names.set(g.vmid, name)
        list.push({
          key: guestKey({ type: g.type, node: g.node ?? "", vmid: g.vmid }),
          vmid: g.vmid,
          name,
          node: g.node ?? "",
          type: g.type,
          status: g.status,
          template: g.template === 1,
        })
      }
      list.sort((a, b) => a.name.localeCompare(b.name))
      setGuestNameByVmid(names)
      setGuests(list)
      if (!snapGuestKey() && list.length) setSnapGuestKey(list[0].key)
    }
  }

  // ============================ Backup archives =============================

  const [bkNode, setBkNode] = createSignal("")
  const [bkStorages, setBkStorages] = createSignal<pve.StorageSummary[]>([])
  const [bkStorageSel, setBkStorageSel] = createSignal("") // "" = all backup-capable storages
  const [bkRows, setBkRows] = createSignal<BackupRow[]>([])
  const [bkLoading, setBkLoading] = createSignal(true)
  const [bkErr, setBkErr] = createSignal("")
  const [bkSync, setBkSync] = createSignal<number | null>(null)

  const backupStorages = createMemo(() =>
    bkStorages().filter((s) => (s.content ?? "").split(",").includes("backup")),
  )

  async function loadBkStorages(node: string) {
    const r = await pve.storages(node)
    if (r.ok) setBkStorages(r.data)
  }

  async function loadBackups(showSkeleton: boolean) {
    const node = bkNode()
    if (!node) return
    if (showSkeleton) setBkLoading(true)
    const targets = bkStorageSel() ? [bkStorageSel()] : backupStorages().map((s) => s.storage)
    if (targets.length === 0) {
      setBkRows([])
      setBkErr("")
      setBkLoading(false)
      setBkSync(Math.floor(Date.now() / 1000))
      return
    }
    const results = await Promise.all(
      targets.map(async (storage) => ({ storage, r: await pve.storageContent(node, storage, "backup") })),
    )
    const rows: BackupRow[] = []
    let anyOk = false
    let firstErr = ""
    for (const { storage, r } of results) {
      if (r.ok) {
        anyOk = true
        for (const item of r.data) rows.push({ ...item, storageName: storage, node })
      } else if (!firstErr) {
        firstErr = r.error
      }
    }
    rows.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0))
    setBkRows((prev) => mergeBackups(prev, rows))
    setBkErr(anyOk ? "" : firstErr)
    setBkLoading(false)
    setBkSync(Math.floor(Date.now() / 1000))
  }

  function changeBkNode(node: string) {
    if (node === bkNode()) return
    setBkNode(node)
    setBkStorageSel("")
    setBkRows([])
    setBkLoading(true)
  }

  createEffect(() => {
    const node = bkNode()
    if (node) void loadBkStorages(node)
  })
  createEffect(() => {
    bkNode()
    bkStorageSel()
    backupStorages()
    // untrack the bkRows() read: loadBackups() writes bkRows, so tracking it here
    // would make this effect re-fire on its own result and hammer the storage
    // API in a loop. Only the node/storage selection should retrigger a load.
    void loadBackups(untrack(() => bkRows().length === 0))
  })

  const bkTotalSize = createMemo(() => bkRows().reduce((s, r) => s + (r.size ?? 0), 0))

  function bkGuestLabel(vmid: number | undefined): string {
    if (vmid == null) return "—"
    return guestNameByVmid().get(vmid) ?? `#${vmid} (removed)`
  }

  // ============================== Snapshots ==================================

  const [snapGuestKey, setSnapGuestKey] = createSignal("")
  const [snapTypeFilter, setSnapTypeFilter] = createSignal<"all" | GuestType>("all")
  const [snaps, setSnaps] = createSignal<pve.SnapshotSummary[]>([])
  const [snapsLoading, setSnapsLoading] = createSignal(true)
  const [snapsErr, setSnapsErr] = createSignal("")

  const filteredGuests = createMemo(() =>
    snapTypeFilter() === "all" ? guests() : guests().filter((g) => g.type === snapTypeFilter()),
  )
  const snapGuest = createMemo(() => guests().find((g) => g.key === snapGuestKey()))

  // When the VM/CT filter changes, the selected guest can fall out of the
  // visible list — reselect the first still-visible guest so the timeline and
  // Roll back / Delete buttons never keep targeting a now-hidden guest.
  createEffect(() => {
    const fg = filteredGuests()
    const cur = snapGuestKey()
    if (cur && !fg.some((g) => g.key === cur)) setSnapGuestKey(fg[0]?.key ?? "")
  })

  async function loadSnapshots(showSkeleton: boolean) {
    const g = snapGuest()
    if (!g) {
      setSnaps([])
      setSnapsLoading(false)
      return
    }
    if (showSkeleton) setSnapsLoading(true)
    const r =
      g.type === "qemu"
        ? await pve.snapshots(g.node, g.vmid)
        : await pve.get<pve.SnapshotSummary[]>(`${guestBase(g)}/snapshot`)
    if (r.ok) {
      setSnapsErr("")
      setSnaps((prev) => mergeSnaps(prev, r.data))
    } else {
      setSnapsErr(r.error)
    }
    setSnapsLoading(false)
  }

  createEffect(() => {
    snapGuestKey()
    void loadSnapshots(true)
  })

  const orderedSnaps = createMemo(() => {
    const list = snaps().filter((s) => s.name !== "current")
    return list.slice().sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0))
  })
  const hasCurrentMarker = createMemo(() => snaps().some((s) => s.name === "current"))

  // --- toasts ---
  let toastSeq = 0
  const [toasts, setToasts] = createSignal<Toast[]>([])
  function pushToast(label: string): number {
    const id = ++toastSeq
    setToasts((t) => [...t, { id, label, state: "pending" }])
    return id
  }
  function settleToast(id: number, state: "ok" | "error", detail?: string) {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, state, detail } : x)))
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), state === "error" ? 6500 : 3800)
  }
  function dismissToast(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id))
  }

  async function afterAction(node: string, data: unknown, label: string, onDone: () => void) {
    const id = pushToast(label)
    if (isUpid(data)) {
      const res = await pollTask(node, data)
      settleToast(id, res.ok ? "ok" : "error", res.ok ? undefined : res.error)
    } else {
      settleToast(id, "ok")
    }
    onDone()
  }

  // --- per-row busy tracking (disables the buttons on the row mid-flight) ---
  const [busyKeys, setBusyKeys] = createSignal<Set<string>>(new Set())
  function setRowBusy(key: string, on: boolean) {
    setBusyKeys((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  // --- confirm dialog (shared by every destructive/irreversible action) ---
  type ConfirmSpec = {
    tone: "danger" | "warn"
    title: string
    message: string
    confirmLabel: string
    run: () => void
  }
  const [confirm, setConfirm] = createSignal<ConfirmSpec | null>(null)
  const [confirmClosing, setConfirmClosing] = createSignal(false)
  function closeConfirm() {
    setConfirmClosing(true)
    setTimeout(() => {
      setConfirmClosing(false)
      setConfirm(null)
    }, 160)
  }

  // --- backup archive delete ---
  function askDeleteBackup(row: BackupRow) {
    setConfirm({
      tone: "danger",
      title: "Delete backup archive",
      message: `Permanently delete this ${fmtBytes(row.size)} backup of ${bkGuestLabel(row.vmid)} from storage “${row.storageName}”? This cannot be undone.`,
      confirmLabel: "Delete archive",
      run: () => void doDeleteBackup(row),
    })
  }
  async function doDeleteBackup(row: BackupRow) {
    setRowBusy(row.volid, true)
    const r = await pve.del(`/nodes/${enc(row.node)}/storage/${enc(row.storageName)}/content/${enc(row.volid)}`)
    setRowBusy(row.volid, false)
    if (!r.ok) {
      const id = pushToast(`Delete failed: ${r.error}`)
      settleToast(id, "error")
      return
    }
    await afterAction(row.node, r.data, `Deleting backup archive (${fmtBytes(row.size)})`, () => void loadBackups(false))
  }

  // --- snapshot create ---
  const [createOpen, setCreateOpen] = createSignal(false)
  const [createClosing, setCreateClosing] = createSignal(false)
  const [snapName, setSnapName] = createSignal("")
  const [snapDesc, setSnapDesc] = createSignal("")
  const [snapVmstate, setSnapVmstate] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [createErr, setCreateErr] = createSignal("")

  function defaultSnapName(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `snap-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }
  function openCreate() {
    setSnapName(defaultSnapName())
    setSnapDesc("")
    setSnapVmstate(false)
    setCreateErr("")
    setCreateOpen(true)
  }
  function requestCloseCreate() {
    if (creating()) return
    setCreateClosing(true)
    setTimeout(() => {
      setCreateClosing(false)
      setCreateOpen(false)
    }, 160)
  }
  const snapNameValid = createMemo(() => SNAP_NAME_RE.test(snapName().trim()))

  async function submitCreate() {
    const g = snapGuest()
    if (!g || !snapNameValid() || creating()) return
    setCreating(true)
    setCreateErr("")
    const params: Record<string, unknown> = { snapname: snapName().trim() }
    if (snapDesc().trim()) params.description = snapDesc().trim()
    if (g.type === "qemu" && snapVmstate() && g.status === "running") params.vmstate = 1
    const r = await pve.create(`${guestBase(g)}/snapshot`, params)
    setCreating(false)
    if (!r.ok) {
      setCreateErr(r.error)
      return
    }
    requestCloseCreate()
    await afterAction(g.node, r.data, `Snapshotting “${g.name}” as “${snapName().trim()}”`, () => void loadSnapshots(false))
  }

  // --- snapshot rollback / delete ---
  function askRollback(g: Guest, snap: pve.SnapshotSummary) {
    setConfirm({
      tone: "warn",
      title: "Roll back snapshot",
      message: `“${g.name}” will be reverted to “${snap.name}”. Any changes made since this snapshot was taken will be lost.`,
      confirmLabel: "Roll back",
      run: () => void doRollback(g, snap),
    })
  }
  async function doRollback(g: Guest, snap: pve.SnapshotSummary) {
    setRowBusy(snap.name, true)
    const r = await pve.create(`${guestBase(g)}/snapshot/${enc(snap.name)}/rollback`, {})
    setRowBusy(snap.name, false)
    if (!r.ok) {
      const id = pushToast(`Rollback failed: ${r.error}`)
      settleToast(id, "error")
      return
    }
    await afterAction(g.node, r.data, `Rolling “${g.name}” back to “${snap.name}”`, () => void loadSnapshots(false))
  }

  function askDeleteSnapshot(g: Guest, snap: pve.SnapshotSummary) {
    setConfirm({
      tone: "danger",
      title: "Delete snapshot",
      message: `Permanently delete snapshot “${snap.name}” of “${g.name}”? This cannot be undone.`,
      confirmLabel: "Delete snapshot",
      run: () => void doDeleteSnapshot(g, snap),
    })
  }
  async function doDeleteSnapshot(g: Guest, snap: pve.SnapshotSummary) {
    setRowBusy(snap.name, true)
    const r = await pve.del(`${guestBase(g)}/snapshot/${enc(snap.name)}`)
    setRowBusy(snap.name, false)
    if (!r.ok) {
      const id = pushToast(`Delete failed: ${r.error}`)
      settleToast(id, "error")
      return
    }
    await afterAction(g.node, r.data, `Deleting snapshot “${snap.name}”`, () => void loadSnapshots(false))
  }

  // --- lifecycle ---
  onMount(() => {
    void loadDirectory()
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    const poll = setInterval(() => {
      void loadDirectory()
      void loadBackups(false)
      void loadSnapshots(false)
    }, POLL_MS)
    onCleanup(() => {
      clearInterval(clock)
      clearInterval(poll)
    })
  })

  return (
    <div class="cx-page cx-bk-page cx-fade-in">
      <div class="cx-page-head">
        <div>
          <h1 class="cx-page-title">Backups &amp; Snapshots</h1>
          <p class="cx-page-sub">
            Vzdump archives sitting on Proxmox storage, plus point-in-time snapshots for every guest —
            create, roll back, or clean them up straight from here.
          </p>
        </div>
      </div>

      <div class="cx-bk-summary">
        <div class="cx-bk-stat cx-item">
          <span class="cx-bk-stat-value">{bkRows().length}</span>
          <span class="cx-bk-stat-label">Backup archives</span>
        </div>
        <div class="cx-bk-stat cx-item" style={{ "animation-delay": "45ms" }}>
          <span class="cx-bk-stat-value">{fmtBytes(bkTotalSize())}</span>
          <span class="cx-bk-stat-label">Total archive size</span>
        </div>
        <div class="cx-bk-stat cx-item" style={{ "animation-delay": "90ms" }}>
          <span class="cx-bk-stat-value">{guests().length}</span>
          <span class="cx-bk-stat-label">Snapshot-capable guests</span>
        </div>
        <div class="cx-bk-stat cx-item" style={{ "animation-delay": "135ms" }}>
          <span class="cx-bk-stat-value">{orderedSnaps().length}</span>
          <span class="cx-bk-stat-label">Snapshots on {snapGuest()?.name ?? "—"}</span>
        </div>
        <div class="cx-bk-sync">
          <span class="cx-bk-sync-dot" classList={{ live: !bkLoading() }} />
          synced {bkSync() ? fmtAgo(bkSync()!, now()) : "—"}
        </div>
      </div>

      {/* =========================== Backup archives =========================== */}
      <section class="cx-bk-section">
        <div class="cx-section-head">
          <span class="cx-section-label">Backup archives</span>
          <div class="cx-bk-toolbar">
            <div class="cx-select-wrap cx-bk-select">
              <select
                class="cx-select"
                value={bkNode()}
                disabled={nodeList().length === 0}
                onChange={(e) => changeBkNode(e.currentTarget.value)}
              >
                <Show when={nodeList().length} fallback={<option value="">no nodes</option>}>
                  <For each={nodeList()}>{(n) => <option value={n.node}>{n.node}</option>}</For>
                </Show>
              </select>
            </div>
            <div class="cx-select-wrap cx-bk-select">
              <select
                class="cx-select"
                value={bkStorageSel()}
                onChange={(e) => setBkStorageSel(e.currentTarget.value)}
              >
                <option value="">All backup storages</option>
                <For each={backupStorages()}>{(s) => <option value={s.storage}>{s.storage}</option>}</For>
              </select>
            </div>
            <button
              type="button"
              class="cx-btn cx-btn-ghost cx-btn-sm"
              onClick={() => void loadBackups(true)}
            >
              <span class="cx-refresh-glyph" classList={{ spinning: bkLoading() }}>⟳</span>
              Refresh
            </button>
          </div>
        </div>

        <Show when={bkErr()}>
          <div class="cx-error-card cx-bk-error">{bkErr()}</div>
        </Show>

        <div class="cx-card cx-card-flat cx-table-wrap">
          <table class="cx-table">
            <thead>
              <tr>
                <th></th>
                <th>Guest</th>
                <th>Storage</th>
                <th>Format</th>
                <th>Size</th>
                <th>Created</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <Show
                when={!bkLoading()}
                fallback={
                  <For each={[0, 1, 2, 3, 4]}>
                    {(i) => (
                      <tr class="cx-skel-row">
                        <For each={["6%", "20%", "14%", "10%", "10%", "16%", "18%", "8%"]}>
                          {(w) => (
                            <td>
                              <div class="cx-skel-bar" style={{ width: w, "animation-delay": `${i * 70}ms` }} />
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                }
              >
                <For
                  each={bkRows()}
                  fallback={
                    <tr>
                      <td colSpan={8}>
                        <div class="cx-empty">No backup archives found on {bkNode() || "this node"}.</div>
                      </td>
                    </tr>
                  }
                >
                  {(row, i) => {
                    const protectedRow = () => Boolean((row as unknown as { protected?: number }).protected)
                    const busy = () => busyKeys().has(row.volid)
                    return (
                      <tr class="cx-item" style={{ "animation-delay": `${Math.min(i(), 14) * 25}ms` }}>
                        <td class="cx-bk-glyph">▤</td>
                        <td class="cx-bk-guest-cell">
                          <span class="cx-bk-guest-name">{bkGuestLabel(row.vmid)}</span>
                          <Show when={row.vmid != null}>
                            <span class="cx-bk-guest-vmid">#{row.vmid}</span>
                          </Show>
                        </td>
                        <td>{row.storageName}</td>
                        <td class="cx-bk-mono">{row.format ?? "—"}</td>
                        <td>{fmtBytes(row.size)}</td>
                        <td title={fmtDate(row.ctime)}>{fmtAgo(row.ctime, now())}</td>
                        <td class="cx-bk-notes">
                          <Show when={protectedRow()}>
                            <span class="cx-pill cx-bk-pill-protected">protected</span>
                          </Show>
                          <Show when={row.notes}>{row.notes}</Show>
                        </td>
                        <td class="cx-bk-row-actions">
                          <button
                            type="button"
                            class="cx-btn cx-btn-ghost cx-btn-sm cx-btn-danger"
                            disabled={busy() || protectedRow()}
                            title={protectedRow() ? "Protected — remove protection in Proxmox first" : "Delete this backup archive"}
                            onClick={() => askDeleteBackup(row)}
                          >
                            <Show when={busy()} fallback="Delete"><span class="cx-spinner" /></Show>
                          </button>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </Show>
            </tbody>
          </table>
        </div>
      </section>

      {/* ================================ Snapshots ============================= */}
      <section class="cx-bk-section">
        <div class="cx-section-head">
          <span class="cx-section-label">Snapshots</span>
          <div class="cx-bk-toolbar">
            <div class="cx-bk-chips">
              <For each={[["all", "All"], ["qemu", "VMs"], ["lxc", "CTs"]] as const}>
                {([key, label]) => (
                  <button
                    type="button"
                    class="cx-bk-chip"
                    classList={{ active: snapTypeFilter() === key }}
                    onClick={() => setSnapTypeFilter(key)}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
            <div class="cx-select-wrap cx-bk-select cx-bk-guest-select">
              <select
                class="cx-select"
                value={snapGuestKey()}
                disabled={filteredGuests().length === 0}
                onChange={(e) => setSnapGuestKey(e.currentTarget.value)}
              >
                <Show when={filteredGuests().length} fallback={<option value="">no guests found</option>}>
                  <For each={filteredGuests()}>
                    {(g) => (
                      <option value={g.key}>
                        {g.name} · #{g.vmid} · {g.type.toUpperCase()}
                        {g.template ? " · template" : ""}
                      </option>
                    )}
                  </For>
                </Show>
              </select>
            </div>
            <button
              type="button"
              class="cx-btn cx-btn-ghost cx-btn-sm"
              onClick={() => void loadSnapshots(true)}
            >
              <span class="cx-refresh-glyph" classList={{ spinning: snapsLoading() }}>⟳</span>
              Refresh
            </button>
            <button
              type="button"
              class="cx-btn cx-btn-primary cx-btn-sm"
              disabled={!snapGuest()}
              onClick={openCreate}
            >
              + New snapshot
            </button>
          </div>
        </div>

        <Show when={snapsErr()}>
          <div class="cx-error-card cx-bk-error">{snapsErr()}</div>
        </Show>

        <div class="cx-card cx-card-flat cx-bk-timeline-card">
          <Show
            when={!snapsLoading()}
            fallback={
              <div class="cx-bk-timeline">
                <For each={[0, 1, 2]}>
                  {(i) => (
                    <div class="cx-bk-tl-item cx-skel" style={{ "animation-delay": `${i * 80}ms` }}>
                      <span class="cx-bk-tl-dot" />
                      <div class="cx-bk-tl-card">
                        <div class="cx-skel-bar" style={{ width: "35%" }} />
                        <div class="cx-skel-bar" style={{ width: "60%", "margin-top": "8px" }} />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <Show
              when={snapGuest()}
              fallback={<div class="cx-empty">Pick a guest above to see its snapshots.</div>}
            >
              <div class="cx-bk-timeline">
                <Show when={hasCurrentMarker()}>
                  <div class="cx-bk-tl-item current cx-item">
                    <span class="cx-bk-tl-dot" />
                    <div class="cx-bk-tl-card cx-bk-tl-current">
                      <div class="cx-bk-tl-head">
                        <span class="cx-bk-tl-name">Live state</span>
                        <span class="cx-pill cx-bk-pill-live">
                          <span class="cx-pill-dot" />
                          now
                        </span>
                      </div>
                      <div class="cx-bk-tl-sub">Current running state of “{snapGuest()?.name}” — nothing to roll back to here.</div>
                    </div>
                  </div>
                </Show>

                <For
                  each={orderedSnaps()}
                  fallback={
                    <Show when={!hasCurrentMarker()}>
                      <div class="cx-empty">No snapshots yet — create one to get started.</div>
                    </Show>
                  }
                >
                  {(snap, i) => {
                    const busy = () => busyKeys().has(snap.name)
                    return (
                      <div class="cx-bk-tl-item cx-item" style={{ "animation-delay": `${Math.min(i(), 10) * 55}ms` }}>
                        <span class="cx-bk-tl-dot" />
                        <div class="cx-bk-tl-card">
                          <div class="cx-bk-tl-head">
                            <span class="cx-bk-tl-name">{snap.name}</span>
                            <Show when={snap.vmstate}>
                              <span class="cx-pill cx-bk-pill-ram">RAM</span>
                            </Show>
                            <span class="cx-bk-tl-time" title={fmtDate(snap.snaptime)}>{fmtAgo(snap.snaptime, now())}</span>
                          </div>
                          <Show when={snap.description && snap.description !== "current"}>
                            <div class="cx-bk-tl-sub">{snap.description}</div>
                          </Show>
                          <div class="cx-bk-tl-actions">
                            <button
                              type="button"
                              class="cx-btn cx-btn-ghost cx-btn-sm cx-btn-warn"
                              disabled={busy()}
                              onClick={() => snapGuest() && askRollback(snapGuest()!, snap)}
                            >
                              Roll back
                            </button>
                            <button
                              type="button"
                              class="cx-btn cx-btn-ghost cx-btn-sm cx-btn-danger"
                              disabled={busy()}
                              onClick={() => snapGuest() && askDeleteSnapshot(snapGuest()!, snap)}
                            >
                              <Show when={busy()} fallback="Delete"><span class="cx-spinner" /></Show>
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </section>

      {/* ============================ Create-snapshot modal ====================== */}
      <Show when={createOpen()}>
        <div
          class="cx-modal-backdrop"
          classList={{ closing: createClosing() }}
          onClick={(e) => { if (e.target === e.currentTarget) requestCloseCreate() }}
          onKeyDown={(e) => { if (e.key === "Escape") requestCloseCreate() }}
        >
          <div class="cx-modal cx-bk-modal-sm" classList={{ closing: createClosing() }} role="dialog" aria-modal="true" aria-label="New snapshot">
            <div class="cx-modal-head">
              <div class="cx-modal-head-text">
                <div class="cx-modal-title">New Snapshot</div>
                <div class="cx-modal-sub">{snapGuest() ? `${snapGuest()!.name} · #${snapGuest()!.vmid}` : ""}</div>
              </div>
              <button type="button" class="cx-modal-close" disabled={creating()} onClick={requestCloseCreate} aria-label="Close">✕</button>
            </div>
            <div class="cx-modal-body">
              <div class="cx-field" style={{ "margin-bottom": "14px" }}>
                <label class="cx-field-label">Snapshot name</label>
                <input
                  class="cx-input"
                  value={snapName()}
                  onInput={(e) => setSnapName(e.currentTarget.value)}
                  placeholder="e.g. pre-upgrade"
                />
                <Show when={snapName().length > 0 && !snapNameValid()}>
                  <div class="cx-bk-hint warn">Start with a letter; letters, numbers, - and _ only.</div>
                </Show>
              </div>
              <div class="cx-field" style={{ "margin-bottom": "14px" }}>
                <label class="cx-field-label">Description (optional)</label>
                <textarea
                  class="cx-input cx-bk-textarea"
                  value={snapDesc()}
                  onInput={(e) => setSnapDesc(e.currentTarget.value)}
                  placeholder="What's this snapshot for?"
                  rows="3"
                />
              </div>
              <Show when={snapGuest()?.type === "qemu"}>
                <label class="cx-switch" classList={{ disabled: snapGuest()?.status !== "running" }}>
                  <input
                    type="checkbox"
                    checked={snapVmstate()}
                    disabled={snapGuest()?.status !== "running"}
                    onChange={(e) => setSnapVmstate(e.currentTarget.checked)}
                  />
                  <span class="cx-switch-track"><span class="cx-switch-thumb" /></span>
                  <span class="cx-switch-label">Include RAM (memory state)</span>
                </label>
                <div class="cx-bk-hint">
                  {snapGuest()?.status === "running" ? "Captures a resumable memory snapshot." : "Guest is stopped — memory state isn't available."}
                </div>
              </Show>
              <Show when={createErr()}>
                <div class="cx-error-card" style={{ "margin-top": "14px" }}>{createErr()}</div>
              </Show>
            </div>
            <div class="cx-modal-foot">
              <div class="cx-modal-foot-spacer" />
              <button type="button" class="cx-btn cx-btn-ghost" disabled={creating()} onClick={requestCloseCreate}>Cancel</button>
              <button type="button" class="cx-btn cx-btn-primary" disabled={!snapNameValid() || creating()} onClick={submitCreate}>
                <Show when={creating()}><span class="cx-spinner" /></Show>
                {creating() ? "Creating…" : "Create snapshot"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* ================================ Confirm modal =========================== */}
      <Show when={confirm()}>
        {(c) => (
          <div
            class="cx-modal-backdrop"
            classList={{ closing: confirmClosing() }}
            onClick={(e) => { if (e.target === e.currentTarget) closeConfirm() }}
            onKeyDown={(e) => { if (e.key === "Escape") closeConfirm() }}
          >
            <div class="cx-modal cx-bk-modal-sm" classList={{ closing: confirmClosing() }} role="alertdialog" aria-modal="true" aria-label={c().title}>
              <div class="cx-modal-head">
                <div class="cx-modal-head-text">
                  <div class="cx-modal-title" classList={{ "cx-bk-title-danger": c().tone === "danger", "cx-bk-title-warn": c().tone === "warn" }}>
                    {c().title}
                  </div>
                </div>
                <button type="button" class="cx-modal-close" onClick={closeConfirm} aria-label="Close">✕</button>
              </div>
              <div class="cx-modal-body">
                <p class="cx-bk-confirm-message">{c().message}</p>
              </div>
              <div class="cx-modal-foot">
                <div class="cx-modal-foot-spacer" />
                <button type="button" class="cx-btn cx-btn-ghost" onClick={closeConfirm}>Cancel</button>
                <button
                  type="button"
                  classList={{
                    "cx-btn": true,
                    "cx-btn-danger": c().tone === "danger",
                    "cx-btn-warn": c().tone === "warn",
                  }}
                  onClick={() => {
                    const run = c().run
                    closeConfirm()
                    run()
                  }}
                >
                  {c().confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* ================================= Toasts ================================ */}
      <div class="cx-bk-toast-stack">
        <For each={toasts()}>
          {(t) => (
            <div class="cx-bk-toast" classList={{ [t.state]: true }}>
              <span class="cx-bk-toast-icon">
                <Show when={t.state === "pending"} fallback={t.state === "ok" ? "✓" : "✕"}>
                  <span class="cx-spinner" />
                </Show>
              </span>
              <div class="cx-bk-toast-body">
                <div class="cx-bk-toast-label">{t.label}</div>
                <Show when={t.detail}><div class="cx-bk-toast-detail">{t.detail}</div></Show>
              </div>
              <button type="button" class="cx-bk-toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">✕</button>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export default {
  id: "backups",
  label: "Backups",
  icon: "▧",
  section: "PROXMOX",
  order: 15,
  component: BackupsPage,
} satisfies PageDef
