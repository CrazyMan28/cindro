// Endpoint + token resolution — a faithful port of cli/jarvis_cli/config.py
// (any change there must be mirrored here; grep "config root" in that file):
//   - config root: $JARVIS_CONFIG_DIR else ~/.config/jarvis
//   - control token: <config>/control_token   (env JARVIS_CONTROL_TOKEN wins)
//   - control port: config.toml [ports] control (default 8795); env
//     JARVIS_CONTROL_HOST / JARVIS_CONTROL_PORT override host/port
//   - data root: $JARVIS_DATA_DIR else $XDG_DATA_HOME/jarvis else
//     ~/.local/share/jarvis

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function configDir(): string {
  return process.env.JARVIS_CONFIG_DIR ?? join(homedir(), ".config", "jarvis")
}

export function dataDir(): string {
  if (process.env.JARVIS_DATA_DIR) return process.env.JARVIS_DATA_DIR
  const xdg = process.env.XDG_DATA_HOME
  return join(xdg ?? join(homedir(), ".local", "share"), "jarvis")
}

export function controlToken(): string {
  const env = process.env.JARVIS_CONTROL_TOKEN
  if (env) return env.trim()
  try {
    return readFileSync(join(configDir(), "control_token"), "utf8").trim()
  } catch {
    return ""
  }
}

export function controlPort(): number {
  const env = process.env.JARVIS_CONTROL_PORT
  if (env) {
    const p = Number.parseInt(env, 10)
    if (Number.isFinite(p) && p > 0 && p < 65536) return p
  }
  // config.toml [ports] control = N — same flat parse the daemon/CLI use.
  try {
    let section = ""
    for (const raw of readFileSync(join(configDir(), "config.toml"), "utf8").split("\n")) {
      const line = raw.trim()
      if (line.startsWith("[") && line.endsWith("]")) {
        section = line.slice(1, -1).trim()
        continue
      }
      if (section === "ports" && line.startsWith("control")) {
        const v = line.split("=")[1]
        if (v !== undefined) {
          const p = Number.parseInt(v.trim(), 10)
          if (Number.isFinite(p) && p > 0 && p < 65536) return p
        }
      }
    }
  } catch {
    // no config.toml — fall through to the default
  }
  return 8795
}

export function controlHost(): string {
  return process.env.JARVIS_CONTROL_HOST ?? "127.0.0.1"
}

export function controlWsUrl(): string {
  const base =
    process.env.JARVIS_CONTROL_WS ?? `ws://${controlHost()}:${controlPort()}/control/ws`
  const token = controlToken()
  if (!token) return base
  const sep = base.includes("?") ? "&" : "?"
  return `${base}${sep}token=${token}`
}
