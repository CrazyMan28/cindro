// Permissions — the user-configurable operator gate. Three surfaces, all live:
//   1. A mode selector for `default_risky` (ask / allow / deny) — read-only
//      Proxmox calls are ALWAYS free no matter which mode is active; this only
//      controls what happens when Cindro reaches for something that changes
//      state.
//   2. "Waiting for you" — the same live approval cards the chat transcript
//      shows (this literally reuses chat.tsx's <ApprovalCard>), for whenever
//      an operator tool is mid-flight and blocked on a decision, without
//      having to go find it in the Chat page.
//   3. Standing rules — the scoped allow-rules an "Always" answer appends to
//      the policy file, removable here.
//
// Wire contract (see daemon/src/ControlServer.cpp):
//   proxmoxop.policy_get              -> { default_risky, rules: [{id,match,effect}], updated? }
//   proxmoxop.policy_set(params)      -> same shape, persisted
//   proxmoxop.pending_list            -> { pending: [{approval_id,session_id,summary,risk}] }
//   proxmoxop.approval (broadcast)    -> fires the instant a NEW approval is parked
//   approval.respond({session_id,approval_id,decision: allow|always|deny})
//
// Self-registers per router.ts's PageDef contract; zero props — pulls
// client from usePve().
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"

import { ArcReactor } from "../../components/ArcReactor"
import { ApprovalCard } from "../chat"
import { usePve } from "../pve-context"
import type { PageDef } from "../router"

// --- types -------------------------------------------------------------------

type PolicyMode = "ask" | "allow" | "deny"
type Decision = "allow" | "always" | "deny"

interface Rule {
  id: string
  match: Record<string, unknown>
  effect: "allow" | "deny"
}

interface RawPending {
  approval_id: string
  session_id: string
  summary: string
  risk: string
}

interface PendingItem {
  id: number
  kind: "approval"
  approvalId: string
  sessionId: string
  summary: string
  risk: "low" | "medium" | "high"
  resolved: "" | Decision
}

const MODES: Array<{ key: PolicyMode; icon: string; label: string; sub: string; tone: "amber" | "danger" | "success" }> = [
  {
    key: "ask",
    icon: "◐",
    label: "Ask before risky",
    sub: "Reads are free. Cindro pauses and asks before anything that changes state — start, stop, create, destroy.",
    tone: "amber",
  },
  {
    key: "allow",
    icon: "◉",
    label: "Full autonomy",
    sub: "Cindro acts on its own for every operation. No approval prompts, ever — the highest-trust mode.",
    tone: "danger",
  },
  {
    key: "deny",
    icon: "◇",
    label: "Read-only",
    sub: "Every state-changing action is blocked outright, even ones you'd normally wave through in chat.",
    tone: "success",
  },
]

// --- helpers -------------------------------------------------------------------

function normalizeRisk(v: unknown): "low" | "medium" | "high" {
  const s = String(v ?? "medium").toLowerCase()
  return s === "high" || s === "low" ? s : "medium"
}

function normalizeMode(v: unknown): PolicyMode {
  return v === "allow" || v === "deny" ? v : "ask"
}

