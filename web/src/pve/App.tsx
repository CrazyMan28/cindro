// App shell bootstrap for the Cindro Proxmox dashboard: a Cindro-branded
// login gate (Proxmox's own ticket auth, see ./pve-api), then a HUD shell —
// animated nav rail grouped by section, a topbar with live connection/clock,
// a page area that cross-fades between routes, and a docked collapsible
// Cindro chat rail (the same ChatController the full Chat page uses, so it's
// one continuous operator conversation wherever it's shown).
//
// Pages self-register: every module under ./pages/**/*.tsx exports a
// `default PageDef` (see ./router.ts) which Vite's import.meta.glob picks up
// eagerly below — NEW PAGE FILES NEVER REQUIRE EDITING THIS FILE. Pages pull
// the client/controller/navigate they need from usePve() (./pve-context)
// rather than props, so router.ts's PageDef.component can stay a zero-prop
// Component (same trick as web/src/App.tsx + core/router.ts, for the same
// reason: many agents can build pages in parallel without touching a shared
// file).
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"

import { ArcReactor } from "../components/ArcReactor"
import { ChatController, ChatPanel } from "./chat"
import { CindroClient } from "./cindro-client"
import * as pve from "./pve-api"
import { PveContext, type PveApi } from "./pve-context"
import {
  getPage,
  getPagesBySection,
  pageFromHash,
  registerPage,
  setHash,
  type PageDef,
  type Section,
} from "./router"

// Eagerly import every page module so its `export default PageDef` registers
// itself as a side effect.
const pageModules = import.meta.glob<{ default: PageDef }>("./pages/**/*.tsx", { eager: true })
for (const path in pageModules) {
  const def = pageModules[path]?.default
  if (def && typeof def.id === "string") registerPage(def)
}

const SECTION_LABEL: Record<Section, string> = {
  PROXMOX: "Proxmox",
  CINDRO: "Cindro",
  SYSTEM: "System",
}

// ---------------------------------------------------------------------------
// Boot splash — shown only for the instant checkAuth() takes to resolve, so
// a valid session never flashes the login card before the shell.
// ---------------------------------------------------------------------------

const BootSplash: Component = () => (
  <div class="cx-boot">
    <ArcReactor size={48} />
    <span class="cx-boot-label">CINDRO</span>
  </div>
)

// ---------------------------------------------------------------------------
// Login — Proxmox's own /access/ticket flow (pve-api.ts), two-step for TFA.
// ---------------------------------------------------------------------------

