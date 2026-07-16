// PveContext — the one context every page/widget consumes: the CindroClient
// (the daemon RPC/event bus), the shared ChatController (one continuous
// operator conversation, wired once in App.tsx and reused by every page +
// the docked side-rail), current page id + navigate(), and the socket's live
// status. Mirrors web/src/core/app-context.tsx's AppApi shape so page logic
// ported between the two dashboards needs minimal adaptation — pages pull
// what they need from usePve() instead of prop-drilling, which is what lets
// router.ts's PageDef.component stay a zero-prop Component.
import { createContext, useContext } from "solid-js"

import type { ChatController } from "./chat"
import type { CindroClient } from "./cindro-client"

export interface PveApi {
  client: CindroClient
  controller: ChatController
  page: () => string
  navigate: (id: string) => void
  connected: () => boolean
}

export const PveContext = createContext<PveApi>()

export function usePve(): PveApi {
  const ctx = useContext(PveContext)
  if (!ctx) throw new Error("usePve() called outside <PveContext.Provider>")
  return ctx
}
