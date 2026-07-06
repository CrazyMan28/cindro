// PHONE SHELL — chrome only: the 6-tab switcher for the Phone Hub, order
// per desktop/qml/PhonePage.qml (CALLS, AGENTS, INBOX, HUD, SETTINGS,
// SCREENING). Tab BODIES are built by later agents in sibling files
// (dialer.tsx, agents-tab.tsx, inbox.tsx, hud.tsx, settings-tab.tsx,
// screening.tsx) — this file is the contract they plug into:
//   - import { PHONE_TABS, type PhoneTabKey } from "./index" for the tab
//     list/order/labels (authoritative — don't re-derive it elsewhere).
//   - import { usePhoneTab } from "./index" inside a tab body to read the
//     active tab and to react to the shell's refresh button
//     (createEffect(() => ctx.refreshNonce())), mirroring PhonePage.qml's
//     onTabActivated()/refresh() behavior.
//   - wrap a tab body's root in <PhoneTabPanel> for chrome-consistent
//     padding/scroll behavior.
//   - to wire a finished body in, replace that tab's <TabPlaceholder .../>
//     below with the real component — nothing else in this file needs to
//     change.
import { createContext, createMemo, createSignal, For, Show, useContext } from "solid-js"
import type { Accessor, JSX } from "solid-js"

import { ArcReactor } from "../../components/ArcReactor"
import { NavIcon } from "../../components/NavIcon"
import type { PageDef } from "../../core/router"
import { PhoneSettingsTab } from "./settings-tab"
import { PhoneScreeningTab } from "./screening"
import { PhoneDialerTab } from "./dialer"
import { PhoneAgentsTab } from "./agents-tab"
import { PhoneInboxTab } from "./inbox"
import { PhoneHudTab } from "./hud"

export type PhoneTabKey = "calls" | "agents" | "inbox" | "hud" | "settings" | "screening"

export interface PhoneTabDef {
  key: PhoneTabKey
  label: string
  /** NavIcon glyph id reused for this sub-tab (see components/NavIcon.tsx). */
  glyph: string
  /** One-line description shown in the placeholder body until the real tab lands. */
  blurb: string
}

// Order is authoritative — mirrors PhonePage.qml's `_tabLabels`. Do not resort.
export const PHONE_TABS: PhoneTabDef[] = [
  { key: "calls", label: "CALLS", glyph: "phone", blurb: "Dialer, quick-dial chips, and active calls." },
  { key: "agents", label: "AGENTS", glyph: "agents", blurb: "Live agent roster with per-agent voice/model config." },
  { key: "inbox", label: "INBOX", glyph: "chat", blurb: "SMS thread list + compose." },
  { key: "hud", label: "HUD", glyph: "activity", blurb: "Ops dashboard + Red Alert." },
  {
    key: "settings",
    label: "SETTINGS",
    glyph: "settings",
    blurb: "SMS agent, call screening, carrier forwarding (incl. Verizon *72/*73), allowlist, diagnostics.",
  },
  { key: "screening", label: "SCREENING", glyph: "voice", blurb: "Live caller/agent transcript while a call is being screened." },
]

interface PhoneShellCtx {
  tab: Accessor<PhoneTabKey>
  refreshNonce: Accessor<number>
  requestRefresh: () => void
}

const PhoneShellContext = createContext<PhoneShellCtx>()

/** Read the active tab / refresh counter from a tab-body file. Falls back to
 * static, safe defaults if ever rendered outside the shell (shouldn't
 * happen in practice, since tab bodies are only ever mounted inside it). */
export function usePhoneTab(): PhoneShellCtx {
  const ctx = useContext(PhoneShellContext)
  if (ctx) return ctx
  const [tab] = createSignal<PhoneTabKey>("calls")
  const [nonce] = createSignal(0)
  return { tab, refreshNonce: nonce, requestRefresh: () => {} }
}

/** Shared chrome wrapper for a tab body's root — consistent padding/scroll
 * so every tab (built later) reads as one cohesive page. Purely cosmetic;
 * using it is optional but recommended for visual consistency. */
export function PhoneTabPanel(props: { children: JSX.Element }) {
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "14px", height: "100%", "min-height": "0" }}>
      {props.children}
    </div>
  )
}

