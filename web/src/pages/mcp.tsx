// MCP — server registry manager, ported from desktop/qml/McpPage.qml's intent
// (list of registered tool servers with enable toggle + live "Test" probe, an
// Add-server form, and a read-only-by-default view of each CLI brain's own
// MCP servers that can be selectively imported). Wires mcp.list/add/remove/
// set_enabled/test/cli_list/cli_set_enabled — see daemon/src/ControlServer.cpp
// handleMcp* for the exact response shapes this mirrors.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"

interface McpServer {
  id: string
  name: string
  transport: string
  endpoint: string
  enabled: boolean
  builtin: boolean
  risk: string
  has_token: boolean
}

interface CliServer {
  brain: string
  name: string
  transport: string
  endpoint: string
  enabled: boolean
}

interface TestState {
  state: "idle" | "testing" | "ok" | "fail"
  tools: number
  error: string
}

interface AddForm {
  name: string
  transport: "http" | "stdio"
  endpoint: string
  token: string
}

interface Approval {
  reason: string
  advisoryIds: string[]
  pkg: string
  params: Record<string, unknown>
}

const EMPTY_FORM: AddForm = { name: "", transport: "http", endpoint: "", token: "" }

function riskVar(risk: string): string {
  if (risk === "high") return "var(--danger)"
  if (risk === "low") return "var(--success)"
  return "var(--amber)"
}

