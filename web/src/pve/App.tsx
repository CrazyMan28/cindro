// Cindro Proxmox dashboard shell: login gate → nav rail + page + docked side
// chat. One Client and one ChatController (shared by the full Chat page and the
// side-rail, so it's one continuous operator conversation).

import { For, Show, createSignal, onMount, type Component } from "solid-js"
import { Client } from "./client"
import { ChatController, ChatPanel } from "./chat"
import { HomePage, PermissionsPage, TasksPage, VmsPage } from "./pages"
import { checkAuth, getRealms, login, type Realm } from "./env"

const client = new Client()
const controller = new ChatController(client)

const NAV = [
  { id: "home", label: "Home" },
  { id: "vms", label: "VMs" },
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tasks" },
  { id: "permissions", label: "Permissions" },
]

const Login: Component<{ onOk: () => void }> = (props) => {
  const [username, setUsername] = createSignal("root")
  const [password, setPassword] = createSignal("")
  const [realm, setRealm] = createSignal("pam")
  const [realms, setRealms] = createSignal<Realm[]>([
    { realm: "pam", comment: "Linux PAM standard authentication" },
    { realm: "pve", comment: "Proxmox VE authentication server" },
  ])
  const [otp, setOtp] = createSignal("")
  const [challenge, setChallenge] = createSignal("")
  const [needTfa, setNeedTfa] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  onMount(async () => {
    const rs = await getRealms()
    if (rs.length) {
      setRealms(rs)
      if (!rs.some((r) => r.realm === "pam")) setRealm(rs[0].realm)
    }
  })

  const submit = async () => {
    setBusy(true)
    setErr("")
    const res = await login({
      username: username().trim(),
      password: password(),
      realm: realm(),
      otp: needTfa() ? otp().trim() : undefined,
      tfa_challenge: needTfa() ? challenge() : undefined,
    })
    setBusy(false)
    if (res.ok) {
      props.onOk()
      return
    }
    if (res.tfa) {
      setNeedTfa(true)
      setChallenge(res.tfa_challenge || "")
      return
    }
    setErr(res.error || "Login failed")
  }

  return (
    <div class="px-login">
      <div class="px-login-card px-fade">
        <div class="px-brand">CINDRO<span class="px-brand-dim"> · PROXMOX</span></div>
        <div class="px-login-sub">
          {needTfa() ? "Two-factor authentication" : "Sign in with your Proxmox account"}
        </div>
        <Show
          when={!needTfa()}
          fallback={
            <input
              class="px-input"
              placeholder="6-digit code"
              inputmode="numeric"
              value={otp()}
              onInput={(e) => setOtp(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit() }}
            />
          }
        >
          <input
            class="px-input"
            placeholder="Username"
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit() }}
          />
          <input
            class="px-input"
            type="password"
            placeholder="Password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit() }}
          />
          <select class="px-input px-select" value={realm()} onChange={(e) => setRealm(e.currentTarget.value)}>
            <For each={realms()}>
              {(r) => <option value={r.realm}>{r.comment}</option>}
            </For>
          </select>
        </Show>
        <button class="px-btn px-btn-ok px-btn-wide" disabled={busy()} onClick={submit}>
          {busy() ? "…" : needTfa() ? "Verify" : "Sign in"}
        </button>
        <Show when={err()}><div class="px-msg px-msg-error">{err()}</div></Show>
      </div>
    </div>
  )
}

export const App: Component = () => {
  const [authed, setAuthed] = createSignal(false)
  const [page, setPage] = createSignal("home")
  const [linked, setLinked] = createSignal(false)

  const boot = () => {
    controller.bind()
    client.onStatus = (c) => setLinked(c)
    client.connect()
  }
  onMount(async () => {
    if (await checkAuth()) {
      setAuthed(true)
      boot()
    }
  })
  const onLogin = () => {
    setAuthed(true)
    boot()
  }

  const pageProps = () => ({ client, controller, goChat: () => setPage("chat") })

  return (
    <Show when={authed()} fallback={<Login onOk={onLogin} />}>
      <div class="px-app">
        <nav class="px-rail">
          <div class="px-brand-mini">C<span class="px-dot" classList={{ live: linked() }} /></div>
          <For each={NAV}>
            {(n) => (
              <button
                class="px-navitem"
                classList={{ active: page() === n.id }}
                onClick={() => setPage(n.id)}
              >
                {n.label}
              </button>
            )}
          </For>
        </nav>

        <main class="px-main">
          <Show when={page() === "home"}><HomePage {...pageProps()} /></Show>
          <Show when={page() === "vms"}><VmsPage {...pageProps()} /></Show>
          <Show when={page() === "tasks"}><TasksPage {...pageProps()} /></Show>
          <Show when={page() === "permissions"}><PermissionsPage {...pageProps()} /></Show>
          <Show when={page() === "chat"}>
            <div class="px-page px-fade px-chatpage">
              <h2 class="px-hud">Jarvis · Proxmox operator</h2>
              <ChatPanel controller={controller} />
            </div>
          </Show>
        </main>

        <Show when={page() !== "chat"}>
          <aside class="px-siderail">
            <div class="px-siderail-head">Jarvis</div>
            <ChatPanel controller={controller} compact />
          </aside>
        </Show>
      </div>
    </Show>
  )
}
