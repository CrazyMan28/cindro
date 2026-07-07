// Outpost — pair remote Windows/Linux/macOS machines and run gated exec +
// screenshot on them by name. Replaces the old SSH page. Pairing-card + poll
// pattern mirrors settings/devices.tsx; the exec console mirrors the old
// ssh.tsx. All verbs proxy through the daemon to outpost-mcp (:8798).
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import { ControlError } from "../core/control-client"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"

interface Machine {
  id: string
  name: string
  os: string
  transport: string
  status: string
  last_seen: number
}

interface PairStart {
  pairing_code: string
  bootstrap_id: string
  expires_at: number
  install_cmd_linux: string
  install_cmd_windows: string
}

interface ExecEntry {
  id: number
  machine: string
  cmd: string
  output: string
  ok: boolean
}

interface ProxmoxVm {
  vmid: number
  name: string
  status: string
  cores: number
  memory_mb: number
  cpu_pct: number
  mem_pct: number
  blocklisted: boolean
  pending_restart: boolean
  last_action: string
  last_action_at: number | null
}

interface ProxmoxMemory {
  id: string
  text: string
  tags: string[]
  created: number
  updated: number
  scope?: string
  entityRef?: string
  score?: number
}

let entrySeq = 0

function fmtTime(ms?: number): string {
  if (!ms) return ""
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ""
  }
}

