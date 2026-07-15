// Storage — per-node datastore usage + a Proxmox storage content browser.
// Every byte on this page comes straight from the real Proxmox REST API via
// pve-api.ts (no jarvisd round-trip): pve.storages(node) for the datastore
// list (capacity/usage/shared/enabled/content types), pve.storageContent(node,
// storage, type) for the file browser (ISOs, CT templates, backups, VM disk
// images, CT volumes, snippets) once a card is selected. Purely read-only —
// there's no destructive action here, so nothing needs to route through the
// operator chat/approval gate the way VM lifecycle actions do.
// Self-registers per router.ts's PageDef contract; zero props.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js"

import * as pve from "../pve-api"
import type { PageDef } from "../router"

const STORAGE_POLL_MS = 8000
const CONTENT_POLL_MS = 10000

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

function fmtAgo(d: Date | null): string {
  if (!d) return "—"
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (s < 3) return "just now"
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

function relTime(epochSec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - epochSec)
  if (diff < 8) return "just now"
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// --- content-type + storage-kind taxonomy -----------------------------------

const CONTENT_TYPES: Array<{ key: string; label: string; icon: string }> = [
  { key: "iso", label: "ISO Images", icon: "◉" },
  { key: "vztmpl", label: "CT Templates", icon: "▥" },
  { key: "backup", label: "Backups", icon: "▤" },
  { key: "images", label: "Disk Images", icon: "▨" },
  { key: "rootdir", label: "CT Volumes", icon: "◫" },
  { key: "snippets", label: "Snippets", icon: "✎" },
]

function contentMeta(key: string): { key: string; label: string; icon: string } {
  return CONTENT_TYPES.find((c) => c.key === key) ?? { key, label: key, icon: "•" }
}

type StorageKind = "local" | "network" | "backup" | "block" | "other"
const LOCAL_TYPES = new Set(["dir", "lvm", "lvmthin", "zfspool", "btrfs"])
const NETWORK_TYPES = new Set(["nfs", "cifs", "glusterfs", "cephfs"])
const BLOCK_TYPES = new Set(["rbd", "iscsi", "iscsidirect", "zfs"])
const BACKUP_TYPES = new Set(["pbs"])

function storageKind(type: string): StorageKind {
  const t = (type || "").toLowerCase()
  if (BACKUP_TYPES.has(t)) return "backup"
  if (NETWORK_TYPES.has(t)) return "network"
  if (BLOCK_TYPES.has(t)) return "block"
  if (LOCAL_TYPES.has(t)) return "local"
  return "other"
}

function splitVolid(volid: string): { name: string; path: string } {
  const idx = volid.indexOf(":")
  const rest = idx >= 0 ? volid.slice(idx + 1) : volid
  const slash = rest.lastIndexOf("/")
  if (slash >= 0) return { name: rest.slice(slash + 1), path: volid }
  return { name: rest, path: "" }
}

// --- row shape -----------------------------------------------------------

type Tone = "ok" | "warn" | "bad"

type StorageRow = {
  storage: string
  type: string
  kind: StorageKind
  active: boolean
  enabled: boolean
  shared: boolean
  used: number
  avail: number
  total: number
  usedPct: number
  tone: Tone
  contentTypes: string[]
}

function buildRow(s: pve.StorageSummary): StorageRow {
  const total = s.total ?? 0
  const used = s.used ?? 0
  const avail = s.avail ?? Math.max(0, total - used)
  const usedPct = total > 0 ? Math.min(1, used / total) : 0
  const tone: Tone = usedPct > 0.9 ? "bad" : usedPct > 0.75 ? "warn" : "ok"
  const declared = String(s.content ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
  const contentTypes = CONTENT_TYPES.filter((ct) => declared.includes(ct.key)).map((ct) => ct.key)
  return {
    storage: s.storage,
    type: s.type,
    kind: storageKind(s.type),
    active: !!s.active,
    enabled: s.enabled !== 0,
    shared: !!s.shared,
    used,
    avail,
    total,
    usedPct,
    tone,
    contentTypes,
  }
}

// --- animated storage card ---------------------------------------------------

const StorageCard: Component<{
  row: StorageRow
  index: number
  selected: boolean
  onSelect: () => void
  onChip: (contentType: string) => void
}> = (props) => {
  const [mounted, setMounted] = createSignal(false)
  onMount(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    onCleanup(() => cancelAnimationFrame(id))
  })
  const width = () => (mounted() ? `${Math.round(props.row.usedPct * 1000) / 10}%` : "0%")

  return (
    <button
      type="button"
      class="cx-storage-card cx-item"
      classList={{ selected: props.selected, offline: !props.row.active }}
      style={{ "animation-delay": `${props.index * 55}ms` }}
      disabled={!props.row.active}
      onClick={props.onSelect}
    >
      <div class="cx-storage-card-head">
        <span class="cx-storage-dot" classList={{ on: props.row.active }} />
        <span class="cx-storage-name" title={props.row.storage}>
          {props.row.storage}
        </span>
        <span class="cx-storage-type-badge" data-kind={props.row.kind}>
          {props.row.type}
        </span>
      </div>

      <Show when={props.row.shared || !props.row.enabled}>
        <div class="cx-storage-card-head" style={{ gap: "6px" }}>
          <Show when={props.row.shared}>
            <span class="cx-storage-shared-pill">shared</span>
          </Show>
          <Show when={!props.row.enabled}>
            <span class="cx-storage-disabled-pill">disabled</span>
          </Show>
        </div>
      </Show>

      <Show
        when={props.row.active}
        fallback={
          <div class="cx-storage-offline-note">
            <span>◇</span> Not active on this node
          </div>
        }
      >
        <div class="cx-storage-meter">
          <div class="cx-storage-meter-track">
            <div class={`cx-storage-meter-fill tone-${props.row.tone}`} style={{ width: width() }} />
          </div>
          <div class="cx-storage-meter-labels">
            <span class={`cx-storage-meter-pct tone-${props.row.tone}`}>{fmtPct(props.row.usedPct)}</span>
            <span>
              {fmtBytes(props.row.used)} / {props.row.total ? fmtBytes(props.row.total) : "—"}
            </span>
          </div>
        </div>

        <Show when={props.row.contentTypes.length > 0}>
          <div class="cx-storage-chips">
            <For each={props.row.contentTypes}>
              {(ct) => {
                const meta = contentMeta(ct)
                return (
                  <span
                    class="cx-storage-chip"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onChip(ct)
                    }}
                  >
                    {meta.icon} {meta.label}
                  </span>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </button>
  )
}

// --- content browser row ------------------------------------------------

const SKEL_WIDTHS = ["50%", "80%", "35%", "45%", "30%", "40%", "55%"]

const ContentSkeletonRows: Component<{ rows: number }> = (props) => (
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

const ContentRow: Component<{ item: pve.StorageContentItem; index: number; now: () => number }> = (props) => {
  const [copied, setCopied] = createSignal(false)
  const meta = () => contentMeta(props.item.content)
  const parsed = () => splitVolid(props.item.volid)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.item.volid)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard unavailable (insecure context / permissions) — no-op */
    }
  }
  return (
    <tr class="cx-item" style={{ "animation-delay": `${Math.min(props.index, 14) * 25}ms` }}>
      <td class="cx-storage-item-glyph">{meta().icon}</td>
      <td>
        <div class="cx-storage-item-name" title={props.item.volid}>
          {parsed().name}
        </div>
        <Show when={parsed().path}>
          <div class="cx-storage-item-path">{parsed().path}</div>
        </Show>
      </td>
      <td>{props.item.format ?? "—"}</td>
      <td>{props.item.size != null ? fmtBytes(props.item.size) : "—"}</td>
      <td>
        <Show when={props.item.vmid} fallback="—">
          <span class="cx-pill">{props.item.vmid}</span>
        </Show>
      </td>
      <td title={props.item.ctime ? new Date(props.item.ctime * 1000).toLocaleString() : undefined}>
        {props.item.ctime ? relTime(props.item.ctime, props.now()) : "—"}
      </td>
      <td>
        <button type="button" class="cx-storage-item-copy" classList={{ copied: copied() }} onClick={copy}>
          {copied() ? "Copied" : "Copy ID"}
        </button>
      </td>
    </tr>
  )
}

