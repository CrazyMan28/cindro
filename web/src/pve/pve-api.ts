// Typed client for the REAL Proxmox VE REST API, reached same-origin at
// /api2/json (the dashboard host reverse-proxies pveproxy :8006 so the
// browser never talks cross-origin/self-signed-TLS directly).
//
// Auth is Proxmox's OWN ticket flow (the same one the stock Proxmox web UI
// uses), not the dashboard's session cookie (see ./env.ts, which gates the
// jarvisd control-WS proxy instead):
//   1. POST /access/ticket sets the PVEAuthCookie — the browser stores and
//      resends it automatically on every same-origin fetch, we never touch it.
//   2. The response body also carries a CSRFPreventionToken, which is NOT a
//      cookie — it must be captured here and echoed back as the
//      "CSRFPreventionToken" header on every mutating (POST/PUT/DELETE) call,
//      or Proxmox rejects the request even though the ticket cookie is valid.
// Nothing here ever throws — every exported call resolves to a typed
// {ok:true,data} | {ok:false,error} result so pages can render failures
// inline instead of needing try/catch everywhere.

const API = "/api2/json"

// The CSRF token only lives in the response body, so it's kept in memory +
// mirrored to sessionStorage (best-effort) to survive a page reload while the
// PVEAuthCookie the browser already holds is still valid. Never persisted
// anywhere alongside a password.
const CSRF_KEY = "cindro-pve-csrf"
const USER_KEY = "cindro-pve-user"

let csrfToken = ""
let currentUser = ""
try {
  csrfToken = sessionStorage.getItem(CSRF_KEY) || ""
  currentUser = sessionStorage.getItem(USER_KEY) || ""
} catch {
  /* sessionStorage unavailable (private mode / non-browser) */
}

// Best-effort — populated after a successful login() (or restored from
// sessionStorage on a page reload while the PVEAuthCookie is still valid).
// Empty if the session was only ever confirmed via checkAuth() without this
// tab ever calling login() itself. Handy for the shell to render "who's in".
export function currentUsername(): string {
  return currentUser
}

function rememberSession(user: string, csrf: string): void {
  currentUser = user
  csrfToken = csrf
  try {
    sessionStorage.setItem(USER_KEY, user)
    sessionStorage.setItem(CSRF_KEY, csrf)
  } catch {
    /* ignore */
  }
}

function forgetSession(): void {
  currentUser = ""
  csrfToken = ""
  try {
    sessionStorage.removeItem(USER_KEY)
    sessionStorage.removeItem(CSRF_KEY)
  } catch {
    /* ignore */
  }
}

// Mirrors how the stock Proxmox web UI logs out: there is no server-side
// logout endpoint, PVEAuthCookie is a plain (non-HttpOnly) cookie the UI
// clears itself.
function clearAuthCookie(): void {
  try {
    document.cookie = "PVEAuthCookie=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"
  } catch {
    /* ignore (non-browser env) */
  }
}

// Proxmox's /access/ticket returns the ticket in the response BODY (it does NOT
// send a Set-Cookie), so — exactly like the stock PVE web UI — the client must
// set PVEAuthCookie itself. Without this, every /api2 request after login sends
// no cookie and pveproxy answers 401, so the whole dashboard reads
// "not authenticated". Value is encodeURIComponent'd (pveproxy url-decodes on
// read). `secure` only when actually served over HTTPS: dashboard_server.py
// falls back to plain HTTP when no TLS cert/key is configured, and browsers
// silently refuse to store/send a `Secure` cookie over a non-HTTPS origin
// (except localhost) — unconditionally marking it Secure would make login
// appear to succeed while every subsequent /api2 request stays unauthenticated.
function setAuthCookie(ticket: string): void {
  try {
    const secure = location.protocol === "https:" ? "; secure" : ""
    document.cookie =
      `PVEAuthCookie=${encodeURIComponent(ticket)}; path=/; samesite=Lax${secure}`
  } catch {
    /* ignore (non-browser env) */
  }
}

function enc(v: string | number): string {
  return encodeURIComponent(String(v))
}

