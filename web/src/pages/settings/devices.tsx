// SETTINGS · DEVICES — paired-device (phone) management, ported from
// desktop/qml/SettingsPage.qml's "// DEVICES" cards: a "Pair a phone" action
// (devices.pair_start -> {code, payload, qr_svg, expires_at}, rendering the
// daemon's own inline qr_svg rather than a client-side QR library) plus the
// paired-devices table (devices.list -> {devices:[{id,name,paired_at,
// last_seen}]}) with per-row Revoke (devices.revoke).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { useApp } from "../../core/app-context"
import { theme } from "../../core/theme"
import { NavIcon } from "../../components/NavIcon"
import { svgToDataUri } from "../../components/WidgetRenderer"
import type { SettingsSectionDef } from "./index"

interface DeviceRow {
  id: string
  name: string
  paired_at: number
  last_seen: number
}

interface PairStartResult {
  code: string
  payload: string
  qr_svg: string
  expires_at: number
}

const REFRESH_MS = 20000

function fmtTime(ms?: number): string {
  if (!ms) return ""
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ""
  }
}

function DevicesSection() {
  const app = useApp()
  const [rows, setRows] = createSignal<DeviceRow[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal("")
  const [revoking, setRevoking] = createSignal<string | null>(null)

  const [pairing, setPairing] = createSignal(false)
  const [pairCode, setPairCode] = createSignal("")
  const [pairPayload, setPairPayload] = createSignal("")
  const [pairQrSvg, setPairQrSvg] = createSignal("")
  const [pairExpiresAt, setPairExpiresAt] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  let alive = true
  onCleanup(() => {
    alive = false
  })

  const load = async () => {
    try {
      const res = await app.client.call("devices.list", {}, 15000)
      if (!alive) return
      setRows((res.devices ?? []) as DeviceRow[])
      setError("")
    } catch (e) {
      if (!alive) return
      setError(String(e))
    } finally {
      if (alive) setLoaded(true)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(tick)
    })
  })

  const remaining = () => Math.max(0, Math.floor((pairExpiresAt() - now()) / 1000))

  const startPairing = async () => {
    setPairing(true)
    try {
      const res = (await app.client.call("devices.pair_start", {}, 15000)) as unknown as PairStartResult
      setPairCode(res.code || "")
      setPairPayload(res.payload || "")
      setPairQrSvg(res.qr_svg || "")
      setPairExpiresAt(Number(res.expires_at) || 0)
    } catch (e) {
      app.notify(`Pairing failed: ${String(e)}`, "error")
    } finally {
      setPairing(false)
    }
  }

  const revoke = async (id: string) => {
    setRevoking(id)
    try {
      await app.client.call("devices.revoke", { id }, 15000)
      app.notify("Device revoked.")
      await load()
    } catch (e) {
      app.notify(`Revoke failed: ${String(e)}`, "error")
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div class="sdv-page">
      <style>{`
        .sdv-page { display: flex; flex-direction: column; gap: 16px; max-width: 620px; animation: sdv-in var(--dur-slow) ease-out; }
        @keyframes sdv-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .sdv-title { color: var(--accent); font-size: 11px; }
        .sdv-desc { color: var(--text-faint); font-size: 12px; margin: 6px 0 0; line-height: 1.5; }
        .sdv-pair-card {
          border: 1px solid var(--hairline-soft); border-radius: var(--radius-sm);
          background: var(--panel-soft); padding: 14px;
        }
        .sdv-pair-row { display: flex; align-items: center; gap: 12px; }
        .sdv-pair-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        .sdv-pair-label { color: var(--text); font-size: 14px; font-weight: 500; }
        .sdv-pair-sub { color: var(--text-faint); font-size: 12px; }
        .sdv-pair-btn {
          all: unset; cursor: pointer; white-space: nowrap; padding: 8px 18px; border-radius: var(--radius-xs);
          background: var(--accent-dim); color: var(--accent-bright); border: 1px solid var(--accent-dim);
          font-family: var(--font-display); letter-spacing: var(--track-mid); font-size: 12px;
          transition: background var(--dur-fast) ease, opacity var(--dur-fast) ease;
        }
        .sdv-pair-btn:hover:not(:disabled) { background: var(--accent-faint); }
        .sdv-pair-btn:disabled { opacity: 0.5; cursor: default; }
        .sdv-qr-panel {
          position: relative; margin-top: 12px; display: flex; gap: 16px; align-items: center;
          border-radius: var(--radius-sm); background: var(--surface-deep); border: 1px solid var(--accent-dim);
          padding: 14px; overflow: hidden;
        }
        .sdv-qr-panel::before {
          content: ""; position: absolute; top: 1px; left: 14px; right: 14px; height: 1px;
          background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: 0.7;
        }
        .sdv-qr-box {
          flex: 0 0 auto; width: 116px; height: 116px; padding: 8px; box-sizing: content-box;
          border-radius: var(--radius-xs);
          background: #EAF6FF; border: 1px solid var(--accent-glow);
        }
        .sdv-qr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
        .sdv-qr-code-label { color: var(--text-muted); font-family: var(--font-display); font-size: 10px; letter-spacing: var(--track-wide); }
        .sdv-qr-code { color: var(--accent-bright); font-family: var(--font-mono); font-size: 26px; font-weight: 600; letter-spacing: 5px; }
        .sdv-qr-status-row { display: flex; align-items: center; gap: 6px; }
        .sdv-qr-dot { width: 6px; height: 6px; border-radius: 50%; }
        .sdv-qr-dot.ok { background: var(--success); }
        .sdv-qr-dot.warn { background: var(--amber); }
        .sdv-qr-dot.dead { background: var(--danger); }
        .sdv-qr-remaining { font-size: 12px; color: var(--text-muted); }
        .sdv-qr-remaining.dead { color: var(--danger); }
        .sdv-qr-payload { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sdv-section-title { color: var(--accent); font-size: 11px; margin-top: 4px; }
        .sdv-empty { color: var(--text-faint); font-size: 12px; }
        .sdv-list { display: flex; flex-direction: column; gap: 8px; }
        .sdv-row {
          display: flex; align-items: center; gap: 12px; border-radius: var(--radius-sm);
          background: var(--panel-soft); border: 1px solid var(--hairline-soft); padding: 10px 14px;
        }
        .sdv-row-icon {
          flex: 0 0 auto; width: 30px; height: 30px; border-radius: var(--radius-xs);
          background: var(--accent-faint); border: 1px solid var(--accent-dim);
          display: flex; align-items: center; justify-content: center;
        }
        .sdv-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .sdv-row-name { color: var(--text); font-size: 14px; font-weight: 500; }
        .sdv-row-meta { color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sdv-revoke {
          all: unset; cursor: pointer; white-space: nowrap; padding: 6px 14px; border-radius: var(--radius-xs);
          background: var(--danger-dim); color: var(--danger); border: 1px solid var(--danger-dim);
          font-family: var(--font-display); letter-spacing: var(--track-mid); font-size: 11px;
          transition: opacity var(--dur-fast) ease;
        }
        .sdv-revoke:disabled { opacity: 0.5; cursor: default; }
      `}</style>

      <div class="sdv-head">
        <div class="hud-label sdv-title">Devices</div>
        <p class="sdv-desc">Paired phones with device-channel access. Scan the QR in the Jarvis app, or enter the code manually.</p>
      </div>

      <div class="sdv-pair-card">
        <div class="sdv-pair-row">
          <div class="sdv-pair-text">
            <div class="sdv-pair-label">Pair a phone</div>
            <div class="sdv-pair-sub">Generates a single-use code + QR, valid for 5 minutes.</div>
          </div>
          <button type="button" class="sdv-pair-btn" disabled={pairing()} onClick={() => void startPairing()}>
            {pairing() ? "Generating…" : pairCode() ? "New code" : "Pair a phone"}
          </button>
        </div>

        <Show when={pairCode()}>
          <div class="sdv-qr-panel">
            <img class="sdv-qr-box" src={svgToDataUri(pairQrSvg())} alt="pairing QR code" />
            <div class="sdv-qr-info">
              <div class="sdv-qr-code-label">PAIRING CODE</div>
              <div class="sdv-qr-code">{pairCode()}</div>
              <div class="sdv-qr-status-row">
                <span
                  class="sdv-qr-dot"
                  classList={{ ok: remaining() > 30, warn: remaining() > 0 && remaining() <= 30, dead: remaining() <= 0 }}
                />
                <span class="sdv-qr-remaining" classList={{ dead: remaining() <= 0 }}>
                  {remaining() > 0 ? `Expires in ${remaining()}s` : "Expired — request a new code"}
                </span>
              </div>
              <Show when={pairPayload()}>
                <div class="sdv-qr-payload">{pairPayload()}</div>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      <div class="hud-label sdv-section-title">Paired</div>

      <Show when={error()}>
        <div class="setup-error">⚠ {error()}</div>
      </Show>

      <Show when={loaded() && !error() && rows().length === 0}>
        <div class="sdv-empty">No devices paired yet.</div>
      </Show>
      <Show when={!loaded() && !error()}>
        <div class="sdv-empty">Loading paired devices…</div>
      </Show>

      <div class="sdv-list">
        <For each={rows()}>
          {(d) => {
            const meta = () => {
              const parts: string[] = []
              if (d.last_seen) parts.push(`last seen ${fmtTime(d.last_seen)}`)
              if (d.paired_at) parts.push(`paired ${fmtTime(d.paired_at)}`)
              return parts.length ? parts.join(" · ") : d.id
            }
            return (
              <div class="sdv-row">
                <div class="sdv-row-icon">
                  <NavIcon glyph="phone" color={theme.accent} />
                </div>
                <div class="sdv-row-text">
                  <div class="sdv-row-name">{d.name || d.id}</div>
                  <div class="sdv-row-meta">{meta()}</div>
                </div>
                <button
                  type="button"
                  class="sdv-revoke"
                  disabled={revoking() === d.id}
                  onClick={() => void revoke(d.id)}
                >
                  {revoking() === d.id ? "Revoking…" : "Revoke"}
                </button>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

const section: SettingsSectionDef = { key: "devices", label: "Devices", component: DevicesSection }
export default section
