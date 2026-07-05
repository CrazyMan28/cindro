// ManifestStore — the client-side face of ui.manifest.get: reactive page
// list (builtin + custom), auto-refreshed on ui.manifest.changed /
// tui.layout.changed broadcasts. This is the diff-and-refetch loop that
// keeps Jarvis-authored custom pages live without a restart (the legacy
// _reconcile_custom_pages promise, now manifest-wide).

import { createSignal } from "solid-js"

import type { ControlClient } from "./control/client"
import type { ManifestPage } from "./pages/engine/types"

export class ManifestStore {
  readonly pages: () => ManifestPage[]
  private setPages: (v: ManifestPage[]) => void
  private offs: Array<() => void> = []

  constructor(private client: ControlClient) {
    const [pages, setPages] = createSignal<ManifestPage[]>([])
    this.pages = pages
    this.setPages = setPages
    this.offs.push(client.on("ui.manifest.changed", () => void this.refresh()))
    // Older daemons only broadcast tui.layout.changed — listen to both
    // (refresh is idempotent).
    this.offs.push(client.on("tui.layout.changed", () => void this.refresh()))
  }

  async refresh(): Promise<void> {
    try {
      const m = await this.client.call("ui.manifest.get", {}, 8000)
      this.setPages((m.pages ?? []) as ManifestPage[])
    } catch {
      // daemon down/too old — keep whatever we had
    }
  }

  page(id: string): ManifestPage | undefined {
    return this.pages().find((p) => p.id === id)
  }

  customPages(): ManifestPage[] {
    return this.pages()
      .filter((p) => p.source === "custom")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  tablePages(): ManifestPage[] {
    return this.pages().filter((p) => p.kind === "table" && p.source !== "custom")
  }

  dispose(): void {
    for (const off of this.offs) off()
  }
}
