// Keybind resolution + user remaps. Defaults live here; ~/.config/jarvis/
// tui.json { "keybinds": { "<action>": "<key>" } } overrides them (Claude
// Code / OpenCode both ship a remappable JSON keymap). An action bound to
// null is unbound. Keys are matched against a normalized "ctrl+k" / "f2" /
// "leader n" string built from the OpenTUI KeyEvent.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { configDir } from "../config"

export type Action =
  | "palette" // Ctrl+K global command palette
  | "leader" // leader prefix (which-key)
  | "voice" // F2
  | "quit" // Ctrl+Q
  | "help" // leader ? / F1
  | "which_key" // leader-hold overlay (auto)
  | "export" // leader e — export transcript
  | "theme" // leader t — theme cycle
  | "sessions" // leader l — session list
  | "new" // leader n — new chat

export const DEFAULT_KEYBINDS: Record<Action, string | null> = {
  palette: "ctrl+k",
  leader: "ctrl+x",
  voice: "f2",
  quit: "ctrl+q",
  help: "f1",
  which_key: "leader ?",
  export: "leader e",
  theme: "leader t",
  sessions: "leader l",
  new: "leader n",
}

export interface KeyLike {
  name?: string
  ctrl?: boolean
  meta?: boolean
  option?: boolean
  shift?: boolean
}

/** Normalize a KeyEvent into "ctrl+k" / "alt+2" / "f2" / "escape". */
export function normalizeKey(key: KeyLike): string {
  const parts: string[] = []
  if (key.ctrl) parts.push("ctrl")
  if (key.meta || key.option) parts.push("alt")
  if (key.shift && (key.name ?? "").length > 1) parts.push("shift")
  parts.push(key.name ?? "")
  return parts.join("+")
}

export class Keybinds {
  private map: Record<string, string | null>

  constructor(overrides: Partial<Record<Action, string | null>> = {}) {
    this.map = { ...DEFAULT_KEYBINDS, ...overrides }
  }

  static load(): Keybinds {
    try {
      const raw = JSON.parse(
        readFileSync(join(configDir(), "tui.json"), "utf8"),
      ) as { keybinds?: Record<string, string | null> }
      return new Keybinds((raw.keybinds ?? {}) as Partial<Record<Action, string | null>>)
    } catch {
      return new Keybinds()
    }
  }

  binding(action: Action): string | null {
    return this.map[action] ?? null
  }

  /** Non-leader match: does this keypress trigger `action`? */
  matches(action: Action, key: KeyLike): boolean {
    const b = this.binding(action)
    if (!b || b.startsWith("leader ")) return false
    return normalizeKey(key) === b
  }

  /** The plain final key of a "leader X" binding, or null if not leader-bound. */
  leaderKey(action: Action): string | null {
    const b = this.binding(action)
    return b && b.startsWith("leader ") ? b.slice("leader ".length) : null
  }

  /** All leader-bound actions, for the which-key overlay. */
  leaderActions(): Array<{ action: Action; key: string }> {
    const out: Array<{ action: Action; key: string }> = []
    for (const action of Object.keys(this.map) as Action[]) {
      const k = this.leaderKey(action)
      if (k) out.push({ action, key: k })
    }
    return out
  }

  isLeader(key: KeyLike): boolean {
    const b = this.binding("leader")
    return b ? normalizeKey(key) === b : false
  }
}

export const LEADER_LABELS: Record<Action, string> = {
  palette: "command palette",
  leader: "leader",
  voice: "voice mode",
  quit: "quit",
  help: "help",
  which_key: "which-key",
  export: "export transcript",
  theme: "cycle theme",
  sessions: "sessions",
  new: "new chat",
}