const Login: Component<{ onOk: (user: string) => void }> = (props) => {
  const [username, setUsername] = createSignal("root")
  const [password, setPassword] = createSignal("")
  const [realm, setRealm] = createSignal("pam")
  const [realms, setRealms] = createSignal<pve.Realm[]>([
    { realm: "pam", comment: "Linux PAM standard authentication" },
    { realm: "pve", comment: "Proxmox VE authentication server" },
  ])
  const [otp, setOtp] = createSignal("")
  const [tfaChallenge, setTfaChallenge] = createSignal("")
  const [needTfa, setNeedTfa] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let otpRef: HTMLInputElement | undefined

  onMount(async () => {
    const r = await pve.getRealms()
    if (r.ok && r.data.length) {
      setRealms(r.data)
      if (!r.data.some((x) => x.realm === "pam")) {
        setRealm(r.data.find((x) => x.default)?.realm ?? r.data[0].realm)
      }
    }
  })

  const submit = async () => {
    if (busy()) return
    setBusy(true)
    setErr("")
    const res = await pve.login(
      username().trim(),
      password(),
      realm(),
      needTfa() ? otp().trim() : undefined,
      needTfa() ? tfaChallenge() : undefined,
    )
    setBusy(false)
    if (res.ok) {
      props.onOk(res.user)
      return
    }
    if (res.tfa) {
      setNeedTfa(true)
      setTfaChallenge(res.tfaChallenge ?? "")
      setOtp("")
      queueMicrotask(() => otpRef?.focus())
      return
    }
    setErr(res.error || "Sign-in failed")
  }

  return (
    <div class="cx-login">
      <div class="cx-ambient" aria-hidden="true">
        <span class="cx-ambient-blob a" />
        <span class="cx-ambient-blob b" />
        <span class="cx-ambient-blob c" />
      </div>
      <div class="cx-login-card cx-fade-in">
        <div class="cx-login-mark">
          <ArcReactor size={48} />
        </div>
        <div class="cx-login-brand">
          CINDRO<span class="cx-login-brand-dim"> · PROXMOX</span>
        </div>
        <div class="cx-login-sub">
          {needTfa() ? "Two-factor authentication" : "Sign in with your Proxmox account"}
        </div>

        <Show
          when={!needTfa()}
          fallback={
            <div class="cx-field">
              <label class="cx-field-label">Authentication code</label>
              <input
                ref={otpRef}
                class="cx-input"
                placeholder="6-digit code"
                inputmode="numeric"
                autocomplete="one-time-code"
                value={otp()}
                onInput={(e) => setOtp(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit()
                }}
              />
            </div>
          }
        >
          <div class="cx-field">
            <label class="cx-field-label">Username</label>
            <input
              class="cx-input"
              placeholder="root"
              autocomplete="username"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit()
              }}
            />
          </div>
          <div class="cx-field">
            <label class="cx-field-label">Password</label>
            <input
              class="cx-input"
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit()
              }}
            />
          </div>
          <div class="cx-field">
            <label class="cx-field-label">Realm</label>
            <div class="cx-select-wrap">
              <select class="cx-select" value={realm()} onChange={(e) => setRealm(e.currentTarget.value)}>
                <For each={realms()}>{(r) => <option value={r.realm}>{r.comment || r.realm}</option>}</For>
              </select>
            </div>
          </div>
        </Show>

        <button type="button" class="cx-btn cx-btn-primary cx-btn-block" disabled={busy()} onClick={submit}>
          <Show when={!busy()} fallback={<span class="cx-spinner" />}>
            {needTfa() ? "Verify" : "Sign in"}
          </Show>
        </button>
        <Show when={needTfa()}>
          <button
            type="button"
            class="cx-btn cx-btn-ghost cx-btn-block cx-login-back"
            onClick={() => {
              setNeedTfa(false)
              setErr("")
            }}
          >
            Back
          </button>
        </Show>
        <Show when={err()}>
          <div class="cx-login-error">{err()}</div>
        </Show>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const Clock: Component = () => {
  const [now, setNow] = createSignal(new Date())
  onMount(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    onCleanup(() => clearInterval(t))
  })
  const hhmmss = createMemo(() => now().toLocaleTimeString(undefined, { hour12: false }))
  return <span class="cx-topbar-clock">{hhmmss()}</span>
}

