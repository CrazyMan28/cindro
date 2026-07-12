// MEMORY — full CRUD over Jarvis long-term memory (Contract A memory.*),
// ported from desktop/qml/MemoryPage.qml's intent: a debounced search box
// over memory.search/memory.list, an inline "remember this…" composer that
// parses #tag tokens out of the text (memory.add), per-row inline edit
// (memory.edit) and remove (memory.remove). Beyond the QML floor, this adds
// an entity quick-filter strip (memory.entities.list + memory.entity.get)
// so memories can be browsed grouped by the person/project/topic the
// knowledge graph auto-extracted them under — a lightweight preview of the
// graph the memorygraph.tsx page renders in full.
import { createSignal, createMemo, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { ArcReactor } from "../components/ArcReactor"

interface MemoryItem {
  id: string
  text: string
  tags: string[]
  created: number
  updated?: number
  score?: number
}

interface EntityItem {
  id: string
  kind: "entity"
  name: string
  type: string
  scope: string
  projectRef?: string
  created: number
  updated: number
}

// memory.entity.get's `related` array mixes entity json ({name,type,...}) and
// bare memory json ({text,tags,...}, no `kind`) — tell them apart by shape.
type RelatedNode = Record<string, unknown>
const isEntityNode = (r: RelatedNode): boolean => typeof r.name === "string"

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}
function asNumber(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function toMemoryItem(raw: unknown): MemoryItem {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    id: asString(r.id),
    text: asString(r.text),
    tags: asStringArray(r.tags),
    created: asNumber(r.created),
    updated: r.updated === undefined ? undefined : asNumber(r.updated),
    score: r.score === undefined || r.score === null ? undefined : asNumber(r.score),
  }
}

function toEntityItem(raw: unknown): EntityItem {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    id: asString(r.id),
    kind: "entity",
    name: asString(r.name),
    type: asString(r.type, "misc"),
    scope: asString(r.scope, "global"),
    projectRef: r.projectRef === undefined ? undefined : asString(r.projectRef),
    created: asNumber(r.created),
    updated: asNumber(r.updated),
  }
}

