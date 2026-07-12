// SCHEDULES — ported from desktop/qml/SchedulesPage.qml's intent (list the
// daemon's cron jobs, compose a new one, enable/disable + run-now + remove)
// using the confirmed Contract A verbs: schedule.list/create/set_enabled/
// run_now/remove. Field shapes (id, name, cron, prompt, brain, model,
// profile, enabled, next_run, last_run, created — next/last_run are unix ms,
// 0 => unset) are taken 1:1 from core/include/jarvis/Scheduler.h's
// ScheduleRow::toJson() and daemon/src/ControlServer.cpp's
// handleScheduleCreate (cron accepts "0 9 * * *" / "every 15m" / "at 09:00").
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"
import { ArcReactor } from "../components/ArcReactor"

interface ScheduleRow {
  id: string
  name?: string
  cron?: string
  prompt?: string
  brain?: string
  model?: string
  profile?: string
  enabled?: boolean
  next_run?: number
  last_run?: number
  created?: number
}

function fmtRel(ms: number | undefined): string {
  if (!ms) return "—"
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  if (mins < 1) return diff >= 0 ? "due now" : "just now"
  if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return diff >= 0 ? `in ${hrs}h` : `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return diff >= 0 ? `in ${days}d` : `${days}d ago`
}

function fmtAbs(ms: number | undefined): string {
  if (!ms) return "never"
  return new Date(ms).toLocaleString()
}

function Schedules() {
  const app = useApp()
  const [rows, setRows] = createSignal<ScheduleRow[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [busyIds, setBusyIds] = createSignal<Set<string>>(new Set())

  const [composing, setComposing] = createSignal(false)
  const [name, setName] = createSignal("")
  const [cron, setCron] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [brain, setBrain] = createSignal("api")
  const [model, setModel] = createSignal("")
  const [brainOptions, setBrainOptions] = createSignal<string[]>(["api"])
  const [creating, setCreating] = createSignal(false)
  const [createError, setCreateError] = createSignal("")

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((s) => new Set(s).add(id))
    try {
      await fn()
    } finally {
      if (alive) setBusyIds((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }

  const load = async () => {
    try {
      const res = await app.client.call("schedule.list", {}, 15000)
      if (!alive) return
      setRows((res.schedules ?? []) as ScheduleRow[])
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  const loadBrains = async () => {
    try {
      const res = await app.client.call("settings.get", {}, 15000)
      if (!alive) return
      const avail = (res.available_brains ?? {}) as Record<string, boolean>
      const opts = Object.keys(avail).filter((k) => avail[k])
      if (!opts.includes("api")) opts.push("api")
      if (opts.length) {
        setBrainOptions(opts)
        setBrain(opts[0])
      }
    } catch {
      // settings.get is best-effort here — the "api" fallback still works
    }
  }

  onMount(() => {
    void load()
    void loadBrains()
    const timer = setInterval(load, 20000)
    onCleanup(() => clearInterval(timer))
  })

  const canCreate = createMemo(() => cron().trim().length > 0 && prompt().trim().length > 0)

  const create = async () => {
    if (!canCreate() || creating()) return
    setCreating(true)
    setCreateError("")
    try {
      const params: Record<string, unknown> = {
        name: name().trim(),
        cron: cron().trim(),
        prompt: prompt().trim(),
        brain: brain(),
        enabled: true,
      }
      if (model().trim()) params.model = model().trim()
      await app.client.call("schedule.create", params, 15000)
      setName("")
      setCron("")
      setPrompt("")
      setModel("")
      setComposing(false)
      app.notify("Schedule created.", "info")
      await load()
    } catch (e) {
      setCreateError(String(e))
    } finally {
      if (alive) setCreating(false)
    }
  }

  const toggleEnabled = (row: ScheduleRow) =>
    withBusy(row.id, async () => {
      try {
        await app.client.call("schedule.set_enabled", { id: row.id, enabled: !row.enabled }, 15000)
        await load()
      } catch (e) {
        app.notify(String(e), "error")
      }
    })

  const runNow = (row: ScheduleRow) =>
    withBusy(row.id, async () => {
      try {
        const res = await app.client.call("schedule.run_now", { id: row.id }, 20000)
        const sid = (res.session_id as string) ?? ""
        app.notify(`Fired "${row.name || row.id}"${sid ? ` — session ${sid}` : ""}`, "info")
        await load()
      } catch (e) {
        app.notify(String(e), "error")
      }
    })

  const remove = (row: ScheduleRow) => {
    if (!window.confirm(`Remove schedule "${row.name || row.id}"? This cannot be undone.`)) return
    void withBusy(row.id, async () => {
      try {
        await app.client.call("schedule.remove", { id: row.id }, 15000)
        app.notify("Schedule removed.", "info")
        await load()
      } catch (e) {
        app.notify(String(e), "error")
      }
    })
  }

  return (
    <div class="sched-page page-enter">
      <style>{`
        .sched-page { display: flex; flex-direction: column; gap: 16px; max-width: 980px; }
        .sched-hero { display: flex; align-items: center; gap: 14px; background: linear-gradient(135deg, var(--surface) 0%, var(--surface-strong) 100%); border-color: var(--accent-dim); }
        .sched-icon-badge { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 12px; background: var(--accent-dim); border: 1px solid var(--accent-dim); flex-shrink: 0; }
        .sched-hero-text { display: flex; flex-direction: column; gap: 3px; }
        .sched-new-btn { all: unset; cursor: pointer; margin-left: auto; padding: 9px 16px; border-radius: var(--radius-sm); background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim); font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid); transition: background var(--dur-fast) ease, transform var(--dur-fast) ease; }
        .sched-new-btn:hover { background: var(--accent-faint); transform: translateY(-1px); }
        .sched-new-btn.active { background: var(--surface-input); color: var(--text-muted); border-color: var(--hairline-soft); }

        .sched-composer { display: flex; flex-direction: column; gap: 12px; border-color: var(--accent-dim); }
        .sched-composer-title { font-size: 11px; color: var(--accent); letter-spacing: var(--track-mid); }
        .sched-field-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .sched-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 160px; }
        .sched-field label { font-family: var(--font-display); font-size: 9px; color: var(--text-faint); letter-spacing: var(--track-wide); }
        .sched-field input, .sched-field select, .sched-field textarea {
          background: var(--surface-input); border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
          color: var(--text); padding: 8px 10px; font-family: var(--font-sans); font-size: 13px; outline: none;
          transition: border-color var(--dur-fast) ease;
        }
        .sched-field textarea { font-family: var(--font-sans); resize: vertical; min-height: 70px; }
        .sched-field input:focus, .sched-field select:focus, .sched-field textarea:focus { border-color: var(--accent); }
        .sched-field small { color: var(--text-faint); font-size: 10px; }
        .sched-composer-actions { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
        .sched-btn { all: unset; cursor: pointer; padding: 8px 16px; border-radius: var(--radius-sm); font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid); transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease, transform var(--dur-fast) ease; }
        .sched-btn.primary { background: var(--accent); color: var(--ink-on-accent); }
        .sched-btn.primary:hover { background: var(--accent-bright); }
        .sched-btn.primary:disabled { opacity: 0.4; cursor: default; }
        .sched-btn.ghost { background: transparent; border: 1px solid var(--hairline-soft); color: var(--text-muted); }
        .sched-btn.ghost:hover { border-color: var(--accent-dim); color: var(--text); }
        .sched-btn.danger { background: transparent; border: 1px solid var(--danger-dim); color: var(--danger); }
        .sched-btn.danger:hover { background: var(--danger-dim); }
        .sched-btn.sm { padding: 5px 11px; font-size: 10px; }
        .sched-btn:disabled { opacity: 0.4; cursor: default; }

        .sched-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 46px 16px; text-align: center; }
        .sched-empty-title { font-family: var(--font-display); font-size: 14px; color: var(--accent-bright); letter-spacing: var(--track-mid); }
        .sched-empty-body { color: var(--text-faint); font-size: 12px; max-width: 380px; line-height: 1.4; }

        .sched-list { display: flex; flex-direction: column; gap: 9px; }
        .sched-row { position: relative; display: flex; align-items: center; gap: 12px; padding: 12px 14px 12px 18px; border-radius: var(--radius); background: var(--panel-soft); border: 1px solid var(--hairline-soft); transition: border-color var(--dur-fast) ease, opacity var(--dur-fast) ease; }
        .sched-row:hover { border-color: var(--accent-dim); }
        .sched-row.disabled { opacity: 0.6; }
        .sched-row-bar { position: absolute; left: 4px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--accent); opacity: 0.85; }
        .sched-row.disabled .sched-row-bar { background: var(--text-faint); }
        .sched-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
        .sched-row-title { font-size: 14px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sched-row-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .sched-cron-chip { padding: 2px 8px; border-radius: 5px; border: 1px solid var(--accent-dim); color: var(--accent); font-family: var(--font-mono); font-size: 10px; }
        .sched-time { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
        .sched-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

        .sched-switch { position: relative; display: inline-flex; width: 34px; height: 19px; flex-shrink: 0; cursor: pointer; }
        .sched-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
        .sched-switch-track { position: absolute; inset: 0; border-radius: 999px; background: var(--surface-input); border: 1px solid var(--hairline-soft); transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease; }
        .sched-switch-thumb { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--text-faint); transition: transform var(--dur-fast) ease, background var(--dur-fast) ease; }
        .sched-switch input:checked + .sched-switch-track { background: var(--accent-dim); border-color: var(--accent); }
        .sched-switch input:checked + .sched-switch-track + .sched-switch-thumb { transform: translateX(15px); background: var(--accent-bright); }
        .sched-switch input:disabled { cursor: default; }
      `}</style>

      <div class="card sched-hero">
        <div class="sched-icon-badge">
          <NavIcon glyph="schedules" color="var(--accent-bright)" glow />
        </div>
        <div class="sched-hero-text">
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>SCHEDULES</div>
          <div style={{ color: "var(--text-muted)", "font-size": "12px" }}>
            Cron-driven jobs the daemon fires as new sessions — set a cadence and a prompt.
          </div>
        </div>
        <button
          type="button"
          class="sched-new-btn"
          classList={{ active: composing() }}
          onClick={() => setComposing((v) => !v)}
        >
          {composing() ? "CLOSE" : "+ NEW"}
        </button>
      </div>

      <Show when={composing()}>
        <div class="card sched-composer">
          <div class="sched-composer-title">// NEW SCHEDULE</div>
          <div class="sched-field-row">
            <div class="sched-field">
              <label>NAME</label>
              <input
                type="text"
                placeholder="e.g. Morning briefing"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </div>
            <div class="sched-field">
              <label>CRON / CADENCE</label>
              <input
                type="text"
                placeholder="0 9 * * *  ·  every 15m  ·  at 09:00"
                value={cron()}
                onInput={(e) => setCron(e.currentTarget.value)}
              />
            </div>
          </div>
          <div class="sched-field">
            <label>PROMPT</label>
            <textarea
              placeholder="Prompt to run on each fire…"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
            />
          </div>
          <div class="sched-field-row">
            <div class="sched-field" style={{ flex: "0 0 160px" }}>
              <label>BRAIN</label>
              <select value={brain()} onChange={(e) => setBrain(e.currentTarget.value)}>
                <For each={brainOptions()}>{(b) => <option value={b}>{b}</option>}</For>
              </select>
            </div>
            <div class="sched-field">
              <label>MODEL (optional)</label>
              <input
                type="text"
                placeholder="default"
                value={model()}
                onInput={(e) => setModel(e.currentTarget.value)}
              />
            </div>
          </div>
          <Show when={createError()}>
            <div class="setup-error">⚠ {createError()}</div>
          </Show>
          <div class="sched-composer-actions">
            <button type="button" class="sched-btn ghost" onClick={() => setComposing(false)}>Cancel</button>
            <button type="button" class="sched-btn primary" disabled={!canCreate() || creating()} onClick={() => void create()}>
              {creating() ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading() && !error() && rows().length === 0}>
        <div class="card sched-empty">
          <ArcReactor size={72} />
          <div class="sched-empty-title">NO SCHEDULES</div>
          <div class="sched-empty-body">
            Create a cron job and Cindro will spin up a session and run your prompt on cadence.
          </div>
        </div>
      </Show>

      <Show when={rows().length > 0}>
        <div class="sched-list">
          <For each={rows()}>
            {(row) => {
              const busy = () => busyIds().has(row.id)
              return (
                <div class="sched-row" classList={{ disabled: !row.enabled }}>
                  <div class="sched-row-bar" />
                  <div class="sched-row-main">
                    <div class="sched-row-title">{row.name || "(unnamed)"}</div>
                    <div class="sched-row-meta">
                      <span class="sched-cron-chip">{row.cron || "—"}</span>
                      <span class="sched-time" title={fmtAbs(row.next_run)}>next {fmtRel(row.next_run)}</span>
                      <Show when={row.last_run}>
                        <span class="sched-time" title={fmtAbs(row.last_run)}>last {fmtRel(row.last_run)}</span>
                      </Show>
                    </div>
                  </div>
                  <div class="sched-row-actions">
                    <button type="button" class="sched-btn ghost sm" disabled={busy()} onClick={() => void runNow(row)}>
                      Run
                    </button>
                    <label class="sched-switch" title={row.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}>
                      <input
                        type="checkbox"
                        checked={!!row.enabled}
                        disabled={busy()}
                        onChange={() => void toggleEnabled(row)}
                      />
                      <span class="sched-switch-track" />
                      <span class="sched-switch-thumb" />
                    </label>
                    <button type="button" class="sched-btn danger sm" disabled={busy()} onClick={() => remove(row)}>
                      Remove
                    </button>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

const page: PageDef = { id: "schedules", label: "SCHEDULES", section: "MIND", order: 3, component: Schedules }
export default page
