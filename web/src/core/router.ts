// Page registry + keep-alive router. Pages self-register via a `export
// default` PageDef — App.tsx discovers them with Vite's import.meta.glob, so
// NEW PAGE FILES NEVER REQUIRE EDITING THIS FILE OR App.tsx. This is the
// mechanism that lets ~20 agents build pages in parallel without touching a
// shared file.
import type { Component } from "solid-js"

export type Section = "WORKSPACE" | "MIND" | "SYSTEM"

export interface PageDef {
  /** Must be a reserved TUI page id (see core/TuiLayoutStore.cpp), or a
   * GUI-only extra like "browser" (flagged — see docs/superpowers/plans). */
  id: string
  label: string
  section: Section
  /** Sort key within a section; lower first. Default 0. Extras (not in the
   * canonical NavRail.qml list) should set a high order (e.g. 999) so they
   * sort after the canonical items instead of disturbing their order. */
  order?: number
  /** When present and false, the NavRail item is hidden (mirrors NavRail
   * .qml's `computerAvailable` gating for the Computer page). */
  gated?: () => boolean
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

/** Reads the current page id from the URL hash (e.g. "#/memory" -> "memory"),
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