export const App: Component = () => {
  const client = new CindroClient()
  const controller = new ChatController(client)

  const [booting, setBooting] = createSignal(true)
  const [authed, setAuthed] = createSignal(false)
  const [authedUser, setAuthedUser] = createSignal("")
  const [connected, setConnected] = createSignal(false)
  const [page, setPage] = createSignal(pageFromHash())
  const [mountedIds, setMountedIds] = createSignal<string[]>([pageFromHash()])
  const [dockCollapsed, setDockCollapsed] = createSignal(false)

  const navigate = (id: string) => {
    if (!getPage(id)) return
    setPage(id)
    setHash(id)
    setMountedIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
  }

  const boot = () => {
    controller.bind()
    client.on("__status", (data) => setConnected(Boolean(data.connected)))
    client.connect()
  }

  onMount(async () => {
    window.addEventListener("hashchange", () => navigate(pageFromHash()))
    const ok = await pve.checkAuth()
    if (ok) {
      setAuthedUser(pve.currentUsername())
      setAuthed(true)
      boot()
    }
    setBooting(false)
  })

  const onLogin = (user: string) => {
    setAuthedUser(user)
    setAuthed(true)
    boot()
  }

  const onLogout = async () => {
    client.close()
    await pve.logout()
    location.reload()
  }

  const api: PveApi = { client, controller, page, navigate, connected }
  const sections = createMemo(() => getPagesBySection())
  const activePages = createMemo(() =>
    mountedIds()
      .map((id) => getPage(id))
      .filter((p): p is PageDef => Boolean(p)),
  )
  const host = location.hostname || "proxmox"
  const activeDef = createMemo(() => getPage(page()))

  return (
    <Show when={!booting()} fallback={<BootSplash />}>
      <Show when={authed()} fallback={<Login onOk={onLogin} />}>
        <PveContext.Provider value={api}>
          <div class="cx-ambient cx-ambient-shell" aria-hidden="true">
            <span class="cx-ambient-blob a" />
            <span class="cx-ambient-blob b" />
            <span class="cx-ambient-blob c" />
          </div>
          <div class="cx-shell">
            <nav class="cx-nav">
              <div class="cx-nav-brand">
                <ArcReactor size={22} />
                <span class="cx-nav-brand-text">CINDRO</span>
              </div>
              <div class="cx-nav-scroll">
                <For each={sections()}>
                  {(group) => (
                    <div class="cx-nav-section">
                      <div class="cx-nav-section-label">{SECTION_LABEL[group.section]}</div>
                      <For each={group.pages}>
                        {(def) => (
                          <button
                            type="button"
                            class="cx-nav-item"
                            classList={{ active: page() === def.id }}
                            onClick={() => navigate(def.id)}
                          >
                            <span class="cx-nav-item-icon">{def.icon ?? "•"}</span>
                            <span class="cx-nav-item-label">{def.label}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
              <button type="button" class="cx-nav-logout" onClick={onLogout} title="Sign out">
                <span class="cx-nav-item-icon">⏻</span>
                <span class="cx-nav-item-label">Sign out</span>
              </button>
            </nav>

            <div class="cx-main">
              <header class="cx-topbar">
                <div class="cx-topbar-title">
                  <span class="cx-topbar-page">{activeDef()?.label ?? ""}</span>
                  <span class="cx-topbar-host">{host}</span>
                </div>
                <div class="cx-topbar-spacer" />
                <Clock />
                <div class="cx-topbar-stat">
                  <span class="cx-topbar-stat-label">OPERATOR</span>
                  <span class="cx-topbar-stat-value">{authedUser() || "—"}</span>
                </div>
                <div class="cx-topbar-link" classList={{ live: connected() }}>
                  <span class="cx-topbar-link-dot" />
                  {connected() ? "LINKED" : "OFFLINE"}
                </div>
              </header>

              <div class="cx-main-scroll">
                <For each={activePages()}>
                  {(def) => (
                    <div class="cx-page-slot" classList={{ active: page() === def.id }} data-page={def.id}>
                      <def.component />
                    </div>
                  )}
                </For>
              </div>
            </div>

            <Show when={page() !== "chat"}>
              <aside class="cx-dock" classList={{ collapsed: dockCollapsed() }}>
                <div class="cx-dock-head">
                  <button
                    type="button"
                    class="cx-dock-toggle"
                    onClick={() => setDockCollapsed((v) => !v)}
                    aria-label={dockCollapsed() ? "Expand Cindro chat" : "Collapse Cindro chat"}
                  >
                    {dockCollapsed() ? "❮" : "❯"}
                  </button>
                  <span class="cx-dock-title">CINDRO</span>
                </div>
                <div class="cx-dock-body">
                  <ChatPanel controller={controller} compact />
                </div>
              </aside>
            </Show>
          </div>
        </PveContext.Provider>
      </Show>
    </Show>
  )
}
