// SETTINGS · TRUST POLICIES — per-tool/per-app rules ENFORCED at the tool
// layer by the computer-use engine's policy gate (jarvis#71), via the
// policy.list/add/update/remove/set_default/test verbs against the daemon's
// trust_policies.json. Ported intent from desktop/qml/SettingsPage.qml's
// trustCard (same default-action selector + rule list + add-rule form),
// plus a policy.test probe panel the QML version doesn't have. Distinct from
// Mode & Autonomy's permission_level: that's a soft hint surfaced to the
// model; a rule here actually fails ('deny') or gates ('ask') the tool call.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import type { SettingsSectionDef } from "./index"

type Action = "allow" | "ask" | "deny"

interface Rule {
  id: string
  tool: string
  app: string
  action: Action
  note?: string
}

const ACTIONS: Action[] = ["allow", "ask", "deny"]

function isAction(v: unknown): v is Action {
  return v === "allow" || v === "ask" || v === "deny"
}

function toRule(raw: unknown): Rule | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === "string" ? r.id : ""
  if (!id) return null
  return {
    id,
    tool: typeof r.tool === "string" && r.tool ? r.tool : "*",
    app: typeof r.app === "string" && r.app ? r.app : "*",
    action: isAction(r.action) ? r.action : "allow",
    note: typeof r.note === "string" ? r.note : undefined,
  }
}

function actionColor(a: Action): string {
  return a === "deny" ? "var(--danger)" : a === "ask" ? "var(--amber)" : "var(--success)"
}

function nextAction(a: Action): Action {
  return a === "allow" ? "ask" : a === "ask" ? "deny" : "allow"
}

