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

interface ScoutResult {
  vmid: number
  name: string
  kind: string
  ok: boolean
  os_family: string
  agent: boolean | null
  summary: string
  error: string
}

interface ScoutStatus {
  state: string // idle | running | done | error
  trigger?: string
  started_at?: number
  finished_at?: number | null
  total?: number
  done?: number
  current_vmid?: number | null
  current_name?: string
  results?: ScoutResult[]
}

interface ProxmoxQuestion {
  qid: string
  vmid: number
  question: string
  options?: string[]
  at: number
}

interface PingedRule {
  id: string
  name: string
  vmid: number
  trigger: { type: string; condition?: string; time?: string }
  action: string
  enabled: boolean
  last_checked_at: number | null
  last_fired_at: number | null
  last_result: string
}

interface PingedEvent {
  eid: string
  rule_id: string
  name: string
  vmid: number
  fired_at: number
  result: string
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
  const [installingDash, setInstallingDash] = createSignal(false)
  const [restartingVmid, setRestartingVmid] = createSignal<number | null>(null)
  const [blocklistBusyVmid, setBlocklistBusyVmid] = createSignal<number | null>(null)
  const [report, setReport] = createSignal<ProxmoxMemory[]>([])
  const [reportLoading, setReportLoading] = createSignal(false)
  const [reportError, setReportError] = createSignal("")
  const [reportLoaded, setReportLoaded] = createSignal(false)

  const [scout, setScout] = createSignal<ScoutStatus | null>(null)
  const [scoutError, setScoutError] = createSignal("")
  const [scoutStarting, setScoutStarting] = createSignal(false)
  const [questions, setQuestions] = createSignal<ProxmoxQuestion[]>([])
  const [answerText, setAnswerText] = createSignal<Record<string, string>>({})
  const [pingedRules, setPingedRules] = createSignal<PingedRule[]>([])
  const [pingedEvents, setPingedEvents] = createSignal<PingedEvent[]>([])
  const [pingedError, setPingedError] = createSignal("")
  const [pingedAddOpen, setPingedAddOpen] = createSignal(false)
  const [prName, setPrName] = createSignal("")
  const [prVmid, setPrVmid] = createSignal("")
  const [prTime, setPrTime] = createSignal("")
  const [prCondition, setPrCondition] = createSignal("")
  const [prAction, setPrAction] = createSignal("")
  const [profileVmid, setProfileVmid] = createSignal<number | null>(null)
  const [profileText, setProfileText] = createSignal("")
  const [profileError, setProfileError] = createSignal("")

  let alive = true
  onCleanup(() => {
    alive = false
  })

  // The workload manager is confirmed present once proxmox.status has
  // succeeded for the selected machine — that's the gate for the extra
  // questions/pinged polling below.
  const workloadPresent = () => vmsLoaded() && !vmsError()

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

  // Questions + pinged rules piggyback the 15s cadence, gated on the
  // workload manager actually being present (see workloadPresent). The two
  // calls are independent (different remote execs) — fire them in parallel
  // rather than paying the round-trip twice, sequentially, every 15s.
  const loadAux = async () => {
    const machine = selected()
    if (!machine || !workloadPresent()) return
    const [qResult, pResult] = await Promise.allSettled([
      app.client.call("proxmox.questions", { machine }, 15000),
      app.client.call("proxmox.pinged_list", { machine }, 15000),
    ])
    if (!alive || selected() !== machine) return
    if (qResult.status === "fulfilled") {
      setQuestions((qResult.value.questions ?? []) as ProxmoxQuestion[])
    } // else: best-effort; the card just keeps its last state
    if (pResult.status === "fulfilled") {
      setPingedRules((pResult.value.rules ?? []) as PingedRule[])
      setPingedEvents((pResult.value.events ?? []) as PingedEvent[])
      setPingedError("")
    } else {
      setPingedError(String(pResult.reason))
    }
  }

  // 3s scout-status poll while a scan runs; stops itself the moment the
  // machine changes or the state leaves "running" (mirrors pollPairing).
  // The detached runner takes a moment to boot + enumerate VMs before it
  // writes state="running" — a status reply whose started_at predates
  // `requestedAt` is stale data from a PREVIOUS run (or the idle default),
  // not evidence the new scan already finished. Only a reply that's
  // actually from our run may stop the poll.
  const reflectsOurRun = (status: ScoutStatus, requestedAt: number) =>
    Boolean(status.started_at) && (status.started_at as number) >= requestedAt

