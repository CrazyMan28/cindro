// App shell bootstrap. Discovers every page module under src/pages/** via
// Vite's import.meta.glob — NEW PAGE FILES ARE PICKED UP AUTOMATICALLY, this
// file never needs editing when a page is added (that's the whole point of
// the registry in core/router.ts).
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"

import { AppContext, type AppApi, type Severity } from "./core/app-context"
import { controlToken } from "./core/config"
import { ControlClient } from "./core/control-client"
import { getPage, pageFromHash, registerPage, setHash, type PageDef } from "./core/router"
import { CommandPalette } from "./components/CommandPalette"
import { NavRail } from "./components/NavRail"
import { HudStatusStrip } from "./components/HudStatusStrip"
import { SetupWizard } from "./components/SetupWizard"

// Eagerly import every page module so its `export default PageDef` registers
// itself as a side effect. Page-building agents only ever add/edit a file
// under src/pages/** — this glob is the only thing that needs to "know"
// about them, and it needs no changes to do so.
const pageModules = import.meta.glob<{ default: PageDef }>("./pages/**/*.tsx", { eager: true })
for (const path in pageModules) {
  const def = pageModules[path]?.default
  if (def && typeof def.id === "string") registerPage(def)
}

let toastSeq = 0

export function App() {
  const client = new ControlClient()
  const [hasToken, setHasToken] = createSignal(Boolean(controlToken()))
  const [page, setPage] = createSignal(pageFromHash())
  const [mountedIds, setMountedIds] = createSignal<string[]>([pageFromHash()])
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [toasts, setToasts] = createSignal<Array<{ id: number; message: string; severity: Severity }>>([])

  const navigate = (id: string) => {
    if (!getPage(id)) return
    setPage(id)
    setHash(id)
    setMountedIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
  }

  const notify = (message: string, severity: Severity = "info") => {
    const id = ++toastSeq
    setToasts((t) => [...t, { id, message, severity }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
  }

  const app: AppApi = { client, page, navigate, notify }

  onMount(() => {
    if (hasToken()) client.start()
    window.addEventListener("hashchange", () => navigate(pageFromHash()))
  })

  createEffect(() => {
    // Re-check after SetupWizard writes a token to localStorage.
    if (hasToken() && !client.connected) client.start()
  })

  const activePages = createMemo(() =>
    mountedIds()
      .map((id) => getPage(id))
      .filter((p): p is PageDef => Boolean(p)),
  )

  return (
    <AppContext.Provider value={app}>
      <Show
        when={hasToken()}
        fallback={
          <SetupWizard
            onDone={() => {
              setHasToken(true)
              client.start()
            }}
          />
        }
      >
        <div class="app-shell">
          <NavRail current={page} onNavigate={navigate} />
          <div class="app-main">
            <HudStatusStrip onOpenPalette={() => setPaletteOpen(true)} />
            <div class="app-content">
              <For each={activePages()}>
                {(def) => (
                  <div
                    class="page-enter"
                    data-page={def.id}
                    style={{ display: page() === def.id ? "block" : "none", height: "100%" }}
                  >
                    <def.component />
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onSelect={(id) => {
            if (id === "__open__") {
              setPaletteOpen(true)
              return
            }
            navigate(id)
            setPaletteOpen(false)
          }}
        />
      </Show>
      <div class="toast-stack">
        <For each={toasts()}>{(t) => <div class={`toast toast-${t.severity}`}>{t.message}</div>}</For>
      </div>
    </AppContext.Provider>
  )
}
