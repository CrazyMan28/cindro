// AGENTS — custom subagent definitions + live dispatch console. Contract A
// verbs: agents.list/create/get/remove/dispatch/running/result. There is no
// broadcast for agent lifecycle changes, so "Running Now" is polled (every
// 4s) against agents.running, per the unit brief. Visual bar ported from
// home.tsx's card/row pattern (glow-on-hover rows, hud labels, staggered
// entrance) rather than a bare list.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import fuzzysort from "fuzzysort"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"

interface AgentDef {
  name: string
  description: string
  when_to_use: string
  brain: string
  model: string
  profile: string
  tools: string[]
  color: string
  path: string
  system_prompt: string
}

interface RunningAgent {
  id: string
  title: string
  agent: string
  state: string
  brain: string
  model: string
  profile: string
  parent_session_id: string
  updated: number
  created: number
  live: boolean
  running: boolean
}

function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : v === null || v === undefined ? fb : String(v)
}
function arrOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}
function timeAgo(ms: number): string {
  if (!ms) return "—"
  const diff = Date.now() - ms
  if (diff < 0) return "just now"
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function toAgentDef(a: Record<string, unknown>): AgentDef {
  return {
    name: str(a.name),
    description: str(a.description),
    when_to_use: str(a.when_to_use),
    brain: str(a.brain),
    model: str(a.model),
    profile: str(a.profile),
    tools: arrOf(a.tools),
    color: str(a.color),
    path: str(a.path),
    system_prompt: str(a.system_prompt),
  }
}

function toRunning(s: Record<string, unknown>): RunningAgent {
  // updated/created may arrive as unix seconds or ms depending on store — treat
  // values below 10^12 as seconds (SQLite epoch columns here are seconds).
  const norm = (v: unknown) => {
    const n = Number(v ?? 0)
    return n > 0 && n < 1e12 ? n * 1000 : n
  }
  return {
    id: str(s.id),
    title: str(s.title),
    agent: str(s.agent),
    state: str(s.state, "idle"),
    brain: str(s.brain),
    model: str(s.model),
    profile: str(s.profile),
    parent_session_id: str(s.parent_session_id),
    updated: norm(s.updated),
    created: norm(s.created),
    live: Boolean(s.live),
    running: Boolean(s.running),
  }
}

function stateColorVar(state: string): string {
  if (state === "running" || state === "starting") return "var(--accent)"
  if (state === "error") return "var(--danger)"
  if (state === "done") return "var(--success)"
  return "var(--text-faint)"
}

const emptyAgentForm = {
  name: "",
  description: "",
  when_to_use: "",
  brain: "",
  model: "",
  profile: "",
  tools: "",
  color: "",
  system_prompt: "",
}
const emptyDispatchForm = {
  agent: "",
  task: "",
  brain: "",
  model: "",
  system_prompt: "",
  parent_session_id: "",
  cwd: "",
}

function AgentsPage() {
  const app = useApp()

  const [defs, setDefs] = createSignal<AgentDef[]>([])
  const [defsLoading, setDefsLoading] = createSignal(true)
  const [defsError, setDefsError] = createSignal("")
  const [query, setQuery] = createSignal("")

  const [running, setRunning] = createSignal<RunningAgent[]>([])
  const [runningError, setRunningError] = createSignal("")

  const [busy, setBusy] = createSignal<Record<string, boolean>>({})
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [detailLoading, setDetailLoading] = createSignal<string | null>(null)
  const [detailPrompt, setDetailPrompt] = createSignal<Record<string, string>>({})
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null)

  const [resultOpen, setResultOpen] = createSignal<string | null>(null)
  const [results, setResults] = createSignal<Record<string, { status: string; summary: string }>>({})
  const [resultLoading, setResultLoading] = createSignal<string | null>(null)
  const [confirmCancel, setConfirmCancel] = createSignal<string | null>(null)

  const [createOpen, setCreateOpen] = createSignal(false)
  const [agentForm, setAgentForm] = createSignal({ ...emptyAgentForm })
  const [createBusy, setCreateBusy] = createSignal(false)
  const [createError, setCreateError] = createSignal("")

  const [dispatchOpen, setDispatchOpen] = createSignal(false)
  const [dispatchForm, setDispatchForm] = createSignal({ ...emptyDispatchForm })
  const [dispatchBusy, setDispatchBusy] = createSignal(false)
  const [dispatchError, setDispatchError] = createSignal("")

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const setRowBusy = (name: string, v: boolean) => setBusy((b) => ({ ...b, [name]: v }))

  const loadDefs = async () => {
    try {
      const res = await app.client.call("agents.list", {}, 15000)
      if (!alive) return
      setDefs(((res.agents ?? []) as Record<string, unknown>[]).map(toAgentDef))
      setDefsError("")
    } catch (e) {
      if (alive) setDefsError(String(e))
    } finally {
      if (alive) setDefsLoading(false)
    }
  }

  const loadRunning = async () => {
    try {
      const res = await app.client.call("agents.running", {}, 15000)
      if (!alive) return
      setRunning(((res.agents ?? []) as Record<string, unknown>[]).map(toRunning))
      setRunningError("")
    } catch (e) {
      if (alive) setRunningError(String(e))
    }
  }

  onMount(() => {
    void loadDefs()
    void loadRunning()
    const poll = setInterval(() => void loadRunning(), 4000)
    onCleanup(() => clearInterval(poll))
  })

  const filteredDefs = createMemo(() => {
    const q = query().trim()
    const list = [...defs()].sort((a, b) => a.name.localeCompare(b.name))
    if (!q) return list
    const prepped = list.map((a) => ({
      row: a,
      hay: `${a.name} ${a.description} ${a.when_to_use} ${a.tools.join(" ")}`,
    }))
    const hits = fuzzysort.go(q, prepped, { key: "hay", limit: 200 })
    return hits.map((h) => h.obj.row)
  })

  const defByName = createMemo(() => new Map(defs().map((d) => [d.name, d])))

  // loadRunning() builds a BRAND NEW RunningAgent object for every row on
  // every 4s poll tick (fresh JSON in, fresh objects out) — if <For> were
  // keyed on those objects directly it would see "all new" every single
  // poll and tear down + rebuild the whole Running Now list every 4s,
  // replaying every row's entrance animation forever. Key on the session id
  // (a stable primitive across polls) instead, with a lookup map for the
  // live fields, so unchanged rows keep their DOM node across polls.
  const runningById = createMemo(() => new Map(running().map((r) => [r.id, r])))
  const runningIdsSorted = createMemo(() => {
    const list = [...running()]
    list.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1
      return b.updated - a.updated
    })
    return list.map((r) => r.id)
  })

  const toggleDetail = async (name: string) => {
    if (expanded() === name) {
      setExpanded(null)
      return
    }
    setExpanded(name)
    if (detailPrompt()[name] !== undefined) return
    setDetailLoading(name)
    try {
      const res = await app.client.call("agents.get", { name }, 15000)
      setDetailPrompt((d) => ({ ...d, [name]: str(res.system_prompt) }))
    } catch (e) {
      app.notify(`Load agent details failed: ${String(e)}`, "error")
      setExpanded(null)
    } finally {
      setDetailLoading(null)
    }
  }

  const doRemove = async (name: string) => {
    setRowBusy(name, true)
    try {
      await app.client.call("agents.remove", { name }, 10000)
      setDefs((list) => list.filter((x) => x.name !== name))
      setConfirmRemove(null)
      app.notify(`Removed agent "${name}"`, "info")
    } catch (e) {
      app.notify(`Remove failed: ${String(e)}`, "error")
    } finally {
      setRowBusy(name, false)
    }
  }

  const openDispatchFor = (name: string) => {
    setDispatchForm((f) => ({ ...f, agent: name }))
    setDispatchOpen(true)
  }

  const submitCreate = async (e: Event) => {
    e.preventDefault()
    const f = agentForm()
    if (!f.name.trim()) {
      setCreateError("Name is required")
      return
    }
    setCreateBusy(true)
    setCreateError("")
    try {
      const tools = f.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      await app.client.call(
        "agents.create",
        {
          name: f.name.trim(),
          description: f.description,
          when_to_use: f.when_to_use,
          system_prompt: f.system_prompt,
          brain: f.brain,
          model: f.model,
          profile: f.profile,
          tools,
          color: f.color,
        },
        20000,
      )
      app.notify(`Created agent "${f.name.trim()}"`, "info")
      setAgentForm({ ...emptyAgentForm })
      setCreateOpen(false)
      void loadDefs()
    } catch (e) {
      setCreateError(String(e))
    } finally {
      setCreateBusy(false)
    }
  }

  const submitDispatch = async (e: Event) => {
    e.preventDefault()
    const f = dispatchForm()
    if (!f.task.trim()) {
      setDispatchError("Task is required")
      return
    }
    setDispatchBusy(true)
    setDispatchError("")
    try {
      const params: Record<string, unknown> = { task: f.task }
      if (f.agent) params.agent = f.agent
      if (f.brain) params.brain = f.brain
      if (f.model) params.model = f.model
      if (f.system_prompt) params.system_prompt = f.system_prompt
      if (f.parent_session_id) params.parent_session_id = f.parent_session_id
      if (f.cwd) params.cwd = f.cwd
      const res = await app.client.call("agents.dispatch", params, 20000)
      const sid = str(res.session_id)
      app.notify(`Dispatched "${str(res.agent, f.agent || "subagent")}" — session ${sid}`, "info")
      setDispatchForm({ ...emptyDispatchForm })
      setDispatchOpen(false)
      void loadRunning()
    } catch (e) {
      setDispatchError(String(e))
    } finally {
      setDispatchBusy(false)
    }
  }

  const toggleResult = async (sid: string) => {
    if (resultOpen() === sid) {
      setResultOpen(null)
      return
    }
    setResultOpen(sid)
    setResultLoading(sid)
    try {
      const res = await app.client.call("agents.result", { session_id: sid }, 15000)
      setResults((r) => ({ ...r, [sid]: { status: str(res.status), summary: str(res.summary) } }))
    } catch (e) {
      app.notify(`Fetch result failed: ${String(e)}`, "error")
    } finally {
      setResultLoading(null)
    }
  }

  const doCancel = async (sid: string) => {
    setRowBusy(sid, true)
    try {
      await app.client.call("session.cancel", { session_id: sid }, 10000)
      app.notify(`Cancelled session ${sid}`, "info")
      setConfirmCancel(null)
      void loadRunning()
    } catch (e) {
      app.notify(`Cancel failed: ${String(e)}`, "error")
    } finally {
      setRowBusy(sid, false)
    }
  }

  return (
    <div class="ag-page">
      <style>{AGENTS_CSS}</style>

      <div class="ag-header">
        <div class="ag-title-group">
          <NavIcon glyph="agents" color="var(--accent-bright)" glow />
          <div>
            <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "18px" }}>
              AGENTS
            </div>
            <div class="ag-subtitle">
              Custom subagents &amp; live dispatch — {running().filter((r) => r.running).length} running
            </div>
          </div>
        </div>
        <div class="ag-toolbar">
          <button
            type="button"
            class="ag-btn ag-btn-ghost"
            onClick={() => {
              void loadDefs()
              void loadRunning()
            }}
          >
            ⟳ Refresh
          </button>
          <button type="button" class="ag-btn" onClick={() => setDispatchOpen((v) => !v)}>
            {dispatchOpen() ? "✕ Cancel" : "▶ Dispatch"}
          </button>
          <button type="button" class="ag-btn" onClick={() => setCreateOpen((v) => !v)}>
            {createOpen() ? "✕ Cancel" : "+ New Agent"}
          </button>
        </div>
      </div>

      <Show when={dispatchOpen()}>
        <form class="ag-card ag-form" onSubmit={submitDispatch}>
          <div class="ag-form-title hud-label">DISPATCH A SUBAGENT</div>
          <div class="ag-form-grid">
            <label class="ag-field">
              <span>Agent</span>
              <select
                value={dispatchForm().agent}
                onChange={(e) => setDispatchForm((f) => ({ ...f, agent: e.currentTarget.value }))}
              >
                <option value="">— ad-hoc (no stored agent) —</option>
                <For each={defs()}>{(d) => <option value={d.name}>{d.name}</option>}</For>
              </select>
            </label>
            <label class="ag-field">
              <span>Parent session (optional)</span>
              <input
                value={dispatchForm().parent_session_id}
                onInput={(e) => setDispatchForm((f) => ({ ...f, parent_session_id: e.currentTarget.value }))}
                placeholder="auto-detected if omitted"
              />
            </label>
            <label class="ag-field ag-field-wide">
              <span>Task *</span>
              <textarea
                rows="3"
                value={dispatchForm().task}
                onInput={(e) => setDispatchForm((f) => ({ ...f, task: e.currentTarget.value }))}
                placeholder="What should this subagent go do?"
              />
            </label>
            <Show when={!dispatchForm().agent}>
              <label class="ag-field">
                <span>Brain override</span>
                <input
                  value={dispatchForm().brain}
                  onInput={(e) => setDispatchForm((f) => ({ ...f, brain: e.currentTarget.value }))}
                  placeholder="codex / claude / api"
                />
              </label>
              <label class="ag-field">
                <span>Model override</span>
                <input
                  value={dispatchForm().model}
                  onInput={(e) => setDispatchForm((f) => ({ ...f, model: e.currentTarget.value }))}
                  placeholder="(brain default)"
                />
              </label>
              <label class="ag-field ag-field-wide">
                <span>System prompt override</span>
                <textarea
                  rows="3"
                  value={dispatchForm().system_prompt}
                  onInput={(e) => setDispatchForm((f) => ({ ...f, system_prompt: e.currentTarget.value }))}
                  placeholder="One-off instructions for an ad-hoc subagent"
                />
              </label>
            </Show>
            <label class="ag-field">
              <span>Working dir (optional)</span>
              <input
                value={dispatchForm().cwd}
                onInput={(e) => setDispatchForm((f) => ({ ...f, cwd: e.currentTarget.value }))}
                placeholder="/path/to/repo"
              />
            </label>
          </div>
          <Show when={dispatchError()}>
            <div class="ag-error">⚠ {dispatchError()}</div>
          </Show>
          <div class="ag-form-actions">
            <button type="submit" class="ag-btn" disabled={dispatchBusy()}>
              {dispatchBusy() ? "Dispatching…" : "Dispatch"}
            </button>
          </div>
        </form>
      </Show>

      <Show when={createOpen()}>
        <form class="ag-card ag-form" onSubmit={submitCreate}>
          <div class="ag-form-title hud-label">DEFINE A NEW AGENT</div>
          <div class="ag-form-grid">
            <label class="ag-field">
              <span>Name *</span>
              <input
                value={agentForm().name}
                onInput={(e) => setAgentForm((f) => ({ ...f, name: e.currentTarget.value }))}
                placeholder="release-manager"
              />
            </label>
            <label class="ag-field">
              <span>Color</span>
              <input
                value={agentForm().color}
                onInput={(e) => setAgentForm((f) => ({ ...f, color: e.currentTarget.value }))}
                placeholder="#B28BFF"
              />
            </label>
            <label class="ag-field ag-field-wide">
              <span>Description</span>
              <input
                value={agentForm().description}
                onInput={(e) => setAgentForm((f) => ({ ...f, description: e.currentTarget.value }))}
                placeholder="What this agent is for"
              />
            </label>
            <label class="ag-field ag-field-wide">
              <span>When to use</span>
              <input
                value={agentForm().when_to_use}
                onInput={(e) => setAgentForm((f) => ({ ...f, when_to_use: e.currentTarget.value }))}
                placeholder="So the model knows when to dispatch this agent on its own"
              />
            </label>
            <label class="ag-field">
              <span>Brain</span>
              <select
                value={agentForm().brain}
                onChange={(e) => setAgentForm((f) => ({ ...f, brain: e.currentTarget.value }))}
              >
                <option value="">(default)</option>
                <option value="codex">codex</option>
                <option value="claude">claude</option>
                <option value="api">api</option>
              </select>
            </label>
            <label class="ag-field">
              <span>Model</span>
              <input
                value={agentForm().model}
                onInput={(e) => setAgentForm((f) => ({ ...f, model: e.currentTarget.value }))}
                placeholder="(brain default)"
              />
            </label>
            <label class="ag-field">
              <span>Profile</span>
              <select
                value={agentForm().profile}
                onChange={(e) => setAgentForm((f) => ({ ...f, profile: e.currentTarget.value }))}
              >
                <option value="">(default — coworker)</option>
                <option value="coworker">coworker</option>
                <option value="coder">coder</option>
              </select>
            </label>
            <label class="ag-field">
              <span>Tools (comma separated)</span>
              <input
                value={agentForm().tools}
                onInput={(e) => setAgentForm((f) => ({ ...f, tools: e.currentTarget.value }))}
                placeholder="shell, browser, memory"
              />
            </label>
            <label class="ag-field ag-field-wide">
              <span>System prompt</span>
              <textarea
                rows="6"
                value={agentForm().system_prompt}
                onInput={(e) => setAgentForm((f) => ({ ...f, system_prompt: e.currentTarget.value }))}
                placeholder="The agent's full system prompt / operating instructions…"
              />
            </label>
          </div>
          <Show when={createError()}>
            <div class="ag-error">⚠ {createError()}</div>
          </Show>
          <div class="ag-form-actions">
            <button type="submit" class="ag-btn" disabled={createBusy()}>
              {createBusy() ? "Saving…" : "Save Agent"}
            </button>
          </div>
        </form>
      </Show>

      <div class="ag-section">
        <div class="ag-section-title hud-label">RUNNING NOW</div>
        <Show when={runningError()}>
          <div class="ag-error">⚠ {runningError()}</div>
        </Show>
        <Show when={!runningError() && runningIdsSorted().length === 0}>
          <div class="ag-empty">No agents running right now.</div>
        </Show>
        <div class="ag-rows">
          <For each={runningIdsSorted()}>
            {(id, i) => {
              // Keyed on the session id (stable primitive) rather than the row
              // object — loadRunning() allocates a fresh RunningAgent object for
              // every row on every 4s poll, so keying on the object itself would
              // make <For> tear down + rebuild the whole list every poll tick.
              // Look the live row up reactively instead; the row's DOM node is
              // created once and just updates its text/attrs as polls land.
              const row = () => runningById().get(id)
              const def = () => defByName().get(row()?.agent ?? "")
              const enterDelay = Math.min(i() * 35, 300)
              return (
                <Show when={row()}>
                  {(r) => (
                    <div class="ag-row" style={{ "animation-delay": `${enterDelay}ms` }}>
                      <div class="ag-row-main">
                        <div class="ag-run-top">
                          <span class="ag-color-dot" style={{ background: def()?.color || "var(--accent)" }} />
                          <span class="ag-row-name-static">{r().agent || "subagent"}</span>
                          <span class="ag-state-badge" style={{ color: stateColorVar(r().state) }}>
                            <span
                              class="ag-state-dot"
                              classList={{ pulsing: r().running }}
                              style={{ background: stateColorVar(r().state) }}
                            />
                            {r().state}
                          </span>
                          <Show when={r().live}>
                            <span class="ag-badge ag-badge-live">live</span>
                          </Show>
                        </div>
                        <div class="ag-desc">{r().title || id}</div>
                        <div class="ag-meta">
                          session <span class="ag-mono">{id}</span> · updated {timeAgo(r().updated)}
                          <Show when={r().brain || r().model}>
                            {" "}
                            · {r().brain}
                            {r().model ? `/${r().model}` : ""}
                          </Show>
                        </div>
                        <Show when={resultOpen() === id}>
                          <div class="ag-detail">
                            <Show when={resultLoading() === id}>
                              <div class="ag-empty">Loading result…</div>
                            </Show>
                            <Show when={results()[id]}>
                              {(res) => (
                                <>
                                  <div class="ag-detail-path">status: {res().status}</div>
                                  <pre class="ag-pre">{res().summary || "(no summary yet)"}</pre>
                                </>
                              )}
                            </Show>
                          </div>
                        </Show>
                      </div>
                      <div class="ag-row-actions">
                        <button type="button" class="ag-btn ag-btn-sm" onClick={() => void toggleResult(id)}>
                          {resultOpen() === id ? "Hide" : "Result"}
                        </button>
                        <Show when={r().running}>
                          <Show
                            when={confirmCancel() !== id}
                            fallback={
                              <span class="ag-confirm">
                                <button
                                  type="button"
                                  class="ag-btn ag-btn-danger ag-btn-sm"
                                  onClick={() => void doCancel(id)}
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  class="ag-btn ag-btn-ghost ag-btn-sm"
                                  onClick={() => setConfirmCancel(null)}
                                >
                                  Cancel
                                </button>
                              </span>
                            }
                          >
                            <button
                              type="button"
                              class="ag-btn ag-btn-ghost ag-btn-sm"
                              disabled={busy()[id]}
                              onClick={() => setConfirmCancel(id)}
                            >
                              ⏹ Stop
                            </button>
                          </Show>
                        </Show>
                      </div>
                    </div>
                  )}
                </Show>
              )
            }}
          </For>
        </div>
      </div>

      <div class="ag-section">
        <div class="ag-section-title-row">
          <div class="ag-section-title hud-label">DEFINED AGENTS</div>
          <input
            class="ag-search"
            placeholder="Search agents by name, purpose, tool…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <Show when={defsError()}>
          <div class="ag-error">⚠ {defsError()}</div>
        </Show>
        <Show when={defsLoading()}>
          <div class="ag-empty">Loading agents…</div>
        </Show>
        <Show when={!defsLoading() && !defsError() && filteredDefs().length === 0}>
          <div class="ag-empty">No agent definitions match — try clearing the search, or define a new one.</div>
        </Show>
        <div class="ag-rows">
          <For each={filteredDefs()}>
            {(d, i) => {
              // One-time capture (see the Running Now row above) — filteredDefs()
              // re-sorts on every search keystroke, so this must not be read
              // reactively inside the style prop.
              const enterDelay = Math.min(i() * 35, 300)
              return (
              <div class="ag-row" style={{ "animation-delay": `${enterDelay}ms` }}>
                <div class="ag-row-main">
                  <button type="button" class="ag-row-name" onClick={() => void toggleDetail(d.name)}>
                    <span class="ag-color-dot" style={{ background: d.color || "var(--accent)" }} />
                    <span class="ag-chev-inline">{expanded() === d.name ? "▾" : "▸"}</span>
                    {d.name}
                  </button>
                  <div class="ag-badges">
                    <Show when={d.brain}>
                      <span class="ag-badge">{d.brain}</span>
                    </Show>
                    <Show when={d.model}>
                      <span class="ag-badge">{d.model}</span>
                    </Show>
                    <Show when={d.profile}>
                      <span class="ag-badge">{d.profile}</span>
                    </Show>
                    <For each={d.tools}>{(t) => <span class="ag-badge">{t}</span>}</For>
                  </div>
                  <div class="ag-desc">{d.description || "No description."}</div>
                  <Show when={d.when_to_use}>
                    <div class="ag-meta">when to use: {d.when_to_use}</div>
                  </Show>

                  <Show when={expanded() === d.name}>
                    <div class="ag-detail">
                      <Show when={detailLoading() === d.name}>
                        <div class="ag-empty">Loading…</div>
                      </Show>
                      <Show when={detailPrompt()[d.name] !== undefined}>
                        <div class="ag-detail-path">{d.path}</div>
                        <pre class="ag-pre">{detailPrompt()[d.name] || "(no system prompt)"}</pre>
                      </Show>
                    </div>
                  </Show>
                </div>
                <div class="ag-row-actions">
                  <button type="button" class="ag-btn ag-btn-sm" onClick={() => openDispatchFor(d.name)}>
                    ▶ Dispatch
                  </button>
                  <Show
                    when={confirmRemove() !== d.name}
                    fallback={
                      <span class="ag-confirm">
                        <button
                          type="button"
                          class="ag-btn ag-btn-danger ag-btn-sm"
                          onClick={() => void doRemove(d.name)}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          class="ag-btn ag-btn-ghost ag-btn-sm"
                          onClick={() => setConfirmRemove(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    }
                  >
                    <button
                      type="button"
                      class="ag-btn ag-btn-ghost ag-btn-sm"
                      disabled={busy()[d.name]}
                      onClick={() => setConfirmRemove(d.name)}
                    >
                      🗑 Remove
                    </button>
                  </Show>
                </div>
              </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

const AGENTS_CSS = `
.ag-page { display:flex; flex-direction:column; gap:16px; max-width:1080px; padding-bottom:24px; }
.ag-header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.ag-title-group { display:flex; align-items:center; gap:10px; }
.ag-subtitle { color:var(--text-muted); font-size:12px; margin-top:2px; }
.ag-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.ag-btn { all:unset; cursor:pointer; box-sizing:border-box; font-family:var(--font-display); letter-spacing:var(--track-tight); font-size:11px; padding:8px 14px; border-radius:var(--radius-sm); background:var(--accent-dim); color:var(--accent-bright); border:1px solid var(--accent-dim); transition:background var(--dur-fast) ease, transform var(--dur-fast) ease; }
.ag-btn:hover:not(:disabled) { background:var(--accent-faint); transform:translateY(-1px); }
.ag-btn:disabled { opacity:0.5; cursor:default; }
.ag-btn-ghost { background:transparent; color:var(--text-muted); border-color:var(--hairline-soft); }
.ag-btn-ghost:hover:not(:disabled) { color:var(--text); border-color:var(--accent-dim); background:rgba(255,255,255,0.03); }
.ag-btn-danger { background:var(--danger-dim); color:var(--danger); border-color:var(--danger-dim); }
.ag-btn-danger:hover:not(:disabled) { background:rgba(255,107,107,0.28); }
.ag-btn-sm { padding:5px 10px; font-size:10px; }
.ag-confirm { display:flex; gap:6px; }
.ag-card { background:var(--surface); border:1px solid var(--hairline-soft); border-radius:var(--radius); padding:14px 16px; }
.ag-form-title { font-size:11px; margin-bottom:10px; }
.ag-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; }
.ag-field { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--text-muted); }
.ag-field-wide { grid-column:1 / -1; }
.ag-field input, .ag-field textarea, .ag-field select { background:var(--surface-input); border:1px solid var(--hairline-soft); border-radius:var(--radius-xs); color:var(--text); padding:8px 10px; font-size:12px; font-family:var(--font-sans); resize:vertical; }
.ag-field input:focus, .ag-field textarea:focus, .ag-field select:focus { outline:none; border-color:var(--accent-dim); }
.ag-form-actions { display:flex; justify-content:flex-end; margin-top:12px; }
.ag-error { color:var(--danger); font-size:12px; padding:4px 0; }
.ag-empty { color:var(--text-faint); font-size:12px; padding:8px 2px; }
.ag-section { display:flex; flex-direction:column; gap:8px; }
.ag-section-title { font-size:10px; letter-spacing:var(--track-mid); color:var(--text-faint); }
.ag-section-title-row { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.ag-search { min-width:220px; height:30px; background:var(--surface-input); border:1px solid var(--hairline-soft); border-radius:var(--radius-sm); color:var(--text); padding:0 12px; font-size:12px; }
.ag-search:focus { outline:none; border-color:var(--accent-dim); }
.ag-rows { display:flex; flex-direction:column; gap:8px; }
.ag-row { display:flex; justify-content:space-between; gap:14px; background:var(--surface); border:1px solid var(--hairline-faint); border-radius:var(--radius-sm); padding:12px 14px; transition:border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease, transform var(--dur-fast) ease; animation:ag-row-in var(--dur-slow) ease-out backwards; }
.ag-row:hover { border-color:var(--accent-dim); box-shadow:0 4px 18px -6px var(--accent-glow); transform:translateY(-1px); }
@keyframes ag-row-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
.ag-row-main { display:flex; flex-direction:column; gap:6px; flex:1; min-width:0; }
.ag-row-name { all:unset; cursor:pointer; color:var(--accent-bright); font-family:var(--font-display); font-size:13px; letter-spacing:var(--track-tight); display:flex; align-items:center; gap:6px; }
.ag-row-name-static { color:var(--text); font-family:var(--font-display); font-size:13px; letter-spacing:var(--track-tight); }
.ag-chev-inline { color:var(--text-faint); font-size:10px; width:10px; }
.ag-run-top { display:flex; align-items:center; gap:8px; }
.ag-color-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; box-shadow:0 0 6px currentColor; }
.ag-state-badge { display:flex; align-items:center; gap:5px; font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:0.5px; }
.ag-state-dot { width:6px; height:6px; border-radius:50%; }
.ag-state-dot.pulsing { animation:ag-pulse 1000ms ease-in-out infinite; }
@keyframes ag-pulse { 0%, 100% { opacity:1; } 50% { opacity:0.35; } }
.ag-badges { display:flex; flex-wrap:wrap; gap:6px; }
.ag-badge { font-size:10px; color:var(--text-muted); background:var(--surface-strong); border:1px solid var(--hairline-soft); border-radius:999px; padding:2px 8px; }
.ag-badge-live { color:var(--success); border-color:rgba(57,230,160,0.3); background:rgba(57,230,160,0.12); }
.ag-desc { color:var(--text-muted); font-size:12px; }
.ag-meta { color:var(--text-faint); font-size:10.5px; font-family:var(--font-mono); }
.ag-mono { font-family:var(--font-mono); }
.ag-detail { margin-top:4px; display:flex; flex-direction:column; gap:6px; }
.ag-detail-path { color:var(--text-faint); font-size:10px; font-family:var(--font-mono); }
.ag-pre { white-space:pre-wrap; word-break:break-word; font-family:var(--font-mono); font-size:11.5px; color:var(--text-muted); background:var(--surface-deep); border:1px solid var(--hairline-faint); border-radius:var(--radius-xs); padding:10px 12px; max-height:280px; overflow:auto; margin:0; }
.ag-row-actions { display:flex; flex-direction:column; gap:6px; align-items:flex-end; flex-shrink:0; }
`

const page: PageDef = { id: "agents", label: "AGENTS", section: "MIND", order: 2, component: AgentsPage }
export default page
