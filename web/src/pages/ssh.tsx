// SSH — ported from desktop/qml/SshPage.qml. Manages the daemon's gated
// remote-command allow-list (ssh.allow_list/allow_add/allow_remove — these
// are real, persisted CRUD against ~/.config/jarvis/ssh_allow.json) and
// exposes the "run a command" console the GUI shows. Verified live against
// the real daemon: ssh.exec is NOT a stub — it spawns a real `ssh -o
// BatchMode=yes` subprocess for allow-listed hosts (SshAllowList::exec) and
// returns the genuine exit code/output/error. We render that response
// verbatim (success or failure) rather than pretend/simulate a terminal.
// Non-allow-listed hosts are hard-gated ('host_not_allowed') before any
// process ever spawns. See ControlServer::handleSshExec.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import { ControlError } from "../core/control-client"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"

interface ConsoleEntry {
  id: number
  host: string
  cmd: string
  output: string
  ok: boolean
  code?: string
}

let entrySeq = 0

function Ssh() {
  const app = useApp()

  const [connected, setConnected] = createSignal(app.client.connected)
  const [hosts, setHosts] = createSignal<string[]>([])
  const [selectedHost, setSelectedHost] = createSignal("")
  const [newHost, setNewHost] = createSignal("")
  const [addBusy, setAddBusy] = createSignal(false)
  const [removeBusyHost, setRemoveBusyHost] = createSignal("")
  const [listError, setListError] = createSignal("")

  const [cmdText, setCmdText] = createSignal("")
  const [running, setRunning] = createSignal(false)
  const [entries, setEntries] = createSignal<ConsoleEntry[]>([])

  let alive = true
  onCleanup(() => {
    alive = false
  })

  onMount(() => {
    const poll = setInterval(() => setConnected(app.client.connected), 500)
    onCleanup(() => clearInterval(poll))
  })

  const applyHosts = (raw: unknown) => {
    const list = (Array.isArray(raw) ? raw : []).map((h) => String(h)).filter(Boolean)
    setHosts(list)
    if (!list.includes(selectedHost())) setSelectedHost(list[0] ?? "")
  }

  const load = async () => {
    try {
      const res = await app.client.call("ssh.allow_list", {}, 15000)
      if (!alive) return
      applyHosts(res.hosts)
      setListError("")
    } catch (e) {
      if (!alive) return
      setListError(String(e))
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(load, 20000)
    onCleanup(() => clearInterval(timer))
  })

  const addHost = async (e?: Event) => {
    e?.preventDefault()
    const h = newHost().trim()
    if (!h || addBusy()) return
    setAddBusy(true)
    try {
      const res = await app.client.call("ssh.allow_add", { host: h }, 15000)
      if (!alive) return
      applyHosts(res.hosts)
      setSelectedHost(h)
      setNewHost("")
      setListError("")
    } catch (e2) {
      if (!alive) return
      setListError(String(e2))
      app.notify(`Failed to add host: ${String(e2)}`, "error")
    } finally {
      if (alive) setAddBusy(false)
    }
  }

  const removeHost = async (host: string) => {
    if (removeBusyHost()) return
    setRemoveBusyHost(host)
    try {
      const res = await app.client.call("ssh.allow_remove", { host }, 15000)
      if (!alive) return
      applyHosts(res.hosts)
      setListError("")
    } catch (e) {
      if (!alive) return
      setListError(String(e))
      app.notify(`Failed to remove host: ${String(e)}`, "error")
    } finally {
      if (alive) setRemoveBusyHost("")
    }
  }

  const runCmd = async (e?: Event) => {
    e?.preventDefault()
    const host = selectedHost()
    const cmd = cmdText().trim()
    if (!host || !cmd || running()) return
    setRunning(true)
    setCmdText("")
    try {
      const res = await app.client.call("ssh.exec", { host, cmd }, 25000)
      if (!alive) return
      const ok = Boolean(res.ok)
      const out =
        String(res.output ?? "") ||
        String(res.error ?? "") ||
        (ok ? "(no output)" : "(failed — no detail returned)")
      setEntries((prev) => [
        ...prev,
        { id: ++entrySeq, host, cmd, output: out, ok, code: res.error ? String(res.error) : undefined },
      ])
    } catch (e2) {
      if (!alive) return
      const isControl = e2 instanceof ControlError
      setEntries((prev) => [
        ...prev,
        {
          id: ++entrySeq,
          host,
          cmd,
          output: isControl ? e2.message : String(e2),
          ok: false,
          code: isControl ? e2.code : undefined,
        },
      ])
    } finally {
      if (alive) setRunning(false)
    }
  }

  return (
    <div class="ssh-page">
      <style>{`
        .ssh-page { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
        .ssh-header { display: flex; align-items: center; gap: 12px; }
        .ssh-header-icon-wrap {
          width: 36px; height: 36px; border-radius: var(--radius-sm);
          display: flex; align-items: center; justify-content: center;
          background: var(--accent-faint); border: 1px solid var(--accent-dim);
          flex-shrink: 0;
        }
        .ssh-header-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .ssh-subtitle { color: var(--text-muted); font-size: 12px; }
        .ssh-conn-pill {
          margin-left: auto; display: flex; align-items: center; gap: 6px;
          font-family: var(--font-mono); font-size: 10px; color: var(--text-faint);
          padding: 4px 10px; border-radius: 999px; border: 1px solid var(--hairline-soft);
          flex-shrink: 0;
        }
        .ssh-conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
        .ssh-conn-dot.on { background: var(--success); animation: ssh-pulse 1100ms ease-in-out infinite; }
        @keyframes ssh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

        .ssh-section-title {
          font-size: 11px; letter-spacing: var(--track-mid); margin-bottom: 12px;
          display: flex; align-items: center; gap: 8px;
        }
        .ssh-section-title.accent { color: var(--accent); }
        .ssh-section-title.amber { color: var(--amber); }

        .ssh-field-row { display: flex; gap: 10px; }
        .ssh-input {
          flex: 1; min-width: 0; background: var(--surface-input);
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-xs);
          color: var(--text); padding: 9px 12px; font-family: var(--font-mono);
          font-size: 13px; transition: border-color var(--dur-fast) ease;
        }
        .ssh-input:focus { outline: none; border-color: var(--accent-dim); }
        .ssh-input:disabled { opacity: 0.5; }
        .ssh-input::placeholder { color: var(--text-faint); }

        .ssh-btn {
          all: unset; cursor: pointer; box-sizing: border-box; text-align: center;
          padding: 9px 18px; border-radius: var(--radius-xs);
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          border: 1px solid var(--accent-dim); color: var(--accent-bright);
          background: var(--accent-faint); transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
          white-space: nowrap;
        }
        .ssh-btn:hover:not(:disabled) { background: var(--accent-dim); }
        .ssh-btn:disabled { opacity: 0.4; cursor: default; }

        .ssh-chip-flow { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .ssh-chip {
          all: unset; cursor: pointer; box-sizing: border-box;
          display: inline-flex; align-items: center; gap: 8px;
          height: 30px; padding: 0 10px 0 12px; border-radius: var(--radius-sm);
          background: var(--surface); border: 1px solid var(--hairline-soft);
          transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease;
        }
        .ssh-chip:hover { border-color: var(--accent-dim); }
        .ssh-chip.selected { background: var(--accent-faint); border-color: var(--accent); }
        .ssh-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); flex-shrink: 0; }
        .ssh-chip-label { font-family: var(--font-mono); font-size: 12px; color: var(--text); }
        .ssh-chip-remove {
          all: unset; cursor: pointer; font-size: 11px; color: var(--text-faint);
          padding: 2px 3px; line-height: 1; transition: color var(--dur-fast) ease;
        }
        .ssh-chip-remove:hover { color: var(--danger); }
        .ssh-empty { color: var(--text-faint); font-size: 12px; margin-top: 10px; }
        .ssh-banner-error {
          color: var(--danger); font-size: 12px; margin-top: 10px;
          border: 1px solid var(--danger-dim); background: rgba(255,107,107,0.06);
          border-radius: var(--radius-xs); padding: 8px 10px;
        }

        .ssh-console-target {
          display: flex; align-items: center; gap: 6px; margin-left: auto;
          font-family: var(--font-mono); font-size: 11px;
        }
        .ssh-console-target.set { color: var(--accent); }
        .ssh-console-target.unset { color: var(--text-faint); }

        .ssh-console {
          min-height: 140px; max-height: 320px; overflow-y: auto;
          background: var(--surface-deep); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-sm); padding: 12px; margin: 12px 0;
          display: flex; flex-direction: column; gap: 10px;
        }
        .ssh-console-empty {
          color: var(--text-faint); font-size: 12px; display: flex;
          align-items: center; justify-content: center; height: 100px; text-align: center;
        }
        .ssh-console-entry { display: flex; flex-direction: column; gap: 3px; }
        .ssh-console-cmd {
          font-family: var(--font-mono); font-size: 12px; color: var(--accent-bright);
          word-break: break-word;
        }
        .ssh-console-cmd-host { color: var(--text-faint); }
        .ssh-console-output {
          font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap;
          word-break: break-word; line-height: 1.4;
        }
        .ssh-console-output.ok { color: var(--text-muted); }
        .ssh-console-output.fail { color: var(--danger); }
        .ssh-console-code {
          font-family: var(--font-mono); font-size: 10px; color: var(--text-faint);
        }

        .ssh-gate-note {
          font-size: 11px; color: var(--text-faint); margin-top: -2px;
        }
      `}</style>

      <div class="ssh-header">
        <div class="ssh-header-icon-wrap">
          <NavIcon glyph="ssh" color="var(--accent)" glow />
        </div>
        <div class="ssh-header-text">
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>SSH</div>
          <div class="ssh-subtitle">
            Allow-listed hosts Jarvis may reach. Exec is gated by the daemon's allow-list + biometric tier.
          </div>
        </div>
        <div class="ssh-conn-pill">
          <span class="ssh-conn-dot" classList={{ on: connected() }} />
          {connected() ? "daemon linked" : "connecting…"}
        </div>
      </div>

      <div class="card">
        <div class="ssh-section-title hud-label accent">// ALLOW-LIST</div>

        <form class="ssh-field-row" onSubmit={addHost}>
          <input
            class="ssh-input"
            placeholder="host  (user@host or host alias)"
            value={newHost()}
            disabled={addBusy()}
            onInput={(e) => setNewHost(e.currentTarget.value)}
          />
          <button
            type="submit"
            class="ssh-btn"
            disabled={!connected() || addBusy() || newHost().trim().length === 0}
          >
            {addBusy() ? "Adding…" : "+ Allow"}
          </button>
        </form>

        <Show when={listError()}>
          <div class="ssh-banner-error">⚠ {listError()}</div>
        </Show>

        <Show when={hosts().length > 0} fallback={<div class="ssh-empty">No allow-listed hosts. Add one above to enable gated exec.</div>}>
          <div class="ssh-chip-flow">
            <For each={hosts()}>
              {(host) => (
                <div class="ssh-chip" classList={{ selected: host === selectedHost() }} onClick={() => setSelectedHost(host)}>
                  <span class="ssh-chip-dot" />
                  <span class="ssh-chip-label">{host}</span>
                  <button
                    type="button"
                    class="ssh-chip-remove"
                    disabled={removeBusyHost() === host}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeHost(host)
                    }}
                    title={`Remove ${host}`}
                  >
                    {removeBusyHost() === host ? "…" : "✕"}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="card">
        <div class="ssh-section-title hud-label amber">
          // GATED EXEC
          <span class="ssh-console-target" classList={{ set: !!selectedHost(), unset: !selectedHost() }}>
            {selectedHost() ? `→ ${selectedHost()}` : "select a host"}
          </span>
        </div>
        <div class="ssh-gate-note">
          Runs a real `ssh` on the daemon host for the selected allow-listed host — this is genuine
          remote execution, not a simulated terminal. The output/error below is exactly what came back.
        </div>

        <div class="ssh-console">
          <Show when={entries().length > 0} fallback={<div class="ssh-console-empty">Output appears here.</div>}>
            <For each={entries()}>
              {(entry) => (
                <div class="ssh-console-entry">
                  <div class="ssh-console-cmd">
                    <span class="ssh-console-cmd-host">[{entry.host}]</span> $ {entry.cmd}
                  </div>
                  <div class="ssh-console-output" classList={{ ok: entry.ok, fail: !entry.ok }}>
                    {entry.output}
                  </div>
                  <Show when={entry.code}>
                    <div class="ssh-console-code">code: {entry.code}</div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>

        <form class="ssh-field-row" onSubmit={runCmd}>
          <input
            class="ssh-input"
            placeholder={selectedHost() ? `Command on ${selectedHost()}…` : "Select a host first…"}
            value={cmdText()}
            disabled={running() || !selectedHost()}
            onInput={(e) => setCmdText(e.currentTarget.value)}
          />
          <button
            type="submit"
            class="ssh-btn"
            disabled={!connected() || !selectedHost() || cmdText().trim().length === 0 || running()}
          >
            {running() ? "Running…" : "Run"}
          </button>
        </form>
      </div>
    </div>
  )
}

const page: PageDef = { id: "ssh", label: "SSH", section: "SYSTEM", order: 2, component: Ssh }
export default page
