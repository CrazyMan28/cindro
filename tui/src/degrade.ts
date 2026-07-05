// callDegrading — the TS twin of cli/jarvis_cli/tui/degrade.py: call a
// daemon verb that might not exist yet (client newer than daemon) and let
// the caller render a quiet "not available yet" instead of a scary error.

import type { ControlClient } from "./control/client"
import { ControlError } from "./control/client"

export interface DegradeOpts {
  onUnknownMethod?: (err: ControlError) => void
  onError?: (err: unknown) => void
}

export async function callDegrading(
  client: ControlClient,
  method: string,
  params: Record<string, unknown> = {},
  opts: DegradeOpts = {},
): Promise<Record<string, unknown> | null> {
  try {
    return await client.call(method, params)
  } catch (err) {
    if (err instanceof ControlError && err.code === "unknown_method") {
      opts.onUnknownMethod?.(err)
      return null
    }
    opts.onError?.(err)
    return null
  }
}
