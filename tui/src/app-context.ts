// AppContext — the one context every page/pane consumes: the daemon client,
// the command registry, navigation, and notifications.

import { createContext, useContext } from "solid-js"

import type { CommandRegistry } from "./commands/registry"
import type { ControlClient } from "./control/client"

export interface AppApi {
  client: ControlClient
  registry: CommandRegistry
  page: () => string
  navigate: (page: string) => void
  notify: (message: string, severity?: "info" | "warn" | "error") => void
  quit: () => void
}

export const AppContext = createContext<AppApi>()

export function useApp(): AppApi {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("useApp() outside <AppContext.Provider>")
  return ctx
}
