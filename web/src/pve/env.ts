// Host-served config for the Cindro Proxmox dashboard. This SPA is served BY
// proxmox-dashboard (:8443) straight off the Proxmox host, and talks to two
// same-origin backends the server reverse-proxies for it (see
// proxmox-mcp/proxmox_mcp/dashboard_server.py):
//   - the REAL Proxmox REST API at /api2/json — see ./pve-api.ts, authed via
//     Proxmox's own PVEAuthCookie (never a token in JS)
//   - the co-located Cindro AI daemon (jarvisd) bridged at /_jarvis/* — see
//     ./cindro-client.ts (RPC/events) and ./chat.tsx (the operator session).
//     The daemon's own control token is injected server-side and never
//     reaches the browser; the bridge is cookie-gated on that same live
//     PVEAuthCookie, so being logged into Proxmox IS being logged into Cindro
//     here — there is no separate Cindro-specific login for this dashboard.

export function controlWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${location.host}/_jarvis/ws`
}

// Any suffix works — makeBrain routes on the "proxmox-op-" prefix. The hostname
// keeps sessions legible per host.
export function operatorTargetRef(): string {
  return "proxmox-op-" + (location.hostname || "host")
}
