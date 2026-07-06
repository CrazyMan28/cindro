// Outpost — pair remote Windows/Linux/macOS machines and run gated exec +
// screenshot on them by name. Replaces the old SSH page. Pairing-card + poll
// pattern mirrors settings/devices.tsx; the exec console mirrors the old
// ssh.tsx. All verbs proxy through the daemon to outpost-mcp (:8798).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

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

let entrySeq = 0

function fmtTime(ms?: number): string {
  if (!ms) return ""
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ""
  }
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

  onMount(() => {
    void load()
    const conn = setInterval(() => setConnected(app.client.connected), 500)
    const timer = setInterval(() => void load(), 15000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      clearInterval(conn)
      clearInterval(timer)
      clearInterval(tick)
    })
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
    </div>
  )
}

const page: PageDef = { id: "outpost", label: "Outpost", section: "SYSTEM", order: 2, component: Outpost }
export default page
