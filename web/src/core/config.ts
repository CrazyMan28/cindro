// Browser-side counterpart to cli/jarvis_cli/config.py / tui/src/config.ts.
// A browser tab has no filesystem access, so the token/port live in
// localStorage instead of ~/.config/jarvis/* — populated by the pairing flow
// or manual paste in <SetupWizard/> (see components/SetupWizard.tsx).

const TOKEN_KEY = "jarvis.controlToken"
const PORT_KEY = "jarvis.controlPort"
const DEFAULT_PORT = 8795

export function controlPort(): number {
  const v = parseInt(localStorage.getItem(PORT_KEY) || String(DEFAULT_PORT), 10)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PORT
}

export function setControlPort(port: number): void {
  localStorage.setItem(PORT_KEY, String(parseInt(String(port), 10) || DEFAULT_PORT))
}

export function controlToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ""
}

export function setControlToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token || "")
}

export function clearControlToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function controlHost(): string {
  return "127.0.0.1"
}

export function controlWsUrl(): string {
  const base = `ws://${controlHost()}:${controlPort()}/control/ws`
  const token = controlToken()
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}
