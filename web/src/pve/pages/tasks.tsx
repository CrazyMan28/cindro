// Tasks page — two live boards:
//   1. Proxmox's OWN node task log (GET /nodes/<node>/tasks via pve-api.ts,
//      real /api2/json) — backups, migrations, console sessions, everything
//      pveproxy itself tracks, polled + status-colored + skeleton-loaded.
//   2. The Cindro operator's Kanban board (todo/doing/done), driven by
//      proxmoxop.tasks_list/create/update over the daemon socket (the same
//      board Cindro itself can edit from chat).
// Self-registers per router.ts's PageDef contract; zero props — pulls
// client/controller from usePve().

import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"

import * as pve from "../pve-api"
import { usePve } from "../pve-context"
import type { PageDef } from "../router"

// --- Proxmox task-log helpers -----------------------------------------------

type TaskState = "running" | "ok" | "error"

function taskState(t: pve.TaskSummary): TaskState {
  if (t.endtime == null) return "running"
  return String(t.status ?? "").toUpperCase().startsWith("OK") ? "ok" : "error"
}

function taskStatusLabel(t: pve.TaskSummary): string {
  const st = taskState(t)
  if (st === "running") return "running"
  if (st === "ok") return "ok"
  return t.status ? String(t.status) : "error"
}

function relTime(epochSec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - epochSec)
  if (diff < 8) return "just now"
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const GLYPH_BY_SUBSTRING: Array<[string, string]> = [
  ["vzdump", "▤"],
  ["backup", "▤"],
  ["migrate", "⇄"],
  ["clone", "✦"],
  ["create", "✦"],
  ["destroy", "✕"],
  ["remove", "✕"],
  ["delete", "✕"],
  ["shutdown", "■"],
  ["stop", "■"],
  ["start", "▶"],
  ["resume", "▶"],
  ["reboot", "↻"],
  ["suspend", "⏸"],
  ["snapshot", "◆"],
  ["rollback", "◆"],
  ["vncshell", "⌘"],
  ["vncproxy", "⌘"],
  ["termproxy", "⌘"],
  ["download", "⇩"],
  ["upload", "⇧"],
]
function taskGlyph(type: string): string {
  const t = type.toLowerCase()
  for (const [needle, glyph] of GLYPH_BY_SUBSTRING) if (t.includes(needle)) return glyph
  return "•"
}

// Preserve object references for rows whose visible state hasn't changed
// between polls, so <For>'s reference-keyed reconciliation only replays the
// entrance/highlight animation for tasks that are actually new or just
// changed state (e.g. running -> ok) — not the whole list every 6s.
function mergeTasks(prev: pve.TaskSummary[], next: pve.TaskSummary[]): pve.TaskSummary[] {
  const byUpid = new Map(prev.map((t) => [t.upid, t] as const))
  return next.map((t) => {
    const old = byUpid.get(t.upid)
    if (old && old.status === t.status && old.endtime === t.endtime) return old
    return t
  })
}

const LOG_COLS = 7
const SKEL_WIDTHS = ["55%", "78%", "40%", "55%", "50%", "45%", "65%"]

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

// --- Cindro Kanban board helpers --------------------------------------------

type BoardTask = { id: string; title: string; detail?: string; status?: string; [k: string]: unknown }

const BOARD_COLS: Array<{ key: string; label: string }> = [
  { key: "todo", label: "To do" },
  { key: "doing", label: "Doing" },
  { key: "done", label: "Done" },
]

function mergeBoard(prev: BoardTask[], next: BoardTask[]): BoardTask[] {
  const byId = new Map(prev.map((t) => [t.id, t] as const))
  return next.map((t) => {
    const old = byId.get(t.id)
    if (old && old.title === t.title && old.detail === t.detail && old.status === t.status) return old
    return t
  })
}

// --- Page --------------------------------------------------------------------

