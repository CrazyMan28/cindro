// jarvis-tui entry — boots the OpenTUI renderer, connects the ControlClient,
// hydrates the command registry from ui.manifest, mounts <App/>.

import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"

import { App } from "./app"
import { CommandRegistry } from "./commands/registry"
import { ControlClient } from "./control/client"
import { loadSavedAccent } from "./theme"

loadSavedAccent()

const renderer = await createCliRenderer({
  targetFps: 60,
  gatherStats: false,
  exitOnCtrlC: false,
  openConsoleOnError: false,
  useMouse: true,
})

const client = new ControlClient()
client.start()

const registry = new CommandRegistry()
const hydrateCommands = async () => {
  try {
    const m = await client.call("ui.manifest.get", {}, 8000)
    registry.mergeManifest((m.commands ?? []) as Array<Record<string, unknown>>)
  } catch {
    // daemon down or too old — the registry still serves local commands
  }
}
void hydrateCommands()
client.on("ui.manifest.changed", () => void hydrateCommands())

const quit = () => {
  void client.close().finally(() => {
    renderer.destroy()
    process.exit(0)
  })
}

process.on("SIGINT", quit)
process.on("SIGTERM", quit)

await render(() => <App client={client} registry={registry} onQuit={quit} />, renderer)
