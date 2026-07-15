// The Proxmox-only page set. Read data comes through proxmoxop.tool (free
// operator read tools) and the proxmoxop.* board/policy verbs; every mutating
// Proxmox action is issued into the operator chat so the permission gate
// applies (an approval card then appears in the side-rail / Chat page).

import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { Client } from "./client"
import type { ChatController } from "./chat"

type PageProps = { client: Client; controller: ChatController; goChat: () => void }

async function readTool(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  try {
    return await client.call("proxmoxop.tool", { tool, args }, 20000)
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v
  if (v && Array.isArray(v.data)) return v.data
  return []
}

// --- Home: live status tiles (editable widget grid is Phase 2) ---------------
export const HomePage: Component<PageProps> = (props) => {
  const [nodes, setNodes] = createSignal<any[]>([])
  const [vms, setVms] = createSignal<any[]>([])
  const [cluster, setCluster] = createSignal<any[]>([])
  const refresh = async () => {
    const [n, v, c] = await Promise.all([
      readTool(props.client, "proxmox_node_list"),
      readTool(props.client, "proxmox_vm_list"),
      readTool(props.client, "proxmox_cluster_status"),
    ])
    setNodes(asArray(n.result))
    setVms(asArray(v.result))
    setCluster(asArray(c.result))
  }
  onMount(refresh)
  const running = () => vms().filter((x) => x.status === "running").length
  return (
    <div class="px-page px-fade">
      <h2 class="px-hud">Overview</h2>
      <div class="px-tiles">
        <div class="px-tile">
          <div class="px-tile-k">Guests</div>
          <div class="px-tile-v">{vms().length}</div>
          <div class="px-tile-sub">{running()} running</div>
        </div>
        <div class="px-tile">
          <div class="px-tile-k">Nodes</div>
          <div class="px-tile-v">{nodes().length}</div>
          <div class="px-tile-sub">{cluster().find((c) => c.type === "cluster")?.name ?? "standalone"}</div>
        </div>
        <div class="px-tile">
          <div class="px-tile-k">Quorum</div>
          <div class="px-tile-v">
            {cluster().some((c) => c.type === "node" && c.online === 0) ? "degraded" : "ok"}
          </div>
          <div class="px-tile-sub">{cluster().filter((c) => c.type === "node").length} members</div>
        </div>
      </div>
      <div class="px-note">
        Ask Jarvis in the side chat to reshape this board (it can add/move tiles) — a fully
        drag-and-drop widget grid lands next.
        <button class="px-btn" style={{ "margin-left": "8px" }} onClick={refresh}>Refresh</button>
      </div>
    </div>
  )
}

// --- VMs: list + gated lifecycle --------------------------------------------
export const VmsPage: Component<PageProps> = (props) => {
  const [vms, setVms] = createSignal<any[]>([])
  const [err, setErr] = createSignal("")
  const refresh = async () => {
    const r = await readTool(props.client, "proxmox_vm_list")
    if (r.ok === false) setErr(r.error ?? "failed")
    else setErr("")
    setVms(asArray(r.result).sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0)))
  }
  onMount(() => {
    void refresh()
    const t = setInterval(refresh, 6000)
    onCleanup(() => clearInterval(t))
  })
  const act = (vm: any, action: string) => {
    const kind = vm.type === "lxc" ? "container" : "VM"
    void props.controller.send(`${action} ${kind} ${vm.vmid} (${vm.name ?? ""})`)
    props.goChat()
  }
  return (
    <div class="px-page px-fade">
      <div class="px-page-head">
        <h2 class="px-hud">Virtual Machines</h2>
        <button class="px-btn" onClick={refresh}>Refresh</button>
      </div>
      <Show when={err()}>
        <div class="px-msg px-msg-error">{err()}</div>
      </Show>
      <table class="px-table">
        <thead>
          <tr><th>VMID</th><th>Name</th><th>Type</th><th>Node</th><th>Status</th><th>CPU</th><th>Mem</th><th>Actions</th></tr>
        </thead>
        <tbody>
          <For each={vms()}>
            {(vm) => (
              <tr>
                <td>{vm.vmid}</td>
                <td>{vm.name}</td>
                <td>{vm.type}</td>
                <td>{vm.node}</td>
                <td><span class={`px-pill ${vm.status === "running" ? "on" : "off"}`}>{vm.status}</span></td>
                <td>{vm.maxcpu ? `${((vm.cpu ?? 0) * 100).toFixed(0)}% / ${vm.maxcpu}` : "—"}</td>
                <td>{vm.maxmem ? `${((vm.mem ?? 0) / vm.maxmem * 100).toFixed(0)}%` : "—"}</td>
                <td class="px-row-actions">
                  <Show
                    when={vm.status === "running"}
                    fallback={<button class="px-btn px-btn-ok" onClick={() => act(vm, "start")}>Start</button>}
                  >
                    <button class="px-btn" onClick={() => act(vm, "reboot")}>Reboot</button>
                    <button class="px-btn px-btn-danger" onClick={() => act(vm, "shutdown")}>Shutdown</button>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="px-note">Lifecycle actions are sent to Jarvis and gated by your permission policy — approve them in chat.</div>
    </div>
  )
}

// --- Tasks: a Kanban Jarvis can also edit -----------------------------------
export const TasksPage: Component<PageProps> = (props) => {
  const [tasks, setTasks] = createSignal<any[]>([])
  const [title, setTitle] = createSignal("")
  const cols: Array<{ key: string; label: string }> = [
    { key: "todo", label: "To do" },
    { key: "doing", label: "Doing" },
    { key: "done", label: "Done" },
  ]
  const refresh = async () => {
    try {
      const r = await props.client.call<any>("proxmoxop.tasks_list")
      setTasks(Array.isArray(r.tasks) ? r.tasks : [])
    } catch {
      /* ignore */
    }
  }
  onMount(refresh)
  const add = async () => {
    const t = title().trim()
    if (!t) return
    setTitle("")
    await props.client.call("proxmoxop.tasks_create", { title: t })
    void refresh()
  }
  const move = async (id: string, status: string) => {
    await props.client.call("proxmoxop.tasks_update", { id, status })
    void refresh()
  }
  return (
    <div class="px-page px-fade">
      <div class="px-page-head">
        <h2 class="px-hud">Tasks for Jarvis</h2>
        <div class="px-composer px-inline">
          <input class="px-input px-input-1" placeholder="New task…" value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add() }} />
          <button class="px-btn px-btn-ok" onClick={add}>Add</button>
        </div>
      </div>
      <div class="px-kanban">
        <For each={cols}>
          {(col) => (
            <div class="px-kcol">
              <div class="px-kcol-head">{col.label}</div>
              <For each={tasks().filter((t) => (t.status ?? "todo") === col.key)}>
                {(t) => (
                  <div class="px-kcard">
                    <div class="px-kcard-title">{t.title}</div>
                    <Show when={t.detail}><div class="px-kcard-detail">{t.detail}</div></Show>
                    <div class="px-kcard-move">
                      <For each={cols.filter((c) => c.key !== (t.status ?? "todo"))}>
                        {(c) => <button class="px-btn px-btn-xs" onClick={() => move(t.id, c.key)}>→ {c.label}</button>}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

// --- Permissions: the user-configurable gate --------------------------------
export const PermissionsPage: Component<PageProps> = (props) => {
  const [mode, setMode] = createSignal("ask")
  const [rules, setRules] = createSignal<any[]>([])
  const [pending, setPending] = createSignal<any[]>([])
  const modes: Array<{ key: string; label: string; sub: string }> = [
    { key: "ask", label: "Ask before risky", sub: "reads free; approve each change" },
    { key: "allow", label: "Full autonomy", sub: "Jarvis acts without asking" },
    { key: "deny", label: "Read-only", sub: "block every change" },
  ]
  const loadPolicy = async () => {
    try {
      const r = await props.client.call<any>("proxmoxop.policy_get")
      setMode(String(r.default_risky ?? "ask"))
      setRules(Array.isArray(r.rules) ? r.rules : [])
    } catch {
      /* ignore */
    }
  }
  const loadPending = async () => {
    try {
      const r = await props.client.call<any>("proxmoxop.pending_list")
      setPending(Array.isArray(r.pending) ? r.pending : [])
    } catch {
      /* ignore */
    }
  }
  onMount(() => {
    void loadPolicy()
    void loadPending()
    const off = props.client.on("proxmoxop.approval", () => void loadPending())
    onCleanup(off)
  })
  const saveMode = async (m: string) => {
    setMode(m)
    await props.client.call("proxmoxop.policy_set", { default_risky: m, rules: rules() })
  }
  const removeRule = async (id: string) => {
    const next = rules().filter((r) => r.id !== id)
    setRules(next)
    await props.client.call("proxmoxop.policy_set", { default_risky: mode(), rules: next })
  }
  const answer = async (p: any, decision: string) => {
    await props.client.call("approval.respond", {
      session_id: p.session_id,
      approval_id: p.approval_id,
      decision,
    })
    void loadPending()
  }
  return (
    <div class="px-page px-fade">
      <h2 class="px-hud">Permissions</h2>
      <div class="px-note">Choose how much Jarvis may do on its own. Reads are always free.</div>
      <div class="px-modes">
        <For each={modes}>
          {(m) => (
            <button class={`px-mode ${mode() === m.key ? "sel" : ""}`} onClick={() => saveMode(m.key)}>
              <div class="px-mode-label">{m.label}</div>
              <div class="px-mode-sub">{m.sub}</div>
            </button>
          )}
        </For>
      </div>

      <Show when={pending().length > 0}>
        <h3 class="px-hud px-sub">Waiting for you</h3>
        <For each={pending()}>
          {(p) => (
            <div class={`px-approval risk-${p.risk}`}>
              <div class="px-approval-body">{p.summary}</div>
              <div class="px-approval-actions">
                <button class="px-btn px-btn-ok" onClick={() => answer(p, "allow")}>Allow</button>
                <button class="px-btn" onClick={() => answer(p, "always")}>Always</button>
                <button class="px-btn px-btn-danger" onClick={() => answer(p, "deny")}>Deny</button>
              </div>
            </div>
          )}
        </For>
      </Show>

      <h3 class="px-hud px-sub">Standing rules</h3>
      <Show when={rules().length === 0}><div class="px-note">No custom rules yet. Answering “Always” in an approval adds one here.</div></Show>
      <For each={rules()}>
        {(r) => (
          <div class="px-rule">
            <span class={`px-pill ${r.effect === "allow" ? "on" : r.effect === "deny" ? "off" : ""}`}>{r.effect}</span>
            <code class="px-rule-match">{JSON.stringify(r.match)}</code>
            <button class="px-btn px-btn-xs px-btn-danger" onClick={() => removeRule(r.id)}>remove</button>
          </div>
        )}
      </For>
    </div>
  )
}
