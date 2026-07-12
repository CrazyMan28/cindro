// HOME — ported from desktop/qml/HomePage.qml's intent (greeting, live
// status, quick nav, recent sessions), using only data Contract A actually
// exposes to a browser client (status.get, session.list) rather than the
// native host stats the QML version also shows.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import { getPages, type PageDef } from "../core/router"
import { ArcReactor } from "../components/ArcReactor"

interface SessionRow {
  id: string
  title?: string
  agent?: string
  state?: string
  updated_at?: number
}

const QUICK_LINKS = ["chat", "voice", "canvas", "memory", "skills", "agents"]

function Home() {
  const app = useApp()
  const [sessions, setSessions] = createSignal<SessionRow[]>([])
  const [error, setError] = createSignal("")
  const [connected, setConnected] = createSignal(app.client.connected)
  let alive = true
  onCleanup(() => {
    alive = false
  })

  onMount(() => {
    const poll = setInterval(() => setConnected(app.client.connected), 500)
    onCleanup(() => clearInterval(poll))
  })

  const load = async () => {
    try {
      const res = await app.client.call("session.list", {}, 15000)
      if (!alive) return
      const rows = (res.sessions ?? []) as SessionRow[]
      setSessions(rows.filter((s) => !s.agent).slice(0, 6))
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(load, 15000)
    onCleanup(() => clearInterval(timer))
  })

  const quickPages = (): PageDef[] => {
    const byId = new Map(getPages().map((p) => [p.id, p]))
    return QUICK_LINKS.map((id) => byId.get(id)).filter((p): p is PageDef => Boolean(p))
  }

  return (
    <div class="home-page">
      <div class="home-hero card">
        <ArcReactor size={64} />
        <div class="home-hero-text">
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "20px" }}>
            CINDRO
          </div>
          <div style={{ color: "var(--text-muted)", "font-size": "13px" }}>
            {connected() ? "All systems connected." : "Connecting to the daemon…"}
          </div>
        </div>
      </div>

      <div class="home-section">
        <div class="hud-label home-section-title">QUICK ACCESS</div>
        <div class="home-quick-grid">
          <For each={quickPages()}>
            {(p) => (
              <button type="button" class="home-quick-card" onClick={() => app.navigate(p.id)}>
                {p.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="home-section">
        <div class="hud-label home-section-title">RECENT SESSIONS</div>
        <Show when={error()}>
          <div class="setup-error">⚠ {error()}</div>
        </Show>
        <Show when={!error() && sessions().length === 0}>
          <div style={{ color: "var(--text-faint)", "font-size": "12px" }}>No sessions yet.</div>
        </Show>
        <div class="home-session-list">
          <For each={sessions()}>
            {(s) => (
              <button type="button" class="home-session-row" onClick={() => app.navigate("chat")}>
                <span class="home-session-title">{s.title || s.id}</span>
                <span class="home-session-state">{s.state || ""}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

const page: PageDef = { id: "home", label: "HOME", section: "WORKSPACE", order: 0, component: Home }
export default page
