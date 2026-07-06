// SETTINGS SHELL — master-detail nav for the 12 sections in desktop/qml/
// SettingsPage.qml (Identity, Defaults, Mode & Autonomy, Voice, Video, API
// Keys, Security, Trust Policies, Updates, Connectors, Extension, Devices).
// CONTRACT for section-body agents (read this, never edit this file): drop a
// SIBLING file at web/src/pages/settings/<key>.tsx (key from the SECTIONS
// list below, e.g. "identity.tsx", "mode-autonomy.tsx", "api-keys.tsx")
// exporting `export default { key, label, component } satisfies
// SettingsSectionDef` (types exported below). This shell auto-discovers every
// sibling module via `import.meta.glob("./*.tsx", { eager: true })` — same
// self-registration idiom core/router.ts uses for whole pages — and swaps
// your component in for that section's placeholder body. Deliberately uses
// `key` (not `id`) so App.tsx's page-wide glob (which only registers modules
// with a string `.id`) never mistakes a section file for a top-level page.
// Until a section file exists for a given key, the shell renders a generic
// placeholder there. Section components take no props; call useApp() same
// as any page for the daemon client / navigate / notify.
import { createSignal, For, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"

import type { PageDef } from "../../core/router"

export interface SettingsSectionDef {
  key: string
  label: string
  component: Component
}

export const SECTIONS: Array<{ key: string; label: string }> = [
  { key: "identity", label: "Identity" },
  { key: "defaults", label: "Defaults" },
  { key: "mode-autonomy", label: "Mode & Autonomy" },
  { key: "voice", label: "Voice" },
  { key: "video", label: "Video" },
  { key: "api-keys", label: "API Keys" },
  { key: "security", label: "Security" },
  { key: "trust-policies", label: "Trust Policies" },
  { key: "updates", label: "Updates" },
  { key: "connectors", label: "Connectors" },
  { key: "extension", label: "Extension" },
  { key: "devices", label: "Devices" },
]

const sectionModules = import.meta.glob<{ default: SettingsSectionDef }>("./*.tsx", { eager: true })
const registry = new Map<string, SettingsSectionDef>()
for (const path in sectionModules) {
  if (path.endsWith("/index.tsx")) continue // this file itself
  const def = sectionModules[path]?.default
  if (def && typeof def === "object" && typeof def.key === "string" && typeof def.component === "function") {
    registry.set(def.key, def)
  }
}

function SectionPlaceholder(props: { label: string }) {
  return (
    <div class="settings-placeholder">
      <div class="hud-label" style={{ color: "var(--accent)", "font-size": "12px" }}>
        {props.label.toUpperCase()}
      </div>
      <p style={{ color: "var(--text-faint)", "font-size": "12px", margin: "10px 0 0" }}>
        This section's body hasn't landed yet — it renders here once
        web/src/pages/settings/{"{key}"}.tsx exists.
      </p>
    </div>
  )
}

function SettingsPage() {
  const [active, setActive] = createSignal(SECTIONS[0].key)

  const activeLabel = () => SECTIONS.find((s) => s.key === active())?.label ?? active()
  const ActiveBody = (): Component => {
    const def = registry.get(active())
    if (def) return def.component
    const label = activeLabel()
    return () => <SectionPlaceholder label={label} />
  }

  return (
    <div class="settings-page page-enter">
      <style>{`
        .settings-page { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; }
        .settings-header { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
        .settings-header-sub { color: var(--text-faint); font-size: 12px; }
        .settings-shell {
          display: flex;
          gap: 14px;
          flex: 1;
          min-height: 0;
        }
        .settings-nav {
          flex: 0 0 220px;
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 8px;
          overflow-y: auto;
        }
        .settings-nav-item {
          all: unset;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 10px;
          height: 38px;
          padding: 0 12px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          font-family: var(--font-display);
          font-size: 11px;
          letter-spacing: var(--track-mid);
          cursor: pointer;
          transition: color var(--dur-fast) ease, background var(--dur-fast) ease, transform var(--dur-fast) ease;
          animation: nav-item-in var(--dur-slow) ease-out backwards;
        }
        .settings-nav-item:hover { color: var(--text); background: rgba(255,255,255,0.045); transform: translateX(2px); }
        .settings-nav-item.active {
          color: var(--accent-bright);
          font-weight: 600;
          background: var(--nav-active);
          border: 1px solid var(--accent-dim);
          box-shadow: inset 3px 0 0 -1px var(--accent), 0 0 12px -2px var(--accent-glow);
        }
        .settings-nav-index {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-faint);
          min-width: 16px;
        }
        .settings-nav-item.active .settings-nav-index { color: var(--accent); }
        .settings-detail {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
        }
        .settings-placeholder { max-width: 520px; }
      `}</style>

      <div class="settings-header">
        <div class="hud-label" style={{ color: "var(--accent-bright)", "font-size": "16px" }}>
          SETTINGS
        </div>
        <div class="settings-header-sub">{SECTIONS.length} sections — {activeLabel()}</div>
      </div>

      <div class="settings-shell">
        <nav class="settings-nav card">
          <For each={SECTIONS}>
            {(s, i) => (
              <button
                type="button"
                class="settings-nav-item"
                classList={{ active: active() === s.key }}
                style={{ "animation-delay": `${i() * 22}ms` }}
                onClick={() => setActive(s.key)}
              >
                <span class="settings-nav-index">{String(i() + 1).padStart(2, "0")}</span>
                {s.label}
              </button>
            )}
          </For>
        </nav>

        <div class="settings-detail card">
          <Dynamic component={ActiveBody()} />
        </div>
      </div>
    </div>
  )
}

const page: PageDef = { id: "settings", label: "SETTINGS", section: "SYSTEM", order: 4, component: SettingsPage }
export default page
