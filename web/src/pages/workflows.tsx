// WORKFLOWS — named, manageable scheduled/webhook-triggered jobs. Built on the
// same schedule.* Contract-A verbs schedules.tsx already uses (this page is
// NOT a new backend surface — it's schedules.tsx's data filtered down to the
// rows that carry workflow-shaped extensions: a `target`, a `report_thread`,
// or a "webhook" trigger). A plain vanilla cron/interval schedule with none of
// those stays exclusively on the Schedules page. See core/include/jarvis/
// Scheduler.h's ScheduleRow (targetRef/reportThread/webhookToken) and
// computer-use/computer_use_mcp/tools_workflows.py (the MCP-facing wrapper:
// workflow_create/list/update/delete).
//
// `id` is "workflows" — NOT in desktop/qml/NavRail.qml's canonical list (the
// native GUI doesn't have this page yet), so per router.ts's PageDef.id
// convention this is a GUI-only extra. Unlike browser.tsx's order:999 (which
// shoves it to the very end of its section), this uses a fractional order
// (right after schedules' order:3, before activity's order:4) so it reads
// next to the page it is most conceptually attached to without renumbering
// any of the other canonical MIND-section pages.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"
import { ArcReactor } from "../components/ArcReactor"

interface WorkflowRow {
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
  target?: string
  report_thread?: string
}

type TriggerType = "cron" | "interval" | "daily" | "webhook"

const DEFAULT_REPORT_THREAD = "Workflows"

// Exact template from the "monitor a condition" usage pattern this codebase
// already relies on (see tools_workflows.py's module docstring): a
// tight-cadence workflow whose prompt recalls last-known agent-scoped state,
// compares, and only escalates/fixes on a change. The bracketed placeholders
// are meant to be edited in place, right in the textarea.
const MONITOR_PRESET_PROMPT =
  "Run <CHECK COMMAND> on <TARGET>. Recall the last known state (agent=<TARGET>) " +
  "and compare — if it changed from healthy/OK, attempt an obvious fix (e.g. " +
  "restart the affected service) and/or escalate to my inbox with details; " +
  "otherwise just remember the current state and stay quiet."
const MONITOR_PRESET_INTERVAL_N = "10"
const MONITOR_PRESET_INTERVAL_UNIT = "m"

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

function isWebhookCron(cron: string | undefined): boolean {
  return (cron ?? "").trim().toLowerCase() === "webhook"
}

// A row counts as a Workflow (vs. a plain schedule) iff it carries at least
// one workflow-only extension: a target ref, a report thread, or a webhook
// trigger. Mirrors ScheduleRow::toJson()'s "target"/"report_thread" keys
// (core/src/Scheduler.cpp) — both are omitted entirely when empty, so a
// truthy check here is exactly right.
function isWorkflowShaped(r: WorkflowRow): boolean {
  return Boolean(r.target) || Boolean(r.report_thread) || isWebhookCron(r.cron)
}

function fmtTrigger(cron: string | undefined): string {
  const c = (cron ?? "").trim()
  if (!c) return "—"
  return isWebhookCron(c) ? "Webhook" : c
}

// Mints a URL-safe random bearer client-side (32 bytes, base64url, no
// padding) — the same shape secrets.token_urlsafe(32) produces in
// tools_workflows.py's workflow_create. The web dashboard is desktop-trust-
// tier, so generating the secret in-browser and handing it straight to
// schedule.create's `token` param (stored verbatim, never re-derivable) is
// fine here.
function mintWebhookToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let bin = ""
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

interface EditState {
  name: string
  triggerText: string
  prompt: string
  brain: string
  model: string
  target: string
  reportThread: string
}

function toEditState(row: WorkflowRow): EditState {
  return {
    name: row.name ?? "",
    triggerText: row.cron ?? "",
    prompt: row.prompt ?? "",
    brain: row.brain ?? "",
    model: row.model ?? "",
    target: row.target ?? "",
    reportThread: row.report_thread ?? "",
  }
}

