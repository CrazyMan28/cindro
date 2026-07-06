// SKILLS — self-authored skill library management console. Contract A verbs:
// skills.list/create/get/invoke/remove/pin/today/list_archived/unarchive.
// Ported visually from home.tsx's card/row bar (glow-on-hover rows, hud
// labels, staggered entrance) rather than a bare list — pin/today/archive
// lifecycle all get real controls, not just list+invoke+remove.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import fuzzysort from "fuzzysort"

import { useApp } from "../core/app-context"
import type { PageDef } from "../core/router"
import { NavIcon } from "../components/NavIcon"

interface SkillItem {
  name: string
  group: string
  description: string
  tags: string[]
  self_authored: boolean
  path: string
  use_count: number
  last_used_at: number
  pinned: boolean
}

interface SkillDetail {
  frontmatter: Record<string, unknown>
  body: string
  path: string
}

function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : v === null || v === undefined ? fb : String(v)
}
function arrOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}
function timeAgo(ms: number): string {
  if (!ms) return "never"
  const diff = Date.now() - ms
  if (diff < 0) return "just now"
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function toSkillItem(s: Record<string, unknown>): SkillItem {
  return {
    name: str(s.name),
    group: str(s.group),
    description: str(s.description),
    tags: arrOf(s.tags),
    self_authored: Boolean(s.self_authored),
    path: str(s.path),
    use_count: Number(s.use_count ?? 0),
    last_used_at: Number(s.last_used_at ?? 0),
    pinned: Boolean(s.pinned),
  }
}

const emptyForm = { name: "", description: "", group: "", tags: "", body: "" }

function SkillsPage() {
  const app = useApp()
  const [skills, setSkills] = createSignal<SkillItem[]>([])
  const [archived, setArchived] = createSignal<SkillItem[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [showArchived, setShowArchived] = createSignal(false)
  const [archivedLoaded, setArchivedLoaded] = createSignal(false)

  const [digest, setDigest] = createSignal("")
  const [digestOpen, setDigestOpen] = createSignal(false)
  const [digestLoading, setDigestLoading] = createSignal(false)

  const [busy, setBusy] = createSignal<Record<string, boolean>>({})
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [details, setDetails] = createSignal<Record<string, SkillDetail>>({})
  const [detailLoading, setDetailLoading] = createSignal<string | null>(null)

  const [invokeOpen, setInvokeOpen] = createSignal<string | null>(null)
  const [invokeArgs, setInvokeArgs] = createSignal("")
  const [invokeBusy, setInvokeBusy] = createSignal(false)
  const [invokeResults, setInvokeResults] = createSignal<Record<string, string>>({})

  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null)

  const [createOpen, setCreateOpen] = createSignal(false)
  const [form, setForm] = createSignal({ ...emptyForm })
  const [createBusy, setCreateBusy] = createSignal(false)
  const [createError, setCreateError] = createSignal("")

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const setRowBusy = (name: string, v: boolean) => setBusy((b) => ({ ...b, [name]: v }))

  const load = async () => {
    try {
      const res = await app.client.call("skills.list", {}, 15000)
      if (!alive) return
      const list = ((res.skills ?? []) as Record<string, unknown>[]).map(toSkillItem)
      setSkills(list)
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  const loadArchived = async () => {
    try {
      const res = await app.client.call("skills.list_archived", {}, 15000)
      if (!alive) return
      const list = ((res.skills ?? []) as Record<string, unknown>[]).map(toSkillItem)
      setArchived(list)
      setArchivedLoaded(true)
    } catch (e) {
      app.notify(`Failed to load archived skills: ${String(e)}`, "error")
    }
  }

  const loadDigest = async () => {
    setDigestLoading(true)
    try {
      const res = await app.client.call("skills.today", {}, 15000)
      if (!alive) return
      setDigest(str(res.digest))
    } catch (e) {
      if (alive) app.notify(`Digest failed: ${String(e)}`, "error")
    } finally {
      if (alive) setDigestLoading(false)
    }
  }

  onMount(() => {
    void load()
    void loadDigest()
  })

  const toggleArchived = () => {
    const next = !showArchived()
    setShowArchived(next)
    if (next && !archivedLoaded()) void loadArchived()
  }

  const filtered = createMemo(() => {
    const q = query().trim()
    // Sort by group/name only here — NOT pin status. Pin priority is applied
    // per-group in rowsForGroup() instead, so toggling a pin only reorders
    // rows inside its own group and never moves a whole group's position
    // (see the note on groupNames() below for why that stability matters).
    const list = [...skills()].sort((a, b) => {
      if (a.group !== b.group) return a.group.localeCompare(b.group)
      return a.name.localeCompare(b.name)
    })
    if (!q) return list
    const prepped = list.map((s) => ({
      row: s,
      hay: `${s.name} ${s.description} ${s.group} ${s.tags.join(" ")}`,
    }))
    const hits = fuzzysort.go(q, prepped, { key: "hay", limit: 200 })
    return hits.map((h) => h.obj.row)
  })

  // Stable PRIMITIVE keys (group name strings) for the outer <For>. Grouping
  // by re-deriving `[group, rows]` tuples (the previous approach) handed
  // <For> a brand-new tuple object on every recompute, and <For> keys by
  // reference — so it saw "all new" and tore down + rebuilt every group
  // (and every row inside it) on each recompute, replaying every row's
  // entrance animation and flashing the whole list to invisible. Plain
  // strings compare by value, so <For> correctly recognizes an unchanged
  // group name across recomputes and only reorders/updates its contents.
  const groupNames = createMemo(() => {
    const seen = new Set<string>()
    for (const s of filtered()) seen.add(s.group || "general")
    return [...seen].sort()
  })

  const rowsForGroup = (group: string) => {
    const rows = filtered().filter((s) => (s.group || "general") === group)
    // Pin priority applied HERE (per-group, not globally) — the row objects
    // themselves keep their stable identity from skills(), so <For> just
    // moves the DOM node on pin-toggle instead of recreating it.
    return rows.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))
  }

  const togglePin = async (s: SkillItem) => {
    setRowBusy(s.name, true)
    try {
      await app.client.call("skills.pin", { name: s.name, pinned: !s.pinned }, 10000)
      setSkills((list) => list.map((x) => (x.name === s.name ? { ...x, pinned: !x.pinned } : x)))
      app.notify(`${s.name} ${!s.pinned ? "pinned" : "unpinned"}`, "info")
    } catch (e) {
      app.notify(`Pin failed: ${String(e)}`, "error")
    } finally {
      setRowBusy(s.name, false)
    }
  }

  const doRemove = async (name: string) => {
    setRowBusy(name, true)
    try {
      await app.client.call("skills.remove", { name }, 10000)
      setSkills((list) => list.filter((x) => x.name !== name))
      setConfirmRemove(null)
      app.notify(`Removed skill "${name}"`, "info")
    } catch (e) {
      app.notify(`Remove failed: ${String(e)}`, "error")
    } finally {
      setRowBusy(name, false)
    }
  }

  const doUnarchive = async (name: string) => {
    setRowBusy(name, true)
    try {
      await app.client.call("skills.unarchive", { name }, 10000)
      setArchived((list) => list.filter((x) => x.name !== name))
      app.notify(`Unarchived "${name}" — back in the active library`, "info")
      void load()
    } catch (e) {
      app.notify(`Unarchive failed: ${String(e)}`, "error")
    } finally {
      setRowBusy(name, false)
    }
  }

  const toggleDetail = async (name: string) => {
    if (expanded() === name) {
      setExpanded(null)
      return
    }
    setExpanded(name)
    if (details()[name]) return
    setDetailLoading(name)
    try {
      const res = await app.client.call("skills.get", { name }, 15000)
      setDetails((d) => ({
        ...d,
        [name]: {
          frontmatter: (res.frontmatter ?? {}) as Record<string, unknown>,
          body: str(res.body),
          path: str(res.path),
        },
      }))
    } catch (e) {
      app.notify(`Load details failed: ${String(e)}`, "error")
      setExpanded(null)
    } finally {
      setDetailLoading(null)
    }
  }

  const runInvoke = async (name: string) => {
    setInvokeBusy(true)
    try {
      const res = await app.client.call("skills.invoke", { name, args: invokeArgs() }, 20000)
      setInvokeResults((r) => ({ ...r, [name]: str(res.message) }))
      setSkills((list) =>
        list.map((x) => (x.name === name ? { ...x, use_count: x.use_count + 1, last_used_at: Date.now() } : x)),
      )
      app.notify(`Invoked "${name}"`, "info")
    } catch (e) {
      app.notify(`Invoke failed: ${String(e)}`, "error")
    } finally {
      setInvokeBusy(false)
    }
  }

  const submitCreate = async (e: Event) => {
    e.preventDefault()
    const f = form()
    if (!f.name.trim()) {
      setCreateError("Name is required")
      return
    }
    setCreateBusy(true)
    setCreateError("")
    try {
      const tags = f.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      await app.client.call(
        "skills.create",
        { name: f.name.trim(), description: f.description, body: f.body, group: f.group, tags },
        20000,
      )
      app.notify(`Created skill "${f.name.trim()}"`, "info")
      setForm({ ...emptyForm })
      setCreateOpen(false)
      void load()
    } catch (e) {
      setCreateError(String(e))
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <div class="sk-page">
      <style>{SKILLS_CSS}</style>

      <div class="sk-header">
        <div class="sk-title-group">
          <NavIcon glyph="skills" color="var(--accent-bright)" glow />
          <div>
            <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "18px" }}>
              SKILLS
            </div>
            <div class="sk-subtitle">Self-authored skill library — {skills().length} active</div>
          </div>
        </div>
        <div class="sk-toolbar">
          <div class="sk-stat-pill">
            <span class="sk-stat-num">{skills().filter((s) => s.pinned).length}</span> pinned
          </div>
          <button type="button" class="sk-btn sk-btn-ghost" onClick={() => void load()}>
            ⟳ Refresh
          </button>
          <button type="button" class="sk-btn" onClick={() => setCreateOpen((v) => !v)}>
            {createOpen() ? "✕ Cancel" : "+ New Skill"}
          </button>
        </div>
      </div>

      <Show when={createOpen()}>
        <form class="sk-card sk-form" onSubmit={submitCreate}>
          <div class="sk-form-title hud-label">AUTHOR A NEW SKILL</div>
          <div class="sk-form-grid">
            <label class="sk-field">
              <span>Name *</span>
              <input
                value={form().name}
                onInput={(e) => setForm((f) => ({ ...f, name: e.currentTarget.value }))}
                placeholder="deploy_web_dashboard"
              />
            </label>
            <label class="sk-field">
              <span>Group</span>
              <input
                value={form().group}
                onInput={(e) => setForm((f) => ({ ...f, group: e.currentTarget.value }))}
                placeholder="self"
              />
            </label>
            <label class="sk-field sk-field-wide">
              <span>Description</span>
              <input
                value={form().description}
                onInput={(e) => setForm((f) => ({ ...f, description: e.currentTarget.value }))}
                placeholder="What this skill does and when to use it"
              />
            </label>
            <label class="sk-field sk-field-wide">
              <span>Tags (comma separated)</span>
              <input
                value={form().tags}
                onInput={(e) => setForm((f) => ({ ...f, tags: e.currentTarget.value }))}
                placeholder="deploy, web, ops"
              />
            </label>
            <label class="sk-field sk-field-wide">
              <span>Body (SKILL.md instructions)</span>
              <textarea
                rows="6"
                value={form().body}
                onInput={(e) => setForm((f) => ({ ...f, body: e.currentTarget.value }))}
                placeholder="Step-by-step instructions the model follows when this skill is invoked…"
              />
            </label>
          </div>
          <Show when={createError()}>
            <div class="sk-error">⚠ {createError()}</div>
          </Show>
          <div class="sk-form-actions">
            <button type="submit" class="sk-btn" disabled={createBusy()}>
              {createBusy() ? "Saving…" : "Save Skill"}
            </button>
          </div>
        </form>
      </Show>

      <div class="sk-card sk-digest">
        <button type="button" class="sk-digest-toggle" onClick={() => setDigestOpen((v) => !v)}>
          <span class="hud-label" style={{ color: "var(--accent)", "font-size": "12px" }}>
            TODAY'S DIGEST
          </span>
          <span class="sk-chev">{digestOpen() ? "▾" : "▸"}</span>
        </button>
        <Show when={digestOpen()}>
          <div class="sk-digest-body">
            <Show when={digestLoading()}>
              <div class="sk-empty">Loading digest…</div>
            </Show>
            <Show when={!digestLoading() && digest()}>
              <pre class="sk-pre">{digest()}</pre>
            </Show>
            <Show when={!digestLoading() && !digest()}>
              <div class="sk-empty">No digest yet.</div>
            </Show>
            <button type="button" class="sk-btn sk-btn-ghost sk-btn-sm" onClick={() => void loadDigest()}>
              ⟳ Regenerate
            </button>
          </div>
        </Show>
      </div>

      <div class="sk-toolbar">
        <input
          class="sk-search"
          placeholder="Search skills by name, tag, description…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          type="button"
          class="sk-chip"
          classList={{ active: showArchived() }}
          onClick={toggleArchived}
        >
          {showArchived() ? "▾" : "▸"} Archived ({archived().length || "…"})
        </button>
      </div>

      <Show when={error()}>
        <div class="sk-error">⚠ {error()}</div>
      </Show>
      <Show when={loading()}>
        <div class="sk-empty">Loading skills…</div>
      </Show>
      <Show when={!loading() && !error() && filtered().length === 0}>
        <div class="sk-empty">No skills match — try clearing the search, or author a new one.</div>
      </Show>

      <For each={groupNames()}>
        {(group, gi) => (
          <div class="sk-group">
            <div class="sk-group-label">{group.toUpperCase()}</div>
            <div class="sk-rows">
              <For each={rowsForGroup(group)}>
                {(s, ri) => {
                  // Captured once at row-insertion time (NOT read reactively in the
                  // style prop) — reading gi()/ri() there would re-fire whenever the
                  // list re-sorts (e.g. a pin toggle), and changing an in-flight
                  // "backwards"-fill animation's delay restarts it, flashing the
                  // whole list to invisible and fading it back in on every reorder.
                  const enterDelay = Math.min(gi() * 40 + ri() * 30, 400)
                  return (
                  <div
                    class="sk-row"
                    classList={{ pinned: s.pinned }}
                    style={{ "animation-delay": `${enterDelay}ms` }}
                  >
                    <div class="sk-row-main">
                      <button type="button" class="sk-row-name" onClick={() => void toggleDetail(s.name)}>
                        <span class="sk-chev-inline">{expanded() === s.name ? "▾" : "▸"}</span>
                        {s.name}
                      </button>
                      <div class="sk-badges">
                        <Show when={s.pinned}>
                          <span class="sk-badge sk-badge-pin">★ pinned</span>
                        </Show>
                        <Show when={s.self_authored}>
                          <span class="sk-badge sk-badge-auto">self-authored</span>
                        </Show>
                        <For each={s.tags}>{(t) => <span class="sk-badge">{t}</span>}</For>
                      </div>
                      <div class="sk-desc">{s.description || "No description."}</div>
                      <div class="sk-meta">
                        used {s.use_count}× · last {timeAgo(s.last_used_at)}
                      </div>

                      <Show when={expanded() === s.name}>
                        <div class="sk-detail">
                          <Show when={detailLoading() === s.name}>
                            <div class="sk-empty">Loading…</div>
                          </Show>
                          <Show when={details()[s.name]}>
                            {(d) => (
                              <>
                                <div class="sk-detail-path">{d().path}</div>
                                <pre class="sk-pre">{d().body || "(empty body)"}</pre>
                              </>
                            )}
                          </Show>
                        </div>
                      </Show>

                      <Show when={invokeOpen() === s.name}>
                        <div class="sk-invoke">
                          <input
                            class="sk-invoke-input"
                            placeholder="Args (optional, passed as {{ARGS}})"
                            value={invokeArgs()}
                            onInput={(e) => setInvokeArgs(e.currentTarget.value)}
                          />
                          <button
                            type="button"
                            class="sk-btn sk-btn-sm"
                            disabled={invokeBusy()}
                            onClick={() => void runInvoke(s.name)}
                          >
                            {invokeBusy() ? "Running…" : "Run"}
                          </button>
                          <button
                            type="button"
                            class="sk-btn sk-btn-ghost sk-btn-sm"
                            onClick={() => {
                              setInvokeOpen(null)
                              setInvokeArgs("")
                            }}
                          >
                            Close
                          </button>
                          <Show when={invokeResults()[s.name]}>
                            <pre class="sk-pre sk-invoke-result">{invokeResults()[s.name]}</pre>
                          </Show>
                        </div>
                      </Show>
                    </div>

                    <div class="sk-row-actions">
                      <button
                        type="button"
                        class="sk-btn sk-btn-sm"
                        disabled={busy()[s.name]}
                        onClick={() => setInvokeOpen((v) => (v === s.name ? null : s.name))}
                      >
                        ▶ Run
                      </button>
                      <button
                        type="button"
                        class="sk-btn sk-btn-ghost sk-btn-sm"
                        disabled={busy()[s.name]}
                        onClick={() => void togglePin(s)}
                      >
                        {s.pinned ? "☆ Unpin" : "★ Pin"}
                      </button>
                      <Show
                        when={confirmRemove() !== s.name}
                        fallback={
                          <span class="sk-confirm">
                            <button
                              type="button"
                              class="sk-btn sk-btn-danger sk-btn-sm"
                              onClick={() => void doRemove(s.name)}
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              class="sk-btn sk-btn-ghost sk-btn-sm"
                              onClick={() => setConfirmRemove(null)}
                            >
                              Cancel
                            </button>
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="sk-btn sk-btn-ghost sk-btn-sm"
                          disabled={busy()[s.name]}
                          onClick={() => setConfirmRemove(s.name)}
                        >
                          🗑 Remove
                        </button>
                      </Show>
                    </div>
                  </div>
                  )
                }}
              </For>
            </div>
          </div>
        )}
      </For>

      <Show when={showArchived()}>
        <div class="sk-group sk-archived-group">
          <div class="sk-group-label">ARCHIVED</div>
          <Show when={archived().length === 0}>
            <div class="sk-empty">No archived skills.</div>
          </Show>
          <div class="sk-rows">
            <For each={archived()}>
              {(s) => (
                <div class="sk-row sk-row-archived">
                  <div class="sk-row-main">
                    <div class="sk-row-name sk-row-name-static">{s.name}</div>
                    <div class="sk-desc">{s.description || "No description."}</div>
                  </div>
                  <div class="sk-row-actions">
                    <button
                      type="button"
                      class="sk-btn sk-btn-sm"
                      disabled={busy()[s.name]}
                      onClick={() => void doUnarchive(s.name)}
                    >
                      ↺ Unarchive
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

const SKILLS_CSS = `
.sk-page { display:flex; flex-direction:column; gap:16px; max-width:1080px; padding-bottom:24px; }
.sk-header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.sk-title-group { display:flex; align-items:center; gap:10px; }
.sk-subtitle { color:var(--text-muted); font-size:12px; margin-top:2px; }
.sk-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.sk-stat-pill { font-size:11px; color:var(--text-muted); background:var(--surface); border:1px solid var(--hairline-soft); border-radius:999px; padding:5px 12px; }
.sk-stat-num { color:var(--accent); font-family:var(--font-display); font-weight:600; }
.sk-search { flex:1; min-width:200px; height:32px; background:var(--surface-input); border:1px solid var(--hairline-soft); border-radius:var(--radius-sm); color:var(--text); padding:0 12px; font-size:12px; transition:border-color var(--dur-fast) ease; }
.sk-search:focus { outline:none; border-color:var(--accent-dim); }
.sk-chip { all:unset; cursor:pointer; font-size:11px; color:var(--text-muted); background:var(--surface); border:1px solid var(--hairline-soft); border-radius:999px; padding:5px 12px; transition:border-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.sk-chip.active { color:var(--accent-bright); border-color:var(--accent-dim); background:var(--nav-active); }
.sk-btn { all:unset; cursor:pointer; box-sizing:border-box; font-family:var(--font-display); letter-spacing:var(--track-tight); font-size:11px; padding:8px 14px; border-radius:var(--radius-sm); background:var(--accent-dim); color:var(--accent-bright); border:1px solid var(--accent-dim); transition:background var(--dur-fast) ease, transform var(--dur-fast) ease; }
.sk-btn:hover:not(:disabled) { background:var(--accent-faint); transform:translateY(-1px); }
.sk-btn:disabled { opacity:0.5; cursor:default; }
.sk-btn-ghost { background:transparent; color:var(--text-muted); border-color:var(--hairline-soft); }
.sk-btn-ghost:hover:not(:disabled) { color:var(--text); border-color:var(--accent-dim); background:rgba(255,255,255,0.03); }
.sk-btn-danger { background:var(--danger-dim); color:var(--danger); border-color:var(--danger-dim); }
.sk-btn-danger:hover:not(:disabled) { background:rgba(255,107,107,0.28); }
.sk-btn-sm { padding:5px 10px; font-size:10px; }
.sk-confirm { display:flex; gap:6px; }
.sk-card { background:var(--surface); border:1px solid var(--hairline-soft); border-radius:var(--radius); padding:14px 16px; }
.sk-form-title { font-size:11px; margin-bottom:10px; }
.sk-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; }
.sk-field { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--text-muted); }
.sk-field-wide { grid-column:1 / -1; }
.sk-field input, .sk-field textarea { background:var(--surface-input); border:1px solid var(--hairline-soft); border-radius:var(--radius-xs); color:var(--text); padding:8px 10px; font-size:12px; font-family:var(--font-sans); resize:vertical; }
.sk-field input:focus, .sk-field textarea:focus { outline:none; border-color:var(--accent-dim); }
.sk-form-actions { display:flex; justify-content:flex-end; margin-top:12px; }
.sk-error { color:var(--danger); font-size:12px; padding:4px 0; }
.sk-empty { color:var(--text-faint); font-size:12px; padding:8px 2px; }
.sk-digest { padding:0; overflow:hidden; }
.sk-digest-toggle { all:unset; cursor:pointer; display:flex; align-items:center; justify-content:space-between; width:100%; padding:12px 16px; box-sizing:border-box; }
.sk-chev { color:var(--text-faint); }
.sk-digest-body { padding:0 16px 14px; display:flex; flex-direction:column; gap:8px; }
.sk-pre { white-space:pre-wrap; word-break:break-word; font-family:var(--font-mono); font-size:11.5px; color:var(--text-muted); background:var(--surface-deep); border:1px solid var(--hairline-faint); border-radius:var(--radius-xs); padding:10px 12px; max-height:280px; overflow:auto; margin:0; }
.sk-group { display:flex; flex-direction:column; gap:8px; }
.sk-group-label { font-size:10px; letter-spacing:var(--track-mid); color:var(--text-faint); font-family:var(--font-display); }
.sk-rows { display:flex; flex-direction:column; gap:8px; }
.sk-row { display:flex; justify-content:space-between; gap:14px; background:var(--surface); border:1px solid var(--hairline-faint); border-radius:var(--radius-sm); padding:12px 14px; transition:border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease, transform var(--dur-fast) ease; animation:sk-row-in var(--dur-slow) ease-out backwards; }
.sk-row:hover { border-color:var(--accent-dim); box-shadow:0 4px 18px -6px var(--accent-glow); transform:translateY(-1px); }
.sk-row.pinned { border-color:var(--accent-deep); }
@keyframes sk-row-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
.sk-row-main { display:flex; flex-direction:column; gap:6px; flex:1; min-width:0; }
.sk-row-name { all:unset; cursor:pointer; color:var(--accent-bright); font-family:var(--font-display); font-size:13px; letter-spacing:var(--track-tight); display:flex; align-items:center; gap:6px; }
.sk-row-name-static { color:var(--text); font-family:var(--font-display); font-size:13px; }
.sk-chev-inline { color:var(--text-faint); font-size:10px; width:10px; }
.sk-badges { display:flex; flex-wrap:wrap; gap:6px; }
.sk-badge { font-size:10px; color:var(--text-muted); background:var(--surface-strong); border:1px solid var(--hairline-soft); border-radius:999px; padding:2px 8px; }
.sk-badge-pin { color:var(--amber); border-color:var(--amber-dim); background:var(--amber-dim); }
.sk-badge-auto { color:var(--accent); border-color:var(--accent-dim); background:var(--accent-faint); }
.sk-desc { color:var(--text-muted); font-size:12px; }
.sk-meta { color:var(--text-faint); font-size:10.5px; font-family:var(--font-mono); }
.sk-detail { margin-top:4px; display:flex; flex-direction:column; gap:6px; }
.sk-detail-path { color:var(--text-faint); font-size:10px; font-family:var(--font-mono); }
.sk-invoke { margin-top:6px; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.sk-invoke-input { flex:1; min-width:160px; height:28px; background:var(--surface-input); border:1px solid var(--hairline-soft); border-radius:var(--radius-xs); color:var(--text); padding:0 10px; font-size:11.5px; }
.sk-invoke-input:focus { outline:none; border-color:var(--accent-dim); }
.sk-invoke-result { width:100%; margin-top:6px; }
.sk-row-actions { display:flex; flex-direction:column; gap:6px; align-items:flex-end; flex-shrink:0; }
.sk-row-archived { opacity:0.75; }
.sk-archived-group { margin-top:6px; padding-top:12px; border-top:1px solid var(--hairline-faint); }
`

const page: PageDef = { id: "skills", label: "SKILLS", section: "MIND", order: 1, component: SkillsPage }
export default page
