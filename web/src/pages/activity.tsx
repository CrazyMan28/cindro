// ACTIVITY — the audit-log tail. There is no separate "activity.*" verb;
// audit.list IS the event log (see core/include/jarvis/AuditLog.h's AuditRow:
// {id, ts (unix ms), tool, ok, risk, summary, session_id?, remote}), ported
// from cli/jarvis_cli/tui/activity_pane.py's ActivityPane (same fields,
// COLUMNS = time/tool/risk/ok/summary) and daemon/src/ControlServer.cpp's
// handleAuditList (limit param, "entries" newest-first).
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"
import { ArcReactor } from "../components/ArcReactor"

interface AuditEntry {
  id?: number
  ts?: number
  tool?: string
  ok?: boolean
  risk?: string
  summary?: string
  session_id?: string
  remote?: boolean
}

const LIMITS = [25, 50, 100, 250, 500]

function fmtTs(ms: number | undefined): string {
  if (!ms) return "—"
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function riskVar(risk: string | undefined): string {
  switch ((risk ?? "").toLowerCase()) {
    case "high":
      return "var(--danger)"
    case "medium":
      return "var(--amber)"
    case "low":
      return "var(--success)"
    default:
      return "var(--text-faint)"
  }
}

function Activity() {
  const app = useApp()
  const [entries, setEntries] = createSignal<AuditEntry[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [limit, setLimit] = createSignal(100)
  const [filter, setFilter] = createSignal("")
  const [refreshedAt, setRefreshedAt] = createSignal(0)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const load = async () => {
    try {
      const res = await app.client.call("audit.list", { limit: limit() }, 15000)
      if (!alive) return
      setEntries((res.entries ?? []) as AuditEntry[])
      setError("")
      setRefreshedAt(Date.now())
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(load, 12000)
    onCleanup(() => clearInterval(timer))
  })

  const filtered = createMemo(() => {
    const q = filter().trim().toLowerCase()
    const all = entries()
    if (!q) return all
    return all.filter((e) => (e.tool ?? "").toLowerCase().includes(q) || (e.summary ?? "").toLowerCase().includes(q))
  })

  return (
    <div class="act-page page-enter">
      <style>{`
        .act-page { display: flex; flex-direction: column; gap: 16px; max-width: 1100px; }
        .act-hero { display: flex; align-items: center; gap: 14px; background: linear-gradient(135deg, var(--surface) 0%, var(--surface-strong) 100%); border-color: var(--accent-dim); flex-wrap: wrap; }
        .act-icon-badge { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 12px; background: var(--accent-dim); border: 1px solid var(--accent-dim); flex-shrink: 0; }
        .act-hero-text { display: flex; flex-direction: column; gap: 3px; margin-right: auto; }

        .act-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .act-search { flex: 1; min-width: 160px; display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 32px; border-radius: var(--radius-sm); border: 1px solid var(--hairline-soft); background: var(--surface-input); }
        .act-search input { all: unset; flex: 1; color: var(--text); font-size: 12px; }
        .act-search-icon { color: var(--text-faint); font-size: 12px; }
        .act-limit { background: var(--surface-input); border: 1px solid var(--hairline-soft); border-radius: var(--radius-sm); color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; padding: 6px 8px; outline: none; }
        .act-limit:focus { border-color: var(--accent); }
        .act-refresh-btn { all: unset; cursor: pointer; padding: 7px 14px; border-radius: var(--radius-sm); background: transparent; border: 1px solid var(--hairline-soft); color: var(--text-muted); font-family: var(--font-display); font-size: 10px; letter-spacing: var(--track-mid); transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease; }
        .act-refresh-btn:hover { border-color: var(--accent-dim); color: var(--accent); }
        .act-stamp { color: var(--text-faint); font-size: 10px; font-family: var(--font-mono); }

        .act-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 46px 16px; text-align: center; }
        .act-empty-title { font-family: var(--font-display); font-size: 14px; color: var(--accent-bright); letter-spacing: var(--track-mid); }
        .act-empty-body { color: var(--text-faint); font-size: 12px; max-width: 380px; line-height: 1.4; }

        .act-table-wrap { padding: 0; overflow-x: auto; }
        .act-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 720px; }
        .act-table thead th {
          position: sticky; top: 0; text-align: left; padding: 10px 14px; background: var(--surface-strong);
          color: var(--text-faint); font-family: var(--font-display); font-size: 9px; letter-spacing: var(--track-wide);
          border-bottom: 1px solid var(--hairline-soft); white-space: nowrap;
        }
        .act-table tbody td { padding: 9px 14px; border-bottom: 1px solid var(--hairline-faint); vertical-align: top; color: var(--text); }
        .act-table tbody tr:last-child td { border-bottom: none; }
        .act-table tbody tr:hover { background: rgba(255,255,255,0.025); }
        .act-ts { font-family: var(--font-mono); color: var(--text-faint); white-space: nowrap; }
        .act-tool { font-family: var(--font-mono); color: var(--accent); white-space: nowrap; }
        .act-remote-tag { margin-left: 6px; padding: 1px 6px; border-radius: 4px; background: var(--accent-faint); color: var(--accent); font-size: 9px; font-family: var(--font-display); letter-spacing: var(--track-tight); }
        .act-risk-dot { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); text-transform: uppercase; font-size: 10px; }
        .act-risk-dot::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
        .act-outcome { font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
        .act-outcome.ok { color: var(--success); }
        .act-outcome.fail { color: var(--danger); }
        .act-summary { color: var(--text-muted); max-width: 420px; }
        .act-session { font-family: var(--font-mono); color: var(--text-faint); font-size: 10px; white-space: nowrap; }
      `}</style>

      <div class="card act-hero">
        <div class="act-icon-badge">
          <NavIcon glyph="activity" color="var(--accent-bright)" glow />
        </div>
        <div class="act-hero-text">
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>ACTIVITY</div>
          <div style={{ color: "var(--text-muted)", "font-size": "12px" }}>
            The daemon's audit log — every tool/action Cindro has taken, newest first.
          </div>
        </div>
        <div class="act-toolbar">
          <div class="act-search">
            <span class="act-search-icon">⌕</span>
            <input
              type="text"
              placeholder="Filter by tool or summary…"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <select class="act-limit" value={limit()} onChange={(e) => { setLimit(Number(e.currentTarget.value)); void load() }}>
            <For each={LIMITS}>{(n) => <option value={n}>{n} rows</option>}</For>
          </select>
          <button type="button" class="act-refresh-btn" onClick={() => void load()}>REFRESH</button>
        </div>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading() && !error() && entries().length === 0}>
        <div class="card act-empty">
          <ArcReactor size={72} />
          <div class="act-empty-title">NO ACTIVITY YET</div>
          <div class="act-empty-body">
            Once Cindro takes an action — a tool call, a session turn, a scheduled fire — it shows up here.
          </div>
        </div>
      </Show>

      <Show when={entries().length > 0}>
        <div style={{ display: "flex", "justify-content": "flex-end" }}>
          <Show when={refreshedAt()}>
            <span class="act-stamp">updated {new Date(refreshedAt()).toLocaleTimeString()} · {filtered().length}/{entries().length} shown</span>
          </Show>
        </div>
        <div class="card act-table-wrap">
          <table class="act-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Risk</th>
                <th>Outcome</th>
                <th>Session</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              <For each={filtered()}>
                {(e) => (
                  <tr>
                    <td class="act-ts">{fmtTs(e.ts)}</td>
                    <td class="act-tool">
                      {e.tool || "—"}
                      <Show when={e.remote}><span class="act-remote-tag">PHONE</span></Show>
                    </td>
                    <td>
                      <span class="act-risk-dot" style={{ color: riskVar(e.risk) }}>{e.risk || "—"}</span>
                    </td>
                    <td>
                      <span class="act-outcome" classList={{ ok: e.ok !== false, fail: e.ok === false }}>
                        {e.ok !== false ? "✓ OK" : "✗ FAIL"}
                      </span>
                    </td>
                    <td class="act-session">{e.session_id ? e.session_id.slice(0, 10) : "—"}</td>
                    <td class="act-summary">{e.summary || ""}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  )
}

const page: PageDef = { id: "activity", label: "ACTIVITY", section: "MIND", order: 4, component: Activity }
export default page