function Workflows() {
  const app = useApp()
  const [rows, setRows] = createSignal<WorkflowRow[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [busyIds, setBusyIds] = createSignal<Set<string>>(new Set())

  // --- webhook reveal (click-to-reveal, not rendered by default) ----------
  const [revealed, setRevealed] = createSignal<Record<string, { token: string; enabled: boolean }>>({})
  const [revealing, setRevealing] = createSignal("")

  // --- inline edit panel ---------------------------------------------------
  const [editingId, setEditingId] = createSignal("")
  const [edit, setEdit] = createSignal<EditState | null>(null)
  const [savingEdit, setSavingEdit] = createSignal(false)
  const [editError, setEditError] = createSignal("")
  // The trigger text as it was WHEN THE EDIT PANEL OPENED (not re-derived from
  // `edit()`, which mutates as the user types). saveEdit() only sends `cron`
  // to schedule.update when the current trigger text differs from this — see
  // saveEdit's comment for why: unconditionally resending an unchanged
  // trigger makes handleScheduleUpdate/Scheduler::update() re-parse + recompute
  // next_run from now(), silently delaying an interval workflow's next fire by
  // up to a full interval on every unrelated edit (e.g. a rename).
  const [editOriginalTrigger, setEditOriginalTrigger] = createSignal("")

  // --- create composer -------------------------------------------------------
  const [composing, setComposing] = createSignal(false)
  const [name, setName] = createSignal("")
  const [triggerType, setTriggerType] = createSignal<TriggerType>("interval")
  const [cronText, setCronText] = createSignal("")
  const [intervalN, setIntervalN] = createSignal("15")
  const [intervalUnit, setIntervalUnit] = createSignal("m")
  const [dailyTime, setDailyTime] = createSignal("09:00")
  const [prompt, setPrompt] = createSignal("")
  const [brain, setBrain] = createSignal("api")
  const [model, setModel] = createSignal("")
  const [target, setTarget] = createSignal("")
  const [reportThread, setReportThread] = createSignal("")
  const [brainOptions, setBrainOptions] = createSignal<string[]>(["codex", "claude", "api"])
  const [creating, setCreating] = createSignal(false)
  const [createError, setCreateError] = createSignal("")
  const [justCreatedWebhook, setJustCreatedWebhook] = createSignal<{ id: string; token: string } | null>(null)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyIds((s) => new Set(s).add(id))
    try {
      await fn()
    } finally {
      if (alive)
        setBusyIds((s) => {
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
      setRows((res.schedules ?? []) as WorkflowRow[])
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
      // settings.get is best-effort here — the codex/claude/api fallback still works
    }
  }

  onMount(() => {
    void load()
    void loadBrains()
    const timer = setInterval(load, 20000)
    onCleanup(() => clearInterval(timer))
  })

  const workflows = createMemo(() => rows().filter(isWorkflowShaped))

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      app.notify(`${label} copied.`, "info")
    } catch {
      app.notify("Copy failed — select and copy manually.", "warn")
    }
  }

  // --- row actions -----------------------------------------------------------

  const toggleEnabled = (row: WorkflowRow) =>
    withBusy(row.id, async () => {
      try {
        await app.client.call("schedule.set_enabled", { id: row.id, enabled: !row.enabled }, 15000)
        await load()
      } catch (e) {
        app.notify(String(e), "error")
      }
    })

  const runNow = (row: WorkflowRow) =>
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

  const remove = (row: WorkflowRow) => {
    if (!window.confirm(`Delete workflow "${row.name || row.id}"? This cannot be undone.`)) return
    void withBusy(row.id, async () => {
      try {
        await app.client.call("schedule.remove", { id: row.id }, 15000)
        setRevealed((prev) => {
          const next = { ...prev }
          delete next[row.id]
          return next
        })
        app.notify("Workflow deleted.", "info")
        await load()
      } catch (e) {
        app.notify(String(e), "error")
      }
    })
  }

  const revealWebhook = (row: WorkflowRow) =>
    withBusy(row.id, async () => {
      setRevealing(row.id)
      try {
        const res = await app.client.call("schedule.webhook_token", { id: row.id }, 15000)
        if (!alive) return
        setRevealed((prev) => ({
          ...prev,
          [row.id]: { token: String(res.token ?? ""), enabled: Boolean(res.enabled) },
        }))
      } catch (e) {
        app.notify(String(e), "error")
      } finally {
        if (alive) setRevealing("")
      }
    })

  const hideWebhook = (id: string) =>
    setRevealed((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })

  // --- inline edit -------------------------------------------------------------

  const startEdit = (row: WorkflowRow) => {
    setEditError("")
    setEditingId(row.id)
    setEdit(toEditState(row))
    setEditOriginalTrigger((row.cron ?? "").trim())
  }

  const cancelEdit = () => {
    setEditingId("")
    setEdit(null)
    setEditError("")
    setEditOriginalTrigger("")
  }

  const saveEdit = (id: string) =>
    withBusy(id, async () => {
      const e = edit()
      if (!e) return
      if (!e.triggerText.trim() || !e.prompt.trim()) {
        setEditError("Trigger and prompt are required.")
        return
      }
      setSavingEdit(true)
      setEditError("")
      try {
        const params: Record<string, unknown> = {
          id,
          name: e.name.trim(),
          prompt: e.prompt.trim(),
          brain: e.brain,
          model: e.model.trim(),
          target: e.target.trim(),
          // Unlike the CREATE composer (which forces the "Workflows"
          // default on a blank field, matching workflow_create's own
          // behavior for a brand new row), an explicit blank here is sent
          // AS-IS: ControlServer::fireScheduledJob treats an empty
          // reportThread as "post no completion report", and this is the
          // only UI path that can deliberately turn that off once a report
          // thread has ever been set.
          report_thread: e.reportThread.trim(),
        }
        // Only send `cron` when the trigger text actually changed from what
        // it was when the edit panel opened. handleScheduleUpdate treats ANY
        // non-empty cron/when as "the caller wants to change this" and
        // Scheduler::update() then re-parses it and recomputes next_run from
        // now() — for an interval trigger (the default and what the "Monitor
        // a condition" preset uses) that discards whatever time was actually
        // left until the next fire. Omitting the key entirely (matching
        // handleScheduleUpdate's "omitted key = don't touch this field"
        // convention already used for the other optional fields here) leaves
        // next_run untouched when the user only edited something else.
        const trigger = e.triggerText.trim()
        if (trigger !== editOriginalTrigger()) params.cron = trigger
        await app.client.call("schedule.update", params, 15000)
        app.notify("Workflow updated.", "info")
        cancelEdit()
        await load()
      } catch (e2) {
        setEditError(String(e2))
      } finally {
        if (alive) setSavingEdit(false)
      }
    })

  // --- create composer ---------------------------------------------------------

  const computeTrigger = (): string => {
    switch (triggerType()) {
      case "cron":
        return cronText().trim()
      case "interval": {
        const n = intervalN().trim()
        return n ? `every ${n}${intervalUnit()}` : ""
      }
      case "daily":
        return dailyTime() ? `at ${dailyTime()}` : ""
      case "webhook":
        return "webhook"
      default:
        return ""
    }
  }

  const canCreate = createMemo(() => computeTrigger().length > 0 && prompt().trim().length > 0)

  const applyMonitorPreset = () => {
    setComposing(true)
    setTriggerType("interval")
    setIntervalN(MONITOR_PRESET_INTERVAL_N)
    setIntervalUnit(MONITOR_PRESET_INTERVAL_UNIT)
    setPrompt(MONITOR_PRESET_PROMPT)
    if (!name().trim()) setName("Condition monitor")
    if (!reportThread().trim()) setReportThread(DEFAULT_REPORT_THREAD)
    app.notify(
      "Preset applied — edit <CHECK COMMAND> and <TARGET> in the prompt below, and fill in Target.",
      "info",
    )
  }

  const create = async () => {
    if (!canCreate() || creating()) return
    setCreating(true)
    setCreateError("")
    setJustCreatedWebhook(null)
    const isWebhook = triggerType() === "webhook"
    const token = isWebhook ? mintWebhookToken() : ""
    try {
      const params: Record<string, unknown> = {
        name: name().trim(),
        cron: computeTrigger(),
        prompt: prompt().trim(),
        brain: brain(),
        enabled: true,
        target: target().trim(),
        report_thread: reportThread().trim() || DEFAULT_REPORT_THREAD,
      }
      if (model().trim()) params.model = model().trim()
      if (isWebhook) params.token = token
      const res = await app.client.call("schedule.create", params, 15000)
      const newId = String(res.id ?? "")
      setName("")
      setCronText("")
      setIntervalN("15")
      setIntervalUnit("m")
      setDailyTime("09:00")
      setPrompt("")
      setModel("")
      setTarget("")
      setReportThread("")
      setTriggerType("interval")
      setComposing(false)
      app.notify("Workflow created.", "info")
      if (isWebhook && newId) setJustCreatedWebhook({ id: newId, token })
      await load()
    } catch (e) {
      setCreateError(String(e))
    } finally {
      if (alive) setCreating(false)
    }
  }

  return (
    <div class="wf-page page-enter">
      <style>{`
        .wf-page { display: flex; flex-direction: column; gap: 16px; max-width: 980px; }
        .wf-hero { display: flex; align-items: center; gap: 14px; background: linear-gradient(135deg, var(--surface) 0%, var(--surface-strong) 100%); border-color: var(--accent-dim); }
        .wf-icon-badge { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 12px; background: var(--accent-dim); border: 1px solid var(--accent-dim); flex-shrink: 0; }
        .wf-hero-text { display: flex; flex-direction: column; gap: 3px; }
        .wf-hero-actions { margin-left: auto; display: flex; gap: 8px; }
        .wf-new-btn { all: unset; cursor: pointer; padding: 9px 16px; border-radius: var(--radius-sm); background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim); font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid); transition: background var(--dur-fast) ease, transform var(--dur-fast) ease; white-space: nowrap; }
        .wf-new-btn:hover { background: var(--accent-faint); transform: translateY(-1px); }
        .wf-new-btn.active { background: var(--surface-input); color: var(--text-muted); border-color: var(--hairline-soft); }
        .wf-new-btn.preset { background: var(--amber-dim, var(--accent-dim)); color: var(--amber, var(--accent-bright)); border-color: var(--amber-dim, var(--accent-dim)); }

        .wf-composer { display: flex; flex-direction: column; gap: 12px; border-color: var(--accent-dim); }
        .wf-composer-title { font-size: 11px; color: var(--accent); letter-spacing: var(--track-mid); }
        .wf-field-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .wf-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 160px; }
        .wf-field label { font-family: var(--font-display); font-size: 9px; color: var(--text-faint); letter-spacing: var(--track-wide); }
        .wf-field input, .wf-field select, .wf-field textarea {
          background: var(--surface-input); border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
          color: var(--text); padding: 8px 10px; font-family: var(--font-sans); font-size: 13px; outline: none;
          transition: border-color var(--dur-fast) ease;
        }
        .wf-field textarea { font-family: var(--font-mono); resize: vertical; min-height: 90px; }
        .wf-field input:focus, .wf-field select:focus, .wf-field textarea:focus { border-color: var(--accent); }
        .wf-field small { color: var(--text-faint); font-size: 10px; }
        .wf-composer-actions { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
        .wf-btn { all: unset; cursor: pointer; padding: 8px 16px; border-radius: var(--radius-sm); font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid); transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease, transform var(--dur-fast) ease; }
        .wf-btn.primary { background: var(--accent); color: var(--ink-on-accent); }
        .wf-btn.primary:hover:not(:disabled) { background: var(--accent-bright); }
        .wf-btn.primary:disabled { opacity: 0.4; cursor: default; }
        .wf-btn.ghost { background: transparent; border: 1px solid var(--hairline-soft); color: var(--text-muted); }
        .wf-btn.ghost:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
        .wf-btn.danger { background: transparent; border: 1px solid var(--danger-dim); color: var(--danger); }
        .wf-btn.danger:hover:not(:disabled) { background: var(--danger-dim); }
        .wf-btn.sm { padding: 5px 11px; font-size: 10px; }
        .wf-btn:disabled { opacity: 0.4; cursor: default; }

        .wf-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 46px 16px; text-align: center; }
        .wf-empty-title { font-family: var(--font-display); font-size: 14px; color: var(--accent-bright); letter-spacing: var(--track-mid); }
        .wf-empty-body { color: var(--text-faint); font-size: 12px; max-width: 420px; line-height: 1.4; }

        .wf-list { display: flex; flex-direction: column; gap: 9px; }
        .wf-row { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 12px 18px; border-radius: var(--radius); background: var(--panel-soft); border: 1px solid var(--hairline-soft); transition: border-color var(--dur-fast) ease, opacity var(--dur-fast) ease; }
        .wf-row:hover { border-color: var(--accent-dim); }
        .wf-row.disabled { opacity: 0.6; }
        .wf-row-bar { position: absolute; left: 4px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--accent); opacity: 0.85; }
        .wf-row.disabled .wf-row-bar { background: var(--text-faint); }
        .wf-row-top { display: flex; align-items: center; gap: 12px; }
        .wf-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
        .wf-row-title { font-size: 14px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .wf-row-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .wf-chip { padding: 2px 8px; border-radius: 5px; border: 1px solid var(--accent-dim); color: var(--accent); font-family: var(--font-mono); font-size: 10px; }
        .wf-chip.muted { border-color: var(--hairline-soft); color: var(--text-faint); }
        .wf-time { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
        .wf-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }

        .wf-switch { position: relative; display: inline-flex; width: 34px; height: 19px; flex-shrink: 0; cursor: pointer; }
        .wf-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
        .wf-switch-track { position: absolute; inset: 0; border-radius: 999px; background: var(--surface-input); border: 1px solid var(--hairline-soft); transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease; }
        .wf-switch-thumb { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--text-faint); transition: transform var(--dur-fast) ease, background var(--dur-fast) ease; }
        .wf-switch input:checked + .wf-switch-track { background: var(--accent-dim); border-color: var(--accent); }
        .wf-switch input:checked + .wf-switch-track + .wf-switch-thumb { transform: translateX(15px); background: var(--accent-bright); }
        .wf-switch input:disabled { cursor: default; }

        .wf-edit-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: var(--radius-sm); background: var(--surface-deep); border: 1px solid var(--accent-dim); }
        .wf-webhook-panel { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-deep); border: 1px solid var(--amber-dim, var(--accent-dim)); }
        .wf-webhook-row { display: flex; align-items: center; gap: 8px; }
        .wf-webhook-label { font-family: var(--font-display); font-size: 9px; color: var(--text-faint); letter-spacing: var(--track-wide); width: 46px; flex-shrink: 0; }
        .wf-webhook-value { flex: 1; min-width: 0; background: var(--surface-input); border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs); padding: 6px 9px; font-family: var(--font-mono); font-size: 11px; color: var(--accent-bright); overflow-x: auto; white-space: nowrap; }
        .wf-webhook-hint { color: var(--text-faint); font-size: 10px; line-height: 1.4; }
        .wf-webhook-hint code { font-family: var(--font-mono); color: var(--text-muted); }

        .setup-error { color: var(--danger); font-size: 12px; border: 1px solid var(--danger-dim); background: rgba(255,107,107,0.06); border-radius: var(--radius-xs); padding: 8px 10px; }
        .wf-convert-warning { color: var(--amber, var(--accent-bright)); font-size: 12px; line-height: 1.4; border: 1px solid var(--amber-dim, var(--accent-dim)); background: rgba(255,193,7,0.08); border-radius: var(--radius-xs); padding: 8px 10px; }
      `}</style>

      <div class="card wf-hero">
        <div class="wf-icon-badge">
          <NavIcon glyph="workflows" color="var(--accent-bright)" glow />
        </div>
        <div class="wf-hero-text">
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>WORKFLOWS</div>
          <div style={{ color: "var(--text-muted)", "font-size": "12px" }}>
            Named, target-aware scheduled/webhook jobs — a Workflow is a Schedule with a target, a report
            thread, or a webhook trigger. Plain schedules stay on the Schedules page.
          </div>
        </div>
        <div class="wf-hero-actions">
          <button type="button" class="wf-new-btn preset" onClick={applyMonitorPreset}>
            ⚡ MONITOR A CONDITION
          </button>
          <button type="button" class="wf-new-btn" classList={{ active: composing() }} onClick={() => setComposing((v) => !v)}>
            {composing() ? "CLOSE" : "+ NEW"}
          </button>
        </div>
      </div>

      <Show when={justCreatedWebhook()}>
        {(info) => (
          <div class="card wf-webhook-panel">
            <div class="wf-composer-title">// WEBHOOK MINTED — save this now, you can re-reveal it later from the row</div>
            <div class="wf-webhook-row">
              <span class="wf-webhook-label">PATH</span>
              <code class="wf-webhook-value">/workflows/webhook/{info().id}</code>
              <button type="button" class="wf-btn ghost sm" onClick={() => void copyText(`/workflows/webhook/${info().id}`, "Path")}>Copy</button>
            </div>
            <div class="wf-webhook-row">
              <span class="wf-webhook-label">TOKEN</span>
              <code class="wf-webhook-value">{info().token}</code>
              <button type="button" class="wf-btn ghost sm" onClick={() => void copyText(info().token, "Token")}>Copy</button>
            </div>
            <div class="wf-webhook-hint">
              POST here with header <code>Authorization: Bearer &lt;token&gt;</code>, on your computer-use server's
              host:port (advertise_host / JARVIS_WEBHOOK_BASE).
            </div>
            <button type="button" class="wf-btn ghost sm" onClick={() => setJustCreatedWebhook(null)}>Dismiss</button>
          </div>
        )}
      </Show>

      <Show when={composing()}>
        <div class="card wf-composer">
          <div class="wf-composer-title">// NEW WORKFLOW</div>
          <div class="wf-field-row">
            <div class="wf-field">
              <label>NAME</label>
              <input type="text" placeholder="e.g. Nightly runner health check" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            </div>
            <div class="wf-field" style={{ flex: "0 0 150px" }}>
              <label>TRIGGER TYPE</label>
              <select value={triggerType()} onChange={(e) => setTriggerType(e.currentTarget.value as TriggerType)}>
                <option value="cron">Cron</option>
                <option value="interval">Interval</option>
                <option value="daily">Daily at</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
          </div>

          <Show when={triggerType() === "cron"}>
            <div class="wf-field">
              <label>CRON EXPRESSION</label>
              <input type="text" placeholder="0 9 * * *" value={cronText()} onInput={(e) => setCronText(e.currentTarget.value)} />
            </div>
          </Show>
          <Show when={triggerType() === "interval"}>
            <div class="wf-field-row">
              <div class="wf-field" style={{ flex: "0 0 100px" }}>
                <label>EVERY</label>
                <input type="number" min="1" value={intervalN()} onInput={(e) => setIntervalN(e.currentTarget.value)} />
              </div>
              <div class="wf-field" style={{ flex: "0 0 130px" }}>
                <label>UNIT</label>
                <select value={intervalUnit()} onChange={(e) => setIntervalUnit(e.currentTarget.value)}>
                  <option value="m">Minutes</option>
                  <option value="h">Hours</option>
                  <option value="s">Seconds</option>
                </select>
              </div>
            </div>
          </Show>
          <Show when={triggerType() === "daily"}>
            <div class="wf-field" style={{ flex: "0 0 160px" }}>
              <label>TIME OF DAY</label>
              <input type="time" value={dailyTime()} onInput={(e) => setDailyTime(e.currentTarget.value)} />
            </div>
          </Show>
          <Show when={triggerType() === "webhook"}>
            <div class="wf-field">
              <small>A bearer token is minted on create — you'll see it once here, and can re-reveal it any time from the row.</small>
            </div>
          </Show>

          <div class="wf-field">
            <label>PROMPT</label>
            <textarea
              placeholder="Prompt to run on each fire… (the ⚡ Monitor a condition button above fills in a ready-to-edit template)"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
            />
          </div>

          <div class="wf-field-row">
            <div class="wf-field" style={{ flex: "0 0 160px" }}>
              <label>BRAIN</label>
              <select value={brain()} onChange={(e) => setBrain(e.currentTarget.value)}>
                <For each={brainOptions()}>{(b) => <option value={b}>{b}</option>}</For>
              </select>
            </div>
            <div class="wf-field">
              <label>MODEL (optional)</label>
              <input type="text" placeholder="default" value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
            </div>
          </div>

          <div class="wf-field-row">
            <div class="wf-field">
              <label>TARGET</label>
              <input
                type="text"
                placeholder="agent or Outpost machine name (free text)"
                value={target()}
                onInput={(e) => setTarget(e.currentTarget.value)}
              />
              <small>What the prompt acts on — e.g. an agent name for recall(), or a paired Outpost machine name.</small>
            </div>
            <div class="wf-field">
              <label>REPORT THREAD</label>
              <input
                type="text"
                placeholder={DEFAULT_REPORT_THREAD}
                value={reportThread()}
                onInput={(e) => setReportThread(e.currentTarget.value)}
              />
            </div>
          </div>

          <Show when={createError()}>
            <div class="setup-error">⚠ {createError()}</div>
          </Show>
          <div class="wf-composer-actions">
            <button type="button" class="wf-btn ghost" onClick={() => setComposing(false)}>Cancel</button>
            <button type="button" class="wf-btn primary" disabled={!canCreate() || creating()} onClick={() => void create()}>
              {creating() ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading() && !error() && workflows().length === 0}>
        <div class="card wf-empty">
          <ArcReactor size={72} />
          <div class="wf-empty-title">NO WORKFLOWS</div>
          <div class="wf-empty-body">
            Create one above, or try the ⚡ Monitor a condition preset for a ready-to-edit
            "poll, compare, escalate-on-change" job. Plain cron/interval schedules with no target,
            report thread, or webhook trigger live on the Schedules page instead.
          </div>
        </div>
      </Show>

      <Show when={workflows().length > 0}>
        <div class="wf-list">
          <For each={workflows()}>
            {(row) => {
              const busy = () => busyIds().has(row.id)
              const isEditing = () => editingId() === row.id
              const isWebhook = () => isWebhookCron(row.cron)
              return (
                <div class="wf-row" classList={{ disabled: !row.enabled }}>
                  <div class="wf-row-bar" />
                  <div class="wf-row-top">
                    <div class="wf-row-main">
                      <div class="wf-row-title">{row.name || "(unnamed)"}</div>
                      <div class="wf-row-meta">
                        <span class="wf-chip">{fmtTrigger(row.cron)}</span>
                        <Show when={row.target}>
                          <span class="wf-chip muted">target: {row.target}</span>
                        </Show>
                        <Show when={row.report_thread}>
                          <span class="wf-chip muted">→ {row.report_thread}</span>
                        </Show>
                        <Show when={row.brain}>
                          <span class="wf-chip muted">{row.brain}{row.model ? `/${row.model}` : ""}</span>
                        </Show>
                        <Show when={!isWebhook()}>
                          <span class="wf-time" title={fmtAbs(row.next_run)}>next {fmtRel(row.next_run)}</span>
                        </Show>
                        <Show when={row.last_run}>
                          <span class="wf-time" title={fmtAbs(row.last_run)}>last {fmtRel(row.last_run)}</span>
                        </Show>
                      </div>
                    </div>
                    <div class="wf-row-actions">
                      <button type="button" class="wf-btn ghost sm" disabled={busy()} onClick={() => void runNow(row)}>
                        Run
                      </button>
                      <label class="wf-switch" title={row.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}>
                        <input type="checkbox" checked={!!row.enabled} disabled={busy()} onChange={() => void toggleEnabled(row)} />
                        <span class="wf-switch-track" />
                        <span class="wf-switch-thumb" />
                      </label>
                      <button
                        type="button"
                        class="wf-btn ghost sm"
                        disabled={busy()}
                        onClick={() => (isEditing() ? cancelEdit() : startEdit(row))}
                      >
                        {isEditing() ? "Cancel" : "Edit"}
                      </button>
                      <button type="button" class="wf-btn danger sm" disabled={busy()} onClick={() => remove(row)}>
                        Delete
                      </button>
                    </div>
                  </div>

                  <Show when={isWebhook()}>
                    <Show
                      when={revealed()[row.id]}
                      fallback={
                        <button type="button" class="wf-btn ghost sm" disabled={busy()} style={{ "align-self": "flex-start" }} onClick={() => void revealWebhook(row)}>
                          {revealing() === row.id ? "Revealing…" : "Reveal webhook URL + token"}
                        </button>
                      }
                    >
                      {(info) => (
                        <div class="wf-webhook-panel">
                          <div class="wf-webhook-row">
                            <span class="wf-webhook-label">PATH</span>
                            <code class="wf-webhook-value">/workflows/webhook/{row.id}</code>
                            <button type="button" class="wf-btn ghost sm" onClick={() => void copyText(`/workflows/webhook/${row.id}`, "Path")}>Copy</button>
                          </div>
                          <div class="wf-webhook-row">
                            <span class="wf-webhook-label">TOKEN</span>
                            <code class="wf-webhook-value">{info().token}</code>
                            <button type="button" class="wf-btn ghost sm" onClick={() => void copyText(info().token, "Token")}>Copy</button>
                          </div>
                          <div class="wf-webhook-hint">
                            {info().enabled ? "Workflow is enabled — this URL fires it." : "Workflow is DISABLED — this URL will 403 until re-enabled."}
                          </div>
                          <button type="button" class="wf-btn ghost sm" style={{ "align-self": "flex-start" }} onClick={() => hideWebhook(row.id)}>
                            Hide
                          </button>
                        </div>
                      )}
                    </Show>
                  </Show>

                  <Show when={isEditing() && edit()}>
                    {(e) => (
                      <div class="wf-edit-panel">
                        <div class="wf-composer-title">// EDIT WORKFLOW</div>
                        <div class="wf-field-row">
                          <div class="wf-field">
                            <label>NAME</label>
                            <input type="text" value={e().name} onInput={(ev) => setEdit({ ...e(), name: ev.currentTarget.value })} />
                          </div>
                          <div class="wf-field">
                            <label>TRIGGER (cron / "every Nm" / "at HH:MM" / "webhook")</label>
                            <input type="text" value={e().triggerText} onInput={(ev) => setEdit({ ...e(), triggerText: ev.currentTarget.value })} />
                          </div>
                        </div>
                        {/* This row's ORIGINAL trigger (row.cron, not the in-progress edit
                            text) is webhook, and the pending edit would move it to something
                            else — saving invalidates its stored token server-side (see
                            Scheduler::update()'s conversion-away-from-webhook clearing), so
                            warn before that happens instead of the token silently going dead. */}
                        <Show when={isWebhook() && !isWebhookCron(e().triggerText)}>
                          <div class="wf-convert-warning">
                            ⚠ Changing this workflow's trigger away from webhook will invalidate its
                            existing webhook token — anything using the old URL will stop working.
                          </div>
                        </Show>
                        <div class="wf-field">
                          <label>PROMPT</label>
                          <textarea value={e().prompt} onInput={(ev) => setEdit({ ...e(), prompt: ev.currentTarget.value })} />
                        </div>
                        <div class="wf-field-row">
                          <div class="wf-field" style={{ flex: "0 0 160px" }}>
                            <label>BRAIN</label>
                            {/* Explicit "" option so a row with brain:"" (ScheduleRow's own
                                convention: "" => daemon default — e.g. any workflow created via
                                workflow_create without specifying one) shows its REAL current
                                value instead of the <select> silently falling back to displaying
                                whatever option happens to render first, which would silently
                                write that displayed-but-never-chosen brain on an untouched Save. */}
                            <select value={e().brain} onChange={(ev) => setEdit({ ...e(), brain: ev.currentTarget.value })}>
                              <option value="">(daemon default)</option>
                              <For each={brainOptions()}>{(b) => <option value={b}>{b}</option>}</For>
                            </select>
                          </div>
                          <div class="wf-field">
                            <label>MODEL</label>
                            <input type="text" value={e().model} onInput={(ev) => setEdit({ ...e(), model: ev.currentTarget.value })} />
                          </div>
                        </div>
                        <div class="wf-field-row">
                          <div class="wf-field">
                            <label>TARGET</label>
                            <input type="text" value={e().target} onInput={(ev) => setEdit({ ...e(), target: ev.currentTarget.value })} />
                          </div>
                          <div class="wf-field">
                            <label>REPORT THREAD</label>
                            <input type="text" value={e().reportThread} onInput={(ev) => setEdit({ ...e(), reportThread: ev.currentTarget.value })} />
                          </div>
                        </div>
                        <Show when={editError()}>
                          <div class="setup-error">⚠ {editError()}</div>
                        </Show>
                        <div class="wf-composer-actions">
                          <button type="button" class="wf-btn ghost" onClick={cancelEdit}>Cancel</button>
                          <button type="button" class="wf-btn primary" disabled={savingEdit()} onClick={() => void saveEdit(row.id)}>
                            {savingEdit() ? "Saving…" : "Save"}
                          </button>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

// Placed right after "schedules" (order:3) with a fractional key — see the
// file-header comment for why this doesn't touch any other page's order.
const page: PageDef = { id: "workflows", label: "WORKFLOWS", section: "MIND", order: 3.5, component: Workflows }
export default page