function McpPage() {
  const app = useApp()
  const [servers, setServers] = createSignal<McpServer[]>([])
  const [cliServers, setCliServers] = createSignal<CliServer[]>([])
  const [testStates, setTestStates] = createSignal<Record<string, TestState>>({})
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const [showAdd, setShowAdd] = createSignal(false)
  const [addForm, setAddForm] = createSignal<AddForm>({ ...EMPTY_FORM })
  const [addBusy, setAddBusy] = createSignal(false)
  const [addError, setAddError] = createSignal("")
  const [approval, setApproval] = createSignal<Approval | null>(null)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const loadServers = async () => {
    try {
      const res = await app.client.call("mcp.list", {}, 15000)
      if (!alive) return
      setServers((res.servers as McpServer[] | undefined) ?? [])
      setError("")
    } catch (e) {
      if (alive) setError(String(e))
    }
  }

  const loadCli = async () => {
    try {
      const res = await app.client.call("mcp.cli_list", {}, 15000)
      if (!alive) return
      setCliServers((res.servers as CliServer[] | undefined) ?? [])
    } catch {
      // The CLI-server section is best-effort (no ~/.claude.json / config.toml
      // to read on some hosts) — leave the section empty rather than error the page.
    }
  }

  const refresh = async () => {
    setLoading(true)
    await Promise.all([loadServers(), loadCli()])
    if (alive) setLoading(false)
  }

  onMount(() => void refresh())

  const groupedCli = createMemo(() => {
    const byBrain = new Map<string, CliServer[]>()
    for (const s of cliServers()) {
      const list = byBrain.get(s.brain) ?? []
      list.push(s)
      byBrain.set(s.brain, list)
    }
    const known = ["codex", "claude"]
    const order = [...known, ...[...byBrain.keys()].filter((b) => !known.includes(b))]
    return order.filter((b) => byBrain.has(b)).map((b) => ({ brain: b, rows: byBrain.get(b) ?? [] }))
  })

  const setServerEnabled = async (id: string, enabled: boolean) => {
    setServers((rows) => rows.map((r) => (r.id === id ? { ...r, enabled } : r)))
    try {
      await app.client.call("mcp.set_enabled", { id, enabled }, 15000)
    } catch (e) {
      app.notify(`Failed to update server: ${String(e)}`, "error")
      void loadServers()
    }
  }

  const testServer = async (id: string) => {
    setTestStates((t) => ({ ...t, [id]: { state: "testing", tools: 0, error: "" } }))
    try {
      const res = await app.client.call("mcp.test", { id }, 8000)
      const ok = Boolean(res.ok)
      setTestStates((t) => ({
        ...t,
        [id]: { state: ok ? "ok" : "fail", tools: Number(res.tools_count ?? 0), error: String(res.error ?? "") },
      }))
    } catch (e) {
      setTestStates((t) => ({ ...t, [id]: { state: "fail", tools: 0, error: String(e) } }))
    }
  }

  const removeServer = async (id: string, name: string) => {
    try {
      await app.client.call("mcp.remove", { id }, 15000)
      app.notify(`Removed "${name}"`, "info")
      void loadServers()
    } catch (e) {
      app.notify(`Remove failed: ${String(e)}`, "error")
    }
  }

  const cliSetEnabled = async (brain: string, name: string, enabled: boolean) => {
    setCliServers((rows) => rows.map((r) => (r.brain === brain && r.name === name ? { ...r, enabled } : r)))
    try {
      await app.client.call("mcp.cli_set_enabled", { brain, name, enabled }, 15000)
      // Enabling imports "cli:<brain>:<name>" into the Jarvis registry — refresh both.
      void refresh()
    } catch (e) {
      app.notify(`Failed to update CLI server: ${String(e)}`, "error")
      void loadCli()
    }
  }

  const openAdd = () => {
    setAddForm({ ...EMPTY_FORM })
    setAddError("")
    setApproval(null)
    setShowAdd(true)
  }

  const submitAdd = async () => {
    const f = addForm()
    const endpoint = f.endpoint.trim()
    if (!endpoint) {
      setAddError("Endpoint (or command) is required.")
      return
    }
    setAddBusy(true)
    setAddError("")
    const params: Record<string, unknown> = {
      name: f.name.trim() || "Unnamed",
      transport: f.transport,
      endpoint,
      token: f.token,
      enabled: true,
    }
    try {
      const res = await app.client.call("mcp.add", params, 15000)
      if (res.ok === false && res.needs_approval) {
        setApproval({
          reason: String(res.reason ?? "This package needs approval before it can run."),
          advisoryIds: (res.advisory_ids as string[] | undefined) ?? [],
          pkg: String(res.package ?? ""),
          params,
        })
        return
      }
      app.notify(`Added "${params.name as string}"`, "info")
      setShowAdd(false)
      void loadServers()
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const approveAdd = async () => {
    const a = approval()
    if (!a) return
    setAddBusy(true)
    setAddError("")
    try {
      const res = await app.client.call("mcp.add", { ...a.params, approve: true }, 15000)
      if (res.ok === false && res.needs_approval) {
        setAddError("Still blocked after approval — try again.")
        return
      }
      app.notify(`Added "${a.params.name as string}" (advisory approved)`, "warn")
      setApproval(null)
      setShowAdd(false)
      void loadServers()
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddBusy(false)
    }
  }

  return (
    <div class="mcp-page page-enter">
      <style>{MCP_CSS}</style>

      <div class="mcp-header">
        <div>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>
            MCP SERVERS
          </div>
          <div class="mcp-subtitle">Tool servers the brain can call. computer-use is built in.</div>
        </div>
        <button type="button" class="mcp-btn primary" onClick={openAdd}>
          + Add server
        </button>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={loading()}>
        <div class="mcp-empty">Loading…</div>
      </Show>

      <Show when={!loading() && !error() && servers().length === 0}>
        <div class="mcp-empty">No MCP servers registered.</div>
      </Show>

      <Show when={!loading() && servers().length > 0}>
        <div class="mcp-table">
          <div class="mcp-thead">
            <span class="mcp-th-status" />
            <span class="mcp-th-name">NAME / ENDPOINT</span>
            <span class="mcp-th-meta">TRANSPORT</span>
            <span class="mcp-th-meta">RISK</span>
            <span class="mcp-th-meta">STATUS</span>
            <span class="mcp-th-toggle">ENABLED</span>
            <span class="mcp-th-actions">ACTIONS</span>
          </div>
          <For each={servers()}>
            {(row) => {
              const ts = () => testStates()[row.id] ?? { state: "idle" as const, tools: 0, error: "" }
              return (
                <div class={`mcp-row ${row.builtin ? "builtin" : ""}`}>
                  <span
                    class={`mcp-dot ${ts().state}`}
                    title={ts().state === "fail" ? ts().error || "test failed" : ts().state}
                  />
                  <div class="mcp-name-col">
                    <div class="mcp-name-line">
                      <span class="mcp-name">{row.name}</span>
                      <Show when={row.builtin}>
                        <span class="mcp-badge builtin">built-in</span>
                      </Show>
                    </div>
                    <span class="mcp-endpoint" title={row.endpoint}>
                      {row.endpoint}
                    </span>
                  </div>
                  <span class="mcp-pill">{row.transport}</span>
                  <span class="mcp-pill" style={{ color: riskVar(row.risk), "border-color": riskVar(row.risk) }}>
                    {row.risk || "—"}
                  </span>
                  <span class="mcp-status-cell">
                    <Show when={ts().state === "ok"}>
                      <span class="mcp-pill" style={{ color: "var(--success)", "border-color": "var(--success)" }}>
                        {ts().tools} tools
                      </span>
                    </Show>
                    <Show when={ts().state === "fail"}>
                      <span class="mcp-fail-text" title={ts().error}>
                        test failed
                      </span>
                    </Show>
                    <Show when={ts().state === "idle"}>
                      <span class="mcp-idle-text">not tested</span>
                    </Show>
                    <Show when={ts().state === "testing"}>
                      <span class="mcp-idle-text">testing…</span>
                    </Show>
                  </span>
                  <span class="mcp-toggle-cell">
                    <Toggle checked={row.enabled} onChange={(v) => void setServerEnabled(row.id, v)} />
                  </span>
                  <span class="mcp-actions">
                    <button
                      type="button"
                      class="mcp-btn"
                      disabled={ts().state === "testing"}
                      onClick={() => void testServer(row.id)}
                    >
                      {ts().state === "testing" ? "Testing…" : "Test"}
                    </button>
                    <Show when={!row.builtin}>
                      <button type="button" class="mcp-btn danger" onClick={() => void removeServer(row.id, row.name)}>
                        Remove
                      </button>
                    </Show>
                  </span>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={groupedCli().length > 0}>
        <div class="mcp-cli-section">
          <div class="hud-label" style={{ color: "var(--text)", "font-size": "13px" }}>
            CLI SERVERS (PER BRAIN)
          </div>
          <div class="mcp-cli-hint">
            Your codex/claude CLI's own MCP servers. Off = isolated (default). Toggle on to let Jarvis use one.
          </div>
          <For each={groupedCli()}>
            {(group) => (
              <div class="mcp-cli-group">
                <div class="mcp-cli-brain">{group.brain.toUpperCase()}</div>
                <For each={group.rows}>
                  {(cs) => (
                    <div class="mcp-cli-row">
                      <div class="mcp-name-col">
                        <span class="mcp-name">{cs.name}</span>
                        <span class="mcp-endpoint" title={cs.endpoint}>
                          {cs.transport}
                          {cs.endpoint ? ` · ${cs.endpoint}` : ""}
                        </span>
                      </div>
                      <Toggle checked={cs.enabled} onChange={(v) => void cliSetEnabled(cs.brain, cs.name, v)} />
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={showAdd()}>
        <div class="mcp-modal-backdrop" onClick={() => !addBusy() && setShowAdd(false)}>
          <div class="mcp-modal" onClick={(e) => e.stopPropagation()}>
            <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "14px" }}>
              ADD MCP SERVER
            </div>

            <Show when={!approval()}>
              <label class="mcp-field">
                <span>Name</span>
                <input
                  type="text"
                  placeholder="My tool server"
                  value={addForm().name}
                  onInput={(e) => setAddForm((f) => ({ ...f, name: e.currentTarget.value }))}
                />
              </label>
              <label class="mcp-field">
                <span>Transport</span>
                <div class="mcp-transport-toggle">
                  <button
                    type="button"
                    class={addForm().transport === "http" ? "active" : ""}
                    onClick={() => setAddForm((f) => ({ ...f, transport: "http" }))}
                  >
                    http
                  </button>
                  <button
                    type="button"
                    class={addForm().transport === "stdio" ? "active" : ""}
                    onClick={() => setAddForm((f) => ({ ...f, transport: "stdio" }))}
                  >
                    stdio
                  </button>
                </div>
              </label>
              <label class="mcp-field">
                <span>{addForm().transport === "http" ? "Endpoint (URL)" : "Command"}</span>
                <input
                  type="text"
                  placeholder={addForm().transport === "http" ? "http://host:port/mcp" : "npx -y some-mcp-server"}
                  value={addForm().endpoint}
                  onInput={(e) => setAddForm((f) => ({ ...f, endpoint: e.currentTarget.value }))}
                />
              </label>
              <Show when={addForm().transport === "http"}>
                <label class="mcp-field">
                  <span>Bearer token (optional)</span>
                  <input
                    type="password"
                    placeholder="token…"
                    value={addForm().token}
                    onInput={(e) => setAddForm((f) => ({ ...f, token: e.currentTarget.value }))}
                  />
                </label>
              </Show>

              <Show when={addError()}>
                <div class="setup-error">⚠ {addError()}</div>
              </Show>

              <div class="mcp-modal-actions">
                <button type="button" class="mcp-btn" onClick={() => setShowAdd(false)} disabled={addBusy()}>
                  Cancel
                </button>
                <button type="button" class="mcp-btn primary" onClick={() => void submitAdd()} disabled={addBusy()}>
                  {addBusy() ? "Adding…" : "Add server"}
                </button>
              </div>
            </Show>

            <Show when={approval()}>
              {(a) => (
                <>
                  <div class="mcp-approval-warn">
                    ⚠ Supply-chain check flagged this package{a().pkg ? ` (${a().pkg})` : ""}.
                  </div>
                  <div class="mcp-approval-reason">{a().reason}</div>
                  <Show when={a().advisoryIds.length > 0}>
                    <div class="mcp-approval-advisories">
                      <For each={a().advisoryIds}>{(id) => <span class="mcp-badge risk-high">{id}</span>}</For>
                    </div>
                  </Show>
                  <Show when={addError()}>
                    <div class="setup-error">⚠ {addError()}</div>
                  </Show>
                  <div class="mcp-modal-actions">
                    <button
                      type="button"
                      class="mcp-btn"
                      onClick={() => {
                        setApproval(null)
                      }}
                      disabled={addBusy()}
                    >
                      Back
                    </button>
                    <button type="button" class="mcp-btn danger" onClick={() => void approveAdd()} disabled={addBusy()}>
                      {addBusy() ? "Approving…" : "Approve anyway & add"}
                    </button>
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      class={`mcp-toggle ${props.checked ? "on" : ""}`}
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="mcp-toggle-thumb" />
    </button>
  )
}

const MCP_CSS = `
.mcp-page { display: flex; flex-direction: column; gap: 16px; max-width: 1080px; }
.mcp-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.mcp-subtitle { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
.mcp-empty { color: var(--text-faint); font-size: 12px; padding: 6px 2px; }

.mcp-btn {
  all: unset; cursor: pointer; padding: 6px 12px; border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft); background: var(--surface); color: var(--text-muted);
  font-family: var(--font-sans); font-size: 12px; white-space: nowrap;
  transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease, background var(--dur-fast) ease;
}
.mcp-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
.mcp-btn:disabled { opacity: 0.5; cursor: default; }
.mcp-btn.primary { background: var(--accent-dim); border-color: var(--accent-dim); color: var(--accent-bright); }
.mcp-btn.primary:hover:not(:disabled) { background: var(--accent-faint); border-color: var(--accent); }
.mcp-btn.danger { color: var(--danger); }
.mcp-btn.danger:hover:not(:disabled) { border-color: var(--danger-dim); background: var(--danger-dim); }

.mcp-table { display: flex; flex-direction: column; gap: 6px; }
.mcp-thead, .mcp-row {
  display: grid;
  grid-template-columns: 14px minmax(180px, 1.6fr) 74px 70px 96px 52px auto;
  align-items: center;
  gap: 12px;
}
.mcp-thead {
  padding: 0 14px 4px;
  font-family: var(--font-display); font-size: 9px; letter-spacing: var(--track-mid);
  color: var(--text-faint);
}
.mcp-row {
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-faint);
  background: var(--surface);
  transition: border-color var(--dur-fast) ease;
}
.mcp-row:hover { border-color: var(--accent-dim); }
.mcp-row.builtin { background: var(--surface-strong); border-color: var(--accent-dim); border-left: 3px solid var(--accent); }

.mcp-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); justify-self: center; }
.mcp-dot.ok { background: var(--success); box-shadow: 0 0 6px var(--success); }
.mcp-dot.fail { background: var(--danger); }
.mcp-dot.testing { background: var(--amber); animation: mcp-pulse 900ms ease-in-out infinite; }
@keyframes mcp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.mcp-name-col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mcp-name-line { display: flex; align-items: center; gap: 8px; }
.mcp-name { color: var(--text); font-size: 13px; font-weight: 500; }
.mcp-endpoint {
  color: var(--text-faint); font-family: var(--font-mono); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mcp-badge {
  font-family: var(--font-sans); font-size: 9px; letter-spacing: 0.4px; padding: 2px 7px;
  border-radius: 5px; background: var(--accent-faint); color: var(--accent);
}
.mcp-badge.risk-high { background: var(--danger-dim); color: var(--danger); }

.mcp-pill {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted);
  border: 1px solid var(--hairline-soft); border-radius: 6px; padding: 2px 8px; text-align: center;
  justify-self: start; white-space: nowrap;
}
.mcp-status-cell { display: flex; align-items: center; }
.mcp-fail-text { color: var(--danger); font-size: 11px; }
.mcp-idle-text { color: var(--text-faint); font-size: 11px; }

.mcp-toggle-cell, .mcp-th-toggle { justify-self: center; }
.mcp-toggle {
  all: unset; cursor: pointer; width: 34px; height: 19px; border-radius: 999px;
  background: var(--hairline); border: 1px solid var(--hairline-soft); position: relative;
  transition: background var(--dur-fast) ease;
}
.mcp-toggle.on { background: var(--accent-dim); border-color: var(--accent); }
.mcp-toggle-thumb {
  position: absolute; top: 1px; left: 1px; width: 15px; height: 15px; border-radius: 50%;
  background: var(--text-muted); transition: transform var(--dur-fast) ease, background var(--dur-fast) ease;
}
.mcp-toggle.on .mcp-toggle-thumb { transform: translateX(15px); background: var(--accent-bright); }

.mcp-actions { display: flex; gap: 6px; justify-self: end; }

.mcp-cli-section { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.mcp-cli-hint { color: var(--text-muted); font-size: 11px; max-width: 640px; }
.mcp-cli-group { display: flex; flex-direction: column; gap: 5px; margin-top: 4px; }
.mcp-cli-brain { color: var(--accent-bright); font-family: var(--font-mono); font-size: 11px; letter-spacing: var(--track-mid); margin-top: 2px; }
.mcp-cli-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 12px; border-radius: var(--radius-sm); background: var(--panel-soft); border: 1px solid var(--hairline-faint);
}

.mcp-modal-backdrop {
  position: fixed; inset: 0; z-index: 250; background: rgba(4,7,12,0.6);
  display: flex; align-items: center; justify-content: center;
}
.mcp-modal {
  width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); overflow-y: auto;
  background: var(--surface-strong); border: 1px solid var(--accent-dim); border-radius: var(--radius);
  padding: 20px; display: flex; flex-direction: column; gap: 12px;
}
.mcp-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-muted); }
.mcp-field input {
  background: var(--surface-input); border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
  color: var(--text); padding: 8px 10px; font-family: var(--font-mono); font-size: 12px;
}
.mcp-field input:focus { outline: none; border-color: var(--accent); }
.mcp-transport-toggle { display: flex; gap: 8px; }
.mcp-transport-toggle button {
  all: unset; cursor: pointer; padding: 6px 14px; border-radius: var(--radius-xs);
  border: 1px solid var(--hairline); color: var(--text-muted); font-family: var(--font-mono); font-size: 12px;
}
.mcp-transport-toggle button.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
.mcp-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.mcp-approval-warn { color: var(--danger); font-size: 12px; font-weight: 600; }
.mcp-approval-reason { color: var(--text-muted); font-size: 12px; line-height: 1.4; }
.mcp-approval-advisories { display: flex; gap: 6px; flex-wrap: wrap; }
`

const page: PageDef = { id: "mcp", label: "MCP", section: "SYSTEM", order: 0, component: McpPage }
export default page
