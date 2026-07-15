// Page registry for the Cindro Proxmox dashboard. Pages self-register with a
// `export default` PageDef — App.tsx discovers them with Vite's
// import.meta.glob over ./pages/**/*.tsx, so NEW PAGE FILES NEVER REQUIRE
// EDITING THIS FILE OR App.tsx. Mirrors web/src/core/router.ts's registry
// pattern (same trick, same reason: many agents can add pages in parallel
// without touching a shared file), trimmed to this SPA's own section set.
import type { Component } from "solid-js"

/** Nav groups, top to bottom: real Proxmox infrastructure, the Cindro AI
 * operator surface, then dashboard-level settings. */
export type Section = "PROXMOX" | "CINDRO" | "SYSTEM"

export interface PageDef {
  /** Stable id — also the URL hash route (#/<id>) and the key used to keep a
   * page's DOM (and its state) alive while it's not the active tab. */
  id: string
  label: string
  /** Optional glyph shown in the nav rail before the label (kept plain-text/
   * emoji so no icon-font dependency is required). */
  icon?: string
  section: Section
  /** Sort key within a section; lower first. Default 0. */
  order?: number
  /** Zero-prop page component — pull the client/controller/navigate it needs
   * from usePve() (./pve-context), not from props, so this registry (and the
   * glob that feeds it) never has to know a page's data needs. */
  component: Component
}

const registry = new Map<string, PageDef>()

export function registerPage(def: PageDef): void {
  registry.set(def.id, def)
}

export function getPage(id: string): PageDef | undefined {
  return registry.get(id)
}

export function getPages(): PageDef[] {
  return [...registry.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** Pages grouped by section, sections in their canonical display order, each
 * group's pages already sorted by `order`. Empty sections are omitted. */
export function getPagesBySection(): Array<{ section: Section; pages: PageDef[] }> {
  const order: Section[] = ["PROXMOX", "CINDRO", "SYSTEM"]
  const all = getPages()
  return order
    .map((section) => ({ section, pages: all.filter((p) => p.section === section) }))
    .filter((g) => g.pages.length > 0)
}

/** Reads the current page id from the URL hash (e.g. "#/vms" -> "vms"),
 * falling back to "home". Lets the browser back/forward buttons and direct
 * navigation (used by browser-based smoke tests) both work. */
export function pageFromHash(): string {
  const raw = location.hash.replace(/^#\/?/, "")
  return raw || "home"
}

export function setHash(id: string): void {
  const target = `#/${id}`
  if (location.hash !== target) location.hash = target
}