function relTime(ms: number): string {
  if (!ms || ms <= 0) return "—"
  const t = ms < 1e12 ? ms * 1000 : ms // tolerate epoch-seconds
  const diff = Date.now() - t
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function Memory() {
  const app = useApp()

  const [query, setQuery] = createSignal("")
  const [searching, setSearching] = createSignal(false)
  const [memories, setMemories] = createSignal<MemoryItem[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const [addText, setAddText] = createSignal("")
  const [addBusy, setAddBusy] = createSignal(false)

  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editText, setEditText] = createSignal("")
  const [editTagsCsv, setEditTagsCsv] = createSignal("")
  const [busyIds, setBusyIds] = createSignal<Set<string>>(new Set())

  const [entities, setEntities] = createSignal<EntityItem[]>([])
  const [activeEntity, setActiveEntity] = createSignal<EntityItem | null>(null)
  const [entityRelated, setEntityRelated] = createSignal<RelatedNode[] | null>(null)
  const [entityBusy, setEntityBusy] = createSignal(false)

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const setBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const refresh = async () => {
    setLoading(true)
    const q = query().trim()
    try {
      const res =
        q.length > 0
          ? await app.client.call(
              "memory.search",
              // include_agent_scoped: this is a human deliberately searching
              // their OWN memory (not automatic LLM-context injection), so it
              // should see agent-scoped facts too — same as empty-query
              // browsing via memory.list already does.
              { q, limit: 50, include_agent_scoped: true },
              15000,
            )
          : await app.client.call("memory.list", { limit: 50 }, 15000)
      if (!alive) return
      const rows = ((res.memories ?? []) as unknown[]).map(toMemoryItem)
      setMemories(rows)
      setSearching(q.length > 0)
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  const loadEntities = async () => {
    try {
      const res = await app.client.call("memory.entities.list", { limit: 40 }, 15000)
      if (!alive) return
      setEntities(((res.entities ?? []) as unknown[]).map(toEntityItem))
    } catch {
      // Entity chips are a bonus affordance, not the floor — degrade quietly.
      if (alive) setEntities([])
    }
  }

  let debounce: ReturnType<typeof setTimeout> | undefined
  const onQueryInput = (v: string) => {
    setQuery(v)
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void refresh(), 220)
  }

  onMount(() => {
    void refresh()
    void loadEntities()
    const timer = setInterval(() => {
      if (!editingId()) void refresh()
    }, 30000)
    onCleanup(() => {
      if (debounce) clearTimeout(debounce)
      clearInterval(timer)
    })
  })

  const commitAdd = async () => {
    const raw = addText().trim()
    if (raw.length === 0 || addBusy()) return
    const tagMatches = raw.match(/#[\w-]+/g) ?? []
    const tags = tagMatches.map((t) => t.slice(1))
    const text = raw.replace(/#[\w-]+/g, "").replace(/\s+/g, " ").trim()
    if (text.length === 0) {
      app.notify("Nothing left to remember after stripping tags.", "warn")
      return
    }
    setAddBusy(true)
    try {
      await app.client.call("memory.add", { text, tags }, 15000)
      setAddText("")
      app.notify("Remembered.", "info")
      await refresh()
      await loadEntities()
    } catch (e) {
      app.notify(`Could not save memory: ${String(e)}`, "error")
    } finally {
      if (alive) setAddBusy(false)
    }
  }

  const startEdit = (row: MemoryItem) => {
    setEditingId(row.id)
    setEditText(row.text)
    setEditTagsCsv(row.tags.join(", "))
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditText("")
    setEditTagsCsv("")
  }
  const saveEdit = async (id: string) => {
    const text = editText().trim()
    if (text.length === 0) {
      app.notify("Memory text cannot be empty.", "warn")
      return
    }
    const tags = editTagsCsv()
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    setBusy(id, true)
    try {
      await app.client.call("memory.edit", { id, text, tags }, 15000)
      cancelEdit()
      app.notify("Memory updated.", "info")
      await refresh()
    } catch (e) {
      app.notify(`Could not update memory: ${String(e)}`, "error")
    } finally {
      if (alive) setBusy(id, false)
    }
  }

  const removeMemory = async (id: string) => {
    setBusy(id, true)
    try {
      await app.client.call("memory.remove", { id }, 15000)
      if (editingId() === id) cancelEdit()
      app.notify("Forgotten.", "info")
      await refresh()
      await loadEntities()
    } catch (e) {
      app.notify(`Could not remove memory: ${String(e)}`, "error")
    } finally {
      if (alive) setBusy(id, false)
    }
  }

  const selectEntity = async (entity: EntityItem) => {
    if (activeEntity()?.id === entity.id) {
      setActiveEntity(null)
      setEntityRelated(null)
      return
    }
    setActiveEntity(entity)
    setEntityRelated(null)
    setEntityBusy(true)
    try {
      const res = await app.client.call("memory.entity.get", { id: entity.id }, 15000)
      if (!alive) return
      setEntityRelated((res.related ?? []) as RelatedNode[])
    } catch (e) {
      if (alive) app.notify(`Could not load entity: ${String(e)}`, "error")
    } finally {
      if (alive) setEntityBusy(false)
    }
  }

  const clearEntityFilter = () => {
    setActiveEntity(null)
    setEntityRelated(null)
  }

  const filterByTag = (tag: string) => {
    setQuery(tag)
    void refresh()
  }

  const relatedMemories = createMemo<MemoryItem[]>(() => {
    const rel = entityRelated()
    if (!rel) return []
    return rel.filter((r) => !isEntityNode(r)).map(toMemoryItem)
  })
  const relatedEntities = createMemo<EntityItem[]>(() => {
    const rel = entityRelated()
    if (!rel) return []
    return rel.filter(isEntityNode).map(toEntityItem)
  })

  const displayedMemories = createMemo(() => (activeEntity() ? relatedMemories() : memories()))

  const renderRow = (row: MemoryItem, i: () => number) => (
    <div class="jw-mem-card" style={{ "animation-delay": `${Math.min(i(), 12) * 22}ms` }}>
      <Show
        when={editingId() !== row.id}
        fallback={
          <>
            <textarea
              class="jw-mem-textarea"
              rows={3}
              value={editText()}
              onInput={(e) => setEditText(e.currentTarget.value)}
              maxlength={2000}
            />
            <div class="jw-mem-row">
              <input
                class="jw-mem-input"
                placeholder="tags, comma, separated"
                value={editTagsCsv()}
                onInput={(e) => setEditTagsCsv(e.currentTarget.value)}
              />
            </div>
            <div class="jw-mem-actions">
              <button
                type="button"
                class="jw-mem-btn primary"
                disabled={busyIds().has(row.id)}
                onClick={() => void saveEdit(row.id)}
              >
                {busyIds().has(row.id) ? "Saving…" : "Save"}
              </button>
              <button type="button" class="jw-mem-btn" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </>
        }
      >
        <div class="jw-mem-card-text">{row.text}</div>
        <div class="jw-mem-card-meta">
          <For each={row.tags}>
            {(t) => (
              <button type="button" class="jw-mem-tag" onClick={() => filterByTag(t)} title={`Search #${t}`}>
                #{t}
              </button>
            )}
          </For>
          <Show
            when={searching() && row.score !== undefined}
            fallback={<span class="jw-mem-time">{relTime(row.created)}</span>}
          >
            <span class="jw-mem-score">score {row.score?.toFixed(2)}</span>
          </Show>
        </div>
        <div class="jw-mem-actions">
          <button type="button" class="jw-mem-btn" onClick={() => startEdit(row)}>
            Edit
          </button>
          <button
            type="button"
            class="jw-mem-btn danger"
            disabled={busyIds().has(row.id)}
            onClick={() => void removeMemory(row.id)}
          >
            {busyIds().has(row.id) ? "…" : "Forget"}
          </button>
        </div>
      </Show>
    </div>
  )

  return (
    <div class="jw-mem-page">
      <style>{`
        .jw-mem-page { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
        .jw-mem-header { display: flex; align-items: center; gap: 16px; }
        .jw-mem-header-sub { color: var(--text-muted); font-size: 12px; max-width: 520px; line-height: 1.35; }
        .jw-mem-toolbar { display: flex; flex-direction: column; gap: 10px; }
        .jw-mem-row { display: flex; gap: 10px; align-items: center; }
        .jw-mem-input, .jw-mem-textarea {
          flex: 1; background: var(--surface-input); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-xs); color: var(--text); padding: 8px 12px;
          font-family: var(--font-sans); font-size: 13px; resize: vertical;
        }
        .jw-mem-input:focus, .jw-mem-textarea:focus { outline: none; border-color: var(--accent-dim); }
        .jw-mem-btn {
          all: unset; cursor: pointer; padding: 7px 14px; border-radius: 999px;
          border: 1px solid var(--hairline-soft); background: var(--surface); color: var(--accent);
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          transition: border-color var(--dur-fast) ease, transform var(--dur-fast) ease, box-shadow var(--dur-fast) ease;
          white-space: nowrap;
        }
        .jw-mem-btn:hover:not(:disabled) { border-color: var(--accent-dim); transform: translateY(-1px); box-shadow: 0 3px 12px -4px var(--accent-glow); }
        .jw-mem-btn.primary { background: var(--accent-dim); color: var(--accent-bright); border-color: var(--accent-dim); }
        .jw-mem-btn.danger { color: var(--danger); border-color: var(--danger-dim); }
        .jw-mem-btn:disabled { opacity: 0.4; cursor: default; transform: none; box-shadow: none; }
        .jw-mem-entities { display: flex; flex-wrap: wrap; gap: 6px; }
        .jw-mem-chip {
          all: unset; cursor: pointer; padding: 4px 11px; border-radius: 999px;
          border: 1px solid var(--hairline-soft); font-family: var(--font-mono); font-size: 11px;
          color: var(--violet); transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease;
        }
        .jw-mem-chip:hover { border-color: var(--violet); }
        .jw-mem-chip.project { color: var(--amber); }
        .jw-mem-chip.active { background: rgba(178,139,255,0.16); border-color: var(--violet); color: var(--text); }
        .jw-mem-chip.active.project { background: rgba(255,180,84,0.16); border-color: var(--amber); }
        .jw-mem-filter-bar {
          display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-radius: var(--radius-sm);
          background: var(--panel-soft); border: 1px solid var(--accent-dim);
        }
        .jw-mem-filter-title { color: var(--text); font-size: 12px; }
        .jw-mem-filter-title b { color: var(--accent-bright); }
        .jw-mem-filter-related { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
        .jw-mem-list { display: flex; flex-direction: column; gap: 9px; }
        .jw-mem-card {
          position: relative; background: var(--panel-soft); border: 1px solid var(--hairline-faint);
          border-radius: var(--radius); padding: 12px 14px 12px 18px; display: flex; flex-direction: column;
          gap: 8px; transition: border-color var(--dur-fast) ease;
          animation: jw-mem-in var(--dur-slow) ease-out backwards;
        }
        .jw-mem-card::before {
          content: ""; position: absolute; left: 1px; top: 1px; bottom: 1px; width: 3px;
          border-radius: 1.5px; background: var(--violet); opacity: 0.7;
        }
        .jw-mem-card:hover { border-color: var(--accent-dim); }
        .jw-mem-card-text { color: var(--text); font-size: 13px; line-height: 1.4; white-space: pre-wrap; }
        .jw-mem-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .jw-mem-tag {
          all: unset; cursor: pointer; padding: 2px 8px; border-radius: 999px;
          border: 1px solid rgba(178,139,255,0.4); color: var(--violet);
          font-family: var(--font-mono); font-size: 10px;
        }
        .jw-mem-tag:hover { border-color: var(--violet); }
        .jw-mem-time, .jw-mem-score { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; margin-left: auto; }
        .jw-mem-score { color: var(--accent); }
        .jw-mem-actions { display: flex; gap: 6px; }
        .jw-mem-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 46px 20px; text-align: center; }
        .jw-mem-empty-title { font-family: var(--font-display); color: var(--accent-bright); font-size: 14px; letter-spacing: var(--track-mid); }
        .jw-mem-empty-sub { color: var(--text-faint); font-size: 12px; max-width: 360px; line-height: 1.4; }
        @keyframes jw-mem-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div class="jw-mem-header card">
        <ArcReactor size={44} tint="var(--violet)" />
        <div>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "18px" }}>
            MEMORY
          </div>
          <div class="jw-mem-header-sub">
            Long-term recall injected into every session. Search, add, or prune what Cindro remembers.
          </div>
        </div>
      </div>

      <div class="jw-mem-toolbar">
        <div class="jw-mem-row">
          <input
            class="jw-mem-input"
            placeholder="Search memory…"
            value={query()}
            onInput={(e) => onQueryInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void refresh()
            }}
          />
          <button
            type="button"
            class="jw-mem-btn"
            onClick={() => {
              if (query().trim().length > 0) setQuery("")
              void refresh()
            }}
          >
            {query().trim().length > 0 ? "Clear" : "Refresh"}
          </button>
        </div>
        <div class="jw-mem-row">
          <input
            class="jw-mem-input"
            placeholder="Remember this…  (tag with #work #project)"
            value={addText()}
            onInput={(e) => setAddText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitAdd()
            }}
            maxlength={2000}
          />
          <button
            type="button"
            class="jw-mem-btn primary"
            disabled={addBusy() || addText().trim().length === 0}
            onClick={() => void commitAdd()}
          >
            {addBusy() ? "Saving…" : "+ Remember"}
          </button>
        </div>

        <Show when={entities().length > 0}>
          <div class="jw-mem-entities">
            <For each={entities()}>
              {(ent) => (
                <button
                  type="button"
                  class={`jw-mem-chip${ent.scope === "project" ? " project" : ""}${activeEntity()?.id === ent.id ? " active" : ""}`}
                  onClick={() => void selectEntity(ent)}
                  title={`${ent.type}${ent.scope === "project" ? " · project" : ""}`}
                >
                  {ent.name}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={activeEntity()}>
        {(ent) => (
          <div class="jw-mem-filter-bar">
            <span class="jw-mem-filter-title">
              Filtered by entity: <b>{ent().name}</b>{" "}
              <span style={{ color: "var(--text-faint)" }}>
                [{ent().type}
                {ent().scope === "project" ? " · project" : ""}]
              </span>
            </span>
            <Show when={relatedEntities().length > 0}>
              <span class="jw-mem-filter-related">
                also linked: {relatedEntities().map((r) => r.name).join(", ")}
              </span>
            </Show>
            <button type="button" class="jw-mem-btn" style={{ "margin-left": "auto" }} onClick={clearEntityFilter}>
              Clear filter
            </button>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={entityBusy()}>
        <div style={{ color: "var(--text-faint)", "font-size": "12px" }}>Loading entity…</div>
      </Show>

      <Show
        when={!loading() && !entityBusy() && displayedMemories().length === 0}
      >
        <div class="jw-mem-empty">
          <ArcReactor size={84} tint={activeEntity() ? "var(--violet)" : "var(--accent)"} />
          <div class="jw-mem-empty-title">
            {activeEntity() ? "NO RELATED MEMORIES" : searching() ? "NO MATCHES" : "MEMORY EMPTY"}
          </div>
          <div class="jw-mem-empty-sub">
            {activeEntity()
              ? "This entity has no linked memories yet."
              : searching()
                ? "No stored memory matches that query."
                : "Anything you ask Cindro to remember — or that it self-curates — shows up here and is recalled across sessions."}
          </div>
        </div>
      </Show>

      <div class="jw-mem-list">
        <For each={displayedMemories()}>{(row, i) => renderRow(row, i)}</For>
      </div>
    </div>
  )
}

const page: PageDef = { id: "memory", label: "MEMORY", section: "MIND", order: 0, component: Memory }
export default page