  const pollScout = async (machine: string, requestedAt: number) => {
    for (let i = 0; i < 400 && alive; i++) {
      try {
        const res = await app.client.call("proxmox.scout_status", { machine }, 15000)
        if (!alive || selected() !== machine) return
        const status = (res.scout ?? { state: "idle" }) as ScoutStatus
        setScout(status)
        setScoutError("")
        if (status.state !== "running" && reflectsOurRun(status, requestedAt)) return
      } catch (e) {
        if (!alive || selected() !== machine) return
        setScoutError(String(e))
        return
      }
      await new Promise((r) => setTimeout(r, 3000))
      if (!alive || selected() !== machine) return
    }
  }

  const startScout = async () => {
    const machine = selected()
    if (!machine || scoutStarting()) return
    setScoutStarting(true)
    setScoutError("")
    const requestedAt = Date.now()
    try {
      await app.client.call("proxmox.scout", { machine }, 30000)
      if (!alive || selected() !== machine) return
      void pollScout(machine, requestedAt)
    } catch (e) {
      if (!alive) return
      setScoutError(e instanceof ControlError ? `${e.code}: ${e.message}` : String(e))
    } finally {
      if (alive) setScoutStarting(false)
    }
  }

  const answerQuestion = async (q: ProxmoxQuestion, answer: string) => {
    const machine = selected()
    const text = answer.trim()
    if (!machine || !text) return
    try {
      await app.client.call("proxmox.answer", { machine, qid: q.qid, answer: text }, 15000)
      setAnswerText((prev) => ({ ...prev, [q.qid]: "" }))
      await loadAux()
    } catch (e) {
      app.notify(`Answer failed: ${String(e)}`, "error")
    }
  }

  const addPinged = async () => {
    const machine = selected()
    if (!machine) return
    try {
      await app.client.call("proxmox.pinged_add", {
        machine,
        name: prName().trim(),
        action: prAction().trim(),
        vmid: parseInt(prVmid(), 10) || 0,
        condition: prCondition().trim(),
        time: prTime().trim(),
      }, 20000)
      setPrName("")
      setPrVmid("")
      setPrTime("")
      setPrCondition("")
      setPrAction("")
      setPingedAddOpen(false)
      await loadAux()
    } catch (e) {
      setPingedError(e instanceof ControlError ? `${e.code}: ${e.message}` : String(e))
    }
  }

  const removePinged = async (rule: PingedRule) => {
    const machine = selected()
    if (!machine) return
    try {
      await app.client.call("proxmox.pinged_remove", { machine, rule_id: rule.id }, 20000)
      await loadAux()
    } catch (e) {
      app.notify(`Remove failed: ${String(e)}`, "error")
    }
  }

  const openProfile = async (vm: ProxmoxVm) => {
    const machine = selected()
    if (!machine) return
    setProfileVmid(vm.vmid)
    setProfileText("")
    setProfileError("")
    try {
      const res = await app.client.call("proxmox.vm_profile", { machine, vmid: vm.vmid }, 15000)
      if (!alive || profileVmid() !== vm.vmid) return
      setProfileText(String(res.profile ?? ""))
    } catch (e) {
      if (!alive) return
      setProfileError(String(e))
    }
  }

