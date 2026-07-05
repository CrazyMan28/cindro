// CanvasStore + the saved-widget library.
//
// CanvasStore tails widget.render/remove/clear broadcasts through the
// multi-subscriber bus (chat listens too — the whole point of killing the
// single-slot dispatcher) with GUI CanvasPage parity the legacy TUI lacked:
// newest-on-top ordering, a 20-item cap, update-by-id.
//
// The library reads/writes the SAME ~/.local/share/jarvis/saved_widgets.json
// the desktop Widgets page uses (Bridge.cpp:3137), via dataDir() so
// JARVIS_DATA_DIR profile isolation matches the daemon. The TUI adds an
// ADDITIVE `pinned`/`pin_order` field pair for its Home-pins terminal
// translation of the GUI's 📌-Home flow — the GUI ignores unknown fields.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { createSignal } from "solid-js"

import { dataDir } from "../config"
import type { ControlClient } from "../control/client"
import { callDegrading } from "../degrade"

export interface CanvasItem {
  id: string
  title: string
  spec: Record<string, unknown>
  at: number
}

const CANVAS_CAP = 20

function parseSpec(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return (raw ?? {}) as Record<string, unknown>
}

export class CanvasStore {
  readonly items: () => CanvasItem[]
  private setItems: (fn: (items: CanvasItem[]) => CanvasItem[]) => void
  private off: () => void
  private seq = 0

  constructor(client: ControlClient) {
    const [items, setItems] = createSignal<CanvasItem[]>([])
    this.items = items
    this.setItems = (fn) => setItems((prev) => fn(prev))
    // Some daemon builds gate widget.* to widget.subscribe'd sockets; older
    // ones broadcast to everyone. Subscribe best-effort either way.
    void callDegrading(client, "widget.subscribe", {})
    this.off = client.on("widget.", (event, data) => this.onEvent(event, data))
  }

  onEvent(event: string, data: Record<string, unknown>): void {
    if (event === "widget.clear") {
      this.setItems(() => [])
      return
    }
    const id = String(data.id ?? "")
    if (event === "widget.remove") {
      this.setItems((items) => items.filter((i) => i.id !== id))
      return
    }
    if (event !== "widget.render") return
    const item: CanvasItem = {
      id: id || `anon-${++this.seq}`,
      title: String(data.title ?? "") || id || "widget",
      spec: parseSpec(data.spec ?? data.widget),
      at: Date.now(),
    }
    this.setItems((items) => {
      const rest = items.filter((i) => i.id !== item.id)
      return [item, ...rest].slice(0, CANVAS_CAP) // newest on top, capped
    })
  }

  inject(item: { id: string; title: string; spec: unknown }): void {
    this.onEvent("widget.render", item as Record<string, unknown>)
  }

  remove(id: string): void {
    this.setItems((items) => items.filter((i) => i.id !== id))
  }

  dispose(): void {
    this.off()
  }
}

// -- saved-widget library -------------------------------------------------

export interface SavedWidget {
  id: string
  name: string
  spec: unknown
  pinned?: boolean
  pin_order?: number
  [key: string]: unknown
}

export function libraryPath(): string {
  return join(dataDir(), "saved_widgets.json")
}

export function loadLibrary(): { widgets: SavedWidget[]; raw: Record<string, unknown> } {
  try {
    const raw = JSON.parse(readFileSync(libraryPath(), "utf8")) as Record<string, unknown>
    const widgets = ((raw.widgets ?? []) as SavedWidget[]).filter((w) => w && w.id)
    return { widgets, raw }
  } catch {
    return { widgets: [], raw: {} }
  }
}

/** Writes back preserving any top-level keys other tools keep in the file. */
export function saveLibrary(widgets: SavedWidget[], raw: Record<string, unknown> = {}): void {
  const out = { ...raw, widgets }
  mkdirSync(dirname(libraryPath()), { recursive: true })
  writeFileSync(libraryPath(), JSON.stringify(out, null, 2))
}

export function saveToLibrary(item: CanvasItem): void {
  const { widgets, raw } = loadLibrary()
  const entry: SavedWidget = {
    id: item.id.startsWith("saved:") ? item.id.slice(6) : item.id,
    name: item.title,
    spec: item.spec,
  }
  const rest = widgets.filter((w) => w.id !== entry.id)
  saveLibrary([...rest, { ...widgets.find((w) => w.id === entry.id), ...entry }], raw)
}

export function pinnedWidgets(): SavedWidget[] {
  return loadLibrary()
    .widgets.filter((w) => w.pinned)
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0))
}

export function specOf(w: SavedWidget): Record<string, unknown> {
  return parseSpec(w.spec)
}
