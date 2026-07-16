// Advanced — a full-height, framed <iframe> straight into the NATIVE Proxmox
// VE web interface (pveproxy on :8006), for every long-tail feature Cindro's
// own pages don't have a dedicated view for: firewall rules, backup jobs,
// replication, Ceph, ACME certificates, HA groups, notifications, realms/
// permissions edge cases, and anything else that would otherwise mean
// re-implementing the entire Proxmox UI. Everything inside the frame IS the
// real Proxmox UI, not a Cindro re-implementation — Proxmox issues its
// PVEAuthCookie for the whole host (not just :8443), so being signed into
// this dashboard already signs the frame in too, same session, no extra login.
//
// pve-api.ts (real /api2/json) still drives the small live status strip above
// the frame, so this page deals in real data, not just chrome around an
// <iframe>.
//
// Self-registers per router.ts's PageDef contract; zero props.
import { createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js"

import * as pve from "../pve-api"
import type { PageDef } from "../router"

// pveproxy listens on :8006 on every Proxmox host — same hostname as this
// dashboard (:8443 only reverse-proxies pveproxy's /api2/json for pve-api.ts;
// the raw web UI itself is served straight off :8006, a different origin).
function nativeUrl(): string {
  const host = location.hostname || "localhost"
  return `https://${host}:8006/`
}

// If the frame hasn't fired `load` by this point it's almost always the
// browser silently refusing pveproxy's self-signed TLS certificate on :8006
// (a different port needs its own trust decision, even though :8443 is
// already trusted) — not a slow page. Proxmox's own UI paints in well under
// a second on a LAN once the cert is accepted.
const LOAD_GRACE_MS = 5000

const StripChip: Component<{ label: string; value: () => string; loading: () => boolean }> = (props) => (
  <div class="cx-adv-chip">
    <span class="cx-adv-chip-label">{props.label}</span>
    <Show when={!props.loading()} fallback={<div class="cx-skel cx-skel-line" />}>
      <span class="cx-adv-chip-value">{props.value()}</span>
    </Show>
  </div>
)

const AdvancedPage: Component = () => {
  const baseUrl = nativeUrl()
  const [bust, setBust] = createSignal(0)
  const src = createMemo(() => (bust() ? `${baseUrl}?_cx=${bust()}` : baseUrl))

  const [loaded, setLoaded] = createSignal(false)
  const [slow, setSlow] = createSignal(false)
  let graceTimer: ReturnType<typeof setTimeout> | undefined

  const armGrace = () => {
    clearTimeout(graceTimer)
    setSlow(false)
    graceTimer = setTimeout(() => {
      if (!loaded()) setSlow(true)
    }, LOAD_GRACE_MS)
  }

  const reload = () => {
    setLoaded(false)
    armGrace()
    setBust(Date.now())
  }

  // --- small live status strip, real /api2/json ---
  const [nodesOnline, setNodesOnline] = createSignal(0)
  const [nodesTotal, setNodesTotal] = createSignal(0)
  const [version, setVersion] = createSignal("")
  const [statLoading, setStatLoading] = createSignal(true)

  onMount(() => {
    armGrace()
    onCleanup(() => clearTimeout(graceTimer))
    void (async () => {
      const [n, v] = await Promise.all([pve.nodes(), pve.get<{ version?: string }>("/version")])
      if (n.ok) {
        setNodesTotal(n.data.length)
        setNodesOnline(n.data.filter((x) => x.status === "online").length)
      }
      if (v.ok && v.data?.version) setVersion(v.data.version)
      setStatLoading(false)
    })()
  })

  return (
    <div class="cx-page cx-page-advanced cx-fade-in">
      <div class="cx-adv-hero">
        <div class="cx-adv-hero-text">
          <h1 class="cx-page-title">Advanced</h1>
          <p class="cx-page-sub">
            The full native Proxmox VE web interface, framed live from this host — every long-tail
            feature (firewall, backup jobs, replication, Ceph, ACME certificates, HA, notifications,
            realms) that Cindro's own pages don't have a dedicated view for yet.
          </p>
        </div>
        <div class="cx-adv-hero-actions">
          <button type="button" class="cx-btn cx-btn-ghost cx-btn-sm" onClick={reload}>
            <span class="cx-refresh-glyph" classList={{ spinning: !loaded() }}>⟳</span>
            Reload
          </button>
          <a class="cx-btn cx-btn-ghost cx-btn-sm cx-adv-open-link" href={baseUrl} target="_blank" rel="noopener noreferrer">
            Open direct ↗
          </a>
        </div>
      </div>

      <div class="cx-adv-note cx-item">
        <span class="cx-adv-note-icon">◆</span>
        <div class="cx-adv-note-text">
          <strong>This is the native Proxmox UI</strong>, not a Cindro re-implementation — it's
          embedded with the same session as the rest of this dashboard. Anything changed in the
          frame below takes effect immediately, exactly as if <code>{baseUrl}</code> were open
          directly.
        </div>
      </div>

      <div class="cx-adv-strip">
        <StripChip label="Nodes" value={() => `${nodesOnline()}/${nodesTotal()}`} loading={statLoading} />
        <StripChip label="PVE version" value={() => version() || "—"} loading={statLoading} />
        <div class="cx-adv-strip-url">
          <span class="cx-adv-chip-label">Target</span>
          <span class="cx-adv-strip-url-value">{baseUrl}</span>
        </div>
      </div>

      <div class="cx-adv-frame-wrap">
        <iframe
          class="cx-adv-iframe"
          classList={{ ready: loaded() }}
          src={src()}
          title="Native Proxmox VE web interface"
          onLoad={() => {
            setLoaded(true)
            setSlow(false)
            clearTimeout(graceTimer)
          }}
        />
        <Show when={!loaded()}>
          <div class="cx-adv-loading">
            <span class="cx-spinner cx-adv-spinner-lg" />
            <span class="cx-adv-loading-label">Connecting to native UI…</span>
            <Show when={slow()}>
              <div class="cx-adv-cert-warn cx-item">
                Taking a while — this is usually pveproxy's self-signed certificate on :8006 being
                silently blocked by the browser (a different port needs its own trust decision,
                even though :8443 is already trusted).
                <a href={baseUrl} target="_blank" rel="noopener noreferrer"> Open it directly once</a>{" "}
                to accept the certificate, then reload the frame.
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default {
  id: "advanced",
  label: "Advanced",
  icon: "⚙",
  section: "SYSTEM",
  order: 10,
  component: AdvancedPage,
} satisfies PageDef