// --- page ----------------------------------------------------------------

const StoragePage: Component = () => {
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000))
  onMount(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    onCleanup(() => clearInterval(t))
  })

  const [nodeList, setNodeList] = createSignal<pve.PveNode[]>([])
  const [node, setNode] = createSignal("")
  const [storageList, setStorageList] = createSignal<pve.StorageSummary[]>([])
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [lastSync, setLastSync] = createSignal<Date | null>(null)

  const [selectedStorage, setSelectedStorage] = createSignal("")
  const [activeTab, setActiveTab] = createSignal("all")
  const [contentItems, setContentItems] = createSignal<pve.StorageContentItem[]>([])
  const [contentLoading, setContentLoading] = createSignal(false)
  const [contentErr, setContentErr] = createSignal("")

  const loadNodes = async () => {
    const r = await pve.nodes()
    if (r.ok) {
      setNodeList(r.data)
      if (!node() && r.data.length) setNode(r.data[0].node)
    }
  }

  const loadStorages = async () => {
    if (!node()) {
      setLoading(false)
      setRefreshing(false)
      return
    }
    const r = await pve.storages(node())
    if (r.ok) {
      setErr("")
      setStorageList(r.data)
    } else {
      setErr(r.error)
    }
    setLoading(false)
    setRefreshing(false)
    setLastSync(new Date())
  }

  const refresh = async () => {
    setRefreshing(true)
    await loadStorages()
  }

  const changeNode = (n: string) => {
    if (!n || n === node()) return
    setNode(n)
    setStorageList([])
    setSelectedStorage("")
    setLoading(true)
    void loadStorages()
  }

  onMount(async () => {
    await loadNodes()
    await loadStorages()
    const t = setInterval(loadStorages, STORAGE_POLL_MS)
    onCleanup(() => clearInterval(t))
  })

  // --- content browser: refetch whenever node/storage/tab changes, then
  // poll while a storage stays selected. `cancelled` guards against a
  // stale in-flight response landing after the selection has moved on.
  createEffect(() => {
    const n = node()
    const s = selectedStorage()
    const tab = activeTab()
    if (!s) {
      setContentItems([])
      setContentErr("")
      return
    }
    let cancelled = false
    const run = async () => {
      setContentLoading(true)
      const type = tab === "all" ? undefined : tab
      const r = await pve.storageContent(n, s, type)
      if (cancelled) return
      if (r.ok) {
        setContentErr("")
        setContentItems(
          [...r.data].sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0) || a.volid.localeCompare(b.volid)),
        )
      } else {
        setContentErr(r.error)
        setContentItems([])
      }
      setContentLoading(false)
    }
    void run()
    const t = setInterval(run, CONTENT_POLL_MS)
    onCleanup(() => {
      cancelled = true
      clearInterval(t)
    })
  })

  const rows = createMemo<StorageRow[]>(() =>
    storageList()
      .slice()
      .sort((a, b) => a.storage.localeCompare(b.storage))
      .map(buildRow),
  )

  const selectedRow = createMemo(() => rows().find((r) => r.storage === selectedStorage()) ?? null)

  const toggleCard = (name: string) => {
    if (selectedStorage() === name) {
      setSelectedStorage("")
      return
    }
    setSelectedStorage(name)
    setActiveTab("all")
  }

  const selectChip = (name: string, contentType: string) => {
    setSelectedStorage(name)
    setActiveTab(contentType)
  }

  const summary = createMemo(() => {
    const list = rows()
    const activeList = list.filter((r) => r.active)
    const used = activeList.reduce((s, r) => s + r.used, 0)
    const total = activeList.reduce((s, r) => s + r.total, 0)
    const pct = total > 0 ? used / total : 0
    const tone: Tone = pct > 0.9 ? "bad" : pct > 0.75 ? "warn" : "ok"
    return {
      count: list.length,
      activeCount: activeList.length,
      used,
      total,
      pct,
      tone,
    }
  })

  const tabsFor = (row: StorageRow) => [{ key: "all", label: "All", icon: "▦" }, ...row.contentTypes.map(contentMeta)]

  const tabLabel = (key: string) => (key === "all" ? "items" : contentMeta(key).label.toLowerCase())

  return (
    <div class="cx-page cx-storage-page cx-fade-in">
      <div class="cx-page-head">
        <div>
          <h1 class="cx-page-title">Storage</h1>
          <p class="cx-page-sub">
            Datastores on {node() || "this node"} — live capacity, and a browser for ISOs, container
            templates, backups, and disk images.
          </p>
        </div>
        <div class="cx-storage-toolbar">
          <div class="cx-select-wrap cx-storage-node-select">
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
          <button type="button" class="cx-btn cx-btn-ghost cx-btn-sm" onClick={refresh}>
            <span class="cx-refresh-glyph" classList={{ spinning: refreshing() }}>⟳</span>
            Refresh
          </button>
          <span class="cx-storage-synced">synced {fmtAgo(lastSync())}</span>
        </div>
      </div>

      <Show when={err()}>
        <div class="cx-error-card cx-fade-in">{err()}</div>
      </Show>

      <div class="cx-storage-summary">
        <div class="cx-storage-stat cx-item">
          <div class="cx-storage-stat-value">
            {summary().activeCount}/{summary().count}
          </div>
          <div class="cx-storage-stat-label">Datastores online</div>
        </div>
        <div class="cx-storage-stat cx-item" style={{ "animation-delay": "40ms" }}>
          <div class={`cx-storage-stat-value tone-${summary().tone}`}>
            {summary().total ? fmtPct(summary().pct) : "—"}
          </div>
          <div class="cx-storage-stat-label">Combined usage</div>
        </div>
        <div class="cx-storage-stat cx-item" style={{ "animation-delay": "80ms" }}>
          <div class="cx-storage-stat-value">{fmtBytes(summary().used)}</div>
          <div class="cx-storage-stat-label">Used</div>
        </div>
        <div class="cx-storage-stat cx-item" style={{ "animation-delay": "120ms" }}>
          <div class="cx-storage-stat-value">{fmtBytes(Math.max(0, summary().total - summary().used))}</div>
          <div class="cx-storage-stat-label">Free</div>
        </div>
      </div>

      <div>
        <div class="cx-section-head">
          <span class="cx-section-label">Datastores</span>
        </div>
        <div class="cx-storage-grid">
          <Show
            when={!loading()}
            fallback={
              <For each={[0, 1, 2, 3]}>
                {(i) => <div class="cx-storage-card cx-skel" style={{ "animation-delay": `${i * 70}ms` }} />}
              </For>
            }
          >
            <Show when={rows().length > 0} fallback={<div class="cx-empty">No storages configured on {node() || "this node"}.</div>}>
              <For each={rows()}>
                {(row, i) => (
                  <StorageCard
                    row={row}
                    index={i()}
                    selected={selectedStorage() === row.storage}
                    onSelect={() => toggleCard(row.storage)}
                    onChip={(ct) => selectChip(row.storage, ct)}
                  />
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={selectedRow()}>
        <div class="cx-card cx-card-flat cx-storage-browser cx-fade-in">
          <div class="cx-storage-browser-head">
            <div class="cx-storage-browser-title">
              <b>{selectedRow()!.storage}</b>
              <span>
                {node()} · {fmtBytes(selectedRow()!.used)} / {selectedRow()!.total ? fmtBytes(selectedRow()!.total) : "—"} used
              </span>
            </div>
            <div class="cx-storage-browser-actions">
              <button
                type="button"
                class="cx-btn cx-btn-ghost cx-btn-sm"
                onClick={() => {
                  const n = node()
                  const s = selectedStorage()
                  const tab = activeTab()
                  setContentLoading(true)
                  void pve.storageContent(n, s, tab === "all" ? undefined : tab).then((r) => {
                    if (r.ok) {
                      setContentErr("")
                      setContentItems(
                        [...r.data].sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0) || a.volid.localeCompare(b.volid)),
                      )
                    } else {
                      setContentErr(r.error)
                    }
                    setContentLoading(false)
                  })
                }}
              >
                <span class="cx-refresh-glyph" classList={{ spinning: contentLoading() }}>⟳</span>
                Refresh
              </button>
              <button type="button" class="cx-btn cx-btn-ghost cx-btn-sm" onClick={() => setSelectedStorage("")}>
                ✕ Close
              </button>
            </div>
          </div>

          <div class="cx-storage-tabs">
            <For each={tabsFor(selectedRow()!)}>
              {(t) => (
                <button
                  type="button"
                  class="cx-storage-tab"
                  classList={{ active: activeTab() === t.key }}
                  onClick={() => setActiveTab(t.key)}
                >
                  <span>{t.icon}</span>
                  {t.label}
                  <Show when={activeTab() === t.key}>
                    <span class="cx-storage-tab-count">{contentItems().length}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>

          <Show when={contentErr()}>
            <div class="cx-error-card">{contentErr()}</div>
          </Show>

          <div class="cx-table-wrap">
            <table class="cx-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Format</th>
                  <th>Size</th>
                  <th>Owner</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <Show when={!contentLoading()} fallback={<ContentSkeletonRows rows={4} />}>
                  <For
                    each={contentItems()}
                    fallback={
                      <tr>
                        <td colSpan={7}>
                          <div class="cx-empty">No {tabLabel(activeTab())} on this storage.</div>
                        </td>
                      </tr>
                    }
                  >
                    {(item, i) => <ContentRow item={item} index={i()} now={now} />}
                  </For>
                </Show>
              </tbody>
            </table>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default {
  id: "storage",
  label: "Storage",
  icon: "▬",
  section: "PROXMOX",
  order: 15,
  component: StoragePage,
} satisfies PageDef
