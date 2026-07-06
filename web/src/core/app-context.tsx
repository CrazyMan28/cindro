// AppContext — the one context every page consumes: the daemon client,
// current page id + navigate(), and a toast/notify sink. Mirrors
// tui/src/app-context.ts's AppApi shape so logic ported from TUI pages needs
// minimal adaptation.
import { createContext, useContext } from "solid-js"

import type { ControlClient } from "./control-client"

export type Severity = "info" | "warn" | "error"

export interface Toast {
  id: number
  message: string
  severity: Severity
}

export interface AppApi {
  client: ControlClient
  page: () => string
  navigate: (page: string) => void
  notify: (message: string, severity?: Severity) => void
}

export const AppContext = createContext<AppApi>()

export function useApp(): AppApi {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("useApp() outside <AppContext.Provider>")
  return ctx
}
