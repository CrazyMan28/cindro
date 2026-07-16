// Full-screen Cindro operator console — the same ChatController/ChatPanel as
// the docked side-rail (App.tsx hides the rail while this page is active,
// see cx-shell.docked), given the whole page to breathe in: an animated
// Cindro-branded hero, a live Proxmox context strip read straight off the
// real REST API (pve-api.ts, /api2/json — distinct from the daemon-routed
// proxmoxop.tool reads the other pages use, so the operator's context here
// keeps working even if jarvisd itself is unreachable), then the transcript
// large and centered.
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js"

import { ArcReactor } from "../../components/ArcReactor"
import { ChatController, ChatPanel } from "../chat"
import { CindroClient } from "../cindro-client"
import * as pve from "../pve-api"
import { usePve } from "../pve-context"
import type { PageDef } from "../router"

const STATS_POLL_MS = 12000

/** Tiny helper: flips a signal true for ~650ms whenever `value()` changes
 * (skipping the very first read), so a stat chip can briefly glow instead of
 * just silently jumping to a new number — a cheap but real "live update". */
function usePulseOnChange(value: () => number): () => boolean {
  const [pulse, setPulse] = createSignal(false)
  let primed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    value()
    if (!primed) {
      primed = true
      return
    }
    setPulse(true)
    clearTimeout(timer)
    timer = setTimeout(() => setPulse(false), 650)
  })
  onCleanup(() => clearTimeout(timer))
  return pulse
}

const StatChip: Component<{
  label: string
  value: () => number | string
  sub?: string
  pulse?: () => boolean
  loading: () => boolean
  warn?: () => boolean
}> = (props) => (
  <div class="cx-stat-chip" classList={{ degraded: !!props.warn?.() }}>
    <span class="cx-stat-label">{props.label}</span>
    <Show when={!props.loading()} fallback={<div class="cx-skel cx-skel-line" />}>
      <span class="cx-stat-value" classList={{ pulse: !!props.pulse?.(), warn: !!props.warn?.() }}>
        {props.value()}
      </span>
    </Show>
    <Show when={props.sub}>
      <span class="cx-stat-sub">{props.sub}</span>
    </Show>
  </div>
)

/** Live Proxmox context strip fed by pve-api.ts's real /api2/json client —
 * node/guest/cluster counts the operator can glance at while chatting.
 * Degrades quietly (dashes, no crash) if the ticket can't read these paths. */
const InfraStrip: Component = () => {
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [nodesOnline, setNodesOnline] = createSignal(0)
  const [nodesTotal, setNodesTotal] = createSignal(0)
  const [guestsRunning, setGuestsRunning] = createSignal(0)
  const [guestsTotal, setGuestsTotal] = createSignal(0)
  const [avgLoad, setAvgLoad] = createSignal(0)
  const [degraded, setDegraded] = createSignal(false)

  const load = async (background: boolean) => {
    if (background) setRefreshing(true)
    const [n, r] = await Promise.all([pve.nodes(), pve.clusterResources()])
    let ok = true
    if (n.ok) {
      setNodesTotal(n.data.length)
      const online = n.data.filter((x) => x.status === "online")
      setNodesOnline(online.length)
      const withCpu = online.filter((x) => typeof x.cpu === "number")
      setAvgLoad(withCpu.length ? Math.round((withCpu.reduce((s, x) => s + (x.cpu ?? 0), 0) / withCpu.length) * 100) : 0)
    } else {
      ok = false
    }
    if (r.ok) {
      const guests = r.data.filter((x) => x.type === "qemu" || x.type === "lxc")
      setGuestsTotal(guests.length)
      setGuestsRunning(guests.filter((x) => x.status === "running").length)
    } else {
      ok = false
    }
    setDegraded(!ok)
    setLoading(false)
    if (background) setRefreshing(false)
  }

  onMount(() => {
    void load(false)
    const t = setInterval(() => void load(true), STATS_POLL_MS)
    onCleanup(() => clearInterval(t))
  })

  const nodesPulse = usePulseOnChange(nodesOnline)
  const guestsPulse = usePulseOnChange(guestsRunning)
  const loadPulse = usePulseOnChange(avgLoad)
  const clusterOk = createMemo(() => nodesTotal() === 0 || nodesOnline() === nodesTotal())

  return (
    <div class="cx-chatpage-stats">
      <StatChip
        label="Nodes"
        value={() => `${nodesOnline()}/${nodesTotal()}`}
        sub="online"
        pulse={nodesPulse}
        loading={loading}
        warn={() => !clusterOk()}
      />
      <StatChip
        label="Guests"
        value={() => `${guestsRunning()}/${guestsTotal()}`}
        sub="running"
        pulse={guestsPulse}
        loading={loading}
      />
      <StatChip
        label="Load"
        value={() => `${avgLoad()}%`}
        sub="cluster avg"
        pulse={loadPulse}
        loading={loading}
      />
      <StatChip
        label="Cluster"
        value={() => (degraded() ? "unknown" : clusterOk() ? "quorate" : "degraded")}
        loading={loading}
        warn={() => degraded() || !clusterOk()}
      />
      <button
        type="button"
        class="cx-chatpage-refresh"
        classList={{ spinning: refreshing() }}
        onClick={() => void load(true)}
        aria-label="Refresh Proxmox status"
        title="Refresh Proxmox status"
      >
        ⟳
      </button>
    </div>
  )
}

const ChatPage: Component = () => {
  // Reuse the shell's one continuous operator conversation when it's
  // available (App.tsx always provides it); fall back to a private
  // client+controller so this page still works if ever mounted standalone.
  let ctx: ReturnType<typeof usePve> | null = null
  try {
    ctx = usePve()
  } catch {
    ctx = null
  }
  const controller =
    ctx?.controller ??
    (() => {
      const client = new CindroClient()
      client.connect()
      return new ChatController(client)
    })()

  return (
    <div class="cx-page cx-page-chat cx-fade-in">
      <div class="cx-chatpage-hero">
        <div class="cx-chatpage-mark">
          <ArcReactor size={40} />
        </div>
        <div class="cx-chatpage-brandwrap">
          <span class="cx-chatpage-brand">CINDRO</span>
          <span class="cx-chatpage-sub">Proxmox operator console</span>
        </div>
        <div class="cx-chatpage-hero-spacer" />
        <div class="cx-topbar-link" classList={{ live: controller.connected() }}>
          <span class="cx-topbar-link-dot" />
          {controller.connected() ? "LINKED" : "OFFLINE"}
        </div>
      </div>
      <InfraStrip />
      <div class="cx-chatpage-shell">
        <ChatPanel controller={controller} />
      </div>
    </div>
  )
}

export default {
  id: "chat",
  label: "Chat",
  icon: "✦",
  section: "CINDRO",
  order: 0,
  component: ChatPage,
} satisfies PageDef