function pveErrorMessage(json: any, status: number): string {
  if (json && typeof json.message === "string" && json.message) return json.message
  if (json && json.errors && typeof json.errors === "object") {
    const parts = Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`)
    if (parts.length) return parts.join("; ")
  }
  if (status === 401) return "not authenticated"
  if (status === 403) return "permission denied"
  return `request failed (${status})`
}

function toParamString(v: unknown): string {
  if (typeof v === "boolean") return v ? "1" : "0"
  if (Array.isArray(v)) return v.map(toParamString).join(",")
  return String(v)
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

type Method = "GET" | "POST" | "PUT" | "DELETE"

async function request<T = any>(
  method: Method,
  path: string,
  params?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  const p = path.startsWith("/") ? path : `/${path}`
  const init: RequestInit = { method, credentials: "include", headers: {} }
  const headers: Record<string, string> = {}
  let url = `${API}${p}`

  const entries = params
    ? Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    : []

  if (method === "GET") {
    if (entries.length) {
      const qs = new URLSearchParams()
      for (const [k, v] of entries) qs.set(k, toParamString(v))
      url += `?${qs.toString()}`
    }
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded"
    headers["CSRFPreventionToken"] = csrfToken
    const body = new URLSearchParams()
    for (const [k, v] of entries) body.set(k, toParamString(v))
    init.body = body.toString()
  }
  init.headers = headers

  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e: any) {
    return { ok: false, error: e?.message ? `network error: ${e.message}` : "network error" }
  }

  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* some responses (e.g. empty bodies) aren't JSON */
  }

  if (!res.ok) {
    return { ok: false, error: pveErrorMessage(json, res.status), status: res.status }
  }
  return { ok: true, data: (json && "data" in json ? json.data : json) as T }
}

// --- generic verbs (Pages/tools can hit any Proxmox API path directly) -----
export function get<T = any>(path: string, params?: Record<string, unknown>): Promise<ApiResult<T>> {
  return request<T>("GET", path, params)
}
export function create<T = any>(path: string, params?: Record<string, unknown>): Promise<ApiResult<T>> {
  return request<T>("POST", path, params)
}
export function set<T = any>(path: string, params?: Record<string, unknown>): Promise<ApiResult<T>> {
  return request<T>("PUT", path, params)
}
export function del<T = any>(path: string, params?: Record<string, unknown>): Promise<ApiResult<T>> {
  return request<T>("DELETE", path, params)
}

// --- auth --------------------------------------------------------------------
export type Realm = { realm: string; comment?: string; type?: string; default?: number; tfa?: string }

export type LoginResult =
  | { ok: true; user: string; ticket: string; csrfToken: string; cap?: unknown }
  | { ok: false; error: string; tfa?: boolean; tfaChallenge?: string }

export function getRealms(): Promise<ApiResult<Realm[]>> {
  return get<Realm[]>("/access/domains")
}

// POST /access/ticket. Two-step TFA: call once with just username/password;
// if the result has tfa:true, re-call with otp + the returned tfaChallenge.
export async function login(
  username: string,
  password: string,
  realm: string,
  otp?: string,
  tfaChallenge?: string,
): Promise<LoginResult> {
  const userid = username.includes("@") ? username : `${username}@${realm || "pam"}`
  const answeringTfa = !!(tfaChallenge && otp)
  const body = new URLSearchParams()
  body.set("username", userid)
  if (answeringTfa) {
    body.set("password", `totp:${otp!.trim()}`)
    body.set("tfa-challenge", tfaChallenge!)
  } else {
    body.set("password", password ?? "")
  }

  let res: Response
  try {
    res = await fetch(`${API}/access/ticket`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
  } catch (e: any) {
    return { ok: false, error: e?.message ? `network error: ${e.message}` : "network error" }
  }

  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* fall through to status-based error below */
  }

  if (!res.ok) {
    return { ok: false, error: pveErrorMessage(json, res.status) }
  }

  const data = json?.data ?? {}
  const ticket = String(data.ticket ?? "")
  const needsTfa = !!data.NeedTFA || ticket.includes("!tfa!")

  if (needsTfa && !answeringTfa) {
    return { ok: false, error: "two-factor authentication required", tfa: true, tfaChallenge: ticket }
  }
  if (!ticket || ticket.includes("!tfa!")) {
    return { ok: false, error: "two-factor authentication failed" }
  }

  const csrf = String(data.CSRFPreventionToken ?? "")
  const user = String(data.username ?? userid)
  setAuthCookie(ticket) // MUST set the cookie or every subsequent /api2 call is unauthenticated
  rememberSession(user, csrf)
  return { ok: true, user, ticket, csrfToken: csrf, cap: data.cap }
}

export async function logout(): Promise<void> {
  forgetSession()
  clearAuthCookie()
}

// GET /version — any authenticated (even unprivileged) ticket can read this,
// so it's a cheap way to confirm the PVEAuthCookie is still valid.
export async function checkAuth(): Promise<boolean> {
  // A valid PVEAuthCookie alone is NOT enough: the CSRF token lives only in
  // memory/sessionStorage (per-tab), so a NEW tab — or a restored session with
  // cleared sessionStorage — would have a live cookie but no token, and every
  // write (start/stop/create/delete) would silently 401 with no recovery. Treat
  // that as unauthenticated so the login screen shows and re-obtains a fresh
  // CSRF token, instead of rendering a shell that can only read.
  if (!csrfToken) return false
  const r = await get("/version")
  return r.ok
}

// --- typed read helpers -------------------------------------------------------
export type PveNode = {
  node: string
  status: "online" | "offline" | "unknown" | string
  type?: string
  cpu?: number
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  level?: string
  ssl_fingerprint?: string
  [key: string]: unknown
}

export type ClusterResourceType = "node" | "storage" | "pool" | "qemu" | "lxc" | "openvz" | "sdn"

export type ClusterResource = {
  id: string
  type: ClusterResourceType | string
  node?: string
  vmid?: number
  name?: string
  status?: string
  cpu?: number
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  template?: number
  pool?: string
  tags?: string
  [key: string]: unknown
}

export type QemuSummary = {
  vmid: number
  name?: string
  status: "running" | "stopped" | "paused" | string
  cpu?: number
  cpus?: number
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  pid?: number
  tags?: string
  template?: number
  [key: string]: unknown
}

// Config keys beyond the common ones (net0, ide2, scsi0, ...) are dynamic —
// index signature covers them.
export type QemuConfig = {
  vmid?: number
  name?: string
  cores?: number
  sockets?: number
  memory?: number | string
  ostype?: string
  boot?: string
  onboot?: number
  agent?: string | number
  digest?: string
  [key: string]: unknown
}

export type QemuStatus = {
  vmid: number
  status: "running" | "stopped" | "paused" | string
  qmpstatus?: string
  cpu?: number
  cpus?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  pid?: number
  ha?: { managed: number; [key: string]: unknown }
  [key: string]: unknown
}

export type LxcSummary = {
  vmid: number
  name?: string
  status: "running" | "stopped" | string
  cpu?: number
  cpus?: number
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  tags?: string
  template?: number
  [key: string]: unknown
}

export type StorageSummary = {
  storage: string
  type: string
  content?: string
  active?: number
  enabled?: number
  shared?: number
  used?: number
  avail?: number
  total?: number
  [key: string]: unknown
}

export type StorageContentItem = {
  volid: string
  content: string
  format?: string
  size?: number
  used?: number
  vmid?: number
  ctime?: number
  notes?: string
  [key: string]: unknown
}

export type NodeStatus = {
  cpu?: number
  cpuinfo?: { cpus?: number; cores?: number; sockets?: number; model?: string; [key: string]: unknown }
  memory?: { total?: number; used?: number; free?: number }
  swap?: { total?: number; used?: number; free?: number }
  rootfs?: { total?: number; used?: number; free?: number }
  loadavg?: [string, string, string]
  uptime?: number
  pveversion?: string
  kversion?: string
  [key: string]: unknown
}

export type TaskSummary = {
  upid: string
  node: string
  pid?: number
  type: string
  id?: string
  user: string
  status?: string
  starttime: number
  endtime?: number
  [key: string]: unknown
}

export type SnapshotSummary = {
  name: string
  description?: string
  snaptime?: number
  vmstate?: number
  parent?: string
  [key: string]: unknown
}

export function nodes(): Promise<ApiResult<PveNode[]>> {
  return get<PveNode[]>("/nodes")
}

export function clusterResources(type?: ClusterResourceType): Promise<ApiResult<ClusterResource[]>> {
  return get<ClusterResource[]>("/cluster/resources", type ? { type } : undefined)
}

export function qemuList(node: string): Promise<ApiResult<QemuSummary[]>> {
  return get<QemuSummary[]>(`/nodes/${enc(node)}/qemu`)
}

export function qemuConfig(node: string, vmid: number | string): Promise<ApiResult<QemuConfig>> {
  return get<QemuConfig>(`/nodes/${enc(node)}/qemu/${enc(vmid)}/config`)
}

export function qemuStatus(node: string, vmid: number | string): Promise<ApiResult<QemuStatus>> {
  return get<QemuStatus>(`/nodes/${enc(node)}/qemu/${enc(vmid)}/status/current`)
}

export function lxcList(node: string): Promise<ApiResult<LxcSummary[]>> {
  return get<LxcSummary[]>(`/nodes/${enc(node)}/lxc`)
}

export function storages(node: string): Promise<ApiResult<StorageSummary[]>> {
  return get<StorageSummary[]>(`/nodes/${enc(node)}/storage`)
}

export function storageContent(
  node: string,
  storage: string,
  content?: string,
): Promise<ApiResult<StorageContentItem[]>> {
  return get<StorageContentItem[]>(`/nodes/${enc(node)}/storage/${enc(storage)}/content`, content ? { content } : undefined)
}

export function nodeStatus(node: string): Promise<ApiResult<NodeStatus>> {
  return get<NodeStatus>(`/nodes/${enc(node)}/status`)
}

// Interfaces/bridges/bonds/VLANs configured on a node (/etc/network/interfaces
// as parsed by pve-manager). `active` reflects live kernel state, `autostart`
// reflects the on-disk config — the two can legitimately disagree (e.g. an
// interface with pending changes not yet applied via "ifreload").
export type NetworkInterface = {
  iface: string
  type: string
  method?: string
  method6?: string
  active?: number
  autostart?: number
  address?: string
  netmask?: string
  gateway?: string
  cidr?: string
  address6?: string
  netmask6?: string
  gateway6?: string
  cidr6?: string
  bridge_ports?: string
  bridge_stp?: string | number
  bridge_fd?: string | number
  bridge_vlan_aware?: number
  slaves?: string
  bond_mode?: string
  bond_miimon?: string | number
  bond_xmit_hash_policy?: string
  comments?: string
  comments6?: string
  priority?: number
  families?: string[]
  exists?: number
  [key: string]: unknown
}

export function nodeNetwork(node: string): Promise<ApiResult<NetworkInterface[]>> {
  return get<NetworkInterface[]>(`/nodes/${enc(node)}/network`)
}

// Proxmox's node task-log (backups, migrations, console sessions, ...) — not
// to be confused with the operator's own Kanban board (proxmoxop.tasks_*).
export function tasks(
  node: string,
  opts?: { limit?: number; vmid?: number | string; errors?: boolean },
): Promise<ApiResult<TaskSummary[]>> {
  const params: Record<string, unknown> = {}
  if (opts?.limit != null) params.limit = opts.limit
  if (opts?.vmid != null) params.vmid = opts.vmid
  if (opts?.errors) params.errors = 1
  return get<TaskSummary[]>(`/nodes/${enc(node)}/tasks`, params)
}

export function snapshots(node: string, vmid: number | string): Promise<ApiResult<SnapshotSummary[]>> {
  return get<SnapshotSummary[]>(`/nodes/${enc(node)}/qemu/${enc(vmid)}/snapshot`)
}
