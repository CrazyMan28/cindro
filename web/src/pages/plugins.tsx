// PLUGINS — marketplace browser/installer, ported from desktop/qml/PluginsPage.qml's
// intent (catalog cards -> Install / Enable toggle / Remove, with a signed/verified
// badge and a permission-approval gate for unverified or computer-use-requesting
// plugins). Wires plugins.catalog/install/set_enabled/remove — see
// daemon/src/ControlServer.cpp handlePlugins* for the exact response shapes this
// mirrors (install() can come back needs_approval:true instead of installing).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"

interface PluginManifest {
  id: string
  name: string
  author: string
  version: string
  kind: string // "mcp" | "skill" | "both"
  permissions: string[]
  description: string
  installed: boolean
  enabled: boolean
  verified: boolean
  signed: boolean
  granted_permissions?: string[]
  transport?: string
  endpoint?: string
}

interface ApprovalPrompt {
  id: string
  name: string
  reason: string
  permissions: string[]
  verified: boolean
  approvalTier: string
}

function kindVar(kind: string): string {
  if (kind === "mcp") return "var(--accent)"
  if (kind === "skill") return "var(--success)"
  return "var(--amber)" // "both"
}

function PluginsPage() {
  const app = useApp()
  const [plugins, setPlugins] = createSignal<PluginManifest[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal<Set<string>>(new Set())
  const [approval, setApproval] = createSignal<ApprovalPrompt | null>(null)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const setRowBusy = (id: string, v: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (v) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const loadCatalog = async () => {
    try {
      const res = await app.client.call("plugins.catalog", {}, 15000)
      if (!alive) return
      setPlugins((res.plugins as PluginManifest[] | undefined) ?? [])
      setError("")
    } catch (e) {
      if (alive) setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => void loadCatalog())

  const install = async (p: PluginManifest, approve = false) => {
    setRowBusy(p.id, true)
    try {
      const res = await app.client.call("plugins.install", approve ? { id: p.id, approve: true } : { id: p.id }, 15000)
      if (res.ok === false && res.needs_approval) {
        setApproval({
          id: p.id,
          name: p.name,
          reason: String(res.reason ?? "This plugin needs approval before it can be installed."),
          permissions: (res.permissions as string[] | undefined) ?? p.permissions,
          verified: Boolean(res.verified),
          approvalTier: String(res.approval_tier ?? "biometric"),
        })
        return
      }
      app.notify(`Installed "${p.name}"`, approve ? "warn" : "info")
      setApproval(null)
      void loadCatalog()
    } catch (e) {
      app.notify(`Install failed: ${String(e)}`, "error")
    } finally {
      setRowBusy(p.id, false)
    }
  }

  const setEnabled = async (p: PluginManifest, enabled: boolean) => {
    setPlugins((rows) => rows.map((r) => (r.id === p.id ? { ...r, enabled } : r)))
    setRowBusy(p.id, true)
    try {
      await app.client.call("plugins.set_enabled", { id: p.id, enabled }, 15000)
    } catch (e) {
      app.notify(`Failed to update "${p.name}": ${String(e)}`, "error")
      void loadCatalog()
    } finally {
      setRowBusy(p.id, false)
    }
  }

  const remove = async (p: PluginManifest) => {
    setRowBusy(p.id, true)
    try {
      await app.client.call("plugins.remove", { id: p.id }, 15000)
      app.notify(`Removed "${p.name}"`, "info")
      void loadCatalog()
    } catch (e) {
      app.notify(`Remove failed: ${String(e)}`, "error")
    } finally {
      setRowBusy(p.id, false)
    }
  }

  return (
    <div class="plg-page page-enter">
      <style>{PLUGINS_CSS}</style>

      <div class="plg-header">
        <div>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>
            PLUGINS
          </div>
          <div class="plg-subtitle">Install MCP tools and skills to extend what Orin can do.</div>
        </div>
        <button type="button" class="plg-btn" onClick={() => void loadCatalog()}>
          Refresh
        </button>
      </div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={loading()}>
        <div class="plg-empty">Loading…</div>
      </Show>

      <Show when={!loading() && !error() && plugins().length === 0}>
        <div class="plg-empty">No plugins in the catalog.</div>
      </Show>

      <div class="plg-list">
        <For each={plugins()}>
          {(p) => {
            const rowBusy = () => busy().has(p.id)
            return (
              <div class="plg-row">
                <div class="plg-row-top">
                  <span class="plg-kind" style={{ color: kindVar(p.kind), "border-color": kindVar(p.kind) }}>
                    {p.kind.toUpperCase()}
                  </span>
                  <span class="plg-name">{p.name}</span>
                  <span class="plg-version">v{p.version}</span>
                  <Show when={p.verified}>
                    <span class="plg-badge verified">✓ verified</span>
                  </Show>
                  <Show when={!p.verified && p.signed}>
                    <span class="plg-badge">signed</span>
                  </Show>
                  <Show when={!p.signed}>
                    <span class="plg-badge unverified">unsigned</span>
                  </Show>
                  <span class="plg-author">by {p.author}</span>

                  <span class="plg-row-actions">
                    <Show when={p.installed}>
                      <span class="plg-enable-label" style={{ color: p.enabled ? "var(--success)" : "var(--text-muted)" }}>
                        {p.enabled ? "Enabled" : "Disabled"}
                      </span>
                      <Toggle checked={p.enabled} disabled={rowBusy()} onChange={(v) => void setEnabled(p, v)} />
                      <button type="button" class="plg-btn danger" disabled={rowBusy()} onClick={() => void remove(p)}>
                        Remove
                      </button>
                    </Show>
                    <Show when={!p.installed}>
                      <button type="button" class="plg-btn primary" disabled={rowBusy()} onClick={() => void install(p)}>
                        {rowBusy() ? "Installing…" : "Install"}
                      </button>
                    </Show>
                  </span>
                </div>

                <div class="plg-desc" title={p.description}>
                  {p.description}
                </div>

                <Show when={p.permissions.length > 0}>
                  <div class="plg-perms">
                    <span class="plg-perms-label">PERMS</span>
                    <For each={p.permissions}>{(perm) => <span class="plg-perm-chip">{perm}</span>}</For>
                  </div>
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      <Show when={approval()}>
        {(a) => (
          <div class="plg-modal-backdrop" onClick={() => setApproval(null)}>
            <div class="plg-modal" onClick={(e) => e.stopPropagation()}>
              <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "14px" }}>
                APPROVAL NEEDED
              </div>
              <div class="plg-approval-name">{a().name}</div>
              <div class="plg-approval-reason">{a().reason}</div>
              <Show when={a().permissions.length > 0}>
                <div class="plg-perms">
                  <span class="plg-perms-label">GRANTS</span>
                  <For each={a().permissions}>{(perm) => <span class="plg-perm-chip warn">{perm}</span>}</For>
                </div>
              </Show>
              <div class="plg-approval-tier">Approval tier: {a().approvalTier}</div>
              <div class="plg-modal-actions">
                <button type="button" class="plg-btn" onClick={() => setApproval(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="plg-btn danger"
                  onClick={() => {
                    const p = plugins().find((x) => x.id === a().id)
                    if (p) void install(p, true)
                  }}
                >
                  Approve & install
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function Toggle(props: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      class={`plg-toggle ${props.checked ? "on" : ""}`}
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="plg-toggle-thumb" />
    </button>
  )
}

const PLUGINS_CSS = `
.plg-page { display: flex; flex-direction: column; gap: 16px; max-width: 1080px; }
.plg-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.plg-subtitle { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
.plg-empty { color: var(--text-faint); font-size: 12px; padding: 6px 2px; }

.plg-btn {
  all: unset; cursor: pointer; padding: 6px 12px; border-radius: var(--radius-xs);
  border: 1px solid var(--hairline-soft); background: var(--surface); color: var(--text-muted);
  font-family: var(--font-sans); font-size: 12px; white-space: nowrap;
  transition: border-color var(--dur-fast) ease, color var(--dur-fast) ease, background var(--dur-fast) ease;
}
.plg-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
.plg-btn:disabled { opacity: 0.5; cursor: default; }
.plg-btn.primary { background: var(--accent-dim); border-color: var(--accent-dim); color: var(--accent-bright); }
.plg-btn.primary:hover:not(:disabled) { background: var(--accent-faint); border-color: var(--accent); }
.plg-btn.danger { color: var(--danger); }
.plg-btn.danger:hover:not(:disabled) { border-color: var(--danger-dim); background: var(--danger-dim); }

.plg-list { display: flex; flex-direction: column; gap: 8px; }
.plg-row {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 14px; border-radius: var(--radius-sm);
  border: 1px solid var(--hairline-faint); background: var(--surface);
  transition: border-color var(--dur-fast) ease;
}
.plg-row:hover { border-color: var(--accent-dim); }

.plg-row-top { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.plg-kind {
  font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.5px; padding: 2px 7px;
  border: 1px solid; border-radius: 5px;
}
.plg-name { color: var(--text); font-size: 13.5px; font-weight: 600; }
.plg-version { color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; }
.plg-author { color: var(--text-muted); font-size: 11.5px; }
.plg-badge {
  font-family: var(--font-sans); font-size: 9.5px; letter-spacing: 0.3px; padding: 2px 7px;
  border-radius: 5px; background: var(--panel-soft); color: var(--text-muted); border: 1px solid var(--hairline-soft);
}
.plg-badge.verified { background: var(--accent-faint); color: var(--accent); border-color: var(--accent-dim); }
.plg-badge.unverified { background: var(--danger-dim); color: var(--danger); border-color: var(--danger-dim); }

.plg-row-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.plg-enable-label { font-size: 11.5px; }

.plg-desc {
  color: var(--text-muted); font-size: 12.5px; line-height: 1.4;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}

.plg-perms { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.plg-perms-label {
  font-family: var(--font-display); font-size: 9px; letter-spacing: var(--track-mid); color: var(--text-faint);
}
.plg-perm-chip {
  font-family: var(--font-mono); font-size: 10px; color: var(--amber);
  background: var(--amber-dim); border-radius: 5px; padding: 2px 7px;
}
.plg-perm-chip.warn { color: var(--amber); background: var(--amber-dim); }

.plg-toggle {
  all: unset; cursor: pointer; width: 34px; height: 19px; border-radius: 999px;
  background: var(--hairline); border: 1px solid var(--hairline-soft); position: relative;
  transition: background var(--dur-fast) ease;
}
.plg-toggle.on { background: var(--accent-dim); border-color: var(--accent); }
.plg-toggle:disabled { opacity: 0.5; cursor: default; }
.plg-toggle-thumb {
  position: absolute; top: 1px; left: 1px; width: 15px; height: 15px; border-radius: 50%;
  background: var(--text-muted); transition: transform var(--dur-fast) ease, background var(--dur-fast) ease;
}
.plg-toggle.on .plg-toggle-thumb { transform: translateX(15px); background: var(--accent-bright); }

.plg-modal-backdrop {
  position: fixed; inset: 0; z-index: 250; background: rgba(4,7,12,0.6);
  display: flex; align-items: center; justify-content: center;
}
.plg-modal {
  width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); overflow-y: auto;
  background: var(--surface-strong); border: 1px solid var(--accent-dim); border-radius: var(--radius);
  padding: 20px; display: flex; flex-direction: column; gap: 12px;
}
.plg-approval-name { color: var(--text); font-size: 13px; font-weight: 600; }
.plg-approval-reason { color: var(--text-muted); font-size: 12px; line-height: 1.4; }
.plg-approval-tier { color: var(--text-faint); font-size: 11px; font-family: var(--font-mono); }
.plg-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
`

const page: PageDef = { id: "plugins", label: "PLUGINS", section: "SYSTEM", order: 1, component: PluginsPage }
export default page