const TasksPage: Component = () => {
  const { client } = usePve()

  // Live ticker driving relative timestamps + running-task elapsed time —
  // one shared clock instead of each row rendering "N ago" only at fetch time.
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000))
  onMount(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    onCleanup(() => clearInterval(t))
  })

  // --- Proxmox task log ---
  const [nodeList, setNodeList] = createSignal<pve.PveNode[]>([])
  const [node, setNode] = createSignal("")
  const [taskLog, setTaskLog] = createSignal<pve.TaskSummary[]>([])
  const [logLoading, setLogLoading] = createSignal(true)
  const [logErr, setLogErr] = createSignal("")

  const loadNodes = async () => {
    const r = await pve.nodes()
    if (r.ok) {
      setNodeList(r.data)
      if (!node() && r.data.length) setNode(r.data[0].node)
    }
  }

  const loadLog = async () => {
    if (!node()) {
      setLogLoading(false)
      return
    }
    const r = await pve.tasks(node(), { limit: 40 })
    if (r.ok) {
      setLogErr("")
      const sorted = [...r.data].sort((a, b) => b.starttime - a.starttime)
      setTaskLog((prev) => mergeTasks(prev, sorted))
    } else {
      setLogErr(r.error)
    }
    setLogLoading(false)
  }

  const changeNode = (n: string) => {
    if (n === node()) return
    setNode(n)
    setTaskLog([])
    setLogLoading(true)
    void loadLog()
  }

  onMount(async () => {
    await loadNodes()
    await loadLog()
    const t = setInterval(loadLog, 6000)
    onCleanup(() => clearInterval(t))
  })

  // --- Cindro Kanban board ---
  const [board, setBoard] = createSignal<BoardTask[]>([])
  const [title, setTitle] = createSignal("")
  const [adding, setAdding] = createSignal(false)

  const loadBoard = async () => {
    try {
      const r = await client.call<any>("proxmoxop.tasks_list")
      const list: BoardTask[] = Array.isArray(r.tasks) ? r.tasks : []
      setBoard((prev) => mergeBoard(prev, list))
    } catch {
      /* best-effort — keep the last known board on a transient RPC failure */
    }
  }

  onMount(() => {
    void loadBoard()
    const off = client.on("proxmoxop.", () => void loadBoard())
    onCleanup(off)
  })

  const addTask = async () => {
    const t = title().trim()
    if (!t || adding()) return
    setAdding(true)
    try {
      await client.call("proxmoxop.tasks_create", { title: t })
      setTitle("")
      await loadBoard()
    } catch {
      /* leave the title in the composer so the user can retry */
    } finally {
      setAdding(false)
    }
  }

  const moveTask = async (id: string, status: string) => {
    setBoard((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)))
    try {
      await client.call("proxmoxop.tasks_update", { id, status })
    } finally {
      void loadBoard()
    }
  }

  return (
    <div class="cx-page cx-tasks-page cx-fade-in">
      <div class="cx-page-head">
        <div>
          <h1 class="cx-page-title">Tasks</h1>
          <p class="cx-page-sub">
            Proxmox's own job log for what's actually running on the cluster, plus the board Cindro
            keeps for follow-ups you or it jot down.
          </p>
        </div>
      </div>

      {/* --- Proxmox task log --- */}
      <section class="cx-tasks-section">
        <div class="cx-section-head">
          <span class="cx-section-label">Proxmox task log</span>
          <div class="cx-tasks-toolbar">
            <div class="cx-select-wrap cx-tasks-node-select">
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
              class="cx-btn cx-btn-ghost cx-btn-sm"
              onClick={() => {
                setLogLoading(true)
                void loadLog()
              }}
            >
              <span class="cx-refresh-glyph" classList={{ spinning: logLoading() }}>⟳</span>
              Refresh
            </button>
          </div>
        </div>

        <Show when={logErr()}>
          <div class="cx-error-card">{logErr()}</div>
        </Show>

        <div class="cx-card cx-card-flat cx-table-wrap">
          <table class="cx-table">
            <thead>
              <tr>
                <th></th>
                <th>Task</th>
                <th>ID</th>
                <th>User</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <Show when={!logLoading()} fallback={<SkeletonRows rows={6} />}>
                <For
                  each={taskLog()}
                  fallback={
                    <tr>
                      <td colSpan={LOG_COLS}>
                        <div class="cx-empty">No recent tasks on {node() || "this node"}.</div>
                      </td>
                    </tr>
                  }
                >
                  {(t, i) => {
                    const state = taskState(t)
                    return (
                      <tr class="cx-item" style={{ "animation-delay": `${Math.min(i(), 14) * 25}ms` }}>
                        <td class="cx-tasks-glyph">{taskGlyph(t.type)}</td>
                        <td class="cx-tasks-type">{t.type.replace(/_/g, " ")}</td>
                        <td class="cx-tasks-id">{t.id ?? "—"}</td>
                        <td>{t.user}</td>
                        <td title={new Date(t.starttime * 1000).toLocaleString()}>{relTime(t.starttime, now())}</td>
                        <td>
                          {state === "running"
                            ? `${fmtDuration(now() - t.starttime)}…`
                            : t.endtime
                              ? fmtDuration(t.endtime - t.starttime)
                              : "—"}
                        </td>
                        <td>
                          <span class={`cx-pill cx-pill-${state}`}>
                            <Show when={state === "running"}><span class="cx-pill-dot" /></Show>
                            {taskStatusLabel(t)}
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
      </section>

      {/* --- Cindro Kanban board --- */}
      <section class="cx-tasks-section">
        <div class="cx-section-head">
          <span class="cx-section-label">Cindro tasks</span>
        </div>

        <div class="cx-card cx-card-flat cx-tasks-composer">
          <input
            class="cx-input"
            placeholder="Add a follow-up for Cindro…"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addTask()
            }}
          />
          <button
            type="button"
            class="cx-btn cx-btn-primary"
            disabled={!title().trim() || adding()}
            onClick={addTask}
          >
            <Show when={!adding()} fallback={<span class="cx-spinner" />}>Add</Show>
          </button>
        </div>

        <div class="cx-kanban">
          <For each={BOARD_COLS}>
            {(col, i) => (
              <div class="cx-kcol cx-item" style={{ "animation-delay": `${i() * 90}ms` }}>
                <div class="cx-kcol-head">
                  <span>{col.label}</span>
                  <span class="cx-kcol-count">{board().filter((t) => (t.status ?? "todo") === col.key).length}</span>
                </div>
                <div class="cx-kcol-body">
                  <For
                    each={board().filter((t) => (t.status ?? "todo") === col.key)}
                    fallback={<div class="cx-empty cx-kcol-empty">Nothing here</div>}
                  >
                    {(t) => (
                      <div class="cx-kcard cx-item">
                        <div class="cx-kcard-title">{t.title}</div>
                        <Show when={t.detail}><div class="cx-kcard-detail">{t.detail}</div></Show>
                        <div class="cx-kcard-move">
                          <For each={BOARD_COLS.filter((c) => c.key !== (t.status ?? "todo"))}>
                            {(c) => (
                              <button type="button" class="cx-kcard-btn" onClick={() => moveTask(t.id, c.key)}>
                                → {c.label}
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </section>
    </div>
  )
}

export default {
  id: "tasks",
  label: "Tasks",
  icon: "▦",
  section: "PROXMOX",
  order: 20,
  component: TasksPage,
} satisfies PageDef
