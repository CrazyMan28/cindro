// Cindro Proxmox dashboard shell: login gate → nav rail + page + docked side
// chat. One Client and one ChatController (shared by the full Chat page and the
// side-rail, so it's one continuous operator conversation).

import { For, Show, createSignal, onMount, type Component } from "solid-js"
import { Client } from "./client"
import { ChatController, ChatPanel } from "./chat"
import { HomePage, PermissionsPage, TasksPage, VmsPage } from "./pages"
import { checkAuth, login } from "./env"

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
  const [token, setToken] = createSignal("")
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    setBusy(true)
    setErr("")
    const ok = await login(token().trim())
    setBusy(false)
    if (ok) props.onOk()
    else setErr("Invalid dashboard token.")
  }
  return (
    <div class="px-login">
      <div class="px-login-card px-fade">
        <div class="px-brand">CINDRO<span class="px-brand-dim"> · PROXMOX</span></div>
        <div class="px-login-sub">Sign in with your dashboard token</div>
        <input
          class="px-input"
          type="password"
          placeholder="dashboard token"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit() }}
        />
        <button class="px-btn px-btn-ok px-btn-wide" disabled={busy()} onClick={submit}>
          {busy() ? "…" : "Enter"}
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