function TrustPoliciesSection() {
  const app = useApp()
  const [rules, setRules] = createSignal<Rule[]>([])
  const [defaultAction, setDefaultAction] = createSignal<Action>("allow")
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const [newTool, setNewTool] = createSignal("")
  const [newApp, setNewApp] = createSignal("")
  const [newNote, setNewNote] = createSignal("")
  const [newAction, setNewAction] = createSignal<Action>("ask")
  const [addBusy, setAddBusy] = createSignal(false)

  const [defaultBusy, setDefaultBusy] = createSignal(false)
  const [ruleBusyId, setRuleBusyId] = createSignal("")

  const [testTool, setTestTool] = createSignal("")
  const [testApp, setTestApp] = createSignal("")
  const [testBusy, setTestBusy] = createSignal(false)
  const [testResult, setTestResult] = createSignal<{ action: Action; ruleId: string; note: string } | null>(null)
  const [testError, setTestError] = createSignal("")

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const load = async () => {
    try {
      const res = await app.client.call("policy.list", {}, 15000)
      if (!alive) return
      const rawRules = Array.isArray(res.rules) ? res.rules : []
      setRules(rawRules.map(toRule).filter((r): r is Rule => r !== null))
      setDefaultAction(isAction(res.default) ? res.default : "allow")
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoading(false)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(load, 20000)
    onCleanup(() => clearInterval(timer))
  })

  const addRule = async (e?: Event) => {
    e?.preventDefault()
    const tool = newTool().trim()
    const appGlob = newApp().trim()
    if (!tool && !appGlob) return
    setAddBusy(true)
    try {
      await app.client.call(
        "policy.add",
        { tool, app: appGlob, action: newAction(), note: newNote().trim() },
        15000,
      )
      setNewTool("")
      setNewApp("")
      setNewNote("")
      setNewAction("ask")
      await load()
    } catch (e2) {
      app.notify(`Failed to add rule: ${String(e2)}`, "error")
    } finally {
      if (alive) setAddBusy(false)
    }
  }

  const cycleRuleAction = async (rule: Rule) => {
    if (ruleBusyId()) return
    setRuleBusyId(rule.id)
    try {
      await app.client.call("policy.update", { id: rule.id, action: nextAction(rule.action) }, 15000)
      await load()
    } catch (e) {
      app.notify(`Failed to update rule: ${String(e)}`, "error")
    } finally {
      if (alive) setRuleBusyId("")
    }
  }

  const removeRule = async (id: string) => {
    if (ruleBusyId()) return
    setRuleBusyId(id)
    try {
      await app.client.call("policy.remove", { id }, 15000)
      await load()
    } catch (e) {
      app.notify(`Failed to remove rule: ${String(e)}`, "error")
    } finally {
      if (alive) setRuleBusyId("")
    }
  }

  const setDefault = async (a: Action) => {
    if (defaultBusy() || a === defaultAction()) return
    setDefaultBusy(true)
    try {
      await app.client.call("policy.set_default", { action: a }, 15000)
      await load()
    } catch (e) {
      app.notify(`Failed to set default: ${String(e)}`, "error")
    } finally {
      if (alive) setDefaultBusy(false)
    }
  }

  const runTest = async (e?: Event) => {
    e?.preventDefault()
    if (testBusy()) return
    setTestBusy(true)
    setTestError("")
    try {
      const res = await app.client.call("policy.test", { tool: testTool().trim(), app: testApp().trim() }, 15000)
      if (!alive) return
      setTestResult({
        action: isAction(res.action) ? res.action : "allow",
        ruleId: typeof res.rule_id === "string" ? res.rule_id : "",
        note: typeof res.note === "string" ? res.note : "",
      })
    } catch (e2) {
      if (!alive) return
      setTestResult(null)
      setTestError(String(e2))
    } finally {
      if (alive) setTestBusy(false)
    }
  }

  return (
    <div class="tpol-page">
      <style>{`
        .tpol-page { display: flex; flex-direction: column; gap: 18px; max-width: 780px; animation: tpol-in var(--dur-slow) ease-out; }
        @keyframes tpol-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .tpol-head { display: flex; align-items: center; gap: 10px; }
        .tpol-title { color: var(--accent); font-size: 11px; }
        .tpol-enforced {
          font-family: var(--font-display); font-size: 9px; letter-spacing: var(--track-mid);
          color: var(--success); border: 1px solid var(--success); border-radius: 999px; padding: 2px 8px;
        }
        .tpol-loading { color: var(--text-faint); font-size: 12px; }
        .tpol-desc { color: var(--text-muted); font-size: 12px; line-height: 1.55; margin: 0; }

        .tpol-block {
          display: flex; flex-direction: column; gap: 12px;
          background: var(--surface-strong); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-sm); padding: 14px;
        }
        .tpol-default-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .tpol-default-label {
          font-family: var(--font-display); font-size: 9px; letter-spacing: var(--track-mid); color: var(--text-muted);
        }
        .tpol-pill {
          all: unset; cursor: pointer; box-sizing: border-box;
          font-family: var(--font-display); font-size: 9px; letter-spacing: var(--track-tight);
          padding: 4px 10px; border-radius: 999px; border: 1px solid var(--hairline-soft); color: var(--text-muted);
          transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease;
        }
        .tpol-pill:disabled { cursor: default; }

        .tpol-rules { display: flex; flex-direction: column; gap: 6px; }
        .tpol-rule {
          display: flex; align-items: center; gap: 10px; min-height: 40px;
          padding: 6px 10px; border-radius: var(--radius-sm);
          background: var(--surface); border: 1px solid var(--hairline-soft);
        }
        .tpol-rule-tool { font-family: var(--font-mono); font-size: 12px; color: var(--text); white-space: nowrap; }
        .tpol-rule-app { font-family: var(--font-mono); font-size: 11px; color: var(--accent); white-space: nowrap; }
        .tpol-rule-note { flex: 1; min-width: 0; font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tpol-rule-remove {
          all: unset; cursor: pointer; color: var(--text-faint); font-size: 12px; padding: 2px 4px;
          transition: color var(--dur-fast) ease;
        }
        .tpol-rule-remove:hover { color: var(--danger); }
        .tpol-rule-remove:disabled { opacity: 0.4; cursor: default; }
        .tpol-empty { color: var(--text-faint); font-size: 11px; padding: 2px; }

        .tpol-add-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .tpol-input {
          box-sizing: border-box; background: var(--surface-input); border: 1px solid var(--hairline-soft);
          border-radius: var(--radius-xs); color: var(--text); padding: 8px 10px;
          font-family: var(--font-mono); font-size: 12px; transition: border-color var(--dur-fast) ease;
        }
        .tpol-input:focus { outline: none; border-color: var(--accent-dim); }
        .tpol-input::placeholder { color: var(--text-faint); }
        .tpol-input.tool { width: 150px; }
        .tpol-input.app { width: 130px; }
        .tpol-input.note { flex: 1; min-width: 140px; }
        .tpol-btn {
          all: unset; cursor: pointer; box-sizing: border-box; white-space: nowrap;
          padding: 8px 16px; border-radius: var(--radius-xs);
          background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim);
          font-family: var(--font-display); font-size: 11px; letter-spacing: var(--track-mid);
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .tpol-btn:hover:not(:disabled) { background: var(--accent-faint); }
        .tpol-btn:disabled { opacity: 0.4; cursor: default; }

        .tpol-test-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .tpol-test-result { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
        .tpol-test-error { color: var(--danger); font-size: 11px; }

        .tpol-banner-error {
          color: var(--danger); font-size: 12px;
          border: 1px solid var(--danger-dim); background: rgba(255,107,107,0.06);
          border-radius: var(--radius-xs); padding: 8px 10px;
        }
      `}</style>

      <div class="tpol-head">
        <div class="hud-label tpol-title">Trust Policies</div>
        <span class="tpol-enforced">ENFORCED</span>
      </div>

      <p class="tpol-desc">
        Per-tool / per-app rules enforced on every tool call: DENY fails the call, ASK pops an approval on
        desktop + phone. The most specific matching rule wins (globs, e.g. <code>browser_*</code> on{" "}
        <code>*bank*</code> → ask). Unlike Mode &amp; Autonomy's permission level — which is just advice
        surfaced to the model — these are hard-enforced by the policy gate.
      </p>

      <Show when={error()}>
        <div class="tpol-banner-error">⚠ {error()}</div>
      </Show>

      <Show when={!loading()} fallback={<div class="tpol-loading">Loading…</div>}>
        <div class="tpol-block">
          <div class="tpol-default-row">
            <span class="tpol-default-label">DEFAULT (no rule matches):</span>
            <For each={ACTIONS}>
              {(a) => (
                <button
                  type="button"
                  class="tpol-pill"
                  disabled={defaultBusy()}
                  style={
                    defaultAction() === a
                      ? { background: `color-mix(in srgb, ${actionColor(a)} 18%, transparent)`, "border-color": actionColor(a), color: actionColor(a) }
                      : {}
                  }
                  onClick={() => void setDefault(a)}
                >
                  {a.toUpperCase()}
                </button>
              )}
            </For>
          </div>

          <div class="tpol-rules">
            <Show when={rules().length > 0} fallback={<div class="tpol-empty">No rules yet — everything falls through to the default above.</div>}>
              <For each={rules()}>
                {(rule) => (
                  <div class="tpol-rule">
                    <button
                      type="button"
                      class="tpol-pill"
                      disabled={ruleBusyId() === rule.id}
                      style={{ background: `color-mix(in srgb, ${actionColor(rule.action)} 16%, transparent)`, "border-color": actionColor(rule.action), color: actionColor(rule.action) }}
                      title="Click to cycle allow → ask → deny"
                      onClick={() => void cycleRuleAction(rule)}
                    >
                      {rule.action.toUpperCase()}
                    </button>
                    <span class="tpol-rule-tool">{rule.tool}</span>
                    <Show when={rule.app !== "*"}>
                      <span class="tpol-rule-app">on {rule.app}</span>
                    </Show>
                    <span class="tpol-rule-note">{rule.note ?? ""}</span>
                    <button
                      type="button"
                      class="tpol-rule-remove"
                      disabled={ruleBusyId() === rule.id}
                      title={`Remove rule`}
                      onClick={() => void removeRule(rule.id)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <form class="tpol-add-form" onSubmit={addRule}>
            <input class="tpol-input tool" placeholder="tool glob (browser_*)" value={newTool()} onInput={(e) => setNewTool(e.currentTarget.value)} />
            <input class="tpol-input app" placeholder="app glob (* = any)" value={newApp()} onInput={(e) => setNewApp(e.currentTarget.value)} />
            <input class="tpol-input note" placeholder="note (why)" value={newNote()} onInput={(e) => setNewNote(e.currentTarget.value)} />
            <button
              type="button"
              class="tpol-pill"
              style={{ background: `color-mix(in srgb, ${actionColor(newAction())} 16%, transparent)`, "border-color": actionColor(newAction()), color: actionColor(newAction()) }}
              title="Click to cycle allow → ask → deny"
              onClick={() => setNewAction(nextAction(newAction()))}
            >
              {newAction().toUpperCase()}
            </button>
            <button type="submit" class="tpol-btn" disabled={addBusy() || (!newTool().trim() && !newApp().trim())}>
              {addBusy() ? "Adding…" : "+ Add Rule"}
            </button>
          </form>
        </div>

        <div class="tpol-block">
          <span class="tpol-default-label">TEST A DECISION</span>
          <form class="tpol-test-row" onSubmit={runTest}>
            <input class="tpol-input tool" placeholder="tool (e.g. browser_click)" value={testTool()} onInput={(e) => setTestTool(e.currentTarget.value)} />
            <input class="tpol-input app" placeholder="app (e.g. chase.com)" value={testApp()} onInput={(e) => setTestApp(e.currentTarget.value)} />
            <button type="submit" class="tpol-btn" disabled={testBusy()}>
              {testBusy() ? "Testing…" : "Test"}
            </button>
          </form>
          <Show when={testError()}>
            <div class="tpol-test-error">⚠ {testError()}</div>
          </Show>
          <Show when={testResult()}>
            {(res) => (
              <div class="tpol-test-result">
                <span
                  class="tpol-pill"
                  style={{ background: `color-mix(in srgb, ${actionColor(res().action)} 18%, transparent)`, "border-color": actionColor(res().action), color: actionColor(res().action) }}
                >
                  {res().action.toUpperCase()}
                </span>
                <Show when={res().ruleId} fallback={<span>matched the default action</span>}>
                  <span>matched rule <code>{res().ruleId}</code></span>
                </Show>
                <Show when={res().note}>
                  <span>— {res().note}</span>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

const section: SettingsSectionDef = { key: "trust-policies", label: "Trust Policies", component: TrustPoliciesSection }
export default section