  onMount(() => {
    void load()
    const conn = setInterval(() => setConnected(app.client.connected), 500)
    const timer = setInterval(() => {
      void load()
      void loadVms()
      void loadAux()
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
    setScout(null)
    setScoutError("")
    setQuestions([])
    setPingedRules([])
    setPingedEvents([])
    setPingedError("")
    setProfileVmid(null)
    void loadVms().then(() => loadAux())
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
      // Install also opened a live scout+interview chat — jump there so the
      // user watches it happen instead of finding out later (same
      // sessionStorage handoff sessions.tsx uses for "open in Chat").
      const sessionId = String(res.session_id ?? "")
      if (sessionId) {
        sessionStorage.setItem("jarvis.web.openSessionId", sessionId)
        const sessionTitle = String(res.session_title ?? "")
        if (sessionTitle) sessionStorage.setItem("jarvis.web.openSessionTitle", sessionTitle)
        app.navigate("chat")
      }
    } catch (e) {
      if (!alive) return
      setInstallOk(false)
      setInstallMsg(e instanceof ControlError ? `${e.code}: ${e.message}` : String(e))
    } finally {
      if (alive) setInstalling(false)
    }
  }

  // Deploy the full AI-powered Cindro dashboard onto this host (requires the
  // workload manager above). See docs/PROXMOX_DASHBOARD.md.
  const installDashboard = async () => {
    const machine = selected()
    if (!machine || installingDash()) return
    setInstallingDash(true)
    setInstallMsg("")
    try {
      // The backend runs a git/pip sync (180s) + asset download (120s) + service
      // enable — well past a 60s client timeout, which would falsely report
      // failure while the install kept running. Wait longer than the backend
      // budget. `host` (the machine NAME) is used only for the browsable URL —
      // exec still targets the unique `machine` id.
      const res = await app.client.call(
        "outpost.install_dashboard",
        { machine, host: selectedName() },
        400000,
      )
      if (!alive) return
      setInstallOk(true)
      const url = String(res.url ?? `https://${selectedName()}:8443/`)
      const token = String(res.dashboard_token ?? "")
      setInstallMsg(
        `${String(res.note ?? "Dashboard installed.")} Open ${url}` +
          (token ? ` — sign in with token: ${token}` : ""),
      )
    } catch (e) {
      if (!alive) return
      setInstallOk(false)
      setInstallMsg(e instanceof ControlError ? `${e.code}: ${e.message}` : String(e))
    } finally {
      if (alive) setInstallingDash(false)
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
        .op-scout-progress { margin-top: 10px; font-family: var(--font-mono); font-size: 12px; color: var(--accent-bright); }
        .op-scout-done { margin-top: 10px; font-family: var(--font-mono); font-size: 12px; color: var(--success); }
        .op-scout-results { max-height: 160px; overflow-y: auto; margin-top: 8px;
          background: var(--surface-deep); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-sm); padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; }
        .op-scout-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); word-break: break-word; }
        .op-scout-line.fail { color: var(--danger); }
        .op-question { border-radius: var(--radius-sm); background: var(--panel-soft);
          border: 1px solid var(--amber-dim, var(--accent-dim)); padding: 10px 14px; margin-top: 8px; }
        .op-question-text { color: var(--text); font-size: 13px; }
        .op-question-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .op-question-row { display: flex; gap: 8px; margin-top: 8px; }
        .op-pinged-rule { border-radius: var(--radius-sm); background: var(--panel-soft);
          border: 1px solid var(--hairline-soft); padding: 10px 14px; margin-top: 8px; }
        .op-pinged-head { display: flex; align-items: center; gap: 10px; }
        .op-pinged-name { flex: 1; color: var(--text); font-size: 13px; font-weight: 500; min-width: 0; }
        .op-pinged-detail { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
        .op-pinged-meta { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; margin-top: 4px; }
        .op-pinged-event { color: var(--amber); font-family: var(--font-mono); font-size: 11px; margin-top: 4px; word-break: break-word; }
        .op-pinged-form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
        .op-pinged-form-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .op-profile-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6);
          display: flex; align-items: center; justify-content: center; z-index: 60; }
        .op-profile-modal { width: min(680px, calc(100vw - 40px)); max-height: min(600px, calc(100vh - 60px));
          display: flex; flex-direction: column; background: var(--panel, #0a1220);
          border: 1px solid var(--accent-dim); border-radius: var(--radius-sm); padding: 18px; }
        .op-profile-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .op-profile-title { flex: 1; color: var(--accent); font-family: var(--font-display);
          font-size: 12px; letter-spacing: var(--track-mid); }
        .op-profile-body { overflow-y: auto; white-space: pre-wrap; font-family: var(--font-mono);
          font-size: 12px; color: var(--text); line-height: 1.45; }
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

          <div class="op-install-row">
            <div class="op-pair-text">
              <div class="op-pair-label">Install the Cindro dashboard</div>
              <div class="op-pair-sub">AI-powered Proxmox dashboard served on the host (needs the
                workload manager first). Opens at https://&lt;host&gt;:8443/.</div>
            </div>
            <button
              type="button"
              class="op-btn"
              disabled={installingDash() || !connected()}
              onClick={() => void installDashboard()}
            >
              {installingDash() ? "Installing…" : "Install Dashboard"}
            </button>
          </div>
          <Show when={installMsg()}>
            <div class="op-install-msg" classList={{ fail: !installOk() }}>
              {installOk() ? "✓ " : "⚠ "}{installMsg()}
            </div>
          </Show>

          <div class="op-pair-row op-report-btn">
            <div class="op-pair-text">
              <div class="op-pair-label">VM scout</div>
              <div class="op-pair-sub">
                Agentless scan of what's running inside every VM/container — refreshes each guest's JARVIS.md profile.
              </div>
            </div>
            <button
              type="button"
              class="op-btn"
              disabled={!connected() || scoutStarting() || scout()?.state === "running"}
              onClick={() => void startScout()}
            >
              {scoutStarting() ? "Starting…" : scout()?.state === "running" ? "Scouting…" : "Scout VMs"}
            </button>
          </div>
          <Show when={scoutError()}>
            <div class="op-banner-error">⚠ {scoutError()}</div>
          </Show>
          <Show when={scout()?.state === "running"}>
            <div class="op-scout-progress">
              Scouting… {scout()?.done ?? 0}/{scout()?.total ?? 0}
              {scout()?.current_vmid ? ` — VM ${scout()!.current_vmid} (${scout()!.current_name ?? ""})` : ""}
            </div>
          </Show>
          <Show when={scout()?.state === "done"}>
            <div class="op-scout-done">
              Scout done: {(scout()?.results ?? []).filter((r) => r.ok).length}/{scout()?.total ?? 0} guests profiled
              {scout()?.finished_at ? ` · ${timeAgo(scout()!.finished_at!)}` : ""}
            </div>
          </Show>
          <Show when={(scout()?.results ?? []).length > 0}>
            <div class="op-scout-results">
              <For each={scout()!.results!}>
                {(r) => (
                  <div class="op-scout-line" classList={{ fail: !r.ok }}>
                    {r.ok ? "✓" : "✗"} VM {r.vmid} ({r.name}, {r.kind}) — {r.ok ? r.summary : r.error}
                  </div>
                )}
              </For>
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
                          <button type="button" class="op-vm-restart" onClick={() => void openProfile(vm)}>
                            Profile
                          </button>
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

          <Show when={questions().length > 0}>
            <div class="op-cmd-label">AGENT QUESTIONS</div>
            <For each={questions()}>
              {(q) => (
                <div class="op-question">
                  <div class="op-question-text">
                    {q.vmid > 0 ? `VM ${q.vmid} · ` : ""}{q.question}
                  </div>
                  <Show when={(q.options ?? []).length > 0}>
                    <div class="op-question-opts">
                      <For each={q.options!}>
                        {(opt) => (
                          <button type="button" class="op-btn" onClick={() => void answerQuestion(q, opt)}>
                            {opt}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <form
                    class="op-question-row"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void answerQuestion(q, answerText()[q.qid] ?? "")
                    }}
                  >
                    <input
                      class="op-input"
                      placeholder="Type an answer…"
                      value={answerText()[q.qid] ?? ""}
                      onInput={(e) => {
                        const v = e.currentTarget.value
                        setAnswerText((prev) => ({ ...prev, [q.qid]: v }))
                      }}
                    />
                    <button type="submit" class="op-btn" disabled={!(answerText()[q.qid] ?? "").trim()}>
                      Answer
                    </button>
                  </form>
                </div>
              )}
            </For>
          </Show>

          <Show when={workloadPresent()}>
            <div class="op-pair-row op-report-btn">
              <div class="op-pair-text">
                <div class="op-pair-label">Pinged watch rules</div>
                <div class="op-pair-sub">
                  Condition rules the agent judges every tick ("the runner looks stuck → fix it")
                  plus daily check-ups. Fired rules ping your inbox.
                </div>
              </div>
              <button type="button" class="op-btn" onClick={() => setPingedAddOpen(!pingedAddOpen())}>
                {pingedAddOpen() ? "Cancel" : "Add rule"}
              </button>
            </div>
            <Show when={pingedError()}>
              <div class="op-banner-error">⚠ {pingedError()}</div>
            </Show>
            <Show when={pingedAddOpen()}>
              <div class="op-pinged-form">
                <div class="op-pinged-form-row">
                  <input class="op-input" style={{ flex: "2" }} placeholder="Rule name"
                         value={prName()} onInput={(e) => setPrName(e.currentTarget.value)} />
                  <input class="op-input" style={{ flex: "1" }} placeholder="VMID (0 = fleet)"
                         value={prVmid()} onInput={(e) => setPrVmid(e.currentTarget.value)} />
                  <input class="op-input" style={{ flex: "1" }} placeholder="Daily HH:MM"
                         value={prTime()} onInput={(e) => setPrTime(e.currentTarget.value)} />
                </div>
                <input class="op-input" placeholder='…or a condition (e.g. "the CI runner on this VM looks stuck") — leave empty for a daily rule'
                       value={prCondition()} onInput={(e) => setPrCondition(e.currentTarget.value)} />
                <div class="op-pinged-form-row">
                  <input class="op-input" style={{ flex: "1" }}
                         placeholder='Action when it fires (e.g. "check up on it and fix it, don&apos;t break anything")'
                         value={prAction()} onInput={(e) => setPrAction(e.currentTarget.value)} />
                  <button
                    type="button"
                    class="op-btn"
                    disabled={!prName().trim() || !prAction().trim()
                              || (prCondition().trim().length > 0) === (prTime().trim().length > 0)}
                    onClick={() => void addPinged()}
                  >
                    Create
                  </button>
                </div>
              </div>
            </Show>
            <Show when={pingedRules().length === 0 && !pingedAddOpen()}>
              <div class="op-empty">No watch rules yet — add one and the agent checks it every tick.</div>
            </Show>
            <For each={pingedRules()}>
              {(rule) => (
                <div class="op-pinged-rule">
                  <div class="op-pinged-head">
                    <div class="op-pinged-name">
                      {rule.name} {rule.vmid > 0 ? `· VM ${rule.vmid}` : "· fleet"}
                      {rule.trigger?.type === "schedule" ? ` · daily ${rule.trigger.time}` : " · condition"}
                    </div>
                    <button type="button" class="op-revoke" onClick={() => void removePinged(rule)}>
                      Remove
                    </button>
                  </div>
                  <div class="op-pinged-detail">
                    {rule.trigger?.condition ? `when: ${rule.trigger.condition} → ` : ""}do: {rule.action}
                  </div>
                  <div class="op-pinged-meta">
                    checked {rule.last_checked_at ? timeAgo(rule.last_checked_at) : "never"}
                    {rule.last_fired_at ? ` · fired ${timeAgo(rule.last_fired_at)}` : ""}
                    {rule.last_result ? ` · ${rule.last_result}` : ""}
                  </div>
                </div>
              )}
            </For>
            <Show when={pingedEvents().length > 0}>
              <div class="op-cmd-label">RECENT FIRES</div>
              <For each={pingedEvents().slice(0, 5)}>
                {(ev) => (
                  <div class="op-pinged-event">
                    ⚡ {ev.name}{ev.vmid > 0 ? ` (VM ${ev.vmid})` : ""} — {ev.result} · {timeAgo(ev.fired_at)}
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={profileVmid() !== null}>
        <div class="op-profile-overlay" onClick={() => setProfileVmid(null)}>
          <div class="op-profile-modal" onClick={(e) => e.stopPropagation()}>
            <div class="op-profile-head">
              <div class="op-profile-title">VM {profileVmid()} — JARVIS.md</div>
              <button type="button" class="op-btn" onClick={() => setProfileVmid(null)}>Close</button>
            </div>
            <Show when={profileError()}>
              <div class="op-banner-error">⚠ {profileError()}</div>
            </Show>
            <Show when={!profileError()}>
              <div class="op-profile-body">
                {profileText() || "No profile yet — run Scout VMs first."}
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

const page: PageDef = { id: "outpost", label: "Outpost", section: "SYSTEM", order: 2, component: Outpost }
export default page
