// Host-served config. Unlike the laptop web app (localStorage token, loopback
// ws), this SPA is served BY the dashboard server on the Proxmox host and talks
// to it same-origin: the control WS is proxied to the co-located jarvisd with
// its token injected server-side, and auth is an HttpOnly session cookie
// (exchanged from the dashboard token at /login) — never a token in JS.

export function controlWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${location.host}/control/ws`
}

// Any suffix works — makeBrain routes on the "proxmox-op-" prefix. The hostname
// keeps sessions legible per host.
export function operatorTargetRef(): string {
  return "proxmox-op-" + (location.hostname || "host")
}

export async function checkAuth(): Promise<boolean> {
  try {
    const r = await fetch("/auth", { credentials: "include" })
    const j = await r.json()
    return !!j.authed
  } catch {
    return false
  }
}

export async function login(token: string): Promise<boolean> {
  try {
    const r = await fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token }),
    })
    return r.ok
  } catch {
    return false
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch("/logout", { method: "POST", credentials: "include" })
  } catch {
    /* ignore */
  }
}