function fmtAgo(sec: number | null, nowSec: number): string {
  if (!sec) return "never"
  const diff = Math.max(0, nowSec - sec)
  if (diff < 5) return "just now"
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// Server match keys (see operatorResolveEffect in ControlServer.cpp): either
// {method,path} for the generic proxmox_api passthrough, or {tool,verb,vmid}
// for named operator tools. Render as small readable key:value chips instead
// of a raw JSON dump.
const MATCH_KEY_ORDER = ["method", "path", "tool", "verb", "vmid"]
function formatMatchChips(match: Record<string, unknown>): Array<{ k: string; v: string }> {
  const keys = Object.keys(match ?? {}).sort((a, b) => {
    const ia = MATCH_KEY_ORDER.indexOf(a)
    const ib = MATCH_KEY_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return keys.map((k) => ({ k, v: String((match as Record<string, unknown>)[k]) }))
}

let nextLocalId = 1
const mkLocalId = () => nextLocalId++

// Preserve object identity for approvals still on the server between polls,
// so <For>'s reference-keyed reconciliation doesn't replay a card's entrance
// animation or clobber an in-flight local "resolved" state every 5s.
function mergePending(prev: PendingItem[], next: RawPending[]): PendingItem[] {
  const byId = new Map(prev.map((p) => [p.approvalId, p] as const))
  return next.map((n) => {
    const old = byId.get(n.approval_id)
    if (old) return old
    return {
      id: mkLocalId(),
      kind: "approval",
      approvalId: n.approval_id,
      sessionId: n.session_id,
      summary: n.summary,
      risk: normalizeRisk(n.risk),
      resolved: "",
    }
  })
}

// --- page ----------------------------------------------------------------------

const PermissionsPage: Component = () => {
  const { client } = usePve()

  const [mode, setMode] = createSignal<PolicyMode>("ask")
  const [rules, setRules] = createSignal<Rule[]>([])
  const [updated, setUpdated] = createSignal<number | null>(null)
  const [pending, setPending] = createSignal<PendingItem[]>([])
  const [loading, setLoading] = createSignal(true)
  const [savingMode, setSavingMode] = createSignal(false)
  const [removingRuleId, setRemovingRuleId] = createSignal("")
  const [err, setErr] = createSignal("")
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000)) // drives fmtAgo() re-render

  const loadPolicy = async () => {
    try {
      const r = await client.call<any>("proxmoxop.policy_get")
      setMode(normalizeMode(r.default_risky))
      setRules(Array.isArray(r.rules) ? (r.rules as Rule[]) : [])
      setUpdated(typeof r.updated === "number" ? r.updated : null)
      setErr("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const loadPending = async () => {
    try {
      const r = await client.call<any>("proxmoxop.pending_list")
      const list: RawPending[] = Array.isArray(r.pending) ? r.pending : []
      setPending((prev) => mergePending(prev, list))
    } catch {
      /* transient — keep the last known list rather than flashing empty */
    }
  }

  onMount(() => {
    void (async () => {
      await Promise.all([loadPolicy(), loadPending()])
      setLoading(false)
    })()
    const pendingTimer = setInterval(() => void loadPending(), 5000)
    const policyTimer = setInterval(() => void loadPolicy(), 15000)
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    const off = client.on("proxmoxop.approval", () => void loadPending())
    onCleanup(() => {
      clearInterval(pendingTimer)
      clearInterval(policyTimer)
      clearInterval(clock)
      off()
    })
  })

  const saveMode = async (m: PolicyMode) => {
    if (m === mode() || savingMode()) return
    const prevMode = mode()
    setMode(m) // optimistic — the badge/selection reacts instantly
    setSavingMode(true)
    try {
      const r = await client.call<any>("proxmoxop.policy_set", { default_risky: m, rules: rules() })
      setMode(normalizeMode(r.default_risky ?? m))
      setRules(Array.isArray(r.rules) ? (r.rules as Rule[]) : rules())
      setUpdated(typeof r.updated === "number" ? r.updated : Math.floor(Date.now() / 1000))
      setErr("")
    } catch (e) {
      setMode(prevMode)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingMode(false)
    }
  }

  const removeRule = async (id: string) => {
    const prevRules = rules()
    const next = prevRules.filter((r) => r.id !== id)
    setRemovingRuleId(id)
    try {
      const r = await client.call<any>("proxmoxop.policy_set", { default_risky: mode(), rules: next })
      setTimeout(() => {
        setRules(Array.isArray(r.rules) ? (r.rules as Rule[]) : next)
        setRemovingRuleId("")
      }, 210) // let the row's exit transition play before it actually leaves the DOM
      setUpdated(typeof r.updated === "number" ? r.updated : Math.floor(Date.now() / 1000))
    } catch (e) {
      setRemovingRuleId("")
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const respond = async (item: PendingItem, decision: Decision) => {
    try {
      await client.call("approval.respond", { session_id: item.sessionId, approval_id: item.approvalId, decision }, 15000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      void loadPending() // it may already be stale (TTL'd out / answered elsewhere) — resync either way
      return
    }
    setPending((prev) => prev.map((p) => (p.approvalId === item.approvalId ? { ...p, resolved: decision } : p)))
    if (decision === "always") setTimeout(() => void loadPolicy(), 500) // "always" just appended a standing rule server-side
    setTimeout(() => void loadPending(), 900) // server already dropped it — this reload is what actually removes the card
  }

  const currentMode = createMemo(() => MODES.find((m) => m.key === mode()) ?? MODES[0])

  return (
    <div class="cx-page cx-perm-page cx-fade-in">
      <div class="cx-page-head">
        <div>
          <h1 class="cx-page-title">Permissions</h1>
          <p class="cx-page-sub">
            Choose how much Cindro may do on its own. Reads — listing nodes, inspecting configs, checking
            status — are always free, no matter the mode below.
          </p>
        </div>
        <div class={`cx-perm-badge tone-${currentMode().tone}`}>
          <span class="cx-perm-badge-icon">{currentMode().icon}</span>
          <div class="cx-perm-badge-text">
            <span class="cx-perm-badge-label">Current mode</span>
            <span class="cx-perm-badge-value">{currentMode().label}</span>
          </div>
          <Show when={savingMode()}>
            <ArcReactor size={16} />
          </Show>
        </div>
      </div>

      <Show when={err()}>
        <div class="cx-error-card cx-fade-in">{err()}</div>
      </Show>

      {/* --- mode selector --- */}
      <section class="cx-perm-section">
        <span class="cx-section-label">Operator autonomy</span>
        <div class="cx-perm-modes">
          <Show
            when={!loading()}
            fallback={
              <For each={[0, 1, 2]}>
                {(i) => <div class="cx-perm-mode cx-skel" style={{ "animation-delay": `${i * 60}ms` }} />}
              </For>
            }
          >
            <For each={MODES}>
              {(m, i) => (
                <button
                  type="button"
                  class={`cx-perm-mode tone-${m.tone} cx-item`}
                  classList={{ selected: mode() === m.key }}
                  style={{ "animation-delay": `${i() * 70}ms` }}
                  disabled={savingMode()}
                  onClick={() => void saveMode(m.key)}
                >
                  <span class="cx-perm-mode-icon">{m.icon}</span>
                  <span class="cx-perm-mode-label">{m.label}</span>
                  <span class="cx-perm-mode-sub">{m.sub}</span>
                  <Show when={mode() === m.key}>
                    <span class="cx-perm-mode-check">✓</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
        <p class="cx-perm-updated">Last changed {fmtAgo(updated(), now())}</p>
      </section>

      {/* --- pending approvals (reuses chat.tsx's ApprovalCard) --- */}
      <section class="cx-perm-section">
        <span class="cx-section-label">
          Waiting for you
          <Show when={pending().length > 0}>
            <span class="cx-perm-count">{pending().length}</span>
          </Show>
        </span>
        <Show
          when={pending().length > 0}
          fallback={
            <div class="cx-empty cx-perm-empty">
              Nothing waiting — Cindro will drop a card here the moment it needs your OK.
            </div>
          }
        >
          <div class="cx-perm-pending-list">
            <For each={pending()}>
              {(p) => (
                <div classList={{ "cx-perm-pending-item": true, exit: Boolean(p.resolved) }}>
                  <ApprovalCard item={p} onRespond={(d) => void respond(p, d)} />
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>

      {/* --- standing rules --- */}
      <section class="cx-perm-section">
        <span class="cx-section-label">Standing rules</span>
        <p class="cx-perm-hint">
          Answering “Always” on an approval adds a scoped rule here — it applies only to that exact tool
          (and VM, where relevant), never a whole class of actions. Remove one any time.
        </p>
        <Show
          when={!loading()}
          fallback={
            <div class="cx-card cx-card-flat cx-perm-rules-skel">
              <For each={[0, 1, 2]}>
                {(i) => <div class="cx-skel cx-skel-line" style={{ width: "70%", "animation-delay": `${i * 60}ms` }} />}
              </For>
            </div>
          }
        >
          <Show
            when={rules().length > 0}
            fallback={<div class="cx-empty cx-perm-empty">No custom rules yet.</div>}
          >
            <div class="cx-card cx-card-flat cx-table-wrap">
              <table class="cx-table cx-perm-table">
                <thead>
                  <tr>
                    <th>Effect</th>
                    <th>Scope</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rules()}>
                    {(r, i) => (
                      <tr
                        classList={{ "cx-item": true, exit: removingRuleId() === r.id }}
                        style={{ "animation-delay": `${Math.min(i(), 10) * 30}ms` }}
                      >
                        <td>
                          <span class={`cx-pill ${r.effect === "allow" ? "cx-pill-ok" : "cx-pill-error"}`}>
                            {r.effect}
                          </span>
                        </td>
                        <td>
                          <div class="cx-perm-match">
                            <For each={formatMatchChips(r.match)}>
                              {(c) => (
                                <span class="cx-perm-match-chip">
                                  <b>{c.k}</b>
                                  {c.v}
                                </span>
                              )}
                            </For>
                          </div>
                        </td>
                        <td class="cx-perm-table-actions">
                          <button
                            type="button"
                            class="cx-btn cx-btn-ghost cx-btn-sm"
                            disabled={removingRuleId() === r.id}
                            onClick={() => void removeRule(r.id)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </section>
    </div>
  )
}

export default {
  id: "permissions",
  label: "Permissions",
  icon: "◆",
  section: "CINDRO",
  order: 20,
  component: PermissionsPage,
} satisfies PageDef