function TabPlaceholder(def: PhoneTabDef) {
  return (
    <PhoneTabPanel>
      <div class="card" style={{ display: "flex", "align-items": "flex-start", gap: "14px" }}>
        <div
          style={{
            padding: "7px",
            "border-radius": "10px",
            background: "var(--accent-faint)",
            border: "1px solid var(--accent-dim)",
            "flex-shrink": 0,
          }}
        >
          <NavIcon glyph={def.glyph} color="var(--accent)" glow />
        </div>
        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "13px" }}>
            {def.label}
          </div>
          <div style={{ color: "var(--text-muted)", "font-size": "12px", "max-width": "480px", "line-height": "1.5" }}>
            {def.blurb}
          </div>
          <div style={{ color: "var(--text-faint)", "font-size": "11px" }}>Coming soon.</div>
        </div>
      </div>
    </PhoneTabPanel>
  )
}

function PhoneShell() {
  const [tab, setTab] = createSignal<PhoneTabKey>("calls")
  const [refreshNonce, setRefreshNonce] = createSignal(0)
  const requestRefresh = () => setRefreshNonce((n) => n + 1)
  const bodyKey = createMemo(() => `${tab()}:${refreshNonce()}`)
  const activeDef = createMemo(() => PHONE_TABS.find((t) => t.key === tab()) ?? PHONE_TABS[0])

  const ctx: PhoneShellCtx = { tab, refreshNonce, requestRefresh }

  return (
    <PhoneShellContext.Provider value={ctx}>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "14px",
          height: "100%",
          "min-height": "0",
          "max-width": "980px",
        }}
      >
        {/* header */}
        <div class="card" style={{ display: "flex", "align-items": "center", gap: "14px" }}>
          <ArcReactor size={28} />
          <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
            <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>
              PHONE HUB
            </div>
            <div style={{ color: "var(--text-muted)", "font-size": "11px" }}>
              Dialer · Agents · Inbox · Ops HUD · Settings · Screening
            </div>
          </div>
        </div>

        {/* tab bar */}
        <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-wrap": "wrap" }}>
          <For each={PHONE_TABS}>
            {(def) => {
              const active = () => tab() === def.key
              return (
                <button
                  type="button"
                  onClick={() => setTab(def.key)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "flex",
                    "align-items": "center",
                    gap: "7px",
                    height: "32px",
                    padding: "0 12px",
                    "border-radius": "var(--radius-xs)",
                    border: `1px solid ${active() ? "var(--accent)" : "var(--hairline-soft)"}`,
                    background: active() ? "var(--accent-dim)" : "transparent",
                    "box-shadow": active() ? "0 0 12px -3px var(--accent-glow)" : "none",
                    transition: "border-color var(--dur-fast) ease, background var(--dur-fast) ease, transform var(--dur-fast) ease",
                  }}
                >
                  <NavIcon glyph={def.glyph} color={active() ? "var(--accent-bright)" : "var(--text-muted)"} glow={active()} />
                  <span class="hud-label" style={{ "font-size": "10px", color: active() ? "var(--accent-bright)" : "var(--text-muted)" }}>
                    {def.label}
                  </span>
                </button>
              )
            }}
          </For>

          <div style={{ flex: 1 }} />

          <button
            type="button"
            title="Refresh"
            onClick={requestRefresh}
            style={{
              all: "unset",
              cursor: "pointer",
              width: "32px",
              height: "32px",
              "border-radius": "var(--radius-xs)",
              border: "1px solid var(--hairline-soft)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              color: "var(--text-muted)",
              "font-size": "14px",
            }}
          >
            ↺
          </button>
        </div>

        {/* tab content — remounts on tab switch or manual refresh. Finished
            tab bodies are dispatched by key here; unfinished ones fall back
            to the placeholder. Each parity agent adds only their own case. */}
        <div style={{ flex: 1, "min-height": "0", overflow: "auto" }}>
          <Show when={bodyKey()} keyed>
            {(_key) => {
              const def = activeDef()
              if (def.key === "calls") return <PhoneDialerTab />
              if (def.key === "agents") return <PhoneAgentsTab />
              if (def.key === "inbox") return <PhoneInboxTab />
              if (def.key === "hud") return <PhoneHudTab />
              if (def.key === "settings") return <PhoneSettingsTab />
              if (def.key === "screening") return <PhoneScreeningTab />
              return <TabPlaceholder {...def} />
            }}
          </Show>
        </div>
      </div>
    </PhoneShellContext.Provider>
  )
}

const page: PageDef = { id: "phone", label: "PHONE", section: "SYSTEM", order: 3, component: PhoneShell }
export default page
