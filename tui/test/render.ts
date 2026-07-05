// Tracked testRender wrapper. A raw testRender() leaves its CliRenderer (and
// every ArcReactor/poll setInterval it started) alive after the test ends —
// the solid root is never disposed. Across the suite those orphaned 100ms
// timers accumulate and starve later render passes, flaking frame-timing
// tests (widget-in-chat, replay stepping). This tracks every renderer and
// destroys it after each test, so each starts on a clean event loop.

import { testRender } from "@opentui/solid"
import { afterEach } from "bun:test"

type Setup = Awaited<ReturnType<typeof testRender>>

const active: Setup[] = []

export async function render(
  node: Parameters<typeof testRender>[0],
  opts?: Parameters<typeof testRender>[1],
): Promise<Setup> {
  const setup = await testRender(node, opts)
  active.push(setup)
  return setup
}

afterEach(() => {
  for (const setup of active.splice(0)) {
    try {
      setup.renderer.destroy()
    } catch {
      // already torn down
    }
  }
})