function timeAgo(ms: number): string {
  if (!ms) return "never"
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

function Outpost() {
  const app = useApp()

  const [connected, setConnected] = createSignal(app.client.connected)
  const [machines, setMachines] = createSignal<Machine[]>([])
  // Holds the selected machine's `id`, not its `name` — names aren't
  // guaranteed unique across paired machines, and id is what the registry
  // resolves unambiguously (mirrors how revoke already targets by id).
  const [selected, setSelected] = createSignal("")
  const selectedMachine = () => machines().find((m) => m.id === selected())
  const selectedName = () => selectedMachine()?.name ?? ""
  const [listError, setListError] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)
  const [revoking, setRevoking] = createSignal("")

  const [pairing, setPairing] = createSignal(false)
  const [pair, setPair] = createSignal<PairStart | null>(null)
  const [pairState, setPairState] = createSignal("")
  const [now, setNow] = createSignal(Date.now())

  const [cmdText, setCmdText] = createSignal("")
  const [running, setRunning] = createSignal(false)
  const [entries, setEntries] = createSignal<ExecEntry[]>([])
  const [shot, setShot] = createSignal("")
  const [shotBusy, setShotBusy] = createSignal(false)

  const [vms, setVms] = createSignal<ProxmoxVm[]>([])
  const [vmsError, setVmsError] = createSignal("")
  const [vmsLoaded, setVmsLoaded] = createSignal(false)
  const [installing, setInstalling] = createSignal(false)
  const [installOk, setInstallOk] = createSignal(false)
  const [installMsg, setInstallMsg] = createSignal("")
  const [restartingVmid, setRestartingVmid] = createSignal<number | null>(null)
  const [blocklistBusyVmid, setBlocklistBusyVmid] = createSignal<number | null>(null)
  const [report, setReport] = createSignal<ProxmoxMemory[]>([])
  const [reportLoading, setReportLoading] = createSignal(false)
  const [reportError, setReportError] = createSignal("")
  const [reportLoaded, setReportLoaded] = createSignal(false)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const load = async () => {
    try {
      const res = await app.client.call("outpost.list", {}, 15000)
      if (!alive) return
      const list = (res.machines ?? []) as Machine[]
      setMachines(list)
      if (!list.some((m) => m.id === selected())) setSelected(list[0]?.id ?? "")
      setListError("")
    } catch (e) {
      if (!alive) return
      setListError(String(e))
    } finally {
      if (alive) setLoaded(true)
    }
  }

  // proxmox.status for the currently selected machine — piggybacks on the
  // same 15s cadence as the machines-list poll (below) rather than running
  // its own timer.
  const loadVms = async () => {
    const machine = selected()
    if (!machine) {
      setVms([])
      setVmsLoaded(false)
      return
    }
    try {
      const res = await app.client.call("proxmox.status", { machine }, 15000)
      if (!alive || selected() !== machine) return
      setVms((res.vms ?? []) as ProxmoxVm[])
      setVmsError("")
    } catch (e) {
      if (!alive || selected() !== machine) return
      setVmsError(String(e))
    } finally {
      if (alive && selected() === machine) setVmsLoaded(true)
    }
  }

  onMount(() => {
    void load()
    const conn = setInterval(() => setConnected(app.client.connected), 500)
    const timer = setInterval(() => {
      void load()
      void loadVms()
    }, 15000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      clearInterval(conn)
      clearInterval(timer)
      clearInterval(tick)
    })
  })

  // Selecting a different machine: drop stale VM/install/report state from
  // the previous one and fetch this one's VM status right away instead of
  // waiting for the next 15s tick.
  createEffect(() => {
    selected()
    setInstallMsg("")
    setReport([])
    setReportLoaded(false)
    setReportError("")
    void loadVms()
  })

  const remaining = () => {
    const p = pair()
    return p ? Math.max(0, Math.floor((p.expires_at - now()) / 1000)) : 0
  }

  const startPairing = async () => {
    setPairing(true)
    setPairState("pending")
    try {
      const res = (await app.client.call("outpost.pair_start", {}, 15000)) as unknown as PairStart
      if (!alive) return
      setPair(res)
      void pollPairing(res.bootstrap_id)
    } catch (e) {
      app.notify(`Pairing failed: ${String(e)}`, "error")
    } finally {
      if (alive) setPairing(false)
    }
  }

  const pollPairing = async (bootstrapId: string) => {
    for (let i = 0; i < 120 && alive; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      if (!alive || pair()?.bootstrap_id !== bootstrapId) return
      try {
        const st = await app.client.call("outpost.pair_status", { bootstrap_id: bootstrapId }, 15000)
        const status = String(st.status ?? "")
        setPairState(status)
        if (status === "paired") {
          app.notify("Machine paired.")
          setPair(null)
          await load()
          return
        }
        if (status === "expired" || status === "unknown") return
      } catch {
        // transient; keep polling
      }
    }
  }

  const revoke = async (m: Machine) => {
    setRevoking(m.id)
    try {
      await app.client.call("outpost.revoke", { machine: m.id }, 15000)
      app.notify(`Revoked ${m.name}.`)
      await load()
    } catch (e) {
      app.notify(`Revoke failed: ${String(e)}`, "error")
    } finally {
      if (alive) setRevoking("")
    }
  }

  const runCmd = async (e?: Event) => {
    e?.preventDefault()
    const machine = selected()
    // Snapshot the display name at call time so console history stays
    // stable even if the machine list refreshes/renames mid-flight.
    const machineName = selectedName() || machine
    const cmd = cmdText().trim()
    if (!machine || !cmd || running()) return
    setRunning(true)
    setCmdText("")
    try {
      const res = await app.client.call("outpost.exec", { machine, cmd }, 40000)
      if (!alive) return
      const ok = Boolean(res.ok)
      const out = String(res.output ?? "") || String(res.error ?? "") || (ok ? "(no output)" : "(failed)")
      setEntries((prev) => [...prev, { id: ++entrySeq, machine: machineName, cmd, output: out, ok }])
    } catch (e2) {
      if (!alive) return
      const msg = e2 instanceof ControlError ? `${e2.code}: ${e2.message}` : String(e2)
      setEntries((prev) => [...prev, { id: ++entrySeq, machine: machineName, cmd, output: msg, ok: false }])
    } finally {
      if (alive) setRunning(false)
    }
  }

  const grabScreenshot = async () => {
    const machine = selected()
    if (!machine || shotBusy()) return
    setShotBusy(true)
    setShot("")
    try {
      const res = await app.client.call("outpost.screenshot", { machine }, 50000)
      if (!alive) return
      if (res.ok && res.image_base64) setShot(`data:image/png;base64,${String(res.image_base64)}`)
      else app.notify(`Screenshot failed: ${String(res.error ?? "unknown")}`, "error")
    } catch (e) {
      app.notify(`Screenshot failed: ${String(e)}`, "error")
    } finally {
      if (alive) setShotBusy(false)
    }
  }

  const installWorkload = async () => {
    const machine = selected()
    if (!machine || installing()) return
    setInstalling(true)
    setInstallMsg("")
    try {
      const res = await app.client.call("outpost.install_workload", { machine }, 60000)
      if (!alive) return
      setInstallOk(true)
      setInstallMsg(String(res.note ?? "Installed."))
      await loadVms()
    } catch (e) {
      if (!alive) return
      setInstallOk(false)
      setInstallMsg(e instanceof ControlError ? `${e.code}: ${e.message}` : String(e))
    } finally {
      if (alive) setInstalling(false)
    }
  }

  const restartVm = async (vm: ProxmoxVm) => {
    const machine = selected()
    if (!machine || restartingVmid() !== null) return
    if (!window.confirm(`Restart VM ${vm.vmid} (${vm.name}) on ${selectedName()}? This will interrupt anything running on it.`)) return
    setRestartingVmid(vm.vmid)
    try {
      await app.client.call("proxmox.restart_vm", { machine, vmid: vm.vmid }, 30000)
      app.notify(`Restart triggered for VM ${vm.vmid}.`)
      await loadVms()
    } catch (e) {
      app.notify(`Restart failed: ${e instanceof ControlError ? e.message : String(e)}`, "error")
    } finally {
      if (alive) setRestartingVmid(null)
    }
  }

  // proxmox.set_blocklist replaces the whole list, so we read the last-fetched
  // status array, flip membership for just this vmid, and send the full
  // resulting array back — never a delta.
  const toggleBlocklist = async (vm: ProxmoxVm) => {
    const machine = selected()
    if (!machine || blocklistBusyVmid() !== null) return
    const nextBlocklisted = vms()
      .map((v) => (v.vmid === vm.vmid ? { ...v, blocklisted: !v.blocklisted } : v))
      .filter((v) => v.blocklisted)
      .map((v) => v.vmid)
    setBlocklistBusyVmid(vm.vmid)
    try {
      await app.client.call("proxmox.set_blocklist", { machine, vmids: nextBlocklisted }, 15000)
      await loadVms()
    } catch (e) {
      app.notify(`Blocklist update failed: ${String(e)}`, "error")
    } finally {
      if (alive) setBlocklistBusyVmid(null)
    }
  }

  const loadReport = async () => {
    const machine = selected()
    if (!machine || reportLoading()) return
    setReportLoading(true)
    setReportError("")
    try {
      const res = await app.client.call("proxmox.report", { machine }, 20000)
      if (!alive) return
      setReport((res.memories ?? []) as ProxmoxMemory[])
      setReportLoaded(true)
    } catch (e) {
      if (!alive) return
      setReportError(String(e))
    } finally {
      if (alive) setReportLoading(false)
    }
  }

  return (
    <div class="op-page">
      <style>{`
        .op-page { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
        .op-header { display: flex; align-items: center; gap: 12px; }
        .op-header-icon { width: 36px; height: 36px; border-radius: var(--radius-sm);
          display: flex; align-items: center; justify-content: center;
          background: var(--accent-faint); border: 1px solid var(--accent-dim); flex-shrink: 0; }
        .op-subtitle { color: var(--text-muted); font-size: 12px; }
        .op-conn-pill { margin-left: auto; display: flex; align-items: center; gap: 6px;
          font-family: var(--font-mono); font-size: 10px; color: var(--text-faint);
          padding: 4px 10px; border-radius: 999px; border: 1px solid var(--hairline-soft); }
        .op-conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
        .op-conn-dot.on { background: var(--success); }
        .op-title-line { font-size: 11px; letter-spacing: var(--track-mid); margin-bottom: 12px; }
        .op-title-line.accent { color: var(--accent); }
        .op-title-line.amber { color: var(--amber); }
        .op-pair-row { display: flex; align-items: center; gap: 12px; }
        .op-pair-text { flex: 1; }
        .op-pair-label { color: var(--text); font-size: 14px; font-weight: 500; }
        .op-pair-sub { color: var(--text-faint); font-size: 12px; }
        .op-btn { all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
          padding: 9px 18px; border-radius: var(--radius-xs); white-space: nowrap;
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          border: 1px solid var(--accent-dim); color: var(--accent-bright); background: var(--accent-faint); }
        .op-btn:hover:not(:disabled) { background: var(--accent-dim); }
        .op-btn:disabled { opacity: 0.4; cursor: default; }
        .op-cmd { display: block; margin-top: 10px; background: var(--surface-deep);
          border: 1px solid var(--accent-dim); border-radius: var(--radius-xs);
          padding: 8px 10px; font-family: var(--font-mono); font-size: 11px; color: var(--accent-bright);
          overflow-x: auto; white-space: pre; }
        .op-cmd-label { color: var(--text-faint); font-family: var(--font-display);
          font-size: 10px; letter-spacing: var(--track-wide); margin-top: 10px; }
        .op-status { margin-top: 10px; font-size: 12px; color: var(--text-muted); }
        .op-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
        .op-row { display: flex; align-items: center; gap: 12px; border-radius: var(--radius-sm);
          background: var(--panel-soft); border: 1px solid var(--hairline-soft); padding: 10px 14px; }
        .op-row.selected { border-color: var(--accent); background: var(--accent-faint); }
        .op-row-text { flex: 1; min-width: 0; }
        .op-row-name { color: var(--text); font-size: 14px; font-weight: 500; }
        .op-row-meta { color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; }
        .op-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .op-dot.online { background: var(--success); }
        .op-dot.offline { background: var(--text-faint); }
        .op-revoke { all: unset; cursor: pointer; white-space: nowrap; padding: 6px 14px;
          border-radius: var(--radius-xs); background: var(--danger-dim); color: var(--danger);
          border: 1px solid var(--danger-dim); font-family: var(--font-display);
          letter-spacing: var(--track-mid); font-size: 11px; }
        .op-revoke:disabled { opacity: 0.5; cursor: default; }
        .op-field-row { display: flex; gap: 10px; margin-top: 12px; }
        .op-input { flex: 1; min-width: 0; background: var(--surface-input);
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs); color: var(--text);
          padding: 9px 12px; font-family: var(--font-mono); font-size: 13px; }
        .op-input:focus { outline: none; border-color: var(--accent-dim); }
        .op-input:disabled { opacity: 0.5; }
        .op-console { min-height: 120px; max-height: 300px; overflow-y: auto;
          background: var(--surface-deep); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-sm); padding: 12px; margin: 12px 0;
          display: flex; flex-direction: column; gap: 10px; }
        .op-console-empty { color: var(--text-faint); font-size: 12px; text-align: center; padding: 30px 0; }
        .op-console-cmd { font-family: var(--font-mono); font-size: 12px; color: var(--accent-bright); word-break: break-word; }
        .op-console-out { font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
        .op-console-out.ok { color: var(--text-muted); }
        .op-console-out.fail { color: var(--danger); }
        .op-shot { max-width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--hairline-soft); margin-top: 10px; }
        .op-banner-error { color: var(--danger); font-size: 12px; margin-top: 10px;
          border: 1px solid var(--danger-dim); background: rgba(255,107,107,0.06);
          border-radius: var(--radius-xs); padding: 8px 10px; }
        .op-empty { color: var(--text-faint); font-size: 12px; margin-top: 10px; }
        .op-install-row { display: flex; align-items: center; gap: 12px; }
        .op-install-msg { margin-top: 10px; font-size: 12px; color: var(--success); }
        .op-install-msg.fail { color: var(--danger); }
        .op-vm-table-wrap { overflow-x: auto; margin-top: 10px; }
        .op-vm-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 640px; }
        .op-vm-table thead th { text-align: left; padding: 8px 10px; color: var(--text-faint);
          font-family: var(--font-display); font-size: 9px; letter-spacing: var(--track-wide);
          border-bottom: 1px solid var(--hairline-soft); white-space: nowrap; }
        .op-vm-table tbody td { padding: 8px 10px; border-bottom: 1px solid var(--hairline-faint);
          color: var(--text); vertical-align: middle; }
        .op-vm-table tbody tr:last-child td { border-bottom: none; }
        .op-vm-table tbody tr:hover { background: rgba(255,255,255,0.025); }
        .op-vm-name { color: var(--text); font-weight: 500; }
        .op-vm-mono { font-family: var(--font-mono); color: var(--text-faint); white-space: nowrap; }
        .op-vm-status { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; }
        .op-vm-status.running { color: var(--success); }
        .op-vm-status.stopped { color: var(--text-faint); }
        .op-vm-pending { display: inline-flex; align-items: center; gap: 4px; margin-top: 2px;
          font-size: 9px; color: var(--amber); font-family: var(--font-display); letter-spacing: var(--track-tight); }
        .op-vm-pending::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--amber); flex-shrink: 0; }
        .op-vm-restart { all: unset; cursor: pointer; white-space: nowrap; padding: 5px 12px;
          border-radius: var(--radius-xs); background: transparent; color: var(--amber);
          border: 1px solid var(--amber-dim, var(--accent-dim)); font-family: var(--font-display);
          letter-spacing: var(--track-mid); font-size: 10px; }
        .op-vm-restart:hover:not(:disabled) { background: var(--amber-dim, var(--accent-dim)); }
        .op-vm-restart:disabled { opacity: 0.5; cursor: default; }
        .op-report-btn { margin-top: 12px; }
        .op-report-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
        .op-report-row { border-radius: var(--radius-sm); background: var(--panel-soft);
          border: 1px solid var(--hairline-soft); padding: 10px 14px; }
        .op-report-text { color: var(--text); font-size: 13px; line-height: 1.4; }
        .op-report-meta { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; margin-top: 6px; }
        .op-report-tag { display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 4px;
          background: var(--accent-faint); color: var(--accent); font-size: 9px;
          font-family: var(--font-display); letter-spacing: var(--track-tight); }
      `}</style>

      <div class="op-header">
        <div class="op-header-icon">
          <NavIcon glyph="outpost" color="var(--accent)" glow />
        </div>
        <div>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>Outpost</div>
          <div class="op-subtitle">
            Pair a remote machine with one command, then run gated exec + screenshot on it by name.
          </div>
        </div>
        <div class="op-conn-pill">
          <span class="op-conn-dot" classList={{ on: connected() }} />
          {connected() ? "daemon linked" : "connecting…"}
        </div>
      </div>

      <div class="card">
        <div class="op-title-line hud-label accent">// PAIR A MACHINE</div>
        <div class="op-pair-row">
          <div class="op-pair-text">
            <div class="op-pair-label">Add a Windows / Linux / macOS machine</div>
            <div class="op-pair-sub">Generates a one-shot install command, valid for 10 minutes.</div>
          </div>
          <button type="button" class="op-btn" disabled={pairing() || !connected()} onClick={() => void startPairing()}>
            {pairing() ? "Generating…" : pair() ? "New code" : "Pair a machine"}
          </button>
        </div>

        <Show when={pair()}>
          <div class="op-cmd-label">RUN ON LINUX / macOS</div>
          <code class="op-cmd">{pair()!.install_cmd_linux}</code>
          <div class="op-cmd-label">RUN ON WINDOWS (PowerShell)</div>
          <code class="op-cmd">{pair()!.install_cmd_windows}</code>
          <div class="op-status">
            {pairState() === "paired"
              ? "Paired ✓"
              : remaining() > 0
                ? `Waiting for the machine to check in… expires in ${remaining()}s`
                : "Code expired — request a new one"}
          </div>
        </Show>
      </div>

      <div class="card">
        <div class="op-title-line hud-label accent">// MACHINES</div>
        <Show when={listError()}>
          <div class="op-banner-error">⚠ {listError()}</div>
        </Show>
        <Show when={loaded() && machines().length === 0 && !listError()}>
          <div class="op-empty">No machines paired yet. Pair one above.</div>
        </Show>
        <div class="op-list">
          <For each={machines()}>
            {(m) => (
              <div class="op-row" classList={{ selected: m.id === selected() }} onClick={() => setSelected(m.id)}>
                <span class="op-dot" classList={{ online: m.status === "online", offline: m.status !== "online" }} />
                <div class="op-row-text">
                  <div class="op-row-name">{m.name}</div>
                  <div class="op-row-meta">
                    {m.os || "?"} · {m.status} {m.last_seen ? `· seen ${fmtTime(m.last_seen)}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  class="op-revoke"
                  disabled={revoking() === m.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    void revoke(m)
                  }}
                >
                  {revoking() === m.id ? "Revoking…" : "Revoke"}
                </button>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="card">
        <div class="op-title-line hud-label amber">
          // EXEC {selected() ? `→ ${selectedName()}` : "(select a machine)"}
        </div>
        <div class="op-console">
          <Show when={entries().length > 0} fallback={<div class="op-console-empty">Command output appears here.</div>}>
            <For each={entries()}>
              {(en) => (
                <div>
                  <div class="op-console-cmd">[{en.machine}] $ {en.cmd}</div>
                  <div class="op-console-out" classList={{ ok: en.ok, fail: !en.ok }}>{en.output}</div>
                </div>
              )}
            </For>
          </Show>
        </div>
        <form class="op-field-row" onSubmit={runCmd}>
          <input
            class="op-input"
            placeholder={selected() ? `Command on ${selectedName()}…` : "Select a machine first…"}
            value={cmdText()}
            disabled={running() || !selected()}
            onInput={(e) => setCmdText(e.currentTarget.value)}
          />
          <button type="submit" class="op-btn" disabled={!connected() || !selected() || cmdText().trim().length === 0 || running()}>
            {running() ? "Running…" : "Run"}
          </button>
          <button type="button" class="op-btn" disabled={!connected() || !selected() || shotBusy()} onClick={() => void grabScreenshot()}>
            {shotBusy() ? "…" : "Screenshot"}
          </button>
        </form>
        <Show when={shot()}>
          <img class="op-shot" src={shot()} alt="remote screenshot" />
        </Show>
      </div>

      <Show when={selected()}>
        <div class="card">
          <div class="op-title-line hud-label accent">// PROXMOX WORKLOAD MANAGER → {selectedName()}</div>

          <div class="op-install-row">
            <div class="op-pair-text">
              <div class="op-pair-label">Install the workload manager</div>
              <div class="op-pair-sub">Provisions the Proxmox agent on this host. Can take up to a minute.</div>
            </div>
            <button
              type="button"
              class="op-btn"
              disabled={installing() || !connected()}
              onClick={() => void installWorkload()}
            >
              {installing() ? "Installing…" : "Install"}
            </button>
          </div>
          <Show when={installMsg()}>
            <div class="op-install-msg" classList={{ fail: !installOk() }}>
              {installOk() ? "✓ " : "⚠ "}{installMsg()}
            </div>
          </Show>

          <div class="op-cmd-label">VIRTUAL MACHINES</div>
          <Show when={vmsError()}>
            <div class="op-banner-error">⚠ {vmsError()}</div>
          </Show>
          <Show when={vmsLoaded() && vms().length === 0 && !vmsError()}>
            <div class="op-empty">No VMs reported yet. Install the workload manager above, then wait for the next refresh.</div>
          </Show>
          <Show when={vms().length > 0}>
            <div class="op-vm-table-wrap">
              <table class="op-vm-table">
                <thead>
                  <tr>
                    <th>VMID</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Cores</th>
                    <th>Mem (MB)</th>
                    <th>CPU %</th>
                    <th>Mem %</th>
                    <th>Blocklist</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={vms()}>
                    {(vm) => (
                      <tr>
                        <td class="op-vm-mono">{vm.vmid}</td>
                        <td>
                          <div class="op-vm-name">{vm.name}</div>
                          <Show when={vm.pending_restart}>
                            <div class="op-vm-pending">restart pending</div>
                          </Show>
                        </td>
                        <td>
                          <span class="op-vm-status" classList={{ running: vm.status === "running", stopped: vm.status !== "running" }}>
                            {vm.status}
                          </span>
                        </td>
                        <td class="op-vm-mono">{vm.cores}</td>
                        <td class="op-vm-mono">{vm.memory_mb}</td>
                        <td class="op-vm-mono">{vm.cpu_pct.toFixed(1)}</td>
                        <td class="op-vm-mono">{vm.mem_pct.toFixed(1)}</td>
                        <td>
                          <input
                            type="checkbox"
                            checked={vm.blocklisted}
                            disabled={blocklistBusyVmid() === vm.vmid}
                            onChange={() => void toggleBlocklist(vm)}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            class="op-vm-restart"
                            disabled={restartingVmid() === vm.vmid}
                            onClick={() => void restartVm(vm)}
                          >
                            {restartingVmid() === vm.vmid ? "Restarting…" : "Restart"}
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>

          <div class="op-pair-row op-report-btn">
            <div class="op-pair-text">
              <div class="op-pair-label">Decision report</div>
              <div class="op-pair-sub">Pull the workload manager's decision-history log for this host.</div>
            </div>
            <button type="button" class="op-btn" disabled={reportLoading() || !connected()} onClick={() => void loadReport()}>
              {reportLoading() ? "Loading…" : "Get report"}
            </button>
          </div>
          <Show when={reportError()}>
            <div class="op-banner-error">⚠ {reportError()}</div>
          </Show>
          <Show when={reportLoaded() && report().length === 0 && !reportError()}>
            <div class="op-empty">No decisions logged yet.</div>
          </Show>
          <Show when={report().length > 0}>
            <div class="op-report-list">
              <For each={report()}>
                {(m) => (
                  <div class="op-report-row">
                    <div class="op-report-text">{m.text}</div>
                    <div class="op-report-meta">
                      <For each={m.tags}>{(t) => <span class="op-report-tag">{t}</span>}</For>
                      {timeAgo(m.created)} · {fmtTime(m.created)}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

const page: PageDef = { id: "outpost", label: "Outpost", section: "SYSTEM", order: 2, component: Outpost }
export default page
