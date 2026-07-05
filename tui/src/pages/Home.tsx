// Home — the GUI HomePage dashboard, terminal edition: greeting +
// connection pill, hero active-agent card (reactor + live agent/session
// counts), quick-action chips, recent sessions (1-4 to open), live CPU/RAM/
// NET cards with rolling history bars (read from /proc like the GUI's
// bridge does), pinned widgets (📌 from the Widgets library) with
// j/k select · J/K reorder · X unpin, and the manifest page directory.

import { TextAttributes } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../app-context"
import { theme } from "../theme"
import { ArcReactor } from "../ui/ArcReactor"
import { historyBars, sampleSystem } from "../ui/sysstats"
import type { SavedWidget } from "../widgets/store"
import { loadLibrary, pinnedWidgets, saveLibrary, specOf } from "../widgets/store"
import { Widget } from "../widgets/Widget"

interface PageEntry {
  id: string
  title: string
  section: string
  kind: string
  source?: string
}

interface SessionRow {
  id: string
  title: string
  state: string
  brain?: string
}

function greeting(hour: number, name: string): string {
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"
  return name ? `Good ${part}, ${name}` : `Good ${part}`
}

const STATS_MS = 2000
const HIST = 5

export function HomeDashboard(props: {
  active: () => boolean
  onOpenSession: (id: string, title: string) => void
}) {
  const app = useApp()
  const [userName, setUserName] = createSignal("")
  const [connected, setConnected] = createSignal(false)
  const [pages, setPages] = createSignal<PageEntry[]>([])
  const [sessions, setSessions] = createSignal<SessionRow[]>([])
  const [agentsRunning, setAgentsRunning] = createSignal(0)
  const [sessionsLive, setSessionsLive] = createSignal(0)
  const [cpuHist, setCpuHist] = createSignal<number[]>([])
  const [ramHist, setRamHist] = createSignal<number[]>([])
  const [net, setNet] = createSignal<{ up: number; down: number } | null>(null)
  const [ramLabel, setRamLabel] = createSignal("")
  const [pins, setPins] = createSignal<SavedWidget[]>([])
  const [pinSel, setPinSel] = createSignal(0)

  const load = async () => {
    try {
      const s = await app.client.call("settings.get", {}, 5000)
      const settings = (s.settings ?? s) as Record<string, unknown>
      setUserName(String(settings.user_name ?? ""))
      setConnected(true)
    } catch {
      setConnected(false)
    }
    try {
      const st = await app.client.call("status.get", {}, 5000)
      setAgentsRunning(Number(st.agents_running ?? 0))
      setSessionsLive(Number(st.sessions_live ?? 0))
    } catch {
      // old daemon — counts stay 0
    }
    try {
      const res = await app.client.call("session.list", {}, 5000)
      const list = ((res.sessions ?? []) as Array<Record<string, unknown>>)
        .filter((r) => !r.parent_session_id)
        .slice(-4)
        .reverse()
        .map((r) => ({
          id: String(r.id ?? ""),
          title: String(r.title ?? r.id ?? ""),
          state: String(r.state ?? ""),
          brain: r.brain ? String(r.brain) : undefined,
        }))
      setSessions(list)
    } catch {
      setSessions([])
    }
    try {
      const m = await app.client.call("ui.manifest.get", {}, 5000)
      setPages(((m.pages ?? []) as PageEntry[]).filter((p) => p.id !== "home"))
    } catch {
      // manifest unavailable — the tab strip still navigates
    }
    setPins(pinnedWidgets())
  }

  onMount(() => {
    void load()
    const offManifest = app.client.on("ui.manifest.changed", () => void load())
    const offOpened = app.client.on("session.opened", () => void load())
    const stats = setInterval(() => {
      const snap = sampleSystem()
      if (snap.cpuPercent !== null)
        setCpuHist((h) => [...h, snap.cpuPercent!].slice(-HIST))
      if (snap.ramPercent !== null) {
        setRamHist((h) => [...h, snap.ramPercent!].slice(-HIST))
        setRamLabel(`${snap.ramUsedGb ?? "?"}/${snap.ramTotalGb ?? "?"}G`)
      }
      if (snap.netUpKbps !== null)
        setNet({ up: snap.netUpKbps, down: snap.netDownKbps ?? 0 })
    }, STATS_MS)
    onCleanup(() => {
      offManifest()
      offOpened()
      clearInterval(stats)
    })
  })

  const movePin = (dir: -1 | 1) => {
    const list = [...pins()]
    const i = pinSel()
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    const { widgets, raw } = loadLibrary()
    const reordered = widgets.map((w) => {
      const idx = list.findIndex((p) => p.id === w.id)
      return idx >= 0 ? { ...w, pin_order: idx } : w
    })
    saveLibrary(reordered, raw)
    setPins(pinnedWidgets())
    setPinSel(j)
  }

  useKeyboard(
    (key: KeyEvent) => {
      if (!props.active()) return
      const n = Number.parseInt(key.name ?? "", 10)
      if (!key.ctrl && !key.meta && !key.option && Number.isInteger(n) && n >= 1 && n <= 4) {
        const s = sessions()[n - 1]
        if (s) props.onOpenSession(s.id, s.title)
        return
      }
      switch (key.name) {
        case "n":
          app.navigate("chat")
          break
        case "c":
          app.navigate("canvas")
          break
        case "j":
          setPinSel((i) => Math.min(Math.max(0, pins().length - 1), i + 1))
          break
        case "k":
          setPinSel((i) => Math.max(0, i - 1))
          break
        case "J":
          movePin(1)
          break
        case "K":
          movePin(-1)
          break
        case "X": {
          const pin = pins()[pinSel()]
          if (pin) {
            const { widgets, raw } = loadLibrary()
            saveLibrary(
              widgets.map((w) => (w.id === pin.id ? { ...w, pinned: false } : w)),
              raw,
            )
            setPins(pinnedWidgets())
            setPinSel((i) => Math.max(0, i - 1))
          }
          break
        }
        default:
          break
      }
    },
    {},
  )

  const sections = () => {
    const by = new Map<string, PageEntry[]>()
    for (const p of pages()) {
      const list = by.get(p.section) ?? []
      list.push(p)
      by.set(p.section, list)
    }
    return [...by.entries()]
  }

  const stateColor = (state: string) =>
    state === "running" || state === "starting"
      ? theme.amber
      : state === "error"
        ? theme.danger
        : theme.success

  return (
    <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
      {/* hero */}
      <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
        <ArcReactor size={11} thinking={agentsRunning() > 0} />
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {greeting(new Date().getHours(), userName())}
          </text>
          <text fg={connected() ? theme.success : theme.danger}>
            {connected() ? "● ONLINE" : "○ CONNECTING…"} · {sessionsLive()} live ·{" "}
            {agentsRunning()} agents working
          </text>
          <text fg={theme.textFaint}>
            n new chat · c canvas · 1-4 open a recent session · / commands
          </text>
        </box>
      </box>

      {/* live system cards */}
      <box flexDirection="row" gap={3} flexShrink={0}>
        <text fg={theme.textMuted} selectable={false}>
          CPU {historyBars(cpuHist())} {cpuHist().at(-1) ?? "–"}%
        </text>
        <text fg={theme.textMuted} selectable={false}>
          RAM {historyBars(ramHist())} {ramHist().at(-1) ?? "–"}% {ramLabel()}
        </text>
        <Show when={net()}>
          {(v) => (
            <text fg={theme.textMuted} selectable={false}>
              NET ↑{v().up} ↓{v().down} kB/s
            </text>
          )}
        </Show>
      </box>

      {/* recent sessions */}
      <Show when={sessions().length > 0}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
            // RECENT SESSIONS
          </text>
          <For each={sessions()}>
            {(s, i) => (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={2}
                onMouseDown={() => props.onOpenSession(s.id, s.title)}
              >
                <text fg={theme.textFaint} selectable={false}>
                  {i() + 1}.
                </text>
                <text fg={stateColor(s.state)} selectable={false}>
                  ●
                </text>
                <text fg={theme.text}>{s.title}</text>
                <text fg={theme.textFaint}>
                  {s.brain ?? ""} {s.state}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* pinned widgets */}
      <Show when={pins().length > 0}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
            // PINNED · j/k select · J/K move · X unpin
          </text>
          <For each={pins()}>
            {(pin, i) => (
              <box
                flexDirection="column"
                flexShrink={0}
                border
                borderColor={i() === pinSel() ? theme.accent : theme.hairlineFaint}
              >
                <text fg={theme.violet} selectable={false}>
                  📌 {pin.name}
                </text>
                <Widget spec={specOf(pin)} />
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* page directory */}
      <Show when={pages().length > 0}>
        <box flexDirection="column" flexShrink={0}>
          <For each={sections()}>
            {([section, entries]) => (
              <box flexDirection="column">
                <text fg={theme.accent} attributes={TextAttributes.BOLD} selectable={false}>
                  // {section.toUpperCase()}
                </text>
                <For each={entries}>
                  {(p) => (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={2}
                      onMouseDown={() => app.navigate(p.id)}
                    >
                      <text fg={theme.text} selectable={false}>
                        {p.title}
                      </text>
                      <text fg={theme.textFaint} selectable={false}>
                        /{p.id}
                        {p.source === "custom" ? "  ✦ custom" : ""}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </Show>
    </scrollbox>
  )
}
